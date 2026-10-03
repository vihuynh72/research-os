import test from "node:test";
import assert from "node:assert/strict";
import { fitToBox, forceLayout, hash01, toUnitSphere, type LayoutEdge, type LayoutNode } from "./forceLayout.ts";

const nodes: LayoutNode[] = [
  { id: "F", role: "focus", type: "Disease", hop: 0, relevance: 1, radius: 30 },
  { id: "R1", role: "related", type: "Disease", hop: 1, relevance: 0.9, radius: 20, group: "c1" },
  { id: "R2", role: "related", type: "Disease", hop: 1, relevance: 0.5, radius: 20, group: "c1" },
  { id: "R3", role: "related", type: "Disease", hop: 1, relevance: 0.3, radius: 20, group: "c2" },
  { id: "G", role: "attribute", type: "Gene", hop: 1, relevance: 1, radius: 16 },
  { id: "M", role: "attribute", type: "Mechanism", hop: 1, relevance: 1, radius: 16 },
  { id: "S1", role: "symptom", type: "Phenotype", hop: 1, relevance: 0.9, radius: 11 },
  { id: "S2", role: "symptom", type: "Phenotype", hop: 1, relevance: 0.6, radius: 11 },
  { id: "O", role: "group", type: "PatientOrg", hop: 2, relevance: 0.9, radius: 15 },
  { id: "B", role: "bubble", type: "Bubble", hop: 1, relevance: 1, radius: 15 },
];
const edges: LayoutEdge[] = [
  { a: "F", b: "R1", relevance: 0.9, role: "similarity" },
  { a: "F", b: "R2", relevance: 0.5, role: "similarity" },
  { a: "F", b: "R3", relevance: 0.3, role: "similarity" },
  { a: "F", b: "G", relevance: 1, role: "evidence" },
  { a: "F", b: "M", relevance: 1, role: "evidence" },
  { a: "F", b: "S1", relevance: 0.9, role: "evidence" },
  { a: "F", b: "S2", relevance: 0.6, role: "evidence" },
  { a: "M", b: "O", relevance: 0.9, role: "evidence" },
  { a: "F", b: "B", relevance: 1, role: "bubble" },
  { a: "R1", b: "M", relevance: 0.9, role: "shared" },
  { a: "R2", b: "M", relevance: 0.5, role: "shared" },
  { a: "R1", b: "R2", relevance: 0.5, role: "bridge" },
];

const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

test("same input, same layout", () => {
  const a = forceLayout(nodes, edges);
  const b = forceLayout([...nodes].reverse(), [...edges].reverse());
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("focus stays at the origin and more related diseases sit closer", () => {
  const pos = forceLayout(nodes, edges);
  assert.deepEqual(pos.get("F"), [0, 0, 0]);
  const o = [0, 0, 0];
  const d1 = dist(pos.get("R1")!, o);
  const d2 = dist(pos.get("R2")!, o);
  const d3 = dist(pos.get("R3")!, o);
  assert.ok(d1 < d2 && d2 < d3, `distances ${d1} ${d2} ${d3}`);
});

test("no overlapping nodes and no NaN", () => {
  const pos = forceLayout(nodes, edges);
  for (const n of nodes) assert.ok(pos.get(n.id)!.every(Number.isFinite));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = dist(pos.get(nodes[i].id)!, pos.get(nodes[j].id)!);
      assert.ok(d >= (nodes[i].radius + nodes[j].radius) * 0.95, `${nodes[i].id}-${nodes[j].id} overlap: ${d}`);
    }
  }
});

test("3D spreads depth, 2D stays flat", () => {
  const flat = forceLayout(nodes, edges, { dims: 2 });
  assert.ok([...flat.values()].every((p) => p[2] === 0));
  const deep = forceLayout(nodes, edges, { dims: 3 });
  assert.ok([...deep.values()].some((p) => Math.abs(p[2]) > 5));
  const unit = toUnitSphere(deep, "F");
  assert.deepEqual(unit.get("F"), [0, 0, 0]);
  assert.ok([...unit.values()].every((p) => Math.hypot(...p) <= 1 + 1e-9));
});

test("fitToBox keeps everything inside the padded box, focus centered", () => {
  const box = fitToBox(forceLayout(nodes, edges), 1000, 700, 60, "F");
  assert.deepEqual(box.get("F"), [500, 350]);
  for (const [x, y] of box.values()) {
    assert.ok(x >= 60 - 1e-6 && x <= 940 + 1e-6 && y >= 60 - 1e-6 && y <= 640 + 1e-6, `${x},${y}`);
  }
});

test("hash01 is stable and in range", () => {
  assert.equal(hash01("MONDO:0008767"), hash01("MONDO:0008767"));
  for (const id of ["a", "b", "HP:0000001", ""]) assert.ok(hash01(id) >= 0 && hash01(id) < 1);
});
