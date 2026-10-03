import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, classicalMds, louvain, sparseMds, type WeightedLink } from "./analytics.ts";
import type { NodeType } from "../graph/types.ts";
import {
  DIMENSIONS,
  DIMENSION_FAMILY,
  type Dimension,
  type DimensionResult,
  type PairGrade,
  type SharedItem,
  type Tier,
} from "./types.ts";

function clique(ids: string[], weight: number): WeightedLink[] {
  const links: WeightedLink[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) links.push({ a: ids[i], b: ids[j], weight });
  return links;
}

test("Louvain splits two 4-cliques joined by one weak edge, the same way every run", () => {
  const left = ["a1", "a2", "a3", "a4"];
  const right = ["b1", "b2", "b3", "b4"];
  const links = [...clique(left, 1), ...clique(right, 1), { a: "a4", b: "b1", weight: 0.1 }];
  const nodes = [...left, ...right];
  const first = louvain(nodes, links);
  assert.deepEqual(first, [left, right]);
  for (let run = 0; run < 5; run++) assert.deepEqual(louvain(nodes, links), first);
  // Input order does not matter: nodes are visited in sorted-id order.
  assert.deepEqual(louvain([...nodes].reverse(), [...links].reverse()), first);
});

test("Louvain keeps a dense group together and separates disconnected groups", () => {
  const five = ["d1", "d2", "d3", "d4", "d5"];
  assert.deepEqual(louvain(five, clique(five, 0.85)), [five]);
  const islands = louvain(["x", "y", "z", "w"], [{ a: "x", b: "y", weight: 1 }, { a: "z", b: "w", weight: 1 }]);
  assert.deepEqual(islands, [["w", "z"], ["x", "y"]]);
  assert.deepEqual(louvain([], []), []);
});

function pairwise(points: number[][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      out.push(Math.hypot(...points[i].map((x, k) => x - points[j][k])));
    }
  }
  return out;
}

test("classical MDS recovers a known 3D configuration up to scale", () => {
  const points = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 2, 0],
    [0, 0, 3],
  ];
  const coords = classicalMds(4, (i, j) => Math.hypot(...points[i].map((x, k) => x - points[j][k])));
  const before = pairwise(points);
  const after = pairwise(coords);
  const scale = after[0] / before[0];
  for (let i = 0; i < before.length; i++) assert.ok(Math.abs(after[i] - scale * before[i]) < 1e-6, `pair ${i}`);
  // Scaled so the farthest point sits on the unit sphere.
  const norms = coords.map((p) => Math.hypot(...p));
  assert.ok(Math.abs(Math.max(...norms) - 1) < 1e-9);
  // Each axis is oriented so the first point with a non-zero value on it is positive.
  for (let k = 0; k < 3; k++) {
    const first = coords.find((p) => Math.abs(p[k]) >= 5e-5);
    assert.ok(first && first[k] > 0, `axis ${k}`);
  }
  assert.deepEqual(classicalMds(4, (i, j) => Math.hypot(...points[i].map((x, k) => x - points[j][k]))), coords);
});

test("the sparse MDS used for the atlas matches the dense one", () => {
  const close = (x: number[][], y: number[][]) => x.every((p, i) => p.every((v, k) => Math.abs(v - y[i][k]) < 1e-6));
  // Every pair listed: the 4-point metric above.
  const points = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 2, 0],
    [0, 0, 3],
  ];
  const metric = (i: number, j: number) => Math.hypot(...points[i].map((x, k) => x - points[j][k]));
  const all = [0, 1, 2, 3].flatMap((i) => [0, 1, 2, 3].filter((j) => j > i).map((j) => ({ i, j, distance: metric(i, j) })));
  assert.ok(close(sparseMds(4, all), classicalMds(4, metric)));
  // Atlas-like: most pairs at distance 1 (nothing shared), two tight groups and one weaker link.
  const listed = [
    { i: 0, j: 1, distance: 0.15 },
    { i: 0, j: 2, distance: 0.2 },
    { i: 1, j: 2, distance: 0.25 },
    { i: 3, j: 4, distance: 0.3 },
    { i: 4, j: 5, distance: 0.35 },
    { i: 2, j: 3, distance: 0.7 },
  ];
  const lookup = (i: number, j: number) =>
    listed.find((p) => (p.i === i && p.j === j) || (p.i === j && p.j === i))?.distance ?? 1;
  const sparse = sparseMds(7, listed);
  assert.ok(close(sparse, classicalMds(7, lookup)));
  // The tight group stays together, far from the disease that shares nothing.
  const dist = (x: number, y: number) => Math.hypot(...sparse[x].map((v, k) => v - sparse[y][k]));
  assert.ok(dist(0, 1) < dist(0, 6) && dist(3, 4) < dist(3, 6));
});

test("classical MDS edge cases: one point, two points, identical points", () => {
  assert.deepEqual(classicalMds(1, () => 1), [[0, 0, 0]]);
  const two = classicalMds(2, () => 0.5);
  assert.ok(Math.abs(two[0][0] - 1) < 1e-9 && Math.abs(two[1][0] + 1) < 1e-9);
  assert.deepEqual([two[0][1], two[0][2], two[1][1], two[1][2]], [0, 0, 0, 0]);
  for (const p of classicalMds(3, () => 0)) assert.deepEqual(p, [0, 0, 0]);
});

// ---- analyze(): clusters, centrality, bridges --------------------------------------------------

function shared(id: string, type: NodeType, edges: string[], weight = 1): SharedItem {
  return { id, label: id === "M1" ? "Lysosomal storage" : `Label ${id}`, type, weight, edges, kind: "observed" };
}

function grade(a: string, b: string, tier: Tier, biology: number, items: Partial<Record<Dimension, SharedItem[]>> = {}): PairGrade {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((d): [Dimension, DimensionResult] => [
      d,
      {
        dimension: d,
        family: DIMENSION_FAMILY[d],
        score: items[d]?.length ? 1 : 0,
        status: items[d]?.length ? "match" : "none",
        coverage: { a: 1, b: 1 },
        shared: items[d] ?? [],
        support: items[d]?.length ? "observed" : null,
        summary: "",
        flags: [],
      },
    ]),
  ) as Record<Dimension, DimensionResult>;
  return {
    a,
    b,
    biology,
    clinical: 0,
    collaboration: 0,
    relevance: biology,
    tier,
    tier_reason: "",
    clinical_tier: "different",
    clinical_reason: "",
    support: null,
    lines_of_evidence: [],
    dimensions,
    flags: [],
    judgments: [],
  };
}

test("clusters are named by their shared mechanism, then symptoms, then number; bridges skip umbrella items", () => {
  const mechanism = (a: string, b: string) => [shared("M1", "Mechanism", [`e-${a}-M1`, `e-${b}-M1`])];
  const grades: PairGrade[] = [
    grade("D1", "D2", "strong", 0.9, { mechanism: mechanism("D1", "D2") }),
    grade("D1", "D3", "moderate", 0.6, { mechanism: mechanism("D1", "D3") }),
    grade("D2", "D3", "strong", 0.8, { mechanism: mechanism("D2", "D3"), grant: [shared("R1", "Grant", ["e-R1-D2", "e-R1-D3"])] }),
    grade("D4", "D5", "moderate", 0.5, { phenotype: [shared("HP:1", "Phenotype", ["e1", "e2"], 0.4), shared("HP:2", "Phenotype", ["e3", "e4"], 0.9)] }),
    grade("D6", "D7", "strong", 0.8),
    // Exploratory links do not cluster; a shared umbrella group is not a bridge, a shared trial is.
    grade("D3", "D4", "exploratory", 0.3, {
      patient_org: [shared("O1", "PatientOrg", ["e-O1-M1"])],
      trial: [shared("T1", "Trial", ["e-T1-D3", "e-T1-D4"])],
    }),
    grade("D1", "D8", "none", 0.1, { patient_org: [shared("O1", "PatientOrg", ["e-O1-M1"])] }),
  ];
  const diseases = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];
  const result = analyze({ diseases, grades, isUmbrella: (_d, id) => id === "O1" });

  assert.deepEqual(
    result.clusters.map((c) => [c.id, c.label, c.members, c.mechanisms, c.color_slot]),
    [
      ["c-M1", "Lysosomal storage", ["D1", "D2", "D3"], ["M1"], 1],
      ["c-group-2", "Shared symptoms: Label HP:2", ["D4", "D5"], [], 2],
      ["c-group-3", "Group 3", ["D6", "D7"], [], 3],
    ],
  );
  assert.equal(result.clusterOf.get("D8"), null);
  assert.equal(result.centrality.get("D2"), 1); // 0.9 + 0.8 is the largest weighted degree
  assert.equal(result.centrality.get("D8"), 0);
  assert.equal(result.bridgeNodes.size, 0);
  assert.deepEqual(result.bridges, [
    { a: "D2", b: "D3", cross_cluster: false, reason: "Same research grant", dimensions: ["grant"], edges: ["e-R1-D2", "e-R1-D3"] },
    { a: "D3", b: "D4", cross_cluster: true, reason: "Same clinical study", dimensions: ["trial"], edges: ["e-T1-D3", "e-T1-D4"] },
  ]);
  for (const id of diseases) {
    const p = result.coords.get(id);
    assert.ok(p && p.every((x) => Math.abs(x) <= 1));
  }
});

test("a cluster is named by its most specific mechanism when several are shared by as many pairs", () => {
  // The CLN seed's shape: every pair shares the family-wide process (weight 0.15); inside each
  // cluster the pairs also share the process that sets the group apart.
  const item = (id: string, label: string, weight: number): SharedItem => ({ id, label, type: "Mechanism", weight, edges: [`e-${id}`], kind: "observed" });
  const fam = item("PW:FAM", "Lysosomal lipofuscin accumulation", 0.15);
  const enzyme = item("PW:ENZ", "Soluble lysosomal enzyme missing", 1);
  const membrane = item("PW:MEM", "Membrane protein missing", 0.5575);
  const grades: PairGrade[] = [
    grade("C1", "C2", "moderate", 0.83, { mechanism: [enzyme, fam] }),
    grade("C3", "C7", "strong", 0.85, { mechanism: [membrane, fam] }),
    grade("C3", "C6", "moderate", 0.54, { mechanism: [membrane, fam] }),
    grade("C6", "C7", "moderate", 0.54, { mechanism: [membrane, fam] }),
    grade("C1", "C3", "exploratory", 0.34, { mechanism: [fam], grant: [shared("R1", "Grant", ["e-R1-C1", "e-R1-C3"])] }),
  ];
  const result = analyze({ diseases: ["C1", "C2", "C3", "C6", "C7"], grades, isUmbrella: () => false });
  assert.deepEqual(
    result.clusters.map((c) => [c.id, c.label, c.members, c.color_slot]),
    [
      ["c-PW_MEM", "Membrane protein missing", ["C3", "C6", "C7"], 1],
      ["c-PW_ENZ", "Soluble lysosomal enzyme missing", ["C1", "C2"], 2],
    ],
  );
  assert.deepEqual(result.bridges.map((b) => [b.a, b.b, b.cross_cluster]), [["C1", "C3", true]]);
});

test("a strong or moderate link across clusters marks both diseases as bridges", () => {
  const grades = [
    ...clique(["A1", "A2", "A3", "A4"], 1).map((l) => grade(l.a, l.b, "strong", 0.9)),
    ...clique(["B1", "B2", "B3", "B4"], 1).map((l) => grade(l.a, l.b, "strong", 0.9)),
    grade("A4", "B1", "moderate", 0.46),
  ];
  const diseases = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"];
  const result = analyze({ diseases, grades, isUmbrella: () => false });
  assert.equal(result.clusters.length, 2);
  assert.deepEqual([...result.bridgeNodes].sort(), ["A4", "B1"]);
});
