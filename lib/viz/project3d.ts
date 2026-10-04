// Projection math written for the former 3D view; the map uses `separate` to spread the start
// screen's disease dots. Pure and DOM-free so it runs under node:test. Conventions: world y
// points up, the camera sits on the +z axis looking at the origin, screen y points down, angles
// are in radians.

export type Vec3 = readonly [number, number, number];

// Turntable orbit: yaw spins the scene about its vertical axis, then pitch tilts it toward the
// viewer. Pitch stays within +-PITCH_LIMIT so the scene never flips over a pole.
export const PITCH_LIMIT = 1.35;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function clampPitch(pitch: number): number {
  return clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

// The same angle in (-PI, PI], so an animated turn takes the short way round.
export function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  const wrapped = angle - turn * Math.floor((angle + Math.PI) / turn);
  return wrapped <= -Math.PI ? wrapped + turn : wrapped;
}

// Dragging right (yaw up) moves the side facing the viewer to the right; dragging down (pitch up)
// moves it down, as if the pointer held the scene by its front.
export function rotate(p: Vec3, yaw: number, pitch: number): [number, number, number] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x = p[0] * cy + p[2] * sy;
  const z = -p[0] * sy + p[2] * cy;
  return [x, p[1] * cp - z * sp, p[1] * sp + z * cp];
}

export interface View {
  yaw: number;
  pitch: number;
  distance: number; // camera to orbit center, in scene units; must exceed the scene's radius
  scale: number; // CSS px per scene unit at the orbit center's depth
  cx: number; // where the orbit center lands on screen, CSS px
  cy: number;
}

export interface Projected {
  x: number; // CSS px
  y: number;
  depth: number; // distance from the camera along the view axis: larger is farther
  k: number; // perspective factor: 1 at the orbit center's depth, above 1 when nearer
}

const MIN_DEPTH = 1e-6; // keeps a point at or behind the camera finite instead of mirrored

export function project(p: Vec3, view: View): Projected {
  const [x, y, z] = rotate(p, view.yaw, view.pitch);
  const depth = Math.max(view.distance - z, MIN_DEPTH);
  const k = view.distance / depth;
  return { x: view.cx + x * view.scale * k, y: view.cy - y * view.scale * k, depth, k };
}

// Largest scale at which a sphere of `radius` around the orbit center stays inside a width x
// height viewport (less padding) from every angle, so rotating never pushes a node off screen
// and the framing does not breathe. Perspective widens the outline: the sphere's silhouette
// projects to radius * d / sqrt(d^2 - radius^2) at the center's depth, not to radius.
export function fitScale(width: number, height: number, distance: number, radius = 1, padding = 0): number {
  const half = Math.max(0, Math.min(width, height) / 2 - padding);
  if (!(radius > 0)) return half; // a lone point at the center fits at any scale
  if (!(distance > radius)) return half / radius; // camera inside the sphere: fall back to a flat fit
  return (half * Math.sqrt(distance * distance - radius * radius)) / (distance * radius);
}

// 0 at the nearest point a sphere of `radius` around the orbit center can reach, 1 at the
// farthest. Drives the cues that make far nodes recede.
export function depthT(depth: number, distance: number, radius = 1): number {
  if (!(radius > 0)) return 0.5;
  return clamp((depth - (distance - radius)) / (2 * radius), 0, 1);
}

export interface OrbitFrame {
  span: number; // radius of the sphere around the pivot that holds every point: what zoom 1 fits
  zoom: number; // default magnification, in [1, maxZoom]
}

const MIN_SPAN = 0.25; // a lone point still gets a camera at a sane distance

// Framing for an orbit around `pivot` (the focus). Zoom 1 keeps every point in view from any
// angle; the default zoom spreads the highlighted points over about `fill` of that radius, so a
// tight neighborhood reads without hunting for the zoom. Zooming out still shows everything.
export function orbitFrame(pivot: Vec3, points: readonly Vec3[], highlighted: readonly Vec3[], fill = 0.55, maxZoom = 3): OrbitFrame {
  const reach = (list: readonly Vec3[]) =>
    list.reduce((max, p) => Math.max(max, Math.hypot(p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2])), 0);
  const span = Math.max(MIN_SPAN, reach(points));
  const near = reach(highlighted);
  return { span, zoom: near > 0 ? clamp((fill * span) / near, 1, maxZoom) : 1 };
}

// Pushes apart points that sit closer than minDist, in any number of dimensions, each pair by half
// the overlap per round, until none overlaps (or maxRounds). Diseases that share no biology all
// land on the same spot of the similarity layout; this spreads them into a readable cloud while
// every point stays near where the layout put it. Points on the very same spot part along a
// direction fixed by their indices, and bounds (when given) are enforced every round, so the
// result is deterministic and stays inside them.
export function separate(
  points: readonly (readonly number[])[],
  minDist: number,
  bounds?: { min: readonly number[]; max: readonly number[] },
  maxRounds = 400,
): number[][] {
  const out = points.map((p) => [...p]);
  const dims = out[0]?.length ?? 0;
  const keepInside = (p: number[]) => {
    if (!bounds) return;
    for (let k = 0; k < dims; k++) p[k] = clamp(p[k], bounds.min[k], bounds.max[k]);
  };
  // A fixed sideways nudge per pair (a unit vector from the pair's indices), so a pile spreads in
  // every dimension instead of along the line its points happen to share.
  const nudge = (i: number, j: number): number[] => {
    const t = 2 * Math.PI * ((i * 0.6180339887 + j * 0.7548776662) % 1);
    const z = 2 * ((i * 0.569840291 + j * 0.3247179572) % 1) - 1;
    const s = Math.sqrt(1 - z * z);
    const v = dims >= 3 ? [s * Math.cos(t), s * Math.sin(t), z] : [Math.cos(t), Math.sin(t)];
    return Array.from({ length: dims }, (_, k) => v[k] ?? 0);
  };
  out.forEach(keepInside);
  for (let round = 0; round < maxRounds; round++) {
    let worst = 0;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = out[j].map((v, k) => v - out[i][k]);
        const len = Math.hypot(...d);
        if (len >= minDist) continue;
        const side = nudge(i, j);
        const dir = d.map((v, k) => (len > 1e-9 ? v / len : 0) + 0.35 * side[k]);
        const norm = Math.hypot(...dir) || 1;
        const push = (minDist - len) / 2;
        for (let k = 0; k < dims; k++) {
          const u = (dir[k] / norm) * push;
          out[i][k] -= u;
          out[j][k] += u;
        }
        worst = Math.max(worst, minDist - len);
      }
    }
    out.forEach(keepInside);
    if (worst < minDist * 0.02) break;
  }
  return out;
}

// Paint order, farthest first, so nearer nodes cover farther ones. Equal depths keep their input
// order, so overlapping nodes never trade places between frames. Depths must be finite.
export function depthSort(depths: readonly number[]): number[] {
  return depths.map((_, i) => i).sort((a, b) => depths[b] - depths[a] || a - b);
}

// Yaw and pitch that turn p toward the camera, so it lands on the orbit center on screen, in
// front of everything else at its distance from the center. Pitch is clamped to PITCH_LIMIT.
export function faceAngles(p: Vec3): { yaw: number; pitch: number } {
  return {
    yaw: Math.atan2(-p[0], p[2]),
    pitch: clampPitch(Math.atan2(p[1], Math.hypot(p[0], p[2]))),
  };
}

export interface HitTarget {
  x: number;
  y: number;
  r: number; // drawn radius, CSS px
  depth: number;
  priority?: number; // higher wins close calls, e.g. highlighted nodes over grayed ones
}

export const HIT_MIN_RADIUS = 24;
export const HIT_PAD = 6;
const PRIORITY_BONUS = 4; // px of edge distance one priority level is worth outside the disks

// Whether target i is painted over target j where both cover the pointer: higher priority first,
// then the nearer one, then (equal depth) the later index, matching depthSort's paint order.
function wins(targets: readonly HitTarget[], i: number, j: number): boolean {
  const pi = targets[i].priority ?? 0;
  const pj = targets[j].priority ?? 0;
  if (pi !== pj) return pi > pj;
  if (targets[i].depth !== targets[j].depth) return targets[i].depth < targets[j].depth;
  return i > j;
}

// Index of the node under (px, py), or -1. Each node reaches max(minRadius, r + pad), so small
// dots stay easy to hit with a finger. A pointer inside drawn disks takes the disk that wins
// (see `wins`); otherwise the node whose edge is closest takes it, highlighted nodes getting a
// few px of benefit of the doubt.
export function hitTest(
  targets: readonly HitTarget[],
  px: number,
  py: number,
  minRadius = HIT_MIN_RADIUS,
  pad = HIT_PAD,
): number {
  let inside = -1;
  let near = -1;
  let nearScore = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const d = Math.hypot(t.x - px, t.y - py);
    if (!(d <= Math.max(minRadius, t.r + pad))) continue;
    if (d <= t.r) {
      if (inside < 0 || wins(targets, i, inside)) inside = i;
      continue;
    }
    const score = d - t.r - PRIORITY_BONUS * (t.priority ?? 0);
    if (score < nearScore || (score === nearScore && wins(targets, i, near))) {
      near = i;
      nearScore = score;
    }
  }
  return inside >= 0 ? inside : near;
}

// Candidate positions around a dot, in order of preference: straight below reads best.
export const LABEL_SIDES = ["below", "above", "right", "left", "below-right", "below-left", "above-right", "above-left"] as const;
export type LabelSide = (typeof LABEL_SIDES)[number];

// How text should be aligned inside a box on that side, so it hugs its dot.
export function sideAlign(side: LabelSide): "left" | "right" | "center" {
  if (side === "right" || side === "below-right" || side === "above-right") return "left";
  if (side === "left" || side === "below-left" || side === "above-left") return "right";
  return "center";
}

export interface LabelRequest {
  x: number; // node center, CSS px
  y: number;
  r: number; // node radius including rings
  w: number; // label box size
  h: number;
  compact?: { w: number; h: number }; // a shorter form (e.g. without its second line) for tight spots
  prefer?: LabelSide; // last frame's side: sticking to it stops labels jumping while the scene turns
  preferCompact?: boolean;
  optional?: boolean; // may be left out rather than cover a label placed before it (requests come in priority order)
}

export interface PlacedLabel {
  x: number; // top-left corner of the label box
  y: number;
  w: number;
  h: number;
  side: LabelSide;
  compact: boolean;
  dropped: boolean; // an optional label with no clear spot: not drawn this frame
}

// Costs in px^2 of overlap. Text over text is the worst outcome, so it outweighs the preferred
// reading position, the shorter form and the stickiness that keeps labels from flickering.
const LABEL_OVERLAP = 10; // per px^2 of another label covered
const DOT_OVERLAP = 3; // per px^2 of another labelled dot covered
const AMBIGUOUS = 300; // per other labelled dot about as close to the label as its own dot
const AMBIGUITY_MARGIN = 12; // px: a dot this much farther than the label's own still competes for it
const SIDE_COST = 60; // per step down LABEL_SIDES
// Dropping the second line costs less when the label was already short last frame, so it
// neither flickers at the threshold nor stays short once its full form fits again.
const COMPACT_COST = 150;
const COMPACT_KEEP_COST = 50;
const STICKY_BONUS = 200; // for keeping last frame's side
const SHIFT_COST = 6; // per px a box is pushed to stay inside the viewport
const DIAGONAL = Math.SQRT1_2; // a box on a diagonal touches the dot at 45 degrees

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Gap between a dot's edge and a box (0 when they touch or overlap).
function dotGap(x: number, y: number, r: number, box: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(box.x - x, 0, x - (box.x + box.w));
  const dy = Math.max(box.y - y, 0, y - (box.y + box.h));
  return Math.max(0, Math.hypot(dx, dy) - r);
}

function sideBox(q: { x: number; y: number; r: number }, w: number, h: number, side: LabelSide, gap: number): { x: number; y: number } {
  const d = q.r * DIAGONAL + gap;
  switch (side) {
    case "below":
      return { x: q.x - w / 2, y: q.y + q.r + gap };
    case "above":
      return { x: q.x - w / 2, y: q.y - q.r - gap - h };
    case "right":
      return { x: q.x + q.r + gap, y: q.y - h / 2 };
    case "left":
      return { x: q.x - q.r - gap - w, y: q.y - h / 2 };
    case "below-right":
      return { x: q.x + d, y: q.y + d };
    case "below-left":
      return { x: q.x - d - w, y: q.y + d };
    case "above-right":
      return { x: q.x + d, y: q.y - d - h };
    case "above-left":
      return { x: q.x - d - w, y: q.y - d - h };
  }
}

// Greedy label placement. Requests come in priority order and earlier labels keep their spot.
// Each label takes the position (and, in a crowd, the shorter form) that overlaps the fewest
// labels already placed and other labelled dots, pushed inside the viewport. A required label is
// always drawn; an optional one is dropped when its best spot still covers a label or another dot,
// or sits as close to another dot as to its own (it would name the wrong one), and its name shows
// on hover instead.
export function placeLabels(
  requests: readonly LabelRequest[],
  width: number,
  height: number,
  gap = 4,
  taken: readonly { x: number; y: number; w: number; h: number }[] = [], // text already drawn (ring and sector names)
): PlacedLabel[] {
  const dots = requests.map((q) => ({ x: q.x - q.r, y: q.y - q.r, w: 2 * q.r, h: 2 * q.r }));
  const out: PlacedLabel[] = [];
  const placed: PlacedLabel[] = taken.map((t) => ({ ...t, side: "below", compact: false, dropped: false })); // the text drawn so far
  for (let i = 0; i < requests.length; i++) {
    const q = requests[i];
    const forms = q.compact ? [false, true] : [false];
    let best: PlacedLabel | null = null;
    let bestCost = Infinity;
    for (const compact of forms) {
      const w = compact && q.compact ? q.compact.w : q.w;
      const h = compact && q.compact ? q.compact.h : q.h;
      for (let rank = 0; rank < LABEL_SIDES.length; rank++) {
        const side = LABEL_SIDES[rank];
        const ideal = sideBox(q, w, h, side, gap);
        const box: PlacedLabel = {
          x: clamp(ideal.x, 0, Math.max(0, width - w)),
          y: clamp(ideal.y, 0, Math.max(0, height - h)),
          w,
          h,
          side,
          compact,
          dropped: false,
        };
        let cost = rank * SIDE_COST + SHIFT_COST * (Math.abs(box.x - ideal.x) + Math.abs(box.y - ideal.y));
        if (compact) cost += q.preferCompact ? COMPACT_KEEP_COST : COMPACT_COST;
        if (q.prefer === side) cost -= STICKY_BONUS;
        for (const other of placed) cost += LABEL_OVERLAP * overlap(box, other);
        // A label read as naming the wrong dot is as bad as a hidden one.
        const own = dotGap(q.x, q.y, q.r, box);
        for (let j = 0; j < dots.length; j++) {
          if (j === i) continue;
          cost += DOT_OVERLAP * overlap(box, dots[j]);
          if (dotGap(requests[j].x, requests[j].y, requests[j].r, box) < own + AMBIGUITY_MARGIN) cost += AMBIGUOUS;
        }
        if (best === null || cost < bestCost) {
          best = box;
          bestCost = cost;
        }
      }
    }
    if (best === null) continue;
    const box = best;
    const own = dotGap(q.x, q.y, q.r, box);
    const clash =
      placed.some((other) => overlap(box, other) > 0) ||
      requests.some((o, j) => j !== i && (overlap(box, dots[j]) > 0 || dotGap(o.x, o.y, o.r, box) < own + AMBIGUITY_MARGIN / 2));
    if (q.optional && clash) {
      out.push({ ...box, dropped: true });
      continue;
    }
    out.push(box);
    placed.push(box);
  }
  return out;
}
