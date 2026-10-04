import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph, NodeType } from "../../../lib/graph/types.ts";
import type { RelevanceDoc } from "../../../lib/grading/types.ts";
import { applyThreshold, buildNeighborhood, type HoodEdge, type HoodNode } from "../../../lib/graph/neighborhood.ts";
import { formatPercent } from "../format.ts";
import { MAP_KINDS, kindCounts, kindHidden, onlyKind, toggleKind } from "../kinds.ts";
import { mapNodeRadius } from "../mapSizes.ts";
import { defaultThreshold } from "../urlState.ts";
import { LABEL_BUDGET, labelPlan, topRelatedIds } from "./labelBudget.ts";
import { LINE_WIDTH, lineStyle, lineTier } from "./lineStyle.ts";
import { universeLayout } from "./universe.ts";
import { mapLines } from "./mapName.ts";
import { dataSources } from "./sources.ts";

const cutoffs = { strong: 0.75, moderate: 0.45, exploratory: 0.2 };

test("percents round down everywhere, so none crosses its tier line", () => {
  assert.equal(formatPercent(0.629), "62%");
  assert.equal(formatPercent(0.449), "44%");
  assert.equal(formatPercent(0.45), "45%");
  assert.equal(formatPercent(0.996), "99.6%");
  assert.equal(formatPercent(1), "100%");
});

test("line width follows the grade file's tier cutoffs, never above the pair's own grade", () => {
  assert.equal(lineTier(0.8, cutoffs), "strong");
  assert.equal(lineTier(0.63, cutoffs), "moderate");
  assert.equal(lineTier(0.41, cutoffs), "exploratory");
  assert.equal(lineTier(0.1, cutoffs), "under");
  assert.equal(lineTier(0.8, cutoffs, "moderate"), "moderate", "a strong score without two lines of evidence stays moderate");
  assert.equal(lineTier(0.5, { strong: 0.9, moderate: 0.6, exploratory: 0.3 }), "exploratory", "other cutoffs, other tiers");
  assert.ok(LINE_WIDTH.strong > LINE_WIDTH.moderate && LINE_WIDTH.moderate > LINE_WIDTH.exploratory && LINE_WIDTH.exploratory > LINE_WIDTH.under);
  const line = (strength: number, extra: Partial<HoodEdge> = {}): HoodEdge => ({ id: "x", a: "A", b: "B", strength, relevance: strength, kind: "observed", role: "similarity", group: "biology", label: "", edgeIds: [], ...extra });
  assert.equal(lineStyle(line(0.63), cutoffs).width, 2.5);
  assert.equal(lineStyle(line(0.63), cutoffs, true).width, 0.75, "under the filter: thin and faint");
  assert.equal(lineStyle(line(0.8), cutoffs).glow, true);
  assert.equal(lineStyle(line(0.63, { kind: "inferred" }), cutoffs).dash !== undefined, true, "dashed = inferred");
  assert.ok(lineStyle(line(1, { role: "evidence", group: "gene" }), cutoffs).width < LINE_WIDTH.exploratory, "evidence lines stay thin");
});

const hoodNode = (id: string, role: HoodNode["role"], type: HoodNode["type"], relevance: number, extra: Partial<HoodNode> = {}): HoodNode => ({
  id,
  type,
  label: id,
  relevance,
  role,
  owner: "F",
  ownerRank: 0,
  hop: 1,
  why: "",
  kind: "observed",
  ...extra,
});

test("the label budget: the center, the five most related, then key items, never more than 14", () => {
  const nodes: HoodNode[] = [
    hoodNode("F", "focus", "Disease", 1),
    ...Array.from({ length: 8 }, (_, i) => hoodNode(`R${i}`, "related", "Disease", 0.7 - i * 0.05, { ownerRank: i + 1, owner: `R${i}` })),
    hoodNode("G", "attribute", "Gene", 1),
    ...Array.from({ length: 4 }, (_, i) => hoodNode(`G${i}`, "attribute", "Gene", 0.6, { owner: `R${i}` })),
    ...Array.from({ length: 5 }, (_, i) => hoodNode(`S${i}`, "symptom", "Phenotype", 0.9 - i * 0.1)),
    hoodNode("S-other", "symptom", "Phenotype", 0.95, { owner: "R0" }),
    ...Array.from({ length: 4 }, (_, i) => hoodNode(`M${i}`, "attribute", "Mechanism", 0.95 - i * 0.01)),
    ...Array.from({ length: 3 }, (_, i) => hoodNode(`O${i}`, "group", "PatientOrg", 1 - i * 0.01)),
    hoodNode("papers", "bubble", "Bubble", 1, { bubbleType: "Paper", members: ["p1", "p2"] }),
  ];
  const plan = labelPlan(nodes);
  assert.equal(plan.length, LABEL_BUDGET);
  assert.deepEqual(plan.slice(0, 6), ["F", "R0", "R1", "R2", "R3", "R4"]);
  assert.ok(!plan.includes("R5"), "lower-ranked related diseases are dots, named on hover");
  assert.ok(plan.includes("G") && plan.includes("S0") && plan.includes("S2") && !plan.includes("S3"));
  assert.ok(!plan.includes("S-other"), "a related disease's symptom is never named as if it were the center's");
  assert.ok(plan.includes("O0") && plan.includes("O1") && !plan.includes("O2"), "caregivers see patient groups before pathways");
  const researcher = labelPlan(nodes, "researcher");
  assert.ok(researcher.includes("M0") && researcher.includes("M1"), "researchers see pathways first");
  assert.deepEqual([...topRelatedIds(nodes)], ["R0", "R1", "R2", "R3", "R4"]);
});

test("Tay-Sachs, achondrogenesis and Gaucher I open with at most 14 names and their top five related", () => {
  const graph: AtlasGraph = JSON.parse(readFileSync(new URL("../../../public/graph.json", import.meta.url), "utf8"));
  const relevance: RelevanceDoc = JSON.parse(readFileSync(new URL("../../../public/relevance.json", import.meta.url), "utf8"));
  for (const id of ["MONDO:0010100", "MONDO:0008702", "MONDO:0009265"]) {
    const hood = buildNeighborhood(graph, relevance, id);
    const shown = applyThreshold(hood, defaultThreshold(hood.related));
    const plan = labelPlan(shown.nodes);
    assert.ok(plan.length <= LABEL_BUDGET, `${id}: ${plan.length} labels`);
    assert.equal(plan[0], id);
    const top = [...topRelatedIds(shown.nodes)];
    assert.equal(top.length, Math.min(5, hood.related.length));
    // The same five, in the same order, as the panel's "Most related diseases" (the grading
    // layer's order), even when scores tie (achondrogenesis: ten at 70%).
    assert.deepEqual(top, relevance.diseases[id].neighbors.slice(0, 5).map((n) => n.id), `${id}: top five as in the panel`);
    for (const t of top) assert.ok(plan.includes(t), `${id}: ${t} named`);
    assert.ok(shown.nodes.some((n) => n.type === "Phenotype" || n.bubbleType === "Phenotype") || !hood.nodes.some((n) => n.type === "Phenotype"), `${id}: symptoms survive the filter`);
    // The emphasis: the five most related are drawn larger than every other related disease.
    const radius = (n: HoodNode) => mapNodeRadius(n, relevance.diseases[n.id]?.centrality ?? 0);
    const related = hood.nodes.filter((n) => n.role === "related");
    const smallestTop = Math.min(...related.filter((n) => n.ownerRank <= 5).map(radius));
    for (const n of related.filter((x) => x.ownerRank > 5)) assert.ok(radius(n) < smallestTop);
  }
});

test("kind chips: toggle, only, counts per kind; the address keeps type names", () => {
  const genes = MAP_KINDS.find((k) => k.id === "gene")!;
  const off = toggleKind(new Set(), genes);
  assert.deepEqual([...off].sort(), ["Gene", "Variant"]);
  assert.ok(kindHidden(genes, off));
  assert.equal(toggleKind(off, genes).size, 0);
  const only = onlyKind(MAP_KINDS.find((k) => k.id === "symptom")!);
  assert.ok(!only.has("Phenotype") && only.has("Disease") && only.has("Paper"));
  const counts = kindCounts({ Gene: { shown: 2, total: 3 }, Variant: { shown: 0, total: 5 }, Paper: { shown: 4, total: 4 } } as Partial<Record<NodeType, { shown: number; total: number }>>);
  assert.deepEqual(
    counts.map((c) => [c.kind.id, c.shown, c.total]),
    [
      ["gene", 2, 8],
      ["research", 4, 4],
    ],
  );
});

test("the universe: deterministic, inside the map, nothing under the search card, no cluster on top of another", () => {
  const clusters = [
    { id: "a", members: Array.from({ length: 12 }, (_, i) => `a${i}`), lines: ["COL2A1 · 12"] },
    { id: "b", members: Array.from({ length: 6 }, (_, i) => `b${i}`), lines: ["Formation of the anterior", "neural plate · 6"] },
    { id: "c", members: ["c0", "c1", "c2"], lines: ["BEST1 · 3"] },
  ];
  const stars = Array.from({ length: 40 }, (_, i) => `s${i}`);
  for (const [w, h] of [
    [1092, 801],
    [860, 744],
    [624, 712],
  ]) {
    const card: [number, number, number, number] = [(w - 600) / 2, 24, (w + 600) / 2, 420];
    const one = universeLayout(clusters, stars, w, h, card);
    const two = universeLayout(clusters, stars, w, h, card);
    assert.deepEqual([...one.positions], [...two.positions]);
    assert.equal(one.positions.size, 21 + 40);
    for (const [id, [x, y]] of one.positions) {
      assert.ok(x >= 8 && x <= w - 8 && y >= 8 && y <= h - 8, `${id} inside ${w}x${h}`);
      assert.ok(!(x > card[0] - 4 && x < card[2] + 4 && y > card[1] - 4 && y < card[3] + 4), `${id} under the card at ${w}x${h}`);
    }
    for (let i = 0; i < one.halos.length; i++) {
      for (let j = i + 1; j < one.halos.length; j++) {
        const [p, q] = [one.halos[i], one.halos[j]];
        assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r, `halos ${p.id}/${q.id} overlap at ${w}x${h}`);
      }
    }
    // Stars spread out: no two closer than a few dots apart.
    const pts = stars.map((s) => one.positions.get(s)!);
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) closest = Math.min(closest, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    assert.ok(closest >= 20, `stars ${closest.toFixed(1)}px apart at ${w}x${h}`);
  }
});

test("where the data comes from is counted from the graph's own links, curated sources first", () => {
  const graph: AtlasGraph = JSON.parse(readFileSync(new URL("../../../public/graph.json", import.meta.url), "utf8"));
  const rows = dataSources(graph.edges);
  assert.equal(rows.length, new Set(graph.edges.map((e) => e.source)).size);
  assert.equal(rows.reduce((n, r) => n + r.links, 0), graph.edges.length);
  const firstInferred = rows.findIndex((r) => r.kind !== "observed");
  assert.ok(rows.slice(firstInferred).every((r) => r.kind !== "observed"), "curated sources are listed before searches and name matches");
  const monarch = rows.find((r) => r.source === "Monarch")!;
  assert.equal(monarch.provides, "the gene behind each disease");
  assert.match(monarch.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("map names wrap whole; past the last line they keep their start and their last words", () => {
  assert.deepEqual(mapLines("CATS - The Cure & Action for Tay-Sachs (CATS) Foundation", 26, 3), ["CATS - The Cure &", "Action for Tay-Sachs", "(CATS) Foundation"]);
  const long = mapLines("Association of TriC/CCT with target proteins during biosynthesis and folding of many things", 26, 3);
  assert.equal(long.length, 3);
  assert.ok(long[0].startsWith("Association"));
  assert.match(long[2], /^… .*folding of many things$/);
  for (const line of long) assert.ok(line.length <= 26, line);
  assert.deepEqual(mapLines("HEXA", 26, 3), ["HEXA"]);
});
