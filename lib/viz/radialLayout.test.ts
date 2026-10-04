import test from "node:test";
import assert from "node:assert/strict";
import { SECTORS, geometryFor, percentBand, radialLayout, ringRadius, sectorOf, type RadialNode } from "./radialLayout.ts";

const nodes: RadialNode[] = [
  { id: "F", type: "Disease", role: "focus", relevance: 1, ownerRank: 0, radius: 30 },
  { id: "D1", type: "Disease", role: "related", relevance: 0.85, ownerRank: 1, radius: 22, cluster: "a" },
  { id: "D2", type: "Disease", role: "related", relevance: 0.5, ownerRank: 2, radius: 22, cluster: "b" },
  { id: "D3", type: "Disease", role: "related", relevance: 0.3, ownerRank: 3, radius: 22, cluster: "b" },
  ...Array.from({ length: 9 }, (_, i): RadialNode => ({ id: `S${i}`, type: "Phenotype", role: "symptom", relevance: 0.95 - i * 0.02, ownerRank: 0, radius: 12 })),
  ...Array.from({ length: 6 }, (_, i): RadialNode => ({ id: `M${i}`, type: "Mechanism", role: "attribute", relevance: 1, ownerRank: 0, radius: 15 })),
  { id: "G", type: "Gene", role: "attribute", relevance: 1, ownerRank: 0, radius: 15 },
  { id: "B", type: "Bubble", bubbleType: "Trial", role: "bubble", relevance: 1, ownerRank: 0, radius: 15 },
  { id: "O", type: "PatientOrg", role: "group", relevance: 0.9, ownerRank: 0, radius: 15 },
];
const W = 1200;
const H = 800;

const angleOf = (p: [number, number]) => {
  const g = geometryFor(W, H);
  let a = (Math.atan2(p[1] - g.cy, p[0] - g.cx) * 180) / Math.PI;
  if (a < -150) a += 360;
  return a;
};

test("same input, same layout, in any order", () => {
  const a = radialLayout(nodes, "F", W, H).positions;
  const b = radialLayout([...nodes].reverse(), "F", W, H).positions;
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("distance from the center encodes relevance", () => {
  const { positions, geometry } = radialLayout(nodes, "F", W, H);
  const dist = (id: string) => Math.hypot(positions.get(id)![0] - geometry.cx, positions.get(id)![1] - geometry.cy);
  assert.ok(dist("D1") < dist("D2") && dist("D2") < dist("D3"));
  assert.ok(Math.abs(dist("D1") - ringRadius(geometry, 0.85)) < 1, "an uncrowded node sits exactly on its ring");
});

test("direction encodes the kind of thing", () => {
  const { positions } = radialLayout(nodes, "F", W, H);
  for (const n of nodes) {
    if (n.id === "F") continue;
    const sector = SECTORS.find((s) => s.id === sectorOf(n.type === "Bubble" ? n.bubbleType! : n.type))!;
    const a = angleOf(positions.get(n.id)!);
    assert.ok(a >= sector.start - 0.01 && a <= sector.end + 0.01, `${n.id} at ${a} outside ${sector.id}`);
  }
});

test("no overlaps, even in a crowded sector", () => {
  const { positions } = radialLayout(nodes, "F", W, H);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const p = positions.get(nodes[i].id)!;
      const q = positions.get(nodes[j].id)!;
      assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) >= nodes[i].radius + nodes[j].radius, `${nodes[i].id}/${nodes[j].id} overlap`);
    }
  }
});

test("crowded sectors keep distance honest: at every whole-percent filter, shown inside the ring and faint outside", () => {
  // 14 diseases a gene is behind (all 100%), 10 related diseases at the same 70%, 12 mechanisms at 95%,
  // and symptoms spread over many values.
  const crowd: RadialNode[] = [
    { id: "F", type: "Gene", role: "focus", relevance: 1, ownerRank: 0, radius: 30 },
    ...Array.from({ length: 14 }, (_, i): RadialNode => ({ id: `A${i}`, type: "Disease", role: "anchor", relevance: 1, ownerRank: 0, radius: 18, cluster: "c" })),
    ...Array.from({ length: 10 }, (_, i): RadialNode => ({ id: `R${i}`, type: "Disease", role: "related", relevance: 0.7, ownerRank: i + 1, radius: 18, cluster: "c" })),
    ...Array.from({ length: 12 }, (_, i): RadialNode => ({ id: `M${i}`, type: "Mechanism", role: "attribute", relevance: 0.95, ownerRank: 0, radius: 15 })),
    ...Array.from({ length: 10 }, (_, i): RadialNode => ({ id: `S${i}`, type: "Phenotype", role: "symptom", relevance: 0.6137 + i * 0.0311, ownerRank: 0, radius: 13 })),
  ];
  const { positions, geometry } = radialLayout(crowd, "F", W, H);
  const dist = (id: string) => Math.hypot(positions.get(id)![0] - geometry.cx, positions.get(id)![1] - geometry.cy);
  assert.ok(geometry.direct > geometry.inner, "many direct links widen the zone around the center");
  for (let pct = 0; pct <= 100; pct++) {
    const t = pct / 100;
    const ring = ringRadius(geometry, t);
    for (const n of crowd) {
      if (n.id === "F") continue;
      const shown = n.relevance >= t - 1e-9;
      if (shown) assert.ok(dist(n.id) <= ring + 0.01, `${n.id} (${n.relevance}) outside the ${pct}% ring`);
      else assert.ok(dist(n.id) > ring - 0.01, `${n.id} (${n.relevance}) inside the ${pct}% ring while under the filter`);
    }
  }
  for (const n of crowd) if (n.id !== "F" && n.relevance < 1) assert.equal(percentBand(n.relevance) <= n.relevance, true);
});

test("members of one cluster fan out, so a line from the center never runs through a nearer disease", () => {
  const nodes2: RadialNode[] = [
    { id: "F", type: "Disease", role: "focus", relevance: 1, ownerRank: 0, radius: 30 },
    { id: "near", type: "Disease", role: "related", relevance: 0.85, ownerRank: 1, radius: 22, cluster: "c" },
    { id: "far", type: "Disease", role: "related", relevance: 0.54, ownerRank: 2, radius: 22, cluster: "c" },
  ];
  const { positions, geometry } = radialLayout(nodes2, "F", W, H);
  const [cx, cy] = [geometry.cx, geometry.cy];
  const [fx, fy] = positions.get("far")!;
  const [nx, ny] = positions.get("near")!;
  // Distance from the near disease's center to the segment center-far.
  const t = Math.max(0, Math.min(1, ((nx - cx) * (fx - cx) + (ny - cy) * (fy - cy)) / ((fx - cx) ** 2 + (fy - cy) ** 2)));
  const gap = Math.hypot(nx - (cx + t * (fx - cx)), ny - (cy + t * (fy - cy)));
  assert.ok(gap >= 22, `the line to the farther disease passes ${gap.toFixed(1)} from the nearer one`);
});
