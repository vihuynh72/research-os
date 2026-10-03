import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PITCH_LIMIT,
  clamp,
  depthSort,
  depthT,
  easeInOutCubic,
  faceAngles,
  fitScale,
  hitTest,
  lerp,
  orbitFrame,
  placeLabels,
  project,
  rotate,
  sideAlign,
  wrapAngle,
  type HitTarget,
  type LabelRequest,
  type PlacedLabel,
  type Vec3,
  type View,
} from "./project3d.ts";

function near(actual: number, expected: number, eps = 1e-9, what = "value"): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} is not within ${eps} of ${expected}`);
}

function nearVec(actual: readonly number[], expected: readonly number[], eps = 1e-9): void {
  actual.forEach((v, i) => near(v, expected[i], eps, `component ${i}`));
}

// Deterministic points spread evenly over a sphere (Fibonacci lattice).
function spherePoints(n: number, radius = 1): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n;
    const ring = Math.sqrt(1 - y * y);
    return [radius * ring * Math.cos(golden * i), radius * y, radius * ring * Math.sin(golden * i)] as Vec3;
  });
}

const ANGLES = [-2.9, -1.3, -0.4, 0, 0.25, 0.9, 1.3, 3.1];
const length = (p: readonly number[]) => Math.hypot(p[0], p[1], p[2]);

test("rotate is the identity at yaw 0, pitch 0", () => {
  nearVec(rotate([0.3, -0.7, 0.2], 0, 0), [0.3, -0.7, 0.2]);
});

test("rotate: positive yaw moves the front of the scene right, positive pitch moves it down", () => {
  const quarter = Math.PI / 2;
  nearVec(rotate([0, 0, 1], quarter, 0), [1, 0, 0]);
  nearVec(rotate([1, 0, 0], quarter, 0), [0, 0, -1]);
  nearVec(rotate([0, 0, 1], 0, quarter), [0, -1, 0]);
  nearVec(rotate([0, 1, 0], 0, quarter), [0, 0, 1]); // the top tips toward the viewer
});

test("rotate preserves length and applies yaw before pitch", () => {
  for (const p of spherePoints(40, 0.8)) {
    for (const yaw of ANGLES) {
      for (const pitch of ANGLES) {
        const r = rotate(p, yaw, pitch);
        near(length(r), 0.8, 1e-12, "length");
        nearVec(r, rotate(rotate(p, yaw, 0), 0, pitch), 1e-12);
      }
    }
    nearVec(rotate(rotate(p, 0.4, 0), 0.7, 0), rotate(p, 1.1, 0), 1e-12);
  }
});

const VIEW: View = { yaw: 0, pitch: 0, distance: 3.5, scale: 200, cx: 400, cy: 300 };

test("project puts the orbit center at (cx, cy) with perspective factor 1", () => {
  const p = project([0, 0, 0], { ...VIEW, yaw: 1.2, pitch: -0.5 });
  near(p.x, 400);
  near(p.y, 300);
  near(p.depth, 3.5);
  near(p.k, 1);
});

test("project: +x is right, +y is up, and nearer points are larger and farther out", () => {
  const right = project([0.5, 0, 0], VIEW);
  const up = project([0, 0.5, 0], VIEW);
  assert.ok(right.x > 400 && Math.abs(right.y - 300) < 1e-9);
  assert.ok(up.y < 300 && Math.abs(up.x - 400) < 1e-9);
  const front = project([0.5, 0, 0.5], VIEW);
  const back = project([0.5, 0, -0.5], VIEW);
  assert.ok(front.depth < back.depth);
  assert.ok(front.k > 1 && back.k < 1);
  assert.ok(front.x - 400 > back.x - 400, "perspective pulls far points toward the center");
  near(front.x, 400 + 0.5 * 200 * (3.5 / 3));
  near(back.x, 400 + 0.5 * 200 * (3.5 / 4));
});

test("project equals rotate followed by the perspective divide, and mirrors left and right", () => {
  const view = { ...VIEW, yaw: 0.8, pitch: 0.3 };
  for (const p of spherePoints(30)) {
    const [x, y, z] = rotate(p, view.yaw, view.pitch);
    const k = view.distance / (view.distance - z);
    const got = project(p, view);
    near(got.x, view.cx + x * view.scale * k);
    near(got.y, view.cy - y * view.scale * k);
    near(got.k, k);
    const mirror = project([-p[0], p[1], p[2]], VIEW);
    const straight = project(p, VIEW);
    near(mirror.x - 400, -(straight.x - 400), 1e-9);
    near(mirror.y, straight.y, 1e-9);
  }
});

test("project keeps points at or behind the camera finite", () => {
  const p = project([0, 0, 5], VIEW);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.depth > 0);
});

test("fitScale: the unit sphere touches the viewport edge but never leaves it, from any angle", () => {
  const [width, height, padding, distance] = [640, 480, 30, 3.5];
  const scale = fitScale(width, height, distance, 1, padding);
  const points = spherePoints(4000);
  let reach = 0;
  for (const yaw of ANGLES) {
    for (const pitch of [-1.3, -0.6, 0, 0.45, 1.2]) {
      for (const p of points) {
        const q = project(p, { yaw, pitch, distance, scale, cx: width / 2, cy: height / 2 });
        reach = Math.max(reach, Math.abs(q.x - width / 2), Math.abs(q.y - height / 2));
      }
    }
  }
  const half = Math.min(width, height) / 2 - padding;
  assert.ok(reach <= half + 1e-9, `sphere reaches ${reach} px, limit ${half}`);
  assert.ok(reach >= half * 0.995, `fit is loose: ${reach} of ${half} px used`);
});

test("fitScale accounts for perspective, radius and degenerate inputs", () => {
  near(fitScale(800, 600, 3.5), (300 * Math.sqrt(3.5 ** 2 - 1)) / 3.5);
  near(fitScale(600, 800, 3.5), fitScale(800, 600, 3.5)); // the smaller side governs
  near(fitScale(800, 600, 7, 2), fitScale(800, 600, 3.5, 1) / 2); // scale-free in distance/radius
  near(fitScale(800, 600, 1e9, 1), 300, 1e-6); // far camera: the flat fit
  assert.equal(fitScale(800, 600, 3.5, 0), 300);
  assert.equal(fitScale(800, 600, 0.5, 1), 300);
  assert.equal(fitScale(40, 40, 3.5, 1, 30), 0);
});

test("depthT runs from 0 at the nearest point of the sphere to 1 at the farthest", () => {
  near(depthT(2.5, 3.5), 0);
  near(depthT(3.5, 3.5), 0.5);
  near(depthT(4.5, 3.5), 1);
  assert.equal(depthT(1, 3.5), 0);
  assert.equal(depthT(9, 3.5), 1);
});

test("depthSort paints farthest first and keeps input order on ties", () => {
  assert.deepEqual(depthSort([3, 5, 1, 4]), [1, 3, 0, 2]);
  assert.deepEqual(depthSort([2, 2, 1, 2]), [0, 1, 3, 2]);
  assert.deepEqual(depthSort([]), []);
  const depths = [1, 2, 3];
  depthSort(depths);
  assert.deepEqual(depths, [1, 2, 3], "input is not mutated");
});

test("depthSort is stable across frames for a rotating scene", () => {
  const points = spherePoints(200);
  for (const yaw of ANGLES) {
    const depths = points.map((p) => project(p, { ...VIEW, yaw }).depth);
    const order = depthSort(depths);
    assert.deepEqual(order, depthSort(depths));
    for (let i = 1; i < order.length; i++) assert.ok(depths[order[i - 1]] >= depths[order[i]]);
  }
});

test("faceAngles turns a point to face the camera at the center of the screen", () => {
  for (const p of spherePoints(60, 0.9)) {
    const { yaw, pitch } = faceAngles(p);
    if (Math.abs(Math.atan2(p[1], Math.hypot(p[0], p[2]))) > PITCH_LIMIT) continue;
    nearVec(rotate(p, yaw, pitch), [0, 0, 0.9], 1e-12);
    const q = project(p, { ...VIEW, yaw, pitch });
    near(q.x, VIEW.cx, 1e-9);
    near(q.y, VIEW.cy, 1e-9);
  }
  const center = faceAngles([0, 0, 0]);
  assert.ok(Number.isFinite(center.yaw) && Number.isFinite(center.pitch));
  near(faceAngles([0, 1, 0.01]).pitch, PITCH_LIMIT); // near a pole the tilt is capped
  near(faceAngles([0, -1, 0.01]).pitch, -PITCH_LIMIT);
});

test("wrapAngle maps any angle into (-PI, PI] without changing its direction", () => {
  for (const a of [-20, -7, -Math.PI, -3, -0.5, 0, 0.5, 3, Math.PI, 7, 20, 3 * Math.PI, -3 * Math.PI]) {
    const w = wrapAngle(a);
    assert.ok(w > -Math.PI && w <= Math.PI, `${a} -> ${w}`);
    near(Math.cos(w), Math.cos(a), 1e-12);
    near(Math.sin(w), Math.sin(a), 1e-12);
  }
  near(wrapAngle(Math.PI), Math.PI);
  near(wrapAngle(-Math.PI), Math.PI);
  near(wrapAngle(0.3 + 4 * Math.PI), 0.3, 1e-12);
});

const dot = (x: number, y: number, r: number, depth = 3.5, priority?: number): HitTarget => ({ x, y, r, depth, priority });

test("hitTest gives small dots a 24 px reach and big ones their radius plus 6 px", () => {
  assert.equal(hitTest([], 0, 0), -1);
  const small = [dot(100, 100, 3)];
  assert.equal(hitTest(small, 124, 100), 0);
  assert.equal(hitTest(small, 124.5, 100), -1);
  const big = [dot(100, 100, 30)];
  assert.equal(hitTest(big, 136, 100), 0);
  assert.equal(hitTest(big, 136.5, 100), -1);
});

test("hitTest outside the disks picks the node whose edge is closest", () => {
  const targets = [dot(0, 0, 20), dot(40, 0, 4)];
  assert.equal(hitTest(targets, 24, 0), 0); // 4 px from the big edge, 12 px from the small one
  assert.equal(hitTest(targets, 30, 0), 1); // 10 px from the big edge, 6 px from the small one
  assert.equal(hitTest([dot(0, 0, 5), dot(20, 0, 5)], 10, 0), 1, "exact tie: the one painted on top");
});

test("hitTest inside overlapping disks takes the one painted on top", () => {
  assert.equal(hitTest([dot(0, 0, 10, 3.0), dot(4, 0, 10, 4.0)], 2, 0), 0, "nearer wins");
  assert.equal(hitTest([dot(0, 0, 10, 4.0), dot(4, 0, 10, 3.0)], 2, 0), 1, "nearer wins");
  const same = [dot(0, 0, 10), dot(4, 0, 10)];
  const top = depthSort(same.map((t) => t.depth)).at(-1);
  assert.equal(hitTest(same, 2, 0), top, "equal depth: matches depthSort's paint order");
});

test("hitTest prefers highlighted nodes in close calls but respects precise pointing", () => {
  const grayInFront = dot(0, 0, 10, 3.0, 0);
  const colorBehind = dot(4, 0, 10, 4.0, 1);
  assert.equal(hitTest([grayInFront, colorBehind], 2, 0), 1, "inside both: highlighted wins");
  assert.equal(hitTest([dot(0, 0, 4, 3.5, 0), dot(14, 0, 4, 3.5, 1)], 6, 0), 1, "near tie: highlighted wins");
  assert.equal(hitTest([dot(0, 0, 4, 3.5, 0), dot(20, 0, 4, 3.5, 1)], 1, 0), 0, "inside a gray dot: it wins");
});

test("hitTest skips targets with non-finite positions", () => {
  assert.equal(hitTest([dot(Number.NaN, 0, 5), dot(10, 0, 5)], 9, 0), 1);
});

type Box = Pick<PlacedLabel, "x" | "y" | "w" | "h">;

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const label = (x: number, y: number, prefer?: LabelRequest["prefer"]): LabelRequest => ({ x, y, r: 8, w: 60, h: 14, prefer });

test("placeLabels puts isolated labels centered below their node", () => {
  const placed = placeLabels([label(100, 100), label(300, 100), label(200, 300)], 500, 500);
  assert.deepEqual(
    placed.map((p) => p.side),
    ["below", "below", "below"],
  );
  near(placed[0].x, 70);
  near(placed[0].y, 112);
});

test("placeLabels moves a label that would collide and never overlaps when there is room", () => {
  // Stacked nodes: neither label may sit on the other label or on the other node's dot.
  const stacked = [label(200, 200), label(200, 222)];
  const placed = placeLabels(stacked, 500, 500);
  assert.deepEqual(
    placed.map((p) => p.side),
    ["above", "below"],
  );
  assert.equal(overlapArea(placed[0], placed[1]), 0);
  stacked.forEach((q, i) => {
    const other = placed[1 - i];
    assert.equal(overlapArea(other, { x: q.x - q.r, y: q.y - q.r, w: 2 * q.r, h: 2 * q.r }), 0);
  });

  const spread = spherePoints(8).map((p) => label(250 + 180 * p[0], 250 - 180 * p[1]));
  const many = placeLabels(spread, 500, 500);
  for (let i = 0; i < many.length; i++) {
    for (let j = i + 1; j < many.length; j++) assert.equal(overlapArea(many[i], many[j]), 0, `${i} and ${j}`);
  }
});

test("placeLabels keeps labels inside the viewport, off their own node", () => {
  const [bottom] = placeLabels([label(250, 492)], 500, 500);
  assert.equal(bottom.side, "above");
  assert.ok(bottom.y >= 0 && bottom.y + bottom.h <= 500);
  const [corner] = placeLabels([label(2, 2)], 500, 500);
  assert.ok(corner.x >= 0 && corner.y >= 0);
});

test("placeLabels keeps a label off the side where it would read as naming a nearby dot", () => {
  // Two dots one above the other: the upper label placed below would sit 4 px from its own dot and
  // 6 px from the lower one, so it reads as either. Outside each pair member it is unambiguous.
  const placed = placeLabels([label(200, 200), label(200, 240)], 500, 500);
  assert.equal(placed[0].side, "above");
  assert.equal(placed[1].side, "below");
  // Far enough apart, the preferred position below is not ambiguous and stays.
  assert.equal(placeLabels([label(200, 200), label(200, 262)], 500, 500)[0].side, "below");
});

test("placeLabels lets a label leave last frame's side rather than overlap another label", () => {
  // Two neighbors drifting together while the scene turns, both labelled below last frame.
  const placed = placeLabels([label(315, 344, "below"), label(359, 340, "below")], 860, 524);
  assert.equal(overlapArea(placed[0], placed[1]), 0);
  assert.equal(placed[0].side, "below", "the first label keeps its side");
});

test("placeLabels never drops a label, keeps last frame's side when it is still clear, and is deterministic", () => {
  const crowd = Array.from({ length: 12 }, () => label(250, 250));
  assert.equal(placeLabels(crowd, 500, 500).length, 12);
  const [kept] = placeLabels([label(200, 200, "right")], 500, 500);
  assert.equal(kept.side, "right");
  const input = [label(100, 100), label(110, 112), label(120, 95, "left")];
  assert.deepEqual(placeLabels(input, 300, 300), placeLabels(input, 300, 300));
});

test("placeLabels falls back to the short form in a crowd, and only there", () => {
  const twoLine = (x: number, y: number): LabelRequest => ({ x, y, r: 8, w: 70, h: 28, compact: { w: 44, h: 15 } });
  const [alone] = placeLabels([twoLine(200, 200)], 500, 500);
  assert.equal(alone.compact, false);
  assert.equal(alone.h, 28);

  // A tight 3 x 3 cluster, 34 px apart: two-line labels cannot all fit, short ones can.
  const cluster = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => twoLine(200 + col * 34, 200 + row * 34)));
  const placed = placeLabels(cluster, 500, 500);
  assert.equal(placed.length, 9);
  assert.ok(placed.some((p) => p.compact), "some labels shrink");
  let overlapTotal = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) overlapTotal += overlapArea(placed[i], placed[j]);
  }
  const fullOnly = placeLabels(
    cluster.map(({ compact: _, ...rest }) => rest),
    500,
    500,
  );
  let fullOverlap = 0;
  for (let i = 0; i < fullOnly.length; i++) {
    for (let j = i + 1; j < fullOnly.length; j++) fullOverlap += overlapArea(fullOnly[i], fullOnly[j]);
  }
  assert.ok(overlapTotal < fullOverlap, `short forms reduce text overlap (${overlapTotal} vs ${fullOverlap})`);
});

test("placeLabels gives a short label its second line back once there is room", () => {
  const twoLine: LabelRequest = { x: 200, y: 200, r: 8, w: 70, h: 28, compact: { w: 44, h: 15 }, prefer: "below", preferCompact: true };
  const [alone] = placeLabels([twoLine], 500, 500);
  assert.equal(alone.compact, false);
  assert.equal(alone.side, "below");
});

test("sideAlign keeps text hugging its dot", () => {
  assert.equal(sideAlign("below"), "center");
  assert.equal(sideAlign("above"), "center");
  assert.equal(sideAlign("right"), "left");
  assert.equal(sideAlign("above-right"), "left");
  assert.equal(sideAlign("left"), "right");
  assert.equal(sideAlign("below-left"), "right");
});

test("orbitFrame: zoom 1 fits every point around the pivot, the default zoom frames the neighbors", () => {
  const pivot: Vec3 = [0.5, 0, 0];
  const points: Vec3[] = [pivot, [-0.5, 0, 0], [0.5, 0.2, 0], [0.5, 0, -0.1]];
  const spread = orbitFrame(pivot, points, [[-0.5, 0, 0]]);
  near(spread.span, 1);
  assert.equal(spread.zoom, 1, "neighbors already reach the edge");
  const tight = orbitFrame(pivot, points, [[0.5, 0.2, 0], [0.5, 0, -0.1]]);
  near(tight.zoom, (0.55 * 1) / 0.2);
  assert.equal(orbitFrame(pivot, points, [[0.5, 0.01, 0]]).zoom, 3, "capped");
  assert.equal(orbitFrame(pivot, points, []).zoom, 1, "no neighbors: show everything");
  near(orbitFrame([0, 0, 0], [[0, 0, 0]], []).span, 0.25, 1e-12, "a lone point keeps a usable span");
});

test("orbiting the focus at zoom 1 keeps every disease in view and the focus in the middle", () => {
  // The camera setup Graph3D uses: pivot on the focus, distance 3.5 spans, fitScale on the span.
  const cloud = spherePoints(300).map((p, i) => [p[0] * (0.3 + (i % 7) / 10), p[1] * 0.8, p[2] * (1 - (i % 5) / 10)] as Vec3);
  const [width, height, padding] = [860, 524, 28];
  for (const pivot of [cloud[0], cloud[137], [0, 0, 0] as Vec3]) {
    const { span } = orbitFrame(pivot, cloud, []);
    const distance = 3.5 * span;
    const scale = fitScale(width, height, distance, span, padding);
    for (const yaw of ANGLES) {
      for (const pitch of [-1.2, 0, 0.7]) {
        const view = { yaw, pitch, distance, scale, cx: width / 2, cy: height / 2 };
        const center = project([0, 0, 0], view);
        near(center.x, width / 2);
        near(center.y, height / 2);
        for (const p of cloud) {
          const q = project([p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]], view);
          assert.ok(q.x >= padding - 1e-9 && q.x <= width - padding + 1e-9, `x ${q.x}`);
          assert.ok(q.y >= padding - 1e-9 && q.y <= height - padding + 1e-9, `y ${q.y}`);
        }
      }
    }
  }
});

test("clamp, lerp and easeInOutCubic behave at their endpoints", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(lerp(2, 6, 0.25), 3);
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  near(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(2), 1);
  let previous = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const v = easeInOutCubic(t);
    assert.ok(v >= previous);
    previous = v;
  }
});
