import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mock, test } from "node:test";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import { CAPS, CLINICAL_THRESHOLDS, MAX_NEIGHBORS, MIN_ANNOTATIONS } from "./config.ts";
import { buildContext, isUmbrella, scoreDimensions, umbrellaCutoff } from "./dimensions.ts";
import { buildBundles, bundleEdgeIds, canonicalJson, gradeGraph } from "./grade.ts";
import {
  COLLABORATION_DIMENSIONS,
  DIMENSIONS,
  TIER_ORDER,
  pairKey,
  type HpoReference,
  type Judgment,
  type JudgmentsDoc,
} from "./types.ts";

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
// D1, D2 and D3 also share a mechanism every disease with a mechanism has, so it says nothing on its
// own. D4 shares nothing. A grant ties D2 and D3, which share no other biology.
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
  assert.equal(
    d12?.tier_reason,
    "Strong: both are missing a soluble lysosomal enzyme (2 of the 3 diseases with a mechanism on record), the most specific of 2 shared mechanisms, and both carry mostly loss-of-function variants.",
  );
  assert.equal(doc.pairs.find((p) => p.a === D(1) && p.b === D(3))?.tier_reason.startsWith("Capped at moderate: only one line"), true);
  // Without a reference symptoms are raw overlap: D1 and D2 have the same single symptom, a full
  // overlap from one symptom on each side, so the tier is capped while the score stays.
  assert.deepEqual(doc.diseases[D(1)].clinical_neighbors.map((n) => [n.id, n.clinical]), [[D(2), 0.75]]);
  assert.equal(d12?.clinical_tier, "somewhat");
  assert.match(d12?.clinical_reason ?? "", /^Capped at looks somewhat similar: few symptoms are on record for disease 1 \(1\) and disease 2 \(1\), and they share only one identical symptom\./);
  assert.deepEqual(doc.diseases[D(4)].neighbors, []);
  assert.deepEqual(doc.diseases[D(4)].clinical_neighbors, []);
  assert.equal(doc.diseases[D(4)].cluster, null);
  assert.equal(doc.diseases[D(4)].centrality, 0);
  // D2-D3 share only the grant and a mechanism all three diseases with one have: not on the map,
  // so the pair is left out of `pairs` and the bridge alone carries the shared grant.
  assert.deepEqual(doc.diseases[D(2)].neighbors.map((n) => n.id), [D(1)]);
  assert.deepEqual(
    doc.pairs.map((p) => [p.a, p.b]),
    [
      [D(1), D(2)],
      [D(1), D(3)],
    ],
  );
  assert.deepEqual(doc.bridges.map((b) => [b.a, b.b, b.reason, b.edges]), [
    [D(2), D(3), "Same research grant", ["e-reporter_R1-MONDO_0000002", "e-reporter_R1-MONDO_0000003"]],
  ]);
  assert.match(doc.meta.notes[0], /^Graded 3 of 6 disease pairs/);
  assert.ok(doc.meta.notes.includes("Pairs listed: every pair in a disease's biology neighbors or clinical look-alikes; 1 research bridge between diseases outside those lists is in bridges only."));
  assert.ok(doc.meta.notes.some((note) => note.startsWith("Mechanism specificity within this atlas") && note.includes("(N = 3 of 4 here)")));
  assert.ok(doc.meta.notes.some((note) => note.startsWith("Settings (lib/grading/config.ts")));
  // Mechanisms get their weight in this atlas even without an HPO reference. PW:2 reaches all three
  // diseases that have a mechanism on record (D4 has none), so it sits at the floor.
  assert.deepEqual(doc.node_info, {
    "PW:1": { specificity: 1, diseases: 2 },
    "PW:2": { specificity: 0.15, diseases: 3 },
    "PW:3": { specificity: 1, diseases: 2 },
  });
});

// Two diseases of one gene whose three variants are recorded for the gene, and whose mechanism comes
// with the gene: one fact, so never strong. With variants of their own that agree, a second line.
function oneGeneGraph(ownVariants: boolean): AtlasGraph {
  const lof = (id: string, k: number) => node(id, "Variant", `NM_1(GENEA):c.${10 * k}del (p.Leu${k}fs)`);
  return {
    meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
    nodes: [
      node(D(1), "Disease", "disease 1"),
      node(D(2), "Disease", "disease 2"),
      node("HGNC:1", "Gene", "GENEA"),
      ...[1, 2, 3].map((k) => lof(`CLINVAR:${k}`, k)),
      ...(ownVariants ? [4, 5, 6, 7].map((k) => lof(`CLINVAR:${k}`, k)) : []),
      node("PW:1", "Mechanism", "Soluble lysosomal enzyme missing"),
    ],
    edges: [
      edge("HGNC:1", D(1)),
      edge("HGNC:1", D(2)),
      ...[1, 2, 3].map((k) => edge(`CLINVAR:${k}`, "HGNC:1")),
      ...(ownVariants ? [edge("CLINVAR:4", D(1)), edge("CLINVAR:5", D(1)), edge("CLINVAR:6", D(2)), edge("CLINVAR:7", D(2))] : []),
      edge("HGNC:1", "PW:1"),
    ],
  };
}

test("two diseases on one gene with three variants are not strong: the gene is one line, not three", () => {
  const pair = gradeGraph(oneGeneGraph(false), null).pairs[0];
  assert.equal(pair.dimensions.gene.status, "match");
  assert.equal(pair.dimensions.variant.status, "unknown");
  assert.ok(pair.dimensions.variant.flags.includes("variant_effect_unknown"));
  assert.equal(pair.dimensions.mechanism.details?.through_shared_gene, true);
  assert.equal(pair.dimensions.mechanism.status, "unknown");
  assert.equal(pair.biology, 0.7);
  assert.equal(pair.tier, "moderate");
  assert.deepEqual(pair.lines_of_evidence, ["gene"]);
  assert.equal(
    pair.tier_reason,
    "Moderate: both are caused by the same gene (GENEA); the variants on record belong to the gene, not to either disease, so whether both break it the same way is unknown.",
  );

  const own = gradeGraph(oneGeneGraph(true), null).pairs[0];
  assert.equal(own.dimensions.variant.status, "match");
  assert.equal(own.dimensions.variant.details?.gene_level_variants, 3);
  assert.equal(own.tier_reason, "Strong: both are caused by the same gene (GENEA), and both carry mostly loss-of-function variants.");
  assert.equal(own.tier, "strong");
  assert.deepEqual(own.lines_of_evidence, ["gene", "variant"]);
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

// ---- end to end on the atlas (public/graph.json, written by scripts/seed-to-graph.ts) ----------
// Rules, not counts: the committed outputs are checked byte for byte by npm run grade:check.

const ATLAS = "public/graph.json";
const REFERENCE = "data/reference/hpo-reference.json";

test("end to end on public/graph.json", { skip: !existsSync(ATLAS) && "public/graph.json not built yet: npm run data:graph" }, () => {
  const graph = JSON.parse(readFileSync(ATLAS, "utf8")) as AtlasGraph;
  const reference = existsSync(REFERENCE) ? (JSON.parse(readFileSync(REFERENCE, "utf8")) as HpoReference) : null;
  const doc = gradeGraph(graph, reference);
  assert.equal(JSON.stringify(gradeGraph(graph, reference)), JSON.stringify(doc));

  const diseases = graph.nodes.filter((n) => n.type === "Disease").map((n) => n.id);
  assert.deepEqual(Object.keys(doc.diseases).sort(), [...diseases].sort());
  for (const id of diseases) {
    const entry = doc.diseases[id];
    assert.ok(entry.neighbors.length <= MAX_NEIGHBORS && entry.clinical_neighbors.length <= MAX_NEIGHBORS);
    assert.ok(entry.neighbors.every((n) => n.tier !== "none"));
  }

  // One shared gene is one line of evidence. Variants hang off the gene and so do its pathways, so
  // two diseases of one gene see one variant list and one set of mechanisms: neither may count again.
  const allelic = doc.pairs.filter((p) => p.dimensions.gene.status === "match");
  assert.ok(allelic.length > 0, "the atlas has diseases of one gene");
  for (const p of allelic) {
    const name = `${p.a} ${p.b}`;
    assert.deepEqual(p.lines_of_evidence, ["gene"], name);
    assert.equal(p.dimensions.variant.status, "unknown", name);
    assert.ok(p.dimensions.variant.flags.includes("variant_effect_unknown"), name);
    if (p.dimensions.mechanism.shared.length) {
      assert.equal(p.dimensions.mechanism.details?.through_shared_gene, true, name);
      assert.equal(p.dimensions.mechanism.status, "unknown", name);
    }
    assert.equal(p.biology, CAPS.gene, name);
    assert.equal(p.tier, "moderate", name);
    assert.match(p.tier_reason, /; the variants on record belong to the gene, not to either disease, so whether both break it the same way is unknown\.$/, name);
  }

  // Variants stand for a disease only when no other disease here has its gene: a pair with such a
  // gene on either side never compares variant types, and a variant line that disagrees never counts.
  const graphGenes = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (diseases.includes(e.object) && graph.nodes.find((n) => n.id === e.subject)?.type === "Gene") {
      graphGenes.set(e.object, [...(graphGenes.get(e.object) ?? []), e.subject]);
    }
  }
  const diseasesOfGene = new Map<string, number>();
  for (const genes of graphGenes.values()) for (const g of genes) diseasesOfGene.set(g, (diseasesOfGene.get(g) ?? 0) + 1);
  const shared = (id: string) => (graphGenes.get(id) ?? []).some((g) => (diseasesOfGene.get(g) ?? 0) > 1);
  for (const p of doc.pairs) {
    if (shared(p.a) || shared(p.b)) assert.equal(p.dimensions.variant.status, "unknown", `${p.a} ${p.b}`);
    if (p.tier_reason.includes("variant types") || p.tier_reason.includes("carry mostly")) {
      assert.ok(["match", "partial"].includes(p.dimensions.variant.status), `${p.a} ${p.b}`);
    }
  }

  // Look-alikes run by clinical tier, and a thin record that shares at most one symptom is never
  // more than "somewhat similar".
  const pairOf = new Map(doc.pairs.map((p) => [pairKey(p.a, p.b), p]));
  const order = { very_similar: 3, similar: 2, somewhat: 1, different: 0 };
  for (const id of diseases) {
    const tiers = doc.diseases[id].clinical_neighbors.map((n) => order[pairOf.get(pairKey(id, n.id))?.clinical_tier ?? "different"]);
    assert.deepEqual(tiers, [...tiers].sort((x, y) => y - x), id);
  }
  for (const p of doc.pairs) {
    const d = p.dimensions.phenotype.details;
    const thin = Math.min(Number(d?.terms_a ?? 0), Number(d?.terms_b ?? 0)) < MIN_ANNOTATIONS;
    if (p.dimensions.phenotype.status !== "unknown" && thin && Number(d?.shared_exact ?? 0) <= 1) {
      assert.ok(order[p.clinical_tier] <= order.somewhat, `${p.a} ${p.b} ${p.clinical_tier}`);
    }
  }

  // Mechanisms are Reactome pathways linked from genes; specificity counts the diseases that have one.
  const mechanisms = graph.nodes.filter((n) => n.type === "Mechanism");
  assert.ok(mechanisms.length > 0, "no mechanism layer: run npm run data:reactome && npm run data:graph");
  for (const m of mechanisms) {
    assert.match(m.id, /^REACT:R-HSA-\d+$/);
    assert.equal(typeof m.attributes?.gene_count, "number");
    assert.ok(doc.node_info?.[m.id]?.diseases !== undefined, m.id);
  }

  // Umbrella resources (listed for more than max(UMBRELLA_MIN, UMBRELLA_SHARE x N) diseases) are
  // flagged and never bridge; every bridge rests on items below the cutoff, and only on those.
  const ctx = buildContext(graph, reference);
  const cutoff = umbrellaCutoff(diseases.length);
  for (const bridge of doc.bridges) {
    const dims = scoreDimensions(ctx, bridge.a, bridge.b);
    const specific = COLLABORATION_DIMENSIONS.filter((d) => dims[d].shared.some((item) => !isUmbrella(ctx, d, item.id)));
    assert.ok(specific.length > 0, `${bridge.a} ${bridge.b}`);
    assert.deepEqual([...bridge.dimensions].sort(), [...specific].sort(), `${bridge.a} ${bridge.b}`);
    for (const id of bridge.edges) {
      const edge = graph.edges.find((e) => e.id === id);
      assert.ok(edge, id);
      const item = [edge.subject, edge.object].find((end) => !diseases.includes(end)) ?? "";
      assert.ok(COLLABORATION_DIMENSIONS.every((d) => !isUmbrella(ctx, d, item)), `${id} ties a bridge to an umbrella item`);
    }
  }
  for (const p of doc.pairs) {
    for (const d of COLLABORATION_DIMENSIONS) {
      const umbrella = p.dimensions[d].shared.filter((item) => (ctx.linkedDiseases[d].get(item.id) ?? 0) > cutoff);
      assert.equal(p.dimensions[d].flags.includes("umbrella_resource"), umbrella.length > 0, `${p.a} ${p.b} ${d}`);
    }
  }

  const bundles = buildBundles(graph, reference, doc);
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  for (const bundle of bundles) for (const id of Object.keys(bundle.edges)) assert.ok(edgeIds.has(id), id);
});
