import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mock, test } from "node:test";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import { CLINICAL_THRESHOLDS, MAX_NEIGHBORS } from "./config.ts";
import { buildBundles, bundleEdgeIds, canonicalJson, gradeGraph } from "./grade.ts";
import { DIMENSIONS, TIER_ORDER, pairKey, type HpoReference, type Judgment, type JudgmentsDoc } from "./types.ts";

function node(id: string, type: NodeType, label = id): GraphNode {
  return { id, type, label, source: "test", url: `https://example.org/${id}` };
}

function edge(subject: string, object: string, kind: EdgeKind = "observed"): GraphEdge {
  return {
    id: `e-${subject}-${object}`.replace(/[^A-Za-z0-9_-]/g, "_"),
    type: "related_to",
    subject,
    object,
    source: "test",
    url: `https://example.org/${subject}/${object}`,
    date: "2026-10-03",
    confidence: kind === "observed" ? 1 : 0.5,
    kind,
  };
}

const D = (n: number) => `MONDO:${String(n).padStart(7, "0")}`;

// n diseases caused by one gene, with one shared symptom: every pair is moderate and ties.
function starGraph(n: number): AtlasGraph {
  const diseases = Array.from({ length: n }, (_, i) => D(i + 1));
  return {
    meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
    nodes: [...diseases.map((id) => node(id, "Disease")), node("HGNC:1", "Gene"), node("HP:0000001", "Phenotype")],
    edges: diseases.flatMap((id) => [edge("HGNC:1", id), edge(id, "HP:0000001")]),
  };
}

// D1-D2: a specific mechanism through their genes (observed) and loss-of-function variants on both
// sides, so strong. D1-D3: another specific mechanism, inferred, so one line: capped at moderate.
// D1, D2 and D3 also share a broader mechanism. D4 shares nothing. A grant ties D2 and D3.
function smallGraph(): AtlasGraph {
  const lof = (gene: string, k: number) => node(`CLINVAR:${gene}${k}`, "Variant", `NM_1(${gene}):c.${10 * k}del (p.Leu${k}fs)`);
  return {
    meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
    nodes: [
      ...[1, 2, 3, 4].map((n) => node(D(n), "Disease", `disease ${n}`)),
      node("HGNC:1", "Gene", "GENEA"),
      node("HGNC:2", "Gene", "GENEB"),
      lof("GENEA", 1),
      lof("GENEA", 2),
      lof("GENEB", 1),
      lof("GENEB", 2),
      node("PW:1", "Mechanism", "Soluble lysosomal enzyme missing"),
      node("PW:2", "Mechanism", "Lysosomal storage"),
      node("PW:3", "Mechanism", "Transport across the lysosomal membrane"),
      node("HP:0000002", "Phenotype", "Rare sign"),
      node("HP:0000003", "Phenotype", "Other sign"),
      node("reporter:R1", "Grant", "Shared grant"),
    ],
    edges: [
      edge("HGNC:1", D(1)),
      edge("HGNC:2", D(2)),
      edge("CLINVAR:GENEA1", "HGNC:1"),
      edge("CLINVAR:GENEA2", "HGNC:1"),
      edge("CLINVAR:GENEB1", "HGNC:2"),
      edge("CLINVAR:GENEB2", "HGNC:2"),
      edge("HGNC:1", "PW:1"),
      edge("HGNC:2", "PW:1"),
      edge(D(1), "PW:2", "inferred"),
      edge(D(2), "PW:2", "inferred"),
      edge(D(3), "PW:2", "inferred"),
      edge(D(1), "PW:3", "inferred"),
      edge(D(3), "PW:3", "inferred"),
      edge(D(1), "HP:0000002"),
      edge(D(2), "HP:0000002"),
      edge(D(4), "HP:0000003"),
      edge("reporter:R1", D(2), "inferred"),
      edge("reporter:R1", D(3), "inferred"),
    ],
  };
}

function judgment(a: string, b: string, verdict: Judgment["verdict"], cited: string[], extra: Partial<Judgment> = {}): Judgment {
  return { a, b, dimension: "overall", verdict, confidence: "high", rationale: "test", cited_edges: cited, caveats: [], runs: 3, agreement: 1, ...extra };
}

function judgmentsDoc(judgments: Judgment[]): JudgmentsDoc {
  return {
    meta: {
      generated_at: "2026-10-03T00:00:00Z",
      workflow: "test",
      prompt_version: "1",
      models: {},
      engine_version: "0.2.0",
      bundles_hash: "0".repeat(64),
    },
    judgments,
  };
}

test("gradeGraph is deterministic", () => {
  const graph = smallGraph();
  const first = JSON.stringify(gradeGraph(graph, null));
  assert.equal(JSON.stringify(gradeGraph(graph, null)), first);
  // Node and edge order in the input do not matter either.
  const shuffled: AtlasGraph = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
  assert.equal(JSON.stringify(gradeGraph(shuffled, null)), first);
});

test("the document: neighbors, look-alikes, output pairs, meta", () => {
  const doc = gradeGraph(smallGraph(), null);
  assert.equal(doc.meta.version, "0.2.0");
  assert.equal(doc.meta.method, "deterministic-baseline");
  assert.equal(doc.meta.ic_source, "uniform");
  assert.equal(doc.meta.reference, undefined);
  assert.equal(doc.meta.symptom_scale, undefined);
  assert.deepEqual(doc.meta.clinical_thresholds, CLINICAL_THRESHOLDS);
  assert.equal(doc.meta.generated_at, "2026-10-03T00:00:00Z");
  assert.deepEqual(Object.keys(doc.diseases), [D(1), D(2), D(3), D(4)]);
  assert.deepEqual(
    doc.diseases[D(1)].neighbors.map((n) => [n.id, n.tier, n.relevance]),
    [
      [D(2), "strong", 0.85],
      [D(3), "moderate", 0.8],
    ],
  );
  const d12 = doc.pairs.find((p) => p.a === D(1) && p.b === D(2));
  assert.equal(d12?.tier_reason, "Strong: both are missing a soluble lysosomal enzyme, and both carry mostly loss-of-function variants.");
  assert.equal(doc.pairs.find((p) => p.a === D(1) && p.b === D(3))?.tier_reason.startsWith("Capped at moderate: only one line"), true);
  // Without a reference symptoms are raw overlap: D1 and D2 have the same single symptom.
  assert.deepEqual(doc.diseases[D(1)].clinical_neighbors.map((n) => [n.id, n.clinical]), [[D(2), 0.75]]);
  assert.equal(d12?.clinical_tier, "very_similar");
  assert.deepEqual(doc.diseases[D(4)].neighbors, []);
  assert.deepEqual(doc.diseases[D(4)].clinical_neighbors, []);
  assert.equal(doc.diseases[D(4)].cluster, null);
  assert.equal(doc.diseases[D(4)].centrality, 0);
  assert.deepEqual(
    doc.pairs.map((p) => [p.a, p.b]),
    [
      [D(1), D(2)],
      [D(1), D(3)],
      [D(2), D(3)],
    ],
  );
  assert.deepEqual(doc.bridges.map((b) => [b.a, b.b, b.reason]), [[D(2), D(3), "Same research grant"]]);
  assert.match(doc.meta.notes[0], /^Graded 3 of 6 disease pairs/);
  // Mechanisms get their weight in this atlas even without an HPO reference.
  assert.deepEqual(doc.node_info, {
    "PW:1": { specificity: 1, diseases: 2 },
    "PW:2": { specificity: Number(((1 - Math.log(3) / Math.log(4)) / (1 - Math.log(2) / Math.log(4))).toFixed(4)), diseases: 3 },
    "PW:3": { specificity: 1, diseases: 2 },
  });
});

test("at most MAX_NEIGHBORS neighbors and look-alikes; the rest are counted in hidden", () => {
  const doc = gradeGraph(starGraph(MAX_NEIGHBORS + 2), null);
  const first = doc.diseases[D(1)];
  assert.equal(first.neighbors.length, MAX_NEIGHBORS);
  assert.equal(first.clinical_neighbors.length, MAX_NEIGHBORS);
  assert.equal(first.hidden, 1);
  assert.ok(first.neighbors.every((n) => n.tier === "moderate" && n.relevance === 0.7));
  // Ties break by id, so the last two diseases list neither other: that pair is left out.
  const listed = new Set(doc.pairs.map((p) => pairKey(p.a, p.b)));
  const n = MAX_NEIGHBORS + 2;
  assert.equal(listed.size, (n * (n - 1)) / 2 - 1);
  assert.ok(!listed.has(pairKey(D(n - 1), D(n))));
});

test("judgments: applied only with valid citations for a graded pair, and they never raise a tier", () => {
  const graph = smallGraph();
  const baseline = gradeGraph(graph, null);
  const strongPair = baseline.pairs.find((p) => p.a === D(1) && p.b === D(2));
  assert.equal(strongPair?.tier, "strong");
  const evidence = bundleEdgeIds(strongPair!.dimensions);
  assert.ok(evidence.includes("e-HGNC_1-PW_1"));

  const warn = mock.method(console, "warn", () => {});
  try {
    const doc = gradeGraph(
      graph,
      null,
      judgmentsDoc([
        judgment(D(2), D(1), "weakens", ["e-HGNC_1-PW_1"], { caveats: ["needs_expert_review"] }),
        judgment(D(1), D(3), "contradicts", ["e-not-in-the-bundle"]),
        judgment(D(1), D(4), "contradicts", []),
      ]),
    );
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /Ignored 2 AI judgments: 1 cites edges outside the pair's evidence, 1 names a pair/);
    assert.equal(doc.meta.method, "agent-judged");
    const lowered = doc.pairs.find((p) => p.a === D(1) && p.b === D(2));
    assert.equal(lowered?.tier, "moderate");
    assert.ok(lowered?.flags.includes("needs_expert_review"));
    assert.deepEqual(lowered?.judgments.map((j) => [j.a, j.b, j.verdict]), [[D(1), D(2), "weakens"]]);
    assert.equal(doc.pairs.find((p) => p.a === D(1) && p.b === D(3))?.tier, "moderate"); // bad citation: ignored
    assert.ok(doc.meta.notes.some((note) => note.startsWith("AI review: applied 1 of 3 judgments")));

    // Whatever the verdict, no pair ends above its baseline tier.
    for (const verdict of ["supports", "weakens", "contradicts", "insufficient"] as const) {
      const judged = gradeGraph(graph, null, judgmentsDoc(baseline.pairs.map((p) => judgment(p.a, p.b, verdict, []))));
      for (const pair of judged.pairs) {
        const before = baseline.pairs.find((p) => p.a === pair.a && p.b === pair.b);
        assert.ok(before && TIER_ORDER[pair.tier] <= TIER_ORDER[before.tier]);
      }
    }
  } finally {
    warn.mock.restore();
  }
});

test("bundles carry every edge and node the evidence references, keys sorted", () => {
  const graph = smallGraph();
  const doc = gradeGraph(graph, null);
  const bundles = buildBundles(graph, null, doc);
  assert.deepEqual(bundles.map((b) => [b.a, b.b]), doc.pairs.map((p) => [p.a, p.b]));
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  for (const bundle of bundles) {
    assert.deepEqual(Object.keys(bundle.dimensions), [...DIMENSIONS]);
    assert.deepEqual(Object.keys(bundle.edges), [...Object.keys(bundle.edges)].sort());
    assert.deepEqual(Object.keys(bundle.nodes), [...Object.keys(bundle.nodes)].sort());
    for (const dimension of DIMENSIONS) {
      for (const item of bundle.dimensions[dimension].shared) {
        assert.ok(bundle.nodes[item.id], item.id);
        for (const id of item.edges) {
          const e = bundle.edges[id];
          assert.ok(e && edgeIds.has(id), id);
          assert.ok(bundle.nodes[e.subject] && bundle.nodes[e.object]);
        }
      }
    }
  }
  const first = bundles[0];
  assert.deepEqual(first.labels, { a: "disease 1", b: "disease 2" });
  assert.deepEqual(Object.keys(first.edges["e-HGNC_1-PW_1"]), ["id", "type", "subject", "object", "source", "url", "kind", "confidence"]);
  assert.deepEqual(first.nodes["PW:1"], { id: "PW:1", type: "Mechanism", label: "Soluble lysosomal enzyme missing", url: "https://example.org/PW:1" });
});

test("canonicalJson sorts keys at every level and ignores formatting", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { f: null, e: "x" }], c: true } }), '{"a":{"c":true,"d":[3,{"e":"x","f":null}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: [undefined] }), '{"b":[null]}');
  assert.equal(canonicalJson(JSON.parse(JSON.stringify({ z: 1, y: [2] }, null, 2))), canonicalJson({ y: [2], z: 1 }));
});

test("with a reference: node_info for symptoms and mechanisms, the symptom scale in meta", () => {
  const graph = smallGraph();
  const reference: HpoReference = {
    meta: {
      hpo_version: "test",
      annotations_version: "test",
      n_diseases: 100,
      ic_formula: "test",
      sources: [],
      null: { pairs: 10, seed: 1, mean: 0.1, quantiles: [{ p: 0, value: 0 }, { p: 0.99, value: 0.2 }, { p: 1, value: 1 }] },
      same_disease: { pairs: 7, quantiles: [{ p: 0, value: 0.1 }, { p: 0.5, value: 0.4 }, { p: 1, value: 0.9 }] },
    },
    terms: {
      "HP:0000002": { label: "Rare sign", ic: 0.81234, specificity: 0.9, ancestors: [], aspect: "P" },
      "HP:0000003": { label: "Onset", ic: 0.2, ancestors: [], aspect: "C" },
    },
  };
  const doc = gradeGraph(graph, reference);
  assert.deepEqual(doc.node_info?.["HP:0000002"], { ic: 0.8123, specificity: 0.9, aspect: "P" });
  assert.deepEqual(doc.node_info?.["HP:0000003"], { ic: 0.2, aspect: "C" });
  assert.deepEqual(doc.node_info?.["PW:1"], { specificity: 1, diseases: 2 });
  assert.deepEqual(doc.meta.reference, { hpo_version: "test", n_diseases: 100, null_pairs: 10 });
  assert.deepEqual(doc.meta.symptom_scale, { floor: 0.2, top: 0.4, same_disease_pairs: 7 });
  assert.equal(doc.meta.ic_source, "hpo-annotations");
});

// ---- end to end on the seed sample (written by scripts/seed-to-graph.ts) ------------------------

const SAMPLE = "public/graph.sample.json";
const REFERENCE = "data/reference/hpo-reference.json";

test("end to end on public/graph.sample.json", { skip: !existsSync(SAMPLE) && "public/graph.sample.json not built yet" }, () => {
  const graph = JSON.parse(readFileSync(SAMPLE, "utf8")) as AtlasGraph;
  const reference = existsSync(REFERENCE) ? (JSON.parse(readFileSync(REFERENCE, "utf8")) as HpoReference) : null;
  const doc = gradeGraph(graph, reference);
  assert.equal(JSON.stringify(gradeGraph(graph, reference)), JSON.stringify(doc));

  const byLabel = new Map(graph.nodes.filter((n) => n.type === "Disease").map((n) => [n.synonyms?.[0] ?? n.label, n.id]));
  const cln = (name: string) => byLabel.get(name) ?? assert.fail(`missing ${name}`);
  const [cln1, cln2, cln3, cln6, cln7] = ["CLN1", "CLN2", "CLN3", "CLN6", "CLN7"].map(cln);
  assert.equal(Object.keys(doc.diseases).length, 5);
  const pairOf = (a: string, b: string) => doc.pairs.find((p) => pairKey(p.a, p.b) === pairKey(a, b)) ?? assert.fail(`no pair ${a} ${b}`);

  // Five neuronal ceroid lipofuscinoses: different genes; every pair shares the family-wide
  // process, which alone says nothing about which subtype is closer.
  assert.equal(doc.pairs.length, 10);
  for (const pair of doc.pairs) {
    assert.equal(pair.dimensions.gene.status, "none");
    assert.notEqual(pair.dimensions.mechanism.status, "unknown");
    assert.ok(pair.dimensions.mechanism.shared.some((item) => item.id === "PW:NCL-LYSOSOME"));
    // Patient groups and the registry hang off the family-wide mechanism: umbrella resources.
    assert.ok(pair.dimensions.patient_org.flags.includes("umbrella_resource"));
    assert.ok(pair.dimensions.asset.flags.includes("umbrella_resource"));
    assert.equal(pair.relevance, pair.biology);
  }
  // Soluble enzymes (CLN1, CLN2) and membrane proteins (CLN3, CLN6, CLN7) form the two clusters.
  assert.deepEqual(
    doc.clusters.map((c) => [c.label, c.members, c.color_slot]),
    [
      ["Membrane protein missing", [cln3, cln6, cln7].sort(), 1],
      ["Soluble lysosomal enzyme missing", [cln1, cln2].sort(), 2],
    ],
  );
  assert.equal(pairOf(cln3, cln7).tier, "strong");
  assert.equal(pairOf(cln1, cln2).dimensions.mechanism.details?.most_specific, "PW:NCL-SOLUBLE-ENZYME");
  for (const [a, b] of [[cln1, cln3], [cln1, cln6], [cln1, cln7], [cln2, cln3], [cln2, cln6], [cln2, cln7]]) {
    assert.ok(pairOf(a, b).dimensions.mechanism.flags.includes("family_level_only"), `${a} ${b}`);
  }

  // One NIH grant (U54HD122210, PI Erika Augustine) covers CLN2, CLN3 and CLN6: across clusters
  // for CLN2, inside the membrane cluster for CLN3-CLN6.
  const funded = [cln2, cln3, cln6];
  const expected = funded.flatMap((a, i) => funded.slice(i + 1).map((b) => pairKey(a, b))).sort();
  assert.deepEqual(doc.bridges.map((b) => pairKey(b.a, b.b)).sort(), expected);
  for (const bridge of doc.bridges) {
    assert.equal(bridge.reason, "Same research grant and same researcher");
    assert.equal(bridge.cross_cluster, bridge.a === cln2 || bridge.b === cln2);
  }

  const bundles = buildBundles(graph, reference, doc);
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  for (const bundle of bundles) for (const id of Object.keys(bundle.edges)) assert.ok(edgeIds.has(id), id);

  if (reference) {
    for (const pair of doc.pairs) {
      assert.notEqual(pair.dimensions.phenotype.status, "unknown");
      assert.notEqual(pair.dimensions.disease.status, "unknown"); // curated onset and inheritance
      assert.ok(pair.clinical > 0);
    }
    // The onsets of CLN2 and CLN7 are disputed between sources; every pair involving them says so.
    for (const pair of doc.pairs) {
      const disputed = [pair.a, pair.b].some((id) => id === cln2 || id === cln7);
      assert.equal(pair.flags.includes("sources_disagree"), disputed, `${pair.a} ${pair.b}`);
    }
    assert.ok(doc.meta.symptom_scale && doc.meta.symptom_scale.same_disease_pairs > 0);
    assert.equal(doc.node_info?.["PW:NCL-LYSOSOME"]?.diseases, 5);
    assert.equal(doc.node_info?.["HP:0000007"]?.aspect, "I");
  }
});
