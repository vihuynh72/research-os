import test from "node:test";
import assert from "node:assert/strict";
import { SECTORS, geometryFor, radialLayout, ringRadius, sectorOf, type RadialNode } from "./radialLayout.ts";

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
