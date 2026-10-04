import assert from "node:assert/strict";
import { test } from "node:test";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import { MECHANISM_FLOOR, SYMPTOM_TOP_FALLBACK } from "./config.ts";
import {
  atlasSpecificity,
  buildContext,
  candidatePairs,
  collaborationWeight,
  isUmbrella,
  lofKind,
  mechanismPhrase,
  mechanismWeight,
  percentileOf,
  percentText,
  quantileValue,
  scoreDimensions,
  scoreFloor,
  sharedMechanismClause,
  symptomScale,
  symptomScore,
  umbrellaCutoff,
} from "./dimensions.ts";
import { biologyScore, clinicalScore } from "./synthesize.ts";
import { COLLABORATION_DIMENSIONS, pairKey, type HpoReference, type HpoTerm } from "./types.ts";

function node(id: string, type: NodeType, label = id, attributes?: Record<string, unknown>, synonyms?: string[]): GraphNode {
  return {
    id,
    type,
    label,
    ...(synonyms ? { synonyms } : {}),
    source: "test",
    url: `https://example.org/${id}`,
    ...(attributes ? { attributes } : {}),
  };
}

function edge(subject: string, object: string, kind: EdgeKind = "observed", evidence?: string): GraphEdge {
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
    ...(evidence ? { evidence } : {}),
  };
}

const term = (label: string, ic: number, aspect: HpoTerm["aspect"], ancestors: string[] = ["HP:0000001", "HP:0000118"]): HpoTerm => ({
  label,
  ic,
  ancestors,
  aspect,
});
const COURSE = ["HP:0000001", "HP:0031797"];

// A small reference: a rare storage sign, common neurological signs, inheritance and the onset
// ladder, one obsolete term with a replacement and one without. Symptom scale: floor 0.3 (p 0.99
// of random pairs), top 0.5 (median of same-disease pairs).
const reference: HpoReference = {
  meta: {
    hpo_version: "test",
    annotations_version: "test",
    n_diseases: 1000,
    ic_formula: "test",
    sources: [],
    null: {
      pairs: 100,
      seed: 1,
      mean: 0.06,
      quantiles: [
        { p: 0, value: 0 },
        { p: 0.5, value: 0.05 },
        { p: 0.9, value: 0.15 },
        { p: 0.95, value: 0.2 },
        { p: 0.99, value: 0.3 },
        { p: 0.999, value: 0.4 },
        { p: 1, value: 0.8 },
      ],
    },
    same_disease: {
      pairs: 50,
      quantiles: [
        { p: 0, value: 0.1 },
        { p: 0.25, value: 0.35 },
        { p: 0.5, value: 0.5 },
        { p: 0.75, value: 0.6 },
        { p: 1, value: 0.9 },
      ],
    },
  },
  terms: {
    "HP:0000001": term("All", 0, "other", []),
    "HP:0000118": term("Phenotypic abnormality", 0, "P", ["HP:0000001"]),
    "HP:0000005": term("Mode of inheritance", 0, "I", ["HP:0000001"]),
    "HP:0000007": term("Autosomal recessive inheritance", 0.05, "I", ["HP:0000001", "HP:0000005"]),
    "HP:0001417": term("X-linked inheritance", 0.3, "I", ["HP:0000001", "HP:0000005"]),
    "HP:0031797": term("Clinical course", 0, "C", ["HP:0000001"]),
    "HP:0003577": term("Congenital onset", 0.2, "C", COURSE),
    "HP:0003623": term("Neonatal onset", 0.3, "C", COURSE),
    "HP:0003593": term("Infantile onset", 0.3, "C", COURSE),
    "HP:0011463": term("Childhood onset", 0.3, "C", COURSE),
    "HP:0003621": term("Juvenile onset", 0.35, "C", COURSE),
    "HP:0003581": term("Adult onset", 0.3, "C", COURSE),
    "HP:0003584": term("Late onset", 0.4, "C", [...COURSE, "HP:0003581"]),
    "HP:0003676": term("Progressive", 0.1, "C", COURSE),
    "HP:0001250": term("Seizure", 0.15, "P"),
    "HP:0001263": term("Global developmental delay", 0.16, "P"),
    "HP:0000252": term("Microcephaly", 0.25, "P"),
    "HP:0000365": term("Hearing impairment", 0.2, "P"),
    "HP:0000505": term("Visual impairment", 0.3, "P"),
    "HP:0002074": term("Increased neuronal autofluorescent lipopigment", 0.75, "P"),
    "HP:0009999": { ...term("obsolete lipopigment", 0.75, "P"), obsolete: true, replaced_by: "HP:0002074" },
    "HP:0009998": { ...term("obsolete, no replacement", 0.5, "P"), obsolete: true },
  },
};

const D = (n: number) => `MONDO:000000${n}`;
const phenotypes: [number, string[]][] = [
  [1, ["HP:0002074", "HP:0001250", "HP:0001263", "HP:0000252", "HP:0000505", "HP:0000007", "HP:0003593"]],
  [2, ["HP:0009999", "HP:0001250", "HP:0001263", "HP:0000252", "HP:0000505", "HP:0000007", "HP:0003621"]],
  [3, ["HP:0001250", "HP:0000365", "HP:0000007"]],
  [4, ["HP:0009998", "HP:0123456"]],
  [5, ["HP:0001250", "HP:0001263"]],
  [6, ["HP:0001250", "HP:0001263"]],
];

const graph: AtlasGraph = {
  meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
  nodes: [
    ...[1, 2, 3, 4, 5, 6].map((n) => node(D(n), "Disease", `test disease ${n}`, undefined, [`DIS${n}`])),
    node("HGNC:1", "Gene", "GENEA"),
    node("HGNC:2", "Gene", "GENEB"),
    node("CLINVAR:1", "Variant", "NM_1.1(GENEA):c.10del (p.Leu4fs)"),
    node("CLINVAR:2", "Variant", "NM_1.1(GENEA):c.20C>T (p.Arg7Ter)"),
    node("CLINVAR:3", "Variant", "NM_2.1(GENEB):c.30A>G (p.Lys10Arg)"),
    node("CLINVAR:4", "Variant", "NM_2.1(GENEB):c.40G>A (p.Gly14Ser)"),
    node("REACT:1", "Mechanism", "Lysosomal storage"),
    node("REACT:2", "Mechanism", "Big pathway", { gene_count: 2000 }),
    ...[...new Set(phenotypes.flatMap(([, ids]) => ids))].map((id) => node(id, "Phenotype", `seed label ${id}`)),
    node("atlas:org-1", "PatientOrg", "Pathway families"),
    node("atlas:org-2", "PatientOrg", "Everyone's alliance"),
    node("atlas:asset-1", "Asset", "GENEA registry"),
    node("clinicaltrials:NCT1", "Trial", "Withdrawn study", { overall_status: "WITHDRAWN" }),
    node("clinicaltrials:NCT2", "Trial", "Open study", { overall_status: "RECRUITING" }),
    node("reporter:R1", "Grant", "Shared grant"),
    node("reporter:pi-1", "Investigator", "Pat Investigator"),
    node("PMID:1", "Paper", "Shared paper"),
    node("PMID:2", "Paper", "Disputed paper"),
  ],
  edges: [
    edge("HGNC:1", D(1)),
    edge("HGNC:1", D(2)),
    edge("HGNC:2", D(3)),
    edge("HGNC:1", D(4), "contradicted"),
    ...["CLINVAR:1", "CLINVAR:2"].map((v) => edge(v, "HGNC:1")),
    ...["CLINVAR:3", "CLINVAR:4"].map((v) => edge(v, "HGNC:2")),
    edge(D(1), "REACT:1", "inferred"),
    edge("HGNC:2", "REACT:1"),
    edge(D(1), "REACT:2"),
    edge(D(2), "REACT:2"),
    ...phenotypes.flatMap(([n, ids]) => ids.map((id) => edge(D(n), id))),
    edge("atlas:org-1", "REACT:2", "inferred"),
    ...[1, 2, 3, 4, 5].map((n) => edge("atlas:org-2", D(n))),
    edge("atlas:asset-1", "HGNC:1", "inferred"),
    edge("clinicaltrials:NCT1", D(1), "inferred"),
    edge("clinicaltrials:NCT1", D(2), "inferred"),
    edge("clinicaltrials:NCT2", D(3), "inferred"),
    edge("reporter:R1", D(2), "inferred"),
    edge("reporter:R1", D(3), "inferred"),
    edge("reporter:pi-1", "reporter:R1"),
    edge("PMID:1", D(5), "inferred"),
    edge("PMID:1", D(6), "inferred"),
    edge("PMID:2", D(5)),
    edge("PMID:2", D(6), "contradicted"),
  ],
};

const ctx = buildContext(graph, reference);
const pair = (a: number, b: number) => scoreDimensions(ctx, D(a), D(b));

test("candidate pairs: only pairs that share something gradable", () => {
  // D4 shares only an umbrella group and a disputed gene, so it is never graded. D3-D5 and D3-D6
  // share a common symptom in their rarest-first prefixes, so they are graded (and score 0).
  const candidates = candidatePairs(ctx);
  assert.deepEqual(candidates, [
    [D(1), D(2)],
    [D(1), D(3)],
    [D(2), D(3)],
    [D(3), D(5)],
    [D(3), D(6)],
    [D(5), D(6)],
  ]);
  assert.equal(pair(3, 5).phenotype.score, 0);
  assert.equal(pair(5, 6).phenotype.score, 1);
});

test("gene: shared gene is a match and flags allelic; a disputed gene never scores", () => {
  const same = pair(1, 2).gene;
  assert.equal(same.status, "match");
  assert.equal(same.score, 1);
  assert.deepEqual(same.shared.map((s) => [s.id, s.edges, s.kind]), [["HGNC:1", ["e-HGNC_1-MONDO_0000001", "e-HGNC_1-MONDO_0000002"], "observed"]]);
  assert.equal(same.support, "observed");
  assert.deepEqual(same.flags, ["same_gene_allelic"]);
  assert.equal(same.summary, "Same gene: GENEA.");

  const different = pair(1, 3).gene;
  assert.equal(different.status, "none");
  assert.equal(different.summary, "Different genes: GENEA for DIS1, GENEB for DIS3.");

  const disputed = pair(1, 4).gene;
  assert.equal(disputed.status, "unknown");
  assert.deepEqual(disputed.coverage, { a: 1, b: 0 });
  assert.deepEqual(disputed.flags, ["contradicted_evidence", "no_data"]);
  assert.equal(disputed.details?.contradicted_edges, "e-HGNC_1-MONDO_0000004");
  assert.equal(disputed.summary, "No gene on record for DIS4.");
});

test("variant: loss-of-function share from notation, with the conflict flag", () => {
  // DIS1 and DIS2 share GENEA, and their only variants are GENEA's: one list seen from two sides,
  // set aside instead of compared with itself.
  const allelic = pair(1, 2).variant;
  assert.equal(allelic.status, "unknown");
  assert.equal(allelic.score, 0);
  assert.deepEqual(allelic.coverage, { a: 2, b: 2 });
  assert.deepEqual(allelic.shared, []);
  assert.deepEqual(allelic.flags, ["variant_effect_unknown"]);
  assert.equal(allelic.details?.gene_level_variants, 2);
  assert.equal(
    allelic.summary,
    "The variants on record are listed for the shared gene GENEA, not for either disease, so variant type cannot tell the two apart.",
  );

  // GENEA has two diseases here, so its variants cannot stand for DIS1 against DIS3 either.
  const geneLevel = pair(1, 3).variant;
  assert.equal(geneLevel.status, "unknown");
  assert.equal(geneLevel.score, 0);
  assert.deepEqual(geneLevel.flags, ["variant_effect_unknown", "derived_from_variant_notation"]);
  assert.equal(geneLevel.details?.gene_level_variants, 2);
  assert.equal(
    geneLevel.summary,
    "Variant type cannot be compared: the variants on record for DIS1 are listed for its gene GENEA, which has 2 diseases here, not for the disease itself.",
  );

  // With GENEA's link to DIS2 removed, each gene has one disease and its variants stand for it.
  const single = buildContext({ ...graph, edges: graph.edges.filter((e) => e.id !== "e-HGNC_1-MONDO_0000002") }, reference);
  const conflict = scoreDimensions(single, D(1), D(3)).variant;
  assert.equal(conflict.score, 0);
  assert.equal(conflict.status, "none");
  assert.deepEqual(conflict.flags, ["variant_type_conflict", "derived_from_variant_notation"]);
  assert.equal(conflict.details?.lof_fraction_a, 1);
  assert.equal(conflict.details?.lof_fraction_b, 0);
  assert.equal(conflict.details?.kind_a, "mostly_lof");
  assert.equal(conflict.details?.kind_b, "mostly_not_lof");
  assert.equal(conflict.details?.gene_level_variants, undefined);
  assert.equal(conflict.summary, "Test records: GENEA mostly loss-of-function (2 of 2 loss-of-function), GENEB mostly missense or in-frame (0 of 2).");

  const none = pair(5, 6).variant;
  assert.equal(none.status, "unknown");
  assert.deepEqual(none.flags, ["variant_effect_unknown", "no_data"]);
});

test("variant: the variants of a gene with several diseases stand for none of them", () => {
  // GENE1 causes A and B, GENE2 causes C and D, each with two loss-of-function variants, and both
  // genes are in one small pathway; E and F (GENE3) are in another. A and C share the pathway. Their
  // genes' records agree, but comparing them would compare the genes, not A and C.
  const lof = (id: string, gene: string, k: number) => ({ ...node(id, "Variant", `NM_7.1(${gene}):c.${k}del (p.Leu${k}fs)`), source: "ClinVar" });
  const g: AtlasGraph = {
    meta: graph.meta,
    nodes: [
      ...["A", "B", "C", "D", "E", "F"].map((x) => node(`MONDO:${x}`, "Disease", x)),
      ...[1, 2, 3].map((k) => node(`HGNC:${k}`, "Gene", `GENE${k}`)),
      lof("CLINVAR:a", "GENE1", 10),
      lof("CLINVAR:b", "GENE1", 20),
      lof("CLINVAR:c", "GENE2", 30),
      lof("CLINVAR:d", "GENE2", 40),
      node("PW:1", "Mechanism", "Small pathway", { gene_count: 5 }),
      node("PW:2", "Mechanism", "Other pathway", { gene_count: 5 }),
    ],
    edges: [
      edge("HGNC:1", "MONDO:A"),
      edge("HGNC:1", "MONDO:B"),
      edge("HGNC:2", "MONDO:C"),
      edge("HGNC:2", "MONDO:D"),
      edge("HGNC:3", "MONDO:E"),
      edge("HGNC:3", "MONDO:F"),
      ...["a", "b"].map((v) => edge(`CLINVAR:${v}`, "HGNC:1")),
      ...["c", "d"].map((v) => edge(`CLINVAR:${v}`, "HGNC:2")),
      edge("HGNC:1", "PW:1"),
      edge("HGNC:2", "PW:1"),
      edge("HGNC:3", "PW:2"),
    ],
  };
  const c = buildContext(g, null);
  const ac = scoreDimensions(c, "MONDO:A", "MONDO:C");
  assert.equal(ac.variant.status, "unknown");
  assert.deepEqual(ac.variant.flags, ["variant_effect_unknown"]);
  assert.equal(ac.variant.details?.gene_level_variants, 4);
  assert.equal(
    ac.variant.summary,
    "Variant type cannot be compared: the variants on record are listed for GENE1 (2 diseases here) and GENE2 (2 diseases here), not for either disease itself.",
  );
  // The pathway alone carries the pair: 0.8 x its weight, nothing from the variants.
  assert.equal(ac.mechanism.status, "partial");
  assert.deepEqual(ac.mechanism.details, { most_specific: "PW:1", n: 4, N: 6, atlas: 6, via_genes: true });
  assert.equal(ac.mechanism.summary, "Their genes share one mechanism, small pathway (4 of 6 diseases here).");
  assert.equal(biologyScore(ac), Number((0.8 * ac.mechanism.score).toFixed(4)));
});

test("variant kinds: two of three loss-of-function variants count as mostly loss-of-function", () => {
  // Rounded, 2/3 is 0.6667: compared on exact fractions so it is not missed by a 0.67 cutoff.
  assert.equal(lofKind(2, 3), "mostly_lof");
  assert.equal(lofKind(3, 5), "mixed");
  assert.equal(lofKind(1, 5), "mostly_not_lof");
  assert.equal(lofKind(0, 2), "mostly_not_lof");
});

test("mechanism weights: specificity within the atlas, floored, times pathway size", () => {
  assert.equal(atlasSpecificity(2, 5), 1);
  assert.equal(atlasSpecificity(5, 5), 0);
  assert.ok(Math.abs(atlasSpecificity(3, 5) - (1 - Math.log(3) / Math.log(5)) / (1 - Math.log(2) / Math.log(5))) < 1e-12);
  assert.equal(atlasSpecificity(1, 5), 1); // reached by one disease: never shared, but not penalized
  assert.equal(atlasSpecificity(2, 2), 1); // too few diseases to judge specificity
  // Three of the fixture's six diseases have a mechanism on record (DIS1, DIS2, and DIS3 through
  // GENEB); N counts only those. Each mechanism reaches two of them; REACT:2 also spans 2000 genes.
  const big = 1 - Math.log(2000) / Math.log(20000);
  assert.equal(ctx.mechanismDiseases, 3);
  assert.deepEqual(mechanismWeight(ctx, "REACT:1"), { weight: 1, floored: false, n: 2, N: 3 });
  assert.ok(Math.abs(mechanismWeight(ctx, "REACT:2").weight - big) < 1e-12);
});

test("mechanism: the most specific shared mechanism sets the score, reached through genes", () => {
  const big = 1 - Math.log(2000) / Math.log(20000);
  const partial = pair(1, 2).mechanism;
  assert.equal(partial.status, "partial");
  assert.equal(partial.score, Number(big.toFixed(4)));
  // Reached directly by both, not through their shared gene, so it counts on its own.
  assert.deepEqual(partial.details, { most_specific: "REACT:2", n: 2, N: 3, atlas: 6 });
  assert.equal(partial.summary, "Both involve big pathway (2 of the 3 diseases with a mechanism on record).");

  const viaGene = pair(1, 3).mechanism;
  assert.equal(viaGene.status, "match");
  assert.equal(viaGene.score, 1);
  const item = viaGene.shared[0];
  assert.equal(item.id, "REACT:1");
  assert.equal(item.via, "HGNC:2");
  assert.deepEqual(item.edges, ["e-HGNC_2-MONDO_0000003", "e-HGNC_2-REACT_1", "e-MONDO_0000001-REACT_1"]);
  assert.equal(item.kind, "mixed");
  assert.equal(viaGene.support, "inferred"); // DIS1's side rests on an inferred edge
  assert.deepEqual(viaGene.flags, ["inferred_only"]);

  assert.equal(pair(2, 3).mechanism.status, "none");
  assert.equal(pair(2, 3).mechanism.summary, "Different mechanisms: Big pathway for DIS2, Lysosomal storage for DIS3.");
  assert.equal(pair(5, 6).mechanism.status, "unknown");
});

// Four diseases on a family-wide process; A and B also share a specific one, A, B and C a middling one.
function familyGraph(specificKind: EdgeKind = "observed"): AtlasGraph {
  const ids = ["A", "B", "C", "D"].map((x) => `MONDO:${x}`);
  return {
    meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
    nodes: [
      ...ids.map((id) => node(id, "Disease", id.slice(6))),
      ...["A", "B", "C", "D"].map((x) => node(`HGNC:${x}`, "Gene", `GENE${x}`)),
      node("PW:FAM", "Mechanism", "Lipofuscin storage"),
      node("PW:SPEC", "Mechanism", "Soluble lysosomal enzyme missing"),
      node("PW:MID", "Mechanism", "Membrane protein missing"),
    ],
    edges: [
      ...["A", "B", "C", "D"].map((x) => edge(`HGNC:${x}`, `MONDO:${x}`)),
      ...ids.map((id) => edge(id, "PW:FAM")),
      edge("HGNC:A", "PW:SPEC", specificKind),
      edge("HGNC:B", "PW:SPEC", specificKind),
      ...["A", "B", "C"].map((x) => edge(`HGNC:${x}`, "PW:MID")),
    ],
  };
}

test("mechanism: a family-wide process alone does not tell diseases apart", () => {
  const c = buildContext(familyGraph(), null);
  const score = (a: string, b: string) => scoreDimensions(c, `MONDO:${a}`, `MONDO:${b}`).mechanism;
  const mid = (1 - Math.log(3) / Math.log(4)) / (1 - Math.log(2) / Math.log(4));

  const ab = score("A", "B");
  assert.equal(ab.score, 1);
  assert.equal(ab.status, "match");
  assert.deepEqual(ab.shared.map((s) => [s.id, s.weight]), [
    ["PW:SPEC", 1],
    ["PW:MID", Number(mid.toFixed(4))],
    ["PW:FAM", MECHANISM_FLOOR],
  ]);
  // A label about the gene product reads as the diseases' own, and the others are named beside it.
  assert.equal(
    ab.summary,
    "Both are missing a soluble lysosomal enzyme (2 of 4 diseases here), the most specific of 3 shared mechanisms. Also shared: Membrane protein missing and Lipofuscin storage.",
  );

  const ac = score("A", "C");
  assert.equal(ac.score, Number(mid.toFixed(4)));
  assert.equal(ac.status, "partial");
  assert.ok(!ac.flags.includes("family_level_only"));

  const cd = score("C", "D");
  assert.equal(cd.score, MECHANISM_FLOOR);
  assert.equal(cd.status, "partial");
  assert.deepEqual(cd.flags, ["family_level_only"]);
  assert.deepEqual(cd.details, { most_specific: "PW:FAM", n: 4, N: 4, atlas: 4 });
  assert.equal(cd.summary, "They share only the family-wide process Lipofuscin storage (all 4 diseases here), which does not tell them apart.");

  // Support follows the mechanism that carries the score, not the family-wide one beside it.
  const inferredSpecific = buildContext(familyGraph("inferred"), null);
  const result = scoreDimensions(inferredSpecific, "MONDO:A", "MONDO:B").mechanism;
  assert.equal(result.support, "inferred");
  assert.ok(result.flags.includes("inferred_only"));
});

test("mechanism specificity counts only the diseases with a mechanism on record", () => {
  // The family graph inside a larger atlas whose other six diseases have genes but no mechanism on
  // record: the family-wide process must stay at the floor, as in the family on its own.
  const base = familyGraph();
  const extra = ["E", "F", "G", "H", "I", "J"];
  const g: AtlasGraph = {
    meta: base.meta,
    nodes: [...base.nodes, ...extra.flatMap((x) => [node(`MONDO:${x}`, "Disease", x), node(`HGNC:${x}`, "Gene", `GENE${x}`)])],
    edges: [...base.edges, ...extra.map((x) => edge(`HGNC:${x}`, `MONDO:${x}`))],
  };
  const c = buildContext(g, null);
  assert.equal(c.diseases.length, 10);
  assert.equal(c.mechanismDiseases, 4);
  assert.deepEqual(mechanismWeight(c, "PW:FAM"), { weight: MECHANISM_FLOOR, floored: true, n: 4, N: 4 });
  // Counted over all ten diseases instead, it would weigh (1 - ln 4 / ln 10) / (1 - ln 2 / ln 10)
  // = 0.57 and pass for a specific mechanism.
  assert.ok(atlasSpecificity(4, 10) > 0.5);

  const cd = scoreDimensions(c, "MONDO:C", "MONDO:D").mechanism;
  assert.equal(cd.score, MECHANISM_FLOOR);
  assert.deepEqual(cd.flags, ["family_level_only"]);
  assert.deepEqual(cd.details, { most_specific: "PW:FAM", n: 4, N: 4, atlas: 10 });
  assert.equal(
    cd.summary,
    "They share only the family-wide process Lipofuscin storage (all 4 diseases with a mechanism on record), which does not tell them apart.",
  );
  assert.equal(
    scoreDimensions(c, "MONDO:A", "MONDO:B").mechanism.summary,
    "Both are missing a soluble lysosomal enzyme (2 of the 4 diseases with a mechanism on record), the most specific of 3 shared mechanisms. Also shared: Membrane protein missing and Lipofuscin storage.",
  );
});

// Diseases of one gene. X and Y share GENEG, whose three variants and mechanism come with the gene;
// each also has two loss-of-function variants of its own. V and W share GENEK; W has one variant of
// its own. U (GENEH) has a mechanism too, so three diseases have one on record.
function oneGeneGraph(): AtlasGraph {
  const variant = (id: string, gene: string, change: string) => ({ ...node(id, "Variant", `NM_9.1(${gene}):${change}`), source: "ClinVar" });
  const lof = (id: string, gene: string, k: number) => variant(id, gene, `c.${k}del (p.Leu${k}fs)`);
  return {
    meta: graph.meta,
    nodes: [
      ...["U", "V", "W", "X", "Y"].map((x) => node(`MONDO:${x}`, "Disease", x)),
      ...["G", "H", "K"].map((x) => node(`HGNC:${x}`, "Gene", `GENE${x}`)),
      lof("CLINVAR:g1", "GENEG", 10),
      lof("CLINVAR:g2", "GENEG", 20),
      variant("CLINVAR:g3", "GENEG", "c.30A>G (p.Lys10Arg)"),
      ...[1, 2, 3].map((k) => lof(`CLINVAR:k${k}`, "GENEK", 10 * k)),
      ...[1, 2].map((k) => lof(`CLINVAR:x${k}`, "GENEG", 40 + k)),
      ...[1, 2].map((k) => lof(`CLINVAR:y${k}`, "GENEG", 50 + k)),
      ...[1, 2].map((k) => lof(`CLINVAR:v${k}`, "GENEK", 60 + k)),
      lof("CLINVAR:w1", "GENEK", 70),
      node("PW:G", "Mechanism", "Soluble lysosomal enzyme missing"),
      node("PW:H", "Mechanism", "Membrane protein missing"),
    ],
    edges: [
      edge("HGNC:G", "MONDO:X"),
      edge("HGNC:G", "MONDO:Y"),
      edge("HGNC:K", "MONDO:V"),
      edge("HGNC:K", "MONDO:W"),
      edge("HGNC:H", "MONDO:U"),
      ...["g1", "g2", "g3"].map((v) => edge(`CLINVAR:${v}`, "HGNC:G")),
      ...["k1", "k2", "k3"].map((v) => edge(`CLINVAR:${v}`, "HGNC:K")),
      ...["x1", "x2"].map((v) => edge(`CLINVAR:${v}`, "MONDO:X")),
      ...["y1", "y2"].map((v) => edge(`CLINVAR:${v}`, "MONDO:Y")),
      ...["v1", "v2"].map((v) => edge(`CLINVAR:${v}`, "MONDO:V")),
      edge("CLINVAR:w1", "MONDO:W"),
      edge("HGNC:G", "PW:G"),
      edge("HGNC:H", "PW:H"),
    ],
  };
}

test("same gene: the gene's own variants and mechanism are the gene's fact, not more evidence", () => {
  const c = buildContext(oneGeneGraph(), null);
  const xy = scoreDimensions(c, "MONDO:X", "MONDO:Y");
  assert.equal(xy.gene.status, "match");
  // Each disease's own variants are compared; the gene's three are set aside.
  assert.equal(xy.variant.status, "match");
  assert.equal(xy.variant.score, 1);
  assert.deepEqual(xy.variant.coverage, { a: 5, b: 5 });
  assert.deepEqual(xy.variant.shared, []);
  assert.equal(xy.variant.details?.gene_level_variants, 3);
  assert.equal(xy.variant.details?.lof_a, 2);
  assert.equal(xy.variant.summary, "Both mostly loss-of-function (ClinVar records: X 2 of 2 loss-of-function, Y 2 of 2).");
  // The mechanism is shared only because the gene is: listed, but no line of its own. It cannot say
  // whether the two diseases disrupt it the same way, so it is unknown and scores 0.
  assert.equal(xy.mechanism.status, "unknown");
  assert.equal(xy.mechanism.score, 0);
  assert.equal(xy.mechanism.support, null);
  assert.deepEqual(xy.mechanism.shared.map((s) => [s.id, s.weight]), [["PW:G", 1]]);
  assert.deepEqual(xy.mechanism.details, { most_specific: "PW:G", n: 2, N: 3, atlas: 5, through_shared_gene: true });
  assert.equal(
    xy.mechanism.summary,
    "The mechanism they share, Soluble lysosomal enzyme missing (2 of the 3 diseases with a mechanism on record), comes with their shared gene GENEG, so it says nothing the gene does not; whether both diseases disrupt it the same way is unknown.",
  );
  // Gene and own variants: two lines. The mechanism adds nothing on top of the gene.
  assert.equal(biologyScore(xy), Number((1 - 0.3 * 0.75).toFixed(4)));

  const vw = scoreDimensions(c, "MONDO:V", "MONDO:W");
  assert.equal(vw.variant.status, "unknown");
  assert.deepEqual(vw.variant.flags, ["variant_effect_unknown", "derived_from_variant_notation"]);
  assert.equal(vw.variant.details?.gene_level_variants, 3);
  assert.equal(vw.variant.summary, "Apart from the variants of the shared gene GENEK, too few with a readable type to compare (V: 2, W: 1; 2 needed each).");
  assert.equal(biologyScore(vw), 0.7);
});

test("variant: the same kind of lesion on both sides matches even when three variants a side differ by one", () => {
  // Two genes read from three variants each: P 2 of 3 loss-of-function, T 3 of 3. M is mixed (1 of 3).
  const variant = (id: string, change: string) => ({ ...node(id, "Variant", `NM_8.1(GENE):${change}`), source: "ClinVar" });
  const g: AtlasGraph = {
    meta: graph.meta,
    nodes: [
      ...["M", "P", "T"].flatMap((x) => [node(`MONDO:${x}`, "Disease", x), node(`HGNC:${x}`, "Gene", `GENE${x}`)]),
      variant("CLINVAR:p1", "c.1A>T (p.Met1Leu)"),
      variant("CLINVAR:p2", "c.138C>A (p.Cys46Ter)"),
      variant("CLINVAR:p3", "c.224C>A (p.Thr75Asn)"),
      variant("CLINVAR:t1", "c.141_144del (p.Leu49fs)"),
      variant("CLINVAR:t2", "c.1053dup (p.Leu352fs)"),
      variant("CLINVAR:t3", "c.2T>C (p.Met1Thr)"),
      variant("CLINVAR:m1", "c.40del (p.Leu14fs)"),
      variant("CLINVAR:m2", "c.50A>G (p.Lys17Arg)"),
      variant("CLINVAR:m3", "c.60G>A (p.Gly20Ser)"),
    ],
    edges: [
      ...["M", "P", "T"].map((x) => edge(`HGNC:${x}`, `MONDO:${x}`)),
      ...["p1", "p2", "p3"].map((v) => edge(`CLINVAR:${v}`, "HGNC:P")),
      ...["t1", "t2", "t3"].map((v) => edge(`CLINVAR:${v}`, "HGNC:T")),
      ...["m1", "m2", "m3"].map((v) => edge(`CLINVAR:${v}`, "HGNC:M")),
    ],
  };
  const c = buildContext(g, null);
  const pt = scoreDimensions(c, "MONDO:P", "MONDO:T").variant;
  assert.equal(pt.score, 0.6667);
  assert.equal(pt.status, "match");
  assert.deepEqual([pt.details?.kind_a, pt.details?.kind_b], ["mostly_lof", "mostly_lof"]);
  // Each gene has one disease here, so its records stand for the disease; the words say whose they are.
  assert.equal(pt.summary, "Both mostly loss-of-function (ClinVar records: GENEP 2 of 3 loss-of-function, GENET 3 of 3).");
  // The same share gap, but one side mixed: only partly in agreement.
  const mp = scoreDimensions(c, "MONDO:M", "MONDO:P").variant;
  assert.equal(mp.score, 0.6667);
  assert.equal(mp.status, "partial");
  const mt = scoreDimensions(c, "MONDO:M", "MONDO:T").variant;
  assert.equal(mt.status, "none");
  assert.ok(!mt.flags.includes("variant_type_conflict")); // mixed is not the opposite kind
});

test("mechanism phrases read the label only", () => {
  assert.equal(mechanismPhrase("Soluble lysosomal enzyme missing"), "both are missing a soluble lysosomal enzyme");
  assert.equal(mechanismPhrase("Membrane protein missing"), "both are missing a membrane protein");
  assert.equal(mechanismPhrase("ER protein missing"), "both are missing an ER protein");
  assert.equal(mechanismPhrase("Lysosomal membrane protein"), "both involve a lysosomal membrane protein");
  assert.equal(mechanismPhrase("Transport across the lysosomal membrane"), "both involve transport across the lysosomal membrane");
  assert.equal(mechanismPhrase("TGF-beta signaling"), "both involve TGF-beta signaling");
  // Reactome names: sentence case reads as running text, title case is kept as written.
  assert.equal(mechanismPhrase("Melanin biosynthesis"), "both involve melanin biosynthesis");
  assert.equal(
    mechanismPhrase("Regulation of MITF-M-dependent genes involved in pigmentation"),
    "both involve regulation of MITF-M-dependent genes involved in pigmentation",
  );
  assert.equal(
    mechanismPhrase("Developmental Lineage of Pancreatic Ductal Cells"),
    "both involve Developmental Lineage of Pancreatic Ductal Cells",
  );
  assert.equal(mechanismPhrase("Pre-NOTCH Processing in the Endoplasmic Reticulum"), "both involve Pre-NOTCH Processing in the Endoplasmic Reticulum");
});

test("shared mechanism clause: a pathway their genes are in is named as such, a gene-product label as their own", () => {
  const reach = "2 of the 81 diseases with a mechanism on record";
  assert.equal(sharedMechanismClause("Galactose catabolism", 1, true, reach), `their genes share one mechanism, galactose catabolism (${reach})`);
  assert.equal(
    sharedMechanismClause("Hyaluronan degradation", 5, true, reach),
    `their genes share 5 mechanisms, of which the most specific here is hyaluronan degradation (${reach})`,
  );
  // Process names ending in a product noun stay process names.
  assert.equal(sharedMechanismClause("Signaling by Insulin receptor", 1, true, ""), "their genes share one mechanism, Signaling by Insulin receptor");
  assert.equal(sharedMechanismClause("Membrane protein missing", 1, true, ""), "both are missing a membrane protein");
  assert.equal(sharedMechanismClause("Lysosomal membrane protein", 2, true, reach), `both involve a lysosomal membrane protein (${reach}), the most specific of 2 shared mechanisms`);
  // Linked to the diseases themselves: their own mechanism.
  assert.equal(sharedMechanismClause("Big pathway", 1, false, reach), `both involve big pathway (${reach})`);
});

test("symptom scale: floor at the 99th percentile of random pairs, top at the same-disease median", () => {
  assert.deepEqual(symptomScale(reference.meta), { floor: 0.3, top: 0.5, sameDiseasePairs: 50 });
  const { same_disease: _omitted, ...withoutAnchor } = reference.meta;
  assert.deepEqual(symptomScale(withoutAnchor), { floor: 0.3, top: SYMPTOM_TOP_FALLBACK, sameDiseasePairs: 0 });
  const scale = symptomScale(reference.meta);
  assert.equal(symptomScore(0.6, 0.999, scale), 1);
  assert.ok(Math.abs(symptomScore(0.4, 0.999, scale) - 0.5) < 1e-12);
  assert.equal(symptomScore(0.25, 0.97, scale), 0); // past the gate, below the floor
  assert.equal(symptomScore(0.6, 0.9, scale), 0); // below the gate scores 0 whatever the raw value
  assert.equal(symptomScore(0.31, 0.99, { floor: 0.3, top: 0.3, sameDiseasePairs: 0 }), 1);
  // Values between stored points are interpolated.
  assert.ok(Math.abs(quantileValue(reference.meta.null.quantiles, 0.97) - 0.25) < 1e-12);
  assert.equal(quantileValue(reference.meta.null.quantiles, 0.99), 0.3);
});

test("phenotype: SimGIC on the symptom scale, obsolete ids mapped", () => {
  const close = pair(1, 2).phenotype;
  // DIS2's obsolete term maps to the same lipopigment term, so the symptom sets are identical.
  assert.equal(close.raw, 1);
  assert.equal(close.percentile, 1);
  assert.equal(close.score, 1);
  assert.equal(close.status, "match");
  assert.equal(close.support, "observed");
  assert.equal(close.family, "clinical");
  assert.deepEqual(close.details, { shared_exact: 5, shared_rare: 1, terms_a: 5, terms_b: 5, raw: 1 });
  assert.equal(close.shared[0].id, "HP:0002074");
  assert.equal(close.shared[0].label, "Increased neuronal autofluorescent lipopigment"); // reference label, not the graph's
  assert.equal(
    close.summary,
    "5 shared symptoms, 1 of them rare (e.g. Increased neuronal autofluorescent lipopigment). They overlap about as much as two records of the same disease. Only 5 symptoms on record for DIS1 and 5 for DIS2.",
  );

  const far = pair(1, 3).phenotype;
  const raw = 0.15 / (0.75 + 0.15 + 0.16 + 0.25 + 0.3 + 0.2);
  assert.equal(far.raw, Number(raw.toFixed(4)));
  assert.ok((far.percentile ?? 1) < 0.95);
  assert.equal(far.status, "none");
  assert.equal(far.score, 0);
  assert.deepEqual(far.flags, ["generic_symptoms_only", "few_annotations"]);
  assert.match(far.summary, /^1 shared symptom, a common one \(e\.g\. Seizure\)\. They overlap no more than many unrelated diseases do\./);

  const generic = pair(5, 6).phenotype;
  assert.equal(generic.status, "match"); // identical sparse profiles: flagged, left to review
  assert.deepEqual(generic.flags, ["generic_symptoms_only", "few_annotations"]);
});

test("phenotype: missing and obsolete-without-replacement ids drop out", () => {
  assert.deepEqual(ctx.missingTerms, ["HP:0123456"]);
  const result = scoreDimensions(ctx, D(1), D(4)).phenotype;
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.coverage, { a: 5, b: 0 });
  assert.equal(result.summary, "No symptoms on record for DIS4.");
});

test("onset and inheritance: onset ladder distance and shared inheritance, weighted 0.8 / 0.2", () => {
  const apart = pair(1, 2).disease;
  assert.equal(apart.family, "clinical");
  assert.equal(apart.score, 0.2); // infantile vs juvenile: two steps apart; both autosomal recessive
  assert.equal(apart.status, "none");
  assert.deepEqual(apart.details, {
    onset_a: "infantile",
    onset_b: "juvenile",
    onset_score: 0,
    inheritance_shared: true,
    onset_edges: "e-MONDO_0000001-HP_0003593 e-MONDO_0000002-HP_0003621",
  });
  assert.equal(apart.summary, "Onset: infantile vs juvenile (further apart). Both autosomal recessive.");

  const inheritanceOnly = pair(1, 3).disease;
  assert.equal(inheritanceOnly.score, 1); // only inheritance is on record for both: renormalized
  assert.equal(inheritanceOnly.status, "match");
  assert.equal(inheritanceOnly.summary, "No onset on record for DIS3. Both autosomal recessive.");
  assert.equal(pair(5, 6).disease.status, "unknown");
});

test("onset: neighbouring steps, finer terms count as their step, disagreeing sources are flagged", () => {
  const ids = ["X", "Y", "Z"].map((x) => `MONDO:${x}`);
  const g: AtlasGraph = {
    meta: graph.meta,
    nodes: [
      ...ids.map((id) => node(id, "Disease", id.slice(6))),
      ...["HP:0011463", "HP:0003621", "HP:0003584", "HP:0003676", "HP:0000007", "HP:0001417"].map((id) => node(id, "Phenotype")),
    ],
    edges: [
      edge("MONDO:X", "HP:0011463"),
      edge("MONDO:X", "HP:0000007"),
      edge("MONDO:Y", "HP:0003621", "observed", "Juvenile (Table 1) Sources disagree: other sources say late infantile."),
      edge("MONDO:Y", "HP:0000007"),
      edge("MONDO:Z", "HP:0003584"),
      edge("MONDO:Z", "HP:0003676"),
      edge("MONDO:Z", "HP:0001417"),
    ],
  };
  const c = buildContext(g, reference);
  const xy = scoreDimensions(c, "MONDO:X", "MONDO:Y").disease;
  assert.equal(xy.score, 0.6); // 0.8 * 0.5 + 0.2 * 1
  assert.equal(xy.status, "partial");
  assert.equal(xy.support, "observed"); // the shared inheritance is stated on both sides
  assert.deepEqual(xy.flags, ["sources_disagree"]);
  assert.equal(
    xy.summary,
    "Onset: childhood vs juvenile (neighbouring). Both autosomal recessive. Sources disagree on the onset of Y; a clinician should confirm.",
  );

  // "Late onset" sits under adult onset; "Progressive" is a course term, not an onset.
  const yz = scoreDimensions(c, "MONDO:Y", "MONDO:Z").disease;
  assert.equal(yz.details?.onset_b, "adult");
  assert.equal(yz.details?.onset_score, 0.5);
  assert.equal(yz.details?.inheritance_shared, false);
  assert.equal(yz.score, 0.4);
  assert.equal(yz.summary, "Onset: juvenile vs adult (neighbouring). Inheritance differs: autosomal recessive vs X-linked. Sources disagree on the onset of Y; a clinician should confirm.");
  assert.deepEqual(yz.coverage, { a: 2, b: 3 });
});

test("collaboration: via a mechanism or gene, umbrella items, inactive studies, disputes", () => {
  const d12 = pair(1, 2);
  assert.equal(d12.patient_org.status, "match");
  // The group linked to two diseases weighs 1 and comes first; the one listed for every disease with
  // a group on record (5 of 5) weighs 0 and is an umbrella (5 > max(4, 0.6)).
  assert.deepEqual(d12.patient_org.shared.map((s) => [s.id, s.via ?? null, s.weight]), [
    ["atlas:org-1", "REACT:2", 1],
    ["atlas:org-2", null, 0],
  ]);
  assert.equal(d12.patient_org.score, 0.5); // 1 - (1 - 0.5 x 1)(1 - 0.5 x 0)
  assert.deepEqual(d12.patient_org.flags, ["via_mechanism", "umbrella_resource"]);
  assert.equal(d12.patient_org.details?.umbrella_items, "atlas:org-2");
  assert.equal(
    d12.patient_org.summary,
    "2 shared patient groups, e.g. Pathway families. Linked through Big pathway. 1 of them is listed for more than 4 of the 6 diseases here.",
  );
  assert.deepEqual(d12.asset.shared.map((s) => [s.id, s.via]), [["atlas:asset-1", "HGNC:1"]]);
  assert.ok(d12.asset.flags.includes("via_mechanism"));
  assert.deepEqual(d12.trial.flags, ["inferred_only", "inactive_or_withdrawn"]);
  assert.equal(d12.trial.summary, "Same clinical study: Withdrawn study.");

  const d23 = pair(2, 3);
  assert.equal(d23.grant.summary, "Same research grant: Shared grant.");
  assert.deepEqual(d23.investigator.shared.map((s) => [s.id, s.via, s.kind]), [["reporter:pi-1", "reporter:R1", "mixed"]]);
  assert.equal(d23.investigator.summary, "Same researcher: Pat Investigator. Linked through Shared grant.");

  const d56 = pair(5, 6);
  assert.deepEqual(d56.paper.shared.map((s) => s.id), ["PMID:1"]);
  assert.deepEqual(d56.paper.flags, ["inferred_only", "contradicted_evidence"]);
  assert.equal(d56.paper.details?.contradicted_edges, "e-PMID_2-MONDO_0000006");
  assert.equal(d56.trial.status, "unknown");
  assert.deepEqual(d56.trial.flags, ["no_data"]);
});

test("umbrella resources and item weights: broad listings say little and never bridge", () => {
  // More than max(UMBRELLA_MIN, UMBRELLA_SHARE x N) diseases: 4 in a small atlas, a tenth of a large one.
  assert.equal(umbrellaCutoff(6), 4);
  assert.equal(umbrellaCutoff(93), 9.3);
  // 30 diseases; 20 of them have a patient group on record. A group for 4 diseases is specific, one
  // for 5 is listed beyond the cutoff (max(4, 3) = 4), and one for all 20 weighs nothing.
  const n = 30;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let d = 1; d <= n; d++) nodes.push(node(D(d), "Disease"));
  const groups: [string, number[]][] = [
    ["atlas:org-a", [1, 2, 3, 4]],
    ["atlas:org-b", [5, 6, 7, 8, 9]],
    ["atlas:org-c", Array.from({ length: 20 }, (_, i) => i + 1)],
  ];
  for (const [id, members] of groups) {
    nodes.push(node(id, "PatientOrg"));
    for (const d of members) edges.push(edge(id, D(d), "inferred"));
  }
  const c = buildContext({ meta: graph.meta, nodes, edges }, null);
  assert.equal(c.collaborationDiseases.patient_org, 20);
  assert.equal(isUmbrella(c, "patient_org", "atlas:org-a"), false);
  assert.equal(isUmbrella(c, "patient_org", "atlas:org-b"), true);
  assert.equal(isUmbrella(c, "patient_org", "atlas:org-c"), true);
  const lnN = Math.log(20);
  assert.ok(Math.abs(collaborationWeight(c, "patient_org", "atlas:org-a") - (1 - Math.log(4) / lnN) / (1 - Math.log(2) / lnN)) < 1e-12);
  assert.equal(collaborationWeight(c, "patient_org", "atlas:org-c"), 0);
  // D1-D2 share a specific group and the everyone group: the pair is a match, flagged for the umbrella.
  const d12 = scoreDimensions(c, D(1), D(2)).patient_org;
  assert.equal(d12.status, "match");
  assert.deepEqual(d12.shared.map((s) => s.id), ["atlas:org-a", "atlas:org-c"]);
  assert.equal(d12.score, Number((0.5 * collaborationWeight(c, "patient_org", "atlas:org-a")).toFixed(4)));
  // D5-D6 share only listings beyond the cutoff: a partial overlap, and no bridge between them.
  const d56 = scoreDimensions(c, D(5), D(6)).patient_org;
  assert.equal(d56.status, "partial");
  assert.ok(d56.flags.includes("umbrella_resource"));
  assert.equal(d56.summary, "2 shared patient groups, e.g. atlas:org-b. Each is listed for more than 4 of the 30 diseases here, so they say little about this pair.");
  assert.ok(!candidatePairs(c).some(([a, b]) => a === D(5) && b === D(6)));
  // Only the specific group makes pairs worth grading.
  assert.deepEqual(
    candidatePairs(c).map(([a, b]) => `${a} ${b}`),
    [[1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]].map(([a, b]) => `${D(a)} ${D(b)}`),
  );
});

test("relation names never matter: the same graph with renamed edges grades the same", () => {
  const renamed: AtlasGraph = { ...graph, edges: graph.edges.map((e) => ({ ...e, type: "x" })) };
  const other = buildContext(renamed, reference);
  assert.deepEqual(candidatePairs(other), candidatePairs(ctx));
  for (const [a, b] of candidatePairs(ctx)) assert.deepEqual(scoreDimensions(other, a, b), scoreDimensions(ctx, a, b));
});

test("without a reference: raw Jaccard, flagged uncalibrated, onset not assessed", () => {
  const bare = buildContext(graph, null);
  const result = scoreDimensions(bare, D(1), D(2));
  // 7 terms each, 5 identical ids: the obsolete id is not mapped and the onset terms differ.
  assert.equal(result.phenotype.score, Number((5 / 9).toFixed(4)));
  assert.equal(result.phenotype.coverage.a, 7); // without aspects, every HPO term counts as a symptom
  assert.equal(result.phenotype.status, "match");
  assert.equal(result.phenotype.raw, undefined);
  assert.equal(result.phenotype.percentile, undefined);
  assert.ok(result.phenotype.flags.includes("uncalibrated"));
  assert.equal(result.phenotype.details?.shared_rare, null);
  assert.equal(result.disease.status, "unknown");
  assert.ok(candidatePairs(bare).some(([a, b]) => a === D(5) && b === D(6)));
});

test("percentile interpolation over the null quantiles", () => {
  const q = reference.meta.null.quantiles;
  assert.equal(percentileOf(-1, q), 0);
  assert.equal(percentileOf(0, q), 0);
  assert.equal(percentileOf(0.05, q), 0.5);
  assert.ok(Math.abs(percentileOf(0.1, q) - 0.7) < 1e-12);
  assert.ok(Math.abs(percentileOf(0.35, q) - 0.9945) < 1e-12);
  assert.equal(percentileOf(0.9, q), 1);
  // On a plateau the lowest p wins: the cautious reading.
  assert.equal(percentileOf(0.1, [{ p: 0, value: 0 }, { p: 0.5, value: 0.1 }, { p: 0.9, value: 0.1 }, { p: 1, value: 1 }]), 0.5);
});

test("score floor: the SimGIC value at or below which the symptom score is 0", () => {
  const scale = symptomScale(reference.meta);
  assert.equal(scoreFloor(reference.meta.null.quantiles, scale), 0.3); // the floor lies above the gate
  // A scale whose floor sits below the gate: the gate (p 0.95 at 0.2) decides.
  assert.ok(Math.abs(scoreFloor(reference.meta.null.quantiles, { ...scale, floor: 0.1 }) - 0.2) < 1e-12);
  assert.equal(scoreFloor([{ p: 0, value: 0 }, { p: 0.9, value: 1 }], scale), Number.POSITIVE_INFINITY);
});

test("candidates include pairs whose symptoms match only through shared common ancestors", () => {
  // No identical term, yet a high SimGIC through the parents of their terms:
  // (0.6 + 0.55) / (0.6 + 0.55 + 4 * 0.45) = 0.39, above the floor of 0.3.
  const tree: Record<string, HpoTerm> = {
    "HP:0000001": term("All", 0, "other", []),
    "HP:0000118": term("Phenotypic abnormality", 0, "P", ["HP:0000001"]),
    "HP:0000100": term("Vision", 0.6, "P"),
    "HP:0000200": term("Cognition", 0.55, "P"),
    "HP:0000101": term("Vision a", 0.45, "P", ["HP:0000001", "HP:0000118", "HP:0000100"]),
    "HP:0000102": term("Vision b", 0.45, "P", ["HP:0000001", "HP:0000118", "HP:0000100"]),
    "HP:0000201": term("Cognition a", 0.45, "P", ["HP:0000001", "HP:0000118", "HP:0000200"]),
    "HP:0000202": term("Cognition b", 0.45, "P", ["HP:0000001", "HP:0000118", "HP:0000200"]),
  };
  const ref: HpoReference = { ...reference, terms: tree };
  const g: AtlasGraph = {
    meta: graph.meta,
    nodes: [D(1), D(2)].map((id) => node(id, "Disease")).concat(Object.keys(tree).slice(2).map((id) => node(id, "Phenotype"))),
    edges: [edge(D(1), "HP:0000101"), edge(D(1), "HP:0000201"), edge(D(2), "HP:0000102"), edge(D(2), "HP:0000202")],
  };
  const c = buildContext(g, ref);
  const result = scoreDimensions(c, D(1), D(2)).phenotype;
  assert.equal(result.details?.shared_exact, 0);
  assert.ok(result.score > 0, `raw ${result.raw}`);
  assert.equal(result.support, "inferred");
  assert.match(result.summary, /^No identical symptoms, but related ones\. They overlap more than unrelated diseases, less than two records of one disease\./);
  assert.deepEqual(candidatePairs(c), [[D(1), D(2)]]);
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("candidate generation is exact: a pair left out shares nothing that can score or bridge", () => {
  for (const seed of [1, 2, 3]) {
    const random = mulberry32(seed);
    const pick = (n: number) => Math.floor(random() * n);
    // A random symptom tree (deeper = rarer), onset and inheritance terms, genes on pathways,
    // groups and grants.
    const terms: Record<string, HpoTerm> = {
      "HP:0000001": term("All", 0, "other", []),
      "HP:0000118": term("Phenotypic abnormality", 0, "P", ["HP:0000001"]),
      "HP:0000007": reference.terms["HP:0000007"],
      "HP:0003593": reference.terms["HP:0003593"],
      "HP:0011463": reference.terms["HP:0011463"],
    };
    const ids: string[] = [];
    for (let k = 0; k < 80; k++) {
      const id = `HP:${String(1000 + k).padStart(7, "0")}`;
      const parent = k < 6 ? null : ids[pick(k)];
      terms[id] = term(`t${k}`, Math.min(1, 0.05 + random() * (k < 6 ? 0.2 : 0.9)), "P", parent ? [...terms[parent].ancestors, parent].sort() : ["HP:0000001", "HP:0000118"]);
      ids.push(id);
    }
    const ref: HpoReference = { ...reference, terms };
    const n = 30;
    const nodes: GraphNode[] = [...ids, "HP:0000007", "HP:0003593", "HP:0011463"].map((id) => node(id, "Phenotype"));
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 12; i++) nodes.push(node(`HGNC:${i}`, "Gene"));
    for (let i = 0; i < 6; i++) nodes.push(node(`REACT:${i}`, "Mechanism"));
    for (let i = 0; i < 12; i++) if (random() < 0.5) edges.push(edge(`HGNC:${i}`, `REACT:${pick(6)}`));
    for (let i = 0; i < 4; i++) nodes.push(node(`atlas:org-${i}`, "PatientOrg"), node(`reporter:R${i}`, "Grant"));
    edges.push(edge("atlas:org-0", "REACT:0", "inferred"));
    for (let d = 1; d <= n; d++) {
      nodes.push(node(D(d), "Disease"));
      if (random() < 0.6) edges.push(edge(`HGNC:${pick(12)}`, D(d)));
      for (let k = 0, count = 2 + pick(8); k < count; k++) edges.push(edge(D(d), ids[pick(ids.length)]));
      // Every disease is autosomal recessive with one of two neighbouring onsets: on their own these
      // must never make a pair look alike.
      edges.push(edge(D(d), "HP:0000007"), edge(D(d), random() < 0.5 ? "HP:0003593" : "HP:0011463"));
      if (random() < 0.2) edges.push(edge(`atlas:org-${1 + pick(3)}`, D(d), "inferred"));
      if (random() < 0.2) edges.push(edge(`reporter:R${pick(4)}`, D(d), "inferred"));
      edges.push(edge("atlas:org-3", D(d), "inferred")); // an umbrella group linked to everyone
    }
    const unique = new Map(edges.map((e) => [e.id, e]));
    const c = buildContext({ meta: graph.meta, nodes, edges: [...unique.values()] }, ref);
    const candidates = new Set(candidatePairs(c).map(([a, b]) => pairKey(a, b)));
    let left = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = i + 1; j <= n; j++) {
        if (candidates.has(pairKey(D(i), D(j)))) continue;
        left += 1;
        const dims = scoreDimensions(c, D(i), D(j));
        assert.equal(biologyScore(dims), 0, `seed ${seed}: ${D(i)} ${D(j)} biology`);
        assert.equal(clinicalScore(dims), 0, `seed ${seed}: ${D(i)} ${D(j)} clinical`);
        for (const dim of COLLABORATION_DIMENSIONS) {
          for (const item of dims[dim].shared) assert.ok(isUmbrella(c, dim, item.id), `seed ${seed}: ${dim} ${item.id}`);
        }
      }
    }
    assert.ok(left > 0, `seed ${seed}: the index pruned nothing`);
  }
});

test("percent text is floored and never claims 100%", () => {
  assert.equal(percentText(0.9961), "99.6%");
  assert.equal(percentText(0.999), "99.9%");
  assert.equal(percentText(1), "99.9%");
  assert.equal(percentText(0.95), "95%");
  assert.equal(percentText(0.5), "50%");
});
