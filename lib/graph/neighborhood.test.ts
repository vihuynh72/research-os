import test from "node:test";
import assert from "node:assert/strict";
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "./types.ts";
import type { Dimension, DimensionResult, PairGrade, RelevanceDoc, SharedItem } from "../grading/types.ts";
import { DIMENSIONS, DIMENSION_FAMILY } from "../grading/types.ts";
import { HOOD, MAP_CAP, applyThreshold, bubbleId, buildNeighborhood, linkGroupOf, relevanceHistogram } from "./neighborhood.ts";

const node = (id: string, type: NodeType, label = id, attributes?: Record<string, unknown>): GraphNode => ({
  id,
  type,
  label,
  source: "test",
  url: `https://example.org/${id}`,
  ...(attributes ? { attributes } : {}),
});
let n = 0;
const edge = (subject: string, type: string, object: string, kind: GraphEdge["kind"] = "observed"): GraphEdge => ({
  id: `e${++n}`,
  type,
  subject,
  object,
  source: "test",
  url: "https://example.org",
  date: "2026-10-03",
  confidence: kind === "observed" ? 1 : 0.6,
  kind,
});

const symptoms = Array.from({ length: 10 }, (_, i) => `HP:${String(i + 10).padStart(7, "0")}`);
const graph: AtlasGraph = {
  meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
  nodes: [
    node("D1", "Disease", "disease one"),
    node("D2", "Disease", "disease two"),
    node("D3", "Disease", "disease three"),
    node("D4", "Disease", "disease four"),
    node("G1", "Gene"),
    node("G2", "Gene"),
    node("V1", "Variant"),
    node("V2", "Variant"),
    node("M1", "Mechanism", "shared process"),
    node("HP:0000001", "Phenotype", "rare sign"),
    node("HP:0000002", "Phenotype", "common sign"),
    node("HP:0000003", "Phenotype", "autosomal recessive inheritance"),
    ...symptoms.map((id) => node(id, "Phenotype", `sign ${id}`)),
    node("O1", "PatientOrg", "family group", { website: "https://example.org/o1" }),
    node("A1", "Asset", "registry"),
    node("T1", "Trial"),
    node("T2", "Trial"),
    node("T3", "Trial", "a study of disease two"),
    node("R1", "Grant", "shared grant"),
    node("I1", "Investigator", "a researcher"),
  ],
  edges: [
    edge("G1", "causes", "D1"),
    edge("G2", "causes", "D2"),
    edge("V1", "variant_of", "G1"),
    edge("V2", "variant_of", "G1"),
    edge("D1", "disrupts_process", "M1", "inferred"),
    edge("D2", "disrupts_process", "M1", "inferred"),
    edge("D1", "has_phenotype", "HP:0000001"),
    edge("D2", "has_phenotype", "HP:0000001"),
    edge("D1", "has_phenotype", "HP:0000002"),
    edge("D1", "has_phenotype", "HP:0000003"),
    ...symptoms.map((id) => edge("D1", "has_phenotype", id)),
    edge("O1", "works_on", "M1", "inferred"),
    edge("A1", "registers", "M1", "inferred"),
    edge("T1", "studies", "D1", "inferred"),
    edge("T2", "studies", "D1", "inferred"),
    edge("T3", "studies", "D2", "inferred"),
    edge("R1", "funds", "D1", "inferred"),
    edge("R1", "funds", "D2", "inferred"),
    edge("I1", "investigates", "R1"),
    edge("D1", "has_phenotype", "D4", "contradicted"),
  ],
};
const edgeId = (subject: string, object: string) => graph.edges.find((e) => e.subject === subject && e.object === object)!.id;

function dim(dimension: Dimension, shared: SharedItem[] = []): DimensionResult {
  return {
    dimension,
    family: DIMENSION_FAMILY[dimension],
    score: shared.length ? 1 : 0,
    status: shared.length ? "match" : "none",
    coverage: { a: 1, b: 1 },
    shared,
    support: shared.length ? "observed" : null,
    summary: "",
    flags: [],
  };
}

function pair(a: string, b: string, biology: number, tier: PairGrade["tier"], shared: Partial<Record<Dimension, SharedItem[]>>): PairGrade {
  const dimensions = Object.fromEntries(DIMENSIONS.map((d) => [d, dim(d, shared[d])])) as Record<Dimension, DimensionResult>;
  return {
    a,
    b,
    biology,
    clinical: 0.5,
    collaboration: 0,
    relevance: biology,
    tier,
    tier_reason: "test reason",
    clinical_tier: "similar",
    clinical_reason: "test",
    support: "observed",
    lines_of_evidence: [],
    dimensions,
    flags: [],
    judgments: [],
  };
}

const item = (id: string, type: NodeType, edges: string[], extra: Partial<SharedItem> = {}): SharedItem => ({ id, label: id, type, weight: 1, edges, kind: "observed", ...extra });
const entry = (id: string, neighbors: { id: string; tier: PairGrade["tier"]; relevance: number }[]) => ({
  id,
  cluster: "c-1",
  centrality: 1,
  bridge: false,
  coords3d: [0, 0, 0],
  neighbors: neighbors.map((x) => ({ ...x, clinical: 0.5, collaboration: 0 })),
  hidden: 0,
  clinical_neighbors: [],
});

const relevance = {
  meta: {} as RelevanceDoc["meta"],
  clusters: [],
  diseases: {
    D1: entry("D1", [
      { id: "D2", tier: "strong", relevance: 0.82 },
      { id: "D3", tier: "exploratory", relevance: 0.3 },
    ]),
    D2: entry("D2", [{ id: "D1", tier: "strong", relevance: 0.82 }]),
  },
  pairs: [
    pair("D1", "D2", 0.82, "strong", {
      mechanism: [item("M1", "Mechanism", [edgeId("D1", "M1"), edgeId("D2", "M1")], { kind: "inferred" })],
      phenotype: [item("HP:0000001", "Phenotype", [edgeId("D1", "HP:0000001"), edgeId("D2", "HP:0000001")])],
    }),
    pair("D1", "D3", 0.3, "exploratory", {}),
  ],
  bridges: [{ a: "D1", b: "D2", cross_cluster: false, reason: "Same research grant", dimensions: ["grant"], edges: [edgeId("R1", "D1"), edgeId("R1", "D2")] }],
  node_info: {
    "HP:0000001": { ic: 0.6, specificity: 0.9, aspect: "P" },
    "HP:0000002": { ic: 0.1, specificity: 0.2, aspect: "P" },
    "HP:0000003": { ic: 0.4, aspect: "I" },
    ...Object.fromEntries(symptoms.map((id, i) => [id, { ic: 0.5, specificity: 0.5 + i * 0.01, aspect: "P" as const }])),
  },
} as unknown as RelevanceDoc;

test("a disease focus: related diseases from the grading layer and the lines between them", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  assert.equal(hood.nodes[0].id, "D1");
  assert.equal(hood.nodes[0].role, "focus");
  assert.deepEqual(hood.anchors, ["D1"]);
  const d2 = hood.nodes.find((x) => x.id === "D2")!;
  assert.equal(d2.role, "related");
  assert.equal(d2.relevance, 0.82);
  const sim = hood.edges.find((e) => e.role === "similarity" && e.b === "D2")!;
  assert.equal(sim.strength, 0.82);
  assert.ok(hood.edges.some((e) => e.role === "bridge" && e.label === "Same research grant"));
});

test("symptoms carry their specificity; context terms are left out; extras fold", () => {
  const hood = buildNeighborhood(graph, relevance, "D1", { maxSymptoms: 4 });
  const rare = hood.nodes.find((x) => x.id === "HP:0000001")!;
  assert.equal(rare.relevance, 0.9);
  assert.ok(!hood.nodes.some((x) => x.id === "HP:0000003"), "inheritance is not a symptom");
  assert.equal(hood.nodes.filter((x) => x.type === "Phenotype").length, 4);
  const bubble = hood.nodes.find((x) => x.id === bubbleId("D1", "Phenotype"))!;
  assert.equal(bubble.members!.length, 8);
  assert.equal(bubble.label, "8 more symptoms");
});

test("shared evidence draws a line from every disease that has it, with its strength", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const shared = hood.edges.find((e) => e.a === "D2" && e.b === "HP:0000001")!;
  assert.equal(shared.strength, 0.9);
  assert.equal(shared.relevance, round(0.82 * 0.9));
  assert.ok(hood.edges.some((e) => e.a === "D2" && e.b === "M1"), "the related disease joins the shared mechanism");
});

test("indirect evidence: a related disease brings its own gene and research, scaled by its relevance", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const g2 = hood.nodes.find((x) => x.id === "G2")!;
  assert.equal(g2.relevance, 0.82);
  assert.equal(g2.owner, "D2");
  assert.match(g2.why, /Through disease two, 82% related/);
  const studies = hood.nodes.find((x) => x.id === bubbleId("D1", "Trial"))!;
  assert.deepEqual(studies.memberOwners, ["D1", "D1", "D2"], "one bubble per kind gathers the related disease's study too");
  assert.equal(studies.memberRelevance![2], 0.82);
});

test("research and variants start folded; expanding shows the members", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  assert.equal(hood.nodes.find((x) => x.id === bubbleId("D1", "Trial"))!.label, "3 clinical studies");
  assert.equal(hood.nodes.find((x) => x.id === bubbleId("D1", "Variant"))!.owner, "G1", "gene changes hang off their gene");
  const open = buildNeighborhood(graph, relevance, "D1", { expanded: new Set([bubbleId("D1", "Trial")]) });
  assert.ok(open.nodes.some((x) => x.id === "T1") && open.nodes.some((x) => x.id === "T2"));
});

test("groups reached through a mechanism are one step removed", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const org = hood.nodes.find((x) => x.id === "O1")!;
  assert.equal(org.relevance, 0.9);
  assert.ok(hood.edges.some((e) => e.a === "M1" && e.b === "O1" && e.role === "evidence"));
});

test("any node can be the focus: a gene maps its disease, then that disease's neighbors", () => {
  const hood = buildNeighborhood(graph, relevance, "G1");
  assert.equal(hood.focusType, "Gene");
  assert.deepEqual(hood.anchors, ["D1"]);
  assert.equal(hood.nodes.find((x) => x.id === "D1")!.role, "anchor");
  assert.equal(hood.nodes.find((x) => x.id === "D2")!.relevance, 0.82);
  assert.ok(hood.edges.some((e) => e.a === "G1" && e.b === "D1"));
});

test("a symptom focus maps every disease that has it", () => {
  const hood = buildNeighborhood(graph, relevance, "HP:0000001");
  assert.deepEqual(hood.anchors, ["D1", "D2"]);
  assert.ok(hood.edges.some((e) => e.role === "similarity" && e.a === "D1" && e.b === "D2"));
});

test("a group focus reaches diseases through its mechanism, one step removed", () => {
  const hood = buildNeighborhood(graph, relevance, "O1");
  assert.deepEqual(hood.anchors, ["D1", "D2"]);
  assert.equal(hood.nodes.find((x) => x.id === "D1")!.relevance, 0.9);
  assert.ok(hood.nodes.some((x) => x.id === "M1"));
});

test("each line is named after the farther-out thing it reaches", () => {
  assert.equal(linkGroupOf("Disease", "Gene"), "gene");
  assert.equal(linkGroupOf("Gene", "Mechanism"), "pathway");
  assert.equal(linkGroupOf("Mechanism", "PatientOrg"), "group");
  assert.equal(linkGroupOf("Grant", "Investigator"), "research");
  assert.equal(linkGroupOf("Disease", "Disease"), "biology");
  const hood = buildNeighborhood(graph, relevance, "D1");
  assert.equal(hood.edges.find((e) => e.a === "D1" && e.b === "G1")!.group, "gene");
  assert.equal(hood.edges.find((e) => e.role === "bridge")!.group, "bridge");
});

test("contradicted edges never put a node on the map", () => {
  assert.ok(!buildNeighborhood(graph, relevance, "D1").nodes.some((x) => x.id === "D4"));
});

test("threshold: the bar picks the diseases, faint ghosts just below, hidden further down", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const at80 = applyThreshold(hood, 0.8);
  const shown = new Set(at80.nodes.map((x) => x.id));
  assert.ok(shown.has("D2") && !shown.has("D3"));
  assert.ok(shown.has("HP:0000001"));
  assert.equal(at80.ghosts.length, 0, "30% is far below the ghost band");
  assert.deepEqual(at80.closestHidden, { id: "D3", relevance: 0.3 });
  assert.ok(at80.edges.every((e) => shown.has(e.a) && shown.has(e.b)));

  const at85 = applyThreshold(hood, 0.85);
  assert.deepEqual(at85.ghosts.map((x) => x.id), ["D2"], "82% stays as a ghost under an 85% bar");
  assert.ok(at85.faintEdges.every((e) => e.role === "similarity"), "only the ghost's biology line is drawn, faintly");

  const all = applyThreshold(hood, 0);
  assert.equal(all.shown, all.total);
  assert.ok(all.shown > at80.shown, "lowering the bar shows more");
  assert.equal(relevanceHistogram(hood).reduce((s, x) => s + x, 0), hood.related.length, "the histogram counts the related diseases the bar filters");

  const direct = applyThreshold(hood, 1, new Set(), 0);
  assert.equal(direct.relatedShown, 0, "100% keeps only what you searched and its own facts");
  assert.ok(!direct.nodes.some((x) => x.id === "G2"));
});

test("everything but diseases follows the disease that brings it, whatever its own relevance", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  // The searched disease's rarest symptoms stay at any bar: they are what a parent recognizes.
  for (const bar of [0.3, 0.8, 0.95]) {
    const ids = new Set(applyThreshold(hood, bar).nodes.map((x) => x.id));
    assert.ok(ids.has("HP:0000001") && ids.has(bubbleId("D1", "Phenotype")), `symptoms at ${bar}`);
  }
  // A related disease's own gene comes and goes with it.
  assert.ok(applyThreshold(hood, 0.8).nodes.some((x) => x.id === "G2"));
  assert.ok(!applyThreshold(hood, 0.85).nodes.some((x) => x.id === "G2"));
});

test("the Links menu hides a kind of line and whatever only that line held", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const noSymptoms = applyThreshold(hood, 0, new Set(), HOOD.ghostBand, new Set(["symptom"]));
  assert.ok(!noSymptoms.nodes.some((x) => x.type === "Phenotype" || x.bubbleType === "Phenotype"));
  assert.ok(noSymptoms.edges.every((e) => e.group !== "symptom"));
  // D3 shares nothing but a biology score: without biology lines it would float, so it goes.
  const noBiology = applyThreshold(hood, 0, new Set(), HOOD.ghostBand, new Set(["biology"]));
  assert.ok(applyThreshold(hood, 0).nodes.some((x) => x.id === "D3"));
  assert.ok(!noBiology.nodes.some((x) => x.id === "D3"));
  assert.ok(noBiology.nodes.some((x) => x.id === "D2"), "D2 still shares a pathway and a symptom on the map");
  assert.equal(hood.edges.find((e) => e.role === "similarity")!.tier, "strong");
});

test("hiding a type hides only that type: what hangs off it stays", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const res = applyThreshold(hood, 0, new Set<NodeType>(["Mechanism"]));
  const ids = new Set(res.nodes.map((x) => x.id));
  assert.ok(!ids.has("M1"));
  assert.ok(ids.has("O1") && ids.has("A1"), "groups reached through the hidden mechanism are still counted and shown");
  assert.ok(ids.has("D2"), "related diseases stay through their similarity line");
  assert.ok(res.edges.every((e) => ids.has(e.a) && ids.has(e.b)), "no line runs to a hidden node");

  // "Only genes": every gene that passes the bar, the related disease's too.
  const onlyGenes = applyThreshold(hood, 0.8, new Set<NodeType>(["Disease", "Variant", "Mechanism", "Phenotype", "PatientOrg", "Asset", "Trial", "Paper", "Grant", "Investigator"]));
  assert.deepEqual(onlyGenes.byType.Gene, applyThreshold(hood, 0.8).byType.Gene);
  assert.ok(onlyGenes.nodes.some((x) => x.id === "G2"), "D2's gene stays although D2 is hidden");
  assert.equal(onlyGenes.relatedShown, 0);
  assert.deepEqual(onlyGenes.closestHidden, { id: "D3", relevance: 0.3 }, "D2 is hidden by type, not under the bar, so it is never offered");
});

test("deterministic, and works without a grading layer", () => {
  assert.equal(JSON.stringify(buildNeighborhood(graph, relevance, "D1")), JSON.stringify(buildNeighborhood(graph, relevance, "D1")));
  const bare = buildNeighborhood(graph, null, "D1");
  assert.equal(bare.related.length, 0);
  assert.equal(bare.nodes.find((x) => x.id === "HP:0000001")!.relevance, 0.5);
});

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// A crowded neighborhood: one gene behind 15 diseases, each with its own symptoms and papers, and a
// disease related to five others that each have their own papers.
function crowdedGraph(): { graph: AtlasGraph; relevance: RelevanceDoc } {
  let k = 0;
  const e = (subject: string, type: string, object: string): GraphEdge => ({ id: `c${++k}`, type, subject, object, source: "test", url: "https://example.org", date: "2026-10-03", confidence: 1, kind: "observed" });
  const nodes: GraphNode[] = [node("GX", "Gene", "GENEX"), node("MX", "Mechanism", "process x")];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 15; i++) {
    nodes.push(node(`A${i}`, "Disease", `anchor ${i}`));
    edges.push(e("GX", "causes", `A${i}`));
    for (let j = 0; j < 4; j++) {
      nodes.push(node(`HP:A${i}${j}`, "Phenotype", `sign ${i}.${j}`));
      edges.push(e(`A${i}`, "has_phenotype", `HP:A${i}${j}`));
    }
  }
  nodes.push(node("F", "Disease", "focus disease"));
  for (let i = 0; i < 5; i++) {
    nodes.push(node(`R${i}`, "Disease", `related ${i}`));
    for (let j = 0; j < 3; j++) {
      nodes.push(node(`P${i}${j}`, "Paper", `paper ${i}.${j}`));
      edges.push(e(`P${i}${j}`, "about", `R${i}`));
    }
  }
  const diseases: Record<string, unknown> = {};
  for (const n of nodes.filter((x) => x.type === "Disease")) diseases[n.id] = entry(n.id, []);
  for (let i = 0; i < 15; i++) (diseases[`A${i}`] as { centrality: number }).centrality = i / 15;
  diseases.F = entry("F", Array.from({ length: 5 }, (_, i) => ({ id: `R${i}`, tier: "moderate" as const, relevance: 0.7 - i * 0.01 })));
  const pairs = Array.from({ length: 5 }, (_, i) => pair("F", `R${i}`, 0.7 - i * 0.01, "moderate", {}));
  const rel = { meta: {} as RelevanceDoc["meta"], clusters: [], diseases, pairs, bridges: [], node_info: {} } as unknown as RelevanceDoc;
  return { graph: { meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" }, nodes, edges }, relevance: rel };
}

test("a gene behind many diseases maps the best connected and folds the rest into one bubble", () => {
  const { graph: g, relevance: r } = crowdedGraph();
  const hood = buildNeighborhood(g, r, "GX");
  assert.equal(hood.anchors.length, 15, "every disease the gene is behind is still an anchor (the panel lists them all)");
  const mapped = hood.nodes.filter((x) => x.role === "anchor");
  assert.equal(mapped.length, HOOD.maxAnchors);
  const bubble = hood.nodes.find((x) => x.id === bubbleId("GX", "Disease"))!;
  assert.equal(bubble.label, "3 more diseases");
  assert.deepEqual([...bubble.members!].sort(), ["A0", "A1", "A2"], "the least connected fold first");
  assert.ok(hood.edges.some((x) => x.role === "bubble" && x.a === "GX" && x.b === bubble.id));
  // Symptoms of all those diseases: at most MAP_CAP single nodes, the rest in one numbered bubble.
  assert.ok(hood.nodes.filter((x) => x.type === "Phenotype").length <= MAP_CAP.Phenotype!);
  const folded = hood.nodes.filter((x) => x.role === "bubble" && x.bubbleType === "Phenotype");
  assert.equal(folded.length, 1, "one bubble per kind, never one per disease");
  assert.equal(folded[0].id, bubbleId("GX", "Phenotype"));
  assert.match(folded[0].label, /^\d+ more symptoms$/);
  const open = buildNeighborhood(g, r, "GX", { expanded: new Set([bubbleId("GX", "Disease")]) });
  assert.equal(open.nodes.filter((x) => x.role === "anchor").length, 15, "opening the bubble maps every disease");
});

test("research of many related diseases shares one bubble per kind, counted at the filter", () => {
  const { graph: g, relevance: r } = crowdedGraph();
  const hood = buildNeighborhood(g, r, "F");
  const papers = hood.nodes.filter((x) => x.role === "bubble" && x.bubbleType === "Paper");
  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, bubbleId("F", "Paper"));
  assert.equal(papers[0].label, "15 papers");
  assert.equal(papers[0].relevance, 0.7, "a shared bubble sits at its best member's relevance");
  assert.equal(hood.edges.filter((x) => x.role === "bubble" && x.b === papers[0].id).length, 5, "a line from each disease it gathers papers from");
  // At 69% only R0 (70%) and R1 (69%) are on the map: the bubble holds their 6 papers.
  const at69 = applyThreshold(hood, 0.69);
  assert.equal(at69.bubbleCount[papers[0].id], 6);
  // The bubble's name and reason say what it holds at this filter, and whose the papers are.
  const shownPapers = at69.nodes.find((x) => x.id === papers[0].id)!;
  assert.equal(shownPapers.label, "6 papers");
  assert.equal(shownPapers.why, "6 papers linked to 2 related diseases on this map. Open to see each one.");
  assert.deepEqual(at69.byType.Paper, { shown: 6, total: 15 });
  assert.equal(hood.nodes.find((x) => x.id === bubbleId("D2", "Trial")), undefined);
  assert.ok(buildNeighborhood(graph, relevance, "D1").nodes.some((x) => x.id === bubbleId("D1", "Trial")));
});

test("percents in the map's reasons round down, like everywhere else", () => {
  const r2 = structuredClone(relevance);
  r2.diseases.D1.neighbors[0].relevance = 0.629;
  const g2 = buildNeighborhood(graph, r2, "D1").nodes.find((x) => x.id === "G2")!;
  assert.match(g2.why, /62% related/);
});
