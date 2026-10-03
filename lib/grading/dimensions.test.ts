import assert from "node:assert/strict";
import { test } from "node:test";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import { MECHANISM_FLOOR, SYMPTOM_TOP_FALLBACK } from "./config.ts";
import {
  atlasSpecificity,
  buildContext,
  candidatePairs,
  isUmbrella,
  lofKind,
  mechanismPhrase,
  mechanismWeight,
  percentileOf,
  percentText,
  quantileValue,
  scoreDimensions,
  scoreFloor,
  symptomScale,
  symptomScore,
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
  const same = pair(1, 2).variant;
  assert.equal(same.status, "match");
  assert.equal(same.score, 1);
  assert.equal(same.support, "inferred");
  assert.equal(same.shared.length, 2); // allelic diseases share the gene's variants
  assert.deepEqual(same.flags, ["derived_from_variant_notation", "inferred_only"]);

  const conflict = pair(1, 3).variant;
  assert.equal(conflict.score, 0);
  assert.equal(conflict.status, "none");
  assert.deepEqual(conflict.flags, ["variant_type_conflict", "derived_from_variant_notation"]);
  assert.equal(conflict.details?.lof_fraction_a, 1);
  assert.equal(conflict.details?.lof_fraction_b, 0);
  assert.equal(conflict.details?.kind_a, "mostly_lof");
  assert.equal(conflict.details?.kind_b, "mostly_not_lof");
  assert.equal(conflict.summary, "DIS1 mostly loss-of-function (2 of 2 loss-of-function), DIS3 mostly missense or in-frame (0 of 2).");

  const none = pair(5, 6).variant;
  assert.equal(none.status, "unknown");
  assert.deepEqual(none.flags, ["variant_effect_unknown", "no_data"]);
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
  // In the fixture both mechanisms reach two of six diseases; REACT:2 also spans 2000 genes.
  const big = 1 - Math.log(2000) / Math.log(20000);
  assert.deepEqual(mechanismWeight(ctx, "REACT:1"), { weight: 1, floored: false, n: 2, N: 6 });
  assert.ok(Math.abs(mechanismWeight(ctx, "REACT:2").weight - big) < 1e-12);
});

test("mechanism: the most specific shared mechanism sets the score, reached through genes", () => {
  const big = 1 - Math.log(2000) / Math.log(20000);
  const partial = pair(1, 2).mechanism;
  assert.equal(partial.status, "partial");
  assert.equal(partial.score, Number(big.toFixed(4)));
  assert.deepEqual(partial.details, { most_specific: "REACT:2", n: 2, N: 6 });
  assert.equal(partial.summary, "Both involve big pathway (2 of 6 diseases here).");

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
  assert.equal(ab.summary, "Both are missing a soluble lysosomal enzyme (2 of 4 diseases here). Also shared: Membrane protein missing and Lipofuscin storage.");

  const ac = score("A", "C");
  assert.equal(ac.score, Number(mid.toFixed(4)));
  assert.equal(ac.status, "partial");
  assert.ok(!ac.flags.includes("family_level_only"));

  const cd = score("C", "D");
  assert.equal(cd.score, MECHANISM_FLOOR);
  assert.equal(cd.status, "partial");
  assert.deepEqual(cd.flags, ["family_level_only"]);
  assert.deepEqual(cd.details, { most_specific: "PW:FAM", n: 4, N: 4 });
  assert.equal(cd.summary, "They share only the family-wide process Lipofuscin storage (all 4 diseases here), which does not tell them apart.");

  // Support follows the mechanism that carries the score, not the family-wide one beside it.
  const inferredSpecific = buildContext(familyGraph("inferred"), null);
  const result = scoreDimensions(inferredSpecific, "MONDO:A", "MONDO:B").mechanism;
  assert.equal(result.support, "inferred");
  assert.ok(result.flags.includes("inferred_only"));
});

test("mechanism phrases read the label only", () => {
  assert.equal(mechanismPhrase("Soluble lysosomal enzyme missing"), "both are missing a soluble lysosomal enzyme");
  assert.equal(mechanismPhrase("Membrane protein missing"), "both are missing a membrane protein");
  assert.equal(mechanismPhrase("ER protein missing"), "both are missing an ER protein");
  assert.equal(mechanismPhrase("Lysosomal membrane protein"), "both involve a lysosomal membrane protein");
  assert.equal(mechanismPhrase("Transport across the lysosomal membrane"), "both involve transport across the lysosomal membrane");
  assert.equal(mechanismPhrase("TGF-beta signaling"), "both involve TGF-beta signaling");
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
  assert.deepEqual(d12.patient_org.shared.map((s) => [s.id, s.via ?? null]), [
    ["atlas:org-2", null],
    ["atlas:org-1", "REACT:2"],
  ]);
  assert.equal(d12.patient_org.score, 0.75);
  assert.deepEqual(d12.patient_org.flags, ["via_mechanism", "umbrella_resource"]);
  assert.equal(d12.patient_org.details?.umbrella_items, "atlas:org-2");
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
