import test from "node:test";
import assert from "node:assert/strict";
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "./types.ts";
import type { Dimension, DimensionResult, PairGrade, RelevanceDoc, SharedItem } from "../grading/types.ts";
import { DIMENSIONS, DIMENSION_FAMILY } from "../grading/types.ts";
import { nextSteps } from "./nextStep.ts";

const node = (id: string, type: NodeType, label = id, attributes?: Record<string, unknown>): GraphNode => ({
  id,
  type,
  label,
  source: "test",
  url: `https://example.org/${id}`,
  ...(attributes ? { attributes } : {}),
});
const edge = (id: string, subject: string, type: string, object: string, kind: GraphEdge["kind"] = "observed", evidence?: string): GraphEdge => ({
  id,
  type,
  subject,
  object,
  source: "test",
  url: "https://example.org",
  date: "2026-10-03",
  confidence: kind === "observed" ? 1 : 0.5,
  kind,
  ...(evidence ? { evidence } : {}),
});

const graph: AtlasGraph = {
  meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
  nodes: [
    node("D1", "Disease", "disease one"),
    node("D2", "Disease", "disease two"),
    node("D3", "Disease", "disease three"),
    node("M1", "Mechanism", "shared process"),
    node("A1", "Asset", "the registry"),
    node("O1", "PatientOrg", "the family group", { country: "Norway", website: "https://example.org/o1" }),
    node("O2", "PatientOrg", "another group"),
    node("R1", "Grant", "a grant covering both"),
    node("I1", "Investigator", "Ada Researcher"),
    node("T1", "Trial", "an open study", { overall_status: "RECRUITING" }),
    node("T2", "Trial", "a closed study", { overall_status: "COMPLETED" }),
  ],
  edges: [
    edge("e1", "D1", "disrupts_process", "M1", "inferred"),
    edge("e2", "D2", "disrupts_process", "M1", "inferred"),
    edge("e3", "A1", "registers", "M1", "inferred", "Name match in the directory, not a disease-specific certification."),
    edge("e4", "O1", "works_on", "M1", "inferred"),
    edge("e5", "O2", "works_on", "M1", "inferred"),
    edge("e6", "R1", "funds", "D1", "inferred"),
    edge("e7", "R1", "funds", "D2", "inferred"),
    edge("e8", "I1", "investigates", "R1"),
    edge("e9", "T1", "studies", "D1", "inferred"),
    edge("e10", "T2", "studies", "D1", "inferred"),
  ],
};

const item = (id: string, type: NodeType, edges: string[], extra: Partial<SharedItem> = {}): SharedItem => ({
  id,
  label: id,
  type,
  weight: 1,
  edges,
  kind: "inferred",
  ...extra,
});

function dim(d: Dimension, shared: SharedItem[] = []): DimensionResult {
  return {
    dimension: d,
    family: DIMENSION_FAMILY[d],
    score: shared.length ? 1 : 0,
    status: shared.length ? "match" : "none",
    coverage: { a: 1, b: 1 },
    shared,
    support: null,
    summary: "",
    flags: [],
  };
}

function pair(a: string, b: string, shared: Partial<Record<Dimension, SharedItem[]>>): PairGrade {
  const dimensions = Object.fromEntries(DIMENSIONS.map((d) => [d, dim(d, shared[d])])) as Record<Dimension, DimensionResult>;
  return { a, b, biology: 0.85, clinical: 0.6, collaboration: 0.7, relevance: 0.85, tier: "strong", tier_reason: "", clinical_tier: "similar", clinical_reason: "", support: "observed", lines_of_evidence: [], dimensions, flags: [], judgments: [] };
}

const relevance = {
  meta: {} as RelevanceDoc["meta"],
  clusters: [],
  diseases: {
    D1: { id: "D1", cluster: "c", centrality: 1, bridge: false, coords3d: [0, 0, 0], neighbors: [{ id: "D2", tier: "strong", relevance: 0.85, clinical: 0.6, collaboration: 0.7 }], hidden: 0, clinical_neighbors: [] },
  },
  pairs: [
    pair("D1", "D2", {
      mechanism: [item("M1", "Mechanism", ["e1", "e2"])],
      grant: [item("R1", "Grant", ["e6", "e7"])],
      investigator: [item("I1", "Investigator", ["e6", "e7", "e8"], { via: "R1" })],
      patient_org: [item("O1", "PatientOrg", ["e4"], { via: "M1" }), item("O2", "PatientOrg", ["e5"], { via: "M1" })],
    }),
  ],
  bridges: [{ a: "D1", b: "D2", cross_cluster: false, reason: "Same researcher and Same research grant", dimensions: ["investigator", "grant"], edges: ["e6", "e7", "e8"] }],
} as unknown as RelevanceDoc;

test("a researcher already working on both diseases comes first", () => {
  const steps = nextSteps(graph, relevance, "D1");
  assert.equal(steps[0].kind, "contact");
  assert.equal(steps[0].target?.id, "I1");
  assert.match(steps[0].text, /Contact Ada Researcher, who already works on both/);
  assert.deepEqual(steps[0].edgeIds, ["e6", "e7", "e8"]);
});

test("then the registry and a group on the shared mechanism, with the evidence caveat", () => {
  const steps = nextSteps(graph, relevance, "D1", null, 4);
  assert.deepEqual(steps.map((s) => s.kind), ["contact", "registry", "group", "study"]);
  assert.equal(steps[1].target?.id, "A1");
  assert.equal(steps[1].caveat, "Name match in the directory, not a disease-specific certification.");
  assert.equal(steps[1].evidence, "inferred");
  assert.equal(steps[2].target?.id, "O1", "a group with a website is preferred");
  assert.match(steps[2].text, /\(Norway\)/);
  assert.equal(steps[3].target?.id, "T1", "only open studies are suggested");
});

test("umbrella groups are never presented as a pair-specific contact", () => {
  const steps = nextSteps(graph, relevance, "D1", null, 10);
  const contacts = steps.filter((s) => s.kind === "contact").map((s) => s.target?.id);
  assert.ok(!contacts.includes("O1") && !contacts.includes("O2"));
});

test("no support means an honest gap with the question to ask next", () => {
  const steps = nextSteps(graph, relevance, "D3");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "gap");
  assert.match(steps[0].because, /Next question: which verified group already runs a registry/);
  assert.equal(steps[0].evidence, null);
});

test("deterministic and limited", () => {
  assert.equal(JSON.stringify(nextSteps(graph, relevance, "D1")), JSON.stringify(nextSteps(graph, relevance, "D1")));
  assert.equal(nextSteps(graph, relevance, "D1", null, 2).length, 2);
});
