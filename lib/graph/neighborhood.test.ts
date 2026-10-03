import test from "node:test";
import assert from "node:assert/strict";
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "./types.ts";
import type { Dimension, DimensionResult, PairGrade, RelevanceDoc, SharedItem } from "../grading/types.ts";
import { DIMENSIONS, DIMENSION_FAMILY } from "../grading/types.ts";
import { applyThreshold, bubbleId, buildNeighborhood, relevanceHistogram } from "./neighborhood.ts";

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
  const studies = hood.nodes.find((x) => x.id === bubbleId("D2", "Trial"))!;
  assert.equal(studies.relevance, 0.82);
});

test("research and variants start folded; expanding shows the members", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  assert.equal(hood.nodes.find((x) => x.id === bubbleId("D1", "Trial"))!.label, "2 clinical studies");
  assert.equal(hood.nodes.find((x) => x.id === bubbleId("G1", "Variant"))!.owner, "G1");
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

test("contradicted edges never put a node on the map", () => {
  assert.ok(!buildNeighborhood(graph, relevance, "D1").nodes.some((x) => x.id === "D4"));
});

test("threshold: shown, faint ghosts just below, hidden further down", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const at80 = applyThreshold(hood, 0.8);
  const shown = new Set(at80.nodes.map((x) => x.id));
  const ghosts = new Set(at80.ghosts.map((x) => x.id));
  assert.ok(shown.has("D2") && !shown.has("D3"));
  assert.ok(shown.has("HP:0000001") && !shown.has("HP:0000002"));
  assert.ok(ghosts.has("HP:0000017") || ghosts.size > 0, "something just below 80% stays as a ghost");
  assert.ok(!ghosts.has("D3"), "30% is far below the ghost band");
  assert.deepEqual(at80.closestHidden, { id: "D3", relevance: 0.3 });
  assert.ok(at80.edges.every((e) => shown.has(e.a) && shown.has(e.b) && e.relevance >= 0.8 - 1e-9));

  const all = applyThreshold(hood, 0);
  assert.equal(all.shown, all.total);
  assert.ok(all.shown > at80.shown, "lowering the bar shows more");
  assert.equal(relevanceHistogram(hood).reduce((s, x) => s + x, 0), all.total);

  const direct = applyThreshold(hood, 1, new Set(), 0);
  assert.ok(direct.nodes.every((x) => x.relevance === 1), "100% keeps only direct facts");
});

test("hiding a type drops what only hangs off it", () => {
  const hood = buildNeighborhood(graph, relevance, "D1");
  const res = applyThreshold(hood, 0, new Set<NodeType>(["Mechanism"]));
  const ids = new Set(res.nodes.map((x) => x.id));
  assert.ok(!ids.has("M1") && !ids.has("O1") && !ids.has("A1"));
  assert.ok(ids.has("D2"), "related diseases stay through their similarity line");
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
