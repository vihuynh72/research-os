import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS } from "./config.ts";
import {
  biologyScore,
  clinicalScore,
  clinicalTierFor,
  collaborationScore,
  countedBiology,
  countedClinical,
  noisyOr,
  synthesizePair,
  thinClinicalEvidence,
  tierFor,
} from "./synthesize.ts";
import {
  DIMENSIONS,
  DIMENSION_FAMILY,
  TIER_ORDER,
  type Dimension,
  type DimensionResult,
  type DimensionStatus,
  type Flag,
  type Judgment,
  type SharedItem,
  type Support,
  type Tier,
} from "./types.ts";

interface Spec {
  status?: DimensionStatus;
  score?: number;
  support?: Support | null;
  flags?: Flag[];
  shared?: SharedItem[];
  summary?: string;
  percentile?: number;
  details?: Record<string, number | string | boolean | null>;
}

function result(dimension: Dimension, spec: Spec = {}): DimensionResult {
  return {
    dimension,
    family: DIMENSION_FAMILY[dimension],
    score: spec.score ?? 0,
    ...(spec.percentile === undefined ? {} : { percentile: spec.percentile }),
    status: spec.status ?? "none",
    coverage: { a: 1, b: 1 },
    shared: spec.shared ?? [],
    support: spec.support ?? null,
    summary: spec.summary ?? "",
    flags: spec.flags ?? [],
    ...(spec.details ? { details: spec.details } : {}),
  };
}

function dims(specs: Partial<Record<Dimension, Spec>>): Record<Dimension, DimensionResult> {
  return Object.fromEntries(DIMENSIONS.map((d) => [d, result(d, specs[d])])) as Record<Dimension, DimensionResult>;
}

function mechanism(label: string, weight: number, n: number, N: number, extra: Spec = {}): Spec {
  const item: SharedItem = { id: `PW:${n}`, label, type: "Mechanism", weight, edges: ["e1", "e2"], kind: "observed" };
  return {
    status: weight >= 0.6 ? "match" : "partial",
    score: weight,
    support: "observed",
    shared: [item],
    details: { most_specific: item.id, n, N },
    ...extra,
  };
}

const enzyme = mechanism("Soluble lysosomal enzyme missing", 1, 2, 5);
const family = mechanism("Lysosomal lipofuscin accumulation", 0.15, 5, 5, { support: "inferred", flags: ["inferred_only", "family_level_only"] });
const mostlyLof: Spec = {
  status: "match",
  score: 1,
  support: "inferred",
  flags: ["derived_from_variant_notation"],
  details: { kind_a: "mostly_lof", kind_b: "mostly_lof" },
};
const observedMatch: Spec = { status: "match", score: 1, support: "observed" };
const inferredMatch: Spec = { status: "match", score: 1, support: "inferred" };

function judgment(verdict: Judgment["verdict"], extra: Partial<Judgment> = {}): Judgment {
  return {
    a: "A",
    b: "B",
    dimension: "overall",
    verdict,
    confidence: "high",
    rationale: "test",
    cited_edges: [],
    caveats: [],
    runs: 3,
    agreement: 1,
    ...extra,
  };
}

test("noisy-OR: 1 - prod(1 - cap * score)", () => {
  assert.equal(noisyOr([]), 0);
  assert.ok(Math.abs(noisyOr([{ cap: 0.6, score: 1 }, { cap: 0.6, score: 1 }]) - 0.84) < 1e-12);
  assert.ok(Math.abs(noisyOr([{ cap: 0.7, score: 0.5 }]) - 0.35) < 1e-12);
  // Agreement raises the score, but no combination of lines reaches 1.
  const all = noisyOr(Object.values(CAPS).map((cap) => ({ cap, score: 1 })));
  assert.ok(all < 1 && all > 0.99);
});

test("biology, clinical resemblance and collaboration are scored separately", () => {
  const d = dims({
    mechanism: enzyme,
    phenotype: { status: "partial", score: 0.5, support: "observed" },
    grant: { status: "match", score: 0.5 },
  });
  assert.equal(biologyScore(d), 0.8);
  assert.equal(clinicalScore(d), 0.375);
  assert.equal(collaborationScore(d), 0.15);
  // Symptoms and shared research never move biology.
  const noBiology = dims({ phenotype: observedMatch, disease: observedMatch, grant: { status: "match", score: 1 } });
  assert.equal(biologyScore(noBiology), 0);
  assert.ok(clinicalScore(noBiology) > 0.8);
  assert.ok(collaborationScore(noBiology) > 0);
});

test("modifier rule (biology): variant type counts only beside a shared gene or mechanism", () => {
  const variantOnly = dims({ variant: mostlyLof, phenotype: observedMatch });
  assert.deepEqual(countedBiology(variantOnly), ["gene", "mechanism"]);
  assert.equal(biologyScore(variantOnly), 0);
  const grade = synthesizePair("A", "B", variantOnly);
  assert.equal(grade.tier, "none");
  assert.deepEqual(grade.lines_of_evidence, []);
  assert.equal(grade.tier_reason, "No shared biology on record: no common gene or mechanism.");

  // A partial mechanism (even the family-wide one) lets the variant line count.
  const withFamily = dims({ mechanism: family, variant: mostlyLof });
  assert.deepEqual(countedBiology(withFamily), ["gene", "variant", "mechanism"]);
  assert.equal(biologyScore(withFamily), Number((1 - (1 - 0.8 * 0.15) * (1 - 0.25)).toFixed(4)));
});

test("modifier rule (clinical): onset and inheritance count only once the symptoms score", () => {
  const contextOnly = dims({ disease: observedMatch });
  assert.deepEqual(countedClinical(contextOnly), ["phenotype"]);
  assert.equal(clinicalScore(contextOnly), 0);
  const both = dims({ phenotype: { status: "none", score: 0.2, support: "observed" }, disease: observedMatch });
  assert.deepEqual(countedClinical(both), ["phenotype", "disease"]);
  assert.equal(clinicalScore(both), Number((1 - (1 - 0.75 * 0.2) * (1 - 0.4)).toFixed(4)));
});

test("tier and clinical tier thresholds", () => {
  assert.equal(tierFor(0.75), "strong");
  assert.equal(tierFor(0.7499), "moderate");
  assert.equal(tierFor(0.45), "moderate");
  assert.equal(tierFor(0.2), "exploratory");
  assert.equal(tierFor(0.1999), "none");
  assert.equal(clinicalTierFor(0.65), "very_similar");
  assert.equal(clinicalTierFor(0.6499), "similar");
  assert.equal(clinicalTierFor(0.4), "similar");
  assert.equal(clinicalTierFor(0.2), "somewhat");
  assert.equal(clinicalTierFor(0.1999), "different");
});

test("strong needs two full-match lines, one of them observed", () => {
  const two = synthesizePair("A", "B", dims({ mechanism: enzyme, variant: mostlyLof }));
  assert.equal(two.biology, 0.85);
  assert.equal(two.tier, "strong");
  assert.equal(two.support, "observed");
  assert.deepEqual(two.lines_of_evidence, ["variant", "mechanism"]);
  assert.equal(
    two.tier_reason,
    "Strong: both are missing a soluble lysosomal enzyme (2 of 5 diseases here), and both carry mostly loss-of-function variants.",
  );

  // The same scores with nothing observed: capped.
  const inferred = synthesizePair("A", "B", dims({ mechanism: { ...enzyme, support: "inferred" }, variant: mostlyLof }));
  assert.equal(inferred.biology, 0.85);
  assert.equal(inferred.tier, "moderate");
  assert.equal(inferred.support, "inferred");
  assert.match(inferred.tier_reason, /^Capped at moderate: the main evidence is inferred, not observed\. Both are missing/);

  // One full match beside a partial one: capped, and the reason says what is partial.
  const single = synthesizePair("A", "B", dims({ mechanism: enzyme, variant: { status: "partial", score: 0.6667, support: "inferred" } }));
  assert.equal(single.biology, 0.8333);
  assert.equal(single.tier, "moderate");
  assert.deepEqual(single.lines_of_evidence, ["mechanism"]);
  assert.equal(
    single.tier_reason,
    "Capped at moderate: only one line of evidence is a full match. Both are missing a soluble lysosomal enzyme (2 of 5 diseases here), and their variant types partly agree.",
  );
});

test("variant type that disagrees never adds to biology; a conflict still caps the tier", () => {
  // Status none (score 1/3, mixed against mostly loss-of-function): the pathway alone counts.
  const disagree: Spec = { status: "none", score: 0.3333, support: "inferred", flags: ["derived_from_variant_notation"] };
  const d = dims({ mechanism: mechanism("Keratan sulfate degradation", 0.5109, 6, 81, { details: { most_specific: "PW:6", n: 6, N: 81, atlas: 93, via_genes: true } }), variant: disagree });
  assert.deepEqual(countedBiology(d), ["gene", "mechanism"]);
  assert.equal(biologyScore(d), Number((0.8 * 0.5109).toFixed(4)));
  const grade = synthesizePair("A", "B", d);
  assert.equal(grade.tier, "exploratory");
  assert.equal(
    grade.tier_reason,
    "Exploratory: their genes share one mechanism, keratan sulfate degradation (6 of the 81 diseases with a mechanism on record).",
  );
  // Partial agreement counts at its score.
  const partly = dims({ mechanism: enzyme, variant: { status: "partial", score: 0.5, support: "inferred" } });
  assert.deepEqual(countedBiology(partly), ["gene", "variant", "mechanism"]);
  const conflict = synthesizePair("A", "B", dims({ mechanism: enzyme, variant: { status: "none", score: 0, flags: ["variant_type_conflict"] } }));
  assert.equal(conflict.biology, 0.8);
  assert.equal(conflict.tier, "moderate");
});

test("support: observed when an agreeing line rests on curated edges, even a partial one", () => {
  // The membrane-protein case: a partial mechanism stated by a curated source draws a solid link.
  const membrane = mechanism("Membrane protein missing", 0.5575, 3, 5);
  const grade = synthesizePair("A", "B", dims({ mechanism: membrane, variant: { status: "partial", score: 0.6667, support: "inferred" } }));
  assert.equal(grade.tier, "moderate");
  assert.equal(grade.support, "observed");
  assert.deepEqual(grade.lines_of_evidence, []);
  assert.equal(grade.tier_reason, "Moderate: both are missing a membrane protein (3 of 5 diseases here), and their variant types partly agree.");
  // Strong still needs a full-match line that is observed: here both full matches are inferred.
  const capped = synthesizePair("A", "B", dims({ gene: { ...inferredMatch, shared: [] }, mechanism: membrane, variant: mostlyLof }));
  assert.ok(capped.biology >= 0.75);
  assert.equal(capped.support, "observed");
  assert.equal(capped.tier, "moderate");
  assert.match(capped.tier_reason, /^Capped at moderate: the main evidence is inferred, not observed\./);
});

test("a family-wide mechanism alone gives an exploratory link that says so", () => {
  const grade = synthesizePair("A", "B", dims({ mechanism: family, variant: mostlyLof }));
  assert.equal(grade.biology, 0.34);
  assert.equal(grade.tier, "exploratory");
  assert.equal(grade.support, "inferred");
  assert.equal(
    grade.tier_reason,
    "Exploratory: they share only the family-wide process Lysosomal lipofuscin accumulation (all 5 diseases here), and both carry mostly loss-of-function variants.",
  );
  assert.ok(grade.flags.includes("family_level_only"));
});

test("one shared gene never counts as two lines: a mechanism that comes with it is not counted again", () => {
  const gene: Spec = { ...observedMatch, shared: [{ id: "HGNC:1", label: "GENEA", type: "Gene", weight: 1, edges: ["e1"], kind: "observed" }] };
  const viaGene = mechanism("Soluble lysosomal enzyme missing", 1, 2, 5, {
    details: { most_specific: "PW:2", n: 2, N: 5, atlas: 5, through_shared_gene: true },
  });
  const unknownVariant: Spec = { status: "unknown", flags: ["variant_effect_unknown"], details: { gene_level_variants: 3 } };
  const grade = synthesizePair("A", "B", dims({ gene, mechanism: viaGene, variant: unknownVariant }));
  assert.deepEqual(countedBiology(dims({ gene, mechanism: viaGene, variant: unknownVariant })), ["gene"]);
  assert.equal(grade.biology, 0.7);
  assert.equal(grade.tier, "moderate");
  assert.deepEqual(grade.lines_of_evidence, ["gene"]);
  // The reason says what one gene cannot tell: whether both diseases break it the same way.
  assert.equal(
    grade.tier_reason,
    "Moderate: both are caused by the same gene (GENEA); the variants on record belong to the gene, not to either disease, so whether both break it the same way is unknown.",
  );
  const noVariants = synthesizePair("A", "B", dims({ gene, variant: { status: "unknown", flags: ["variant_effect_unknown", "no_data"] } }));
  assert.equal(
    noVariants.tier_reason,
    "Moderate: both are caused by the same gene (GENEA); no variants are on record to tell whether both break it the same way.",
  );

  // Variants of their own that agree are a second line: strong.
  const own = synthesizePair("A", "B", dims({ gene, mechanism: viaGene, variant: mostlyLof }));
  assert.equal(own.biology, 0.775);
  assert.equal(own.tier, "strong");
  assert.deepEqual(own.lines_of_evidence, ["gene", "variant"]);
  assert.equal(own.tier_reason, "Strong: both are caused by the same gene (GENEA), and both carry mostly loss-of-function variants.");
});

test("the reason names the mechanism that carries the score, not a heavier one that comes with a gene", () => {
  const heavy: SharedItem = { id: "PW:G", label: "Lysosomal membrane protein", type: "Mechanism", weight: 1, edges: ["e1"], kind: "observed" };
  const scored: SharedItem = { id: "PW:M", label: "Membrane protein missing", type: "Mechanism", weight: 0.5575, edges: ["e2"], kind: "observed" };
  // The heavier one comes with a shared gene, so one mechanism counts.
  const result: Spec = {
    status: "partial",
    score: 0.5575,
    support: "observed",
    shared: [heavy, scored],
    details: { most_specific: "PW:M", n: 3, N: 5, atlas: 5, independent_mechanisms: 1 },
  };
  const grade = synthesizePair("A", "B", dims({ mechanism: result }));
  assert.equal(grade.tier_reason, "Exploratory: both are missing a membrane protein (3 of 5 diseases here).");
  // When some diseases have no mechanism on record, the reach says what N counts.
  const wider = synthesizePair("A", "B", dims({ mechanism: { ...result, details: { most_specific: "PW:M", n: 3, N: 5, atlas: 98, independent_mechanisms: 1 } } }));
  assert.equal(wider.tier_reason, "Exploratory: both are missing a membrane protein (3 of the 5 diseases with a mechanism on record).");
});

test("a pathway their genes are in is named as one they share, the most specific here, not as the disease mechanism", () => {
  const pathway = (id: string, label: string, weight: number): SharedItem => ({ id, label, type: "Mechanism", weight, edges: [`e-${id}`], kind: "observed" });
  const shared = [
    pathway("PW:H", "Hyaluronan degradation", 0.72),
    pathway("PW:K", "Keratan sulfate degradation", 0.51),
    pathway("PW:G", "Glycosphingolipid catabolism", 0.33),
  ];
  const result: Spec = { status: "match", score: 0.72, support: "observed", shared, details: { most_specific: "PW:H", n: 2, N: 81, atlas: 93, via_genes: true } };
  assert.equal(
    synthesizePair("A", "B", dims({ mechanism: result })).tier_reason,
    "Moderate: their genes share 3 mechanisms, of which the most specific here is hyaluronan degradation (2 of the 81 diseases with a mechanism on record).",
  );
  const one: Spec = { ...result, shared: [shared[0]] };
  assert.equal(
    synthesizePair("A", "B", dims({ mechanism: one })).tier_reason,
    "Moderate: their genes share one mechanism, hyaluronan degradation (2 of the 81 diseases with a mechanism on record).",
  );
});

test("a variant type conflict caps at moderate", () => {
  const grade = synthesizePair(
    "A",
    "B",
    dims({
      gene: { ...observedMatch, shared: [{ id: "HGNC:1", label: "GENEA", type: "Gene", weight: 1, edges: ["e1"], kind: "observed" }] },
      mechanism: enzyme,
      variant: { status: "none", score: 0, flags: ["derived_from_variant_notation", "variant_type_conflict"] },
    }),
  );
  assert.equal(grade.biology, 0.94);
  assert.equal(grade.tier, "moderate");
  assert.match(grade.tier_reason, /^Capped at moderate: one disease's variants are mostly loss-of-function and the other's are not\. Both are caused by the same gene \(GENEA\), and both are missing/);
});

test("contradicted biology evidence caps at exploratory; disputed symptoms or research links do not", () => {
  const disputed = synthesizePair("A", "B", dims({ mechanism: { ...enzyme, flags: ["contradicted_evidence"] }, variant: mostlyLof }));
  assert.equal(disputed.tier, "exploratory");
  assert.match(disputed.tier_reason, /^Capped at exploratory: a source disputes part of the evidence\./);
  assert.ok(disputed.flags.includes("contradicted_evidence"));

  for (const elsewhere of ["phenotype", "grant"] as const) {
    const grade = synthesizePair(
      "A",
      "B",
      dims({ mechanism: enzyme, variant: mostlyLof, [elsewhere]: { status: "none", flags: ["contradicted_evidence"] } }),
    );
    assert.equal(grade.tier, "strong", elsewhere);
    assert.ok(grade.flags.includes("contradicted_evidence"));
  }
});

test("AI judgments only lower the biology tier, in the documented way", () => {
  const strong = dims({ mechanism: enzyme, variant: mostlyLof });
  const tierWith = (...judgments: Judgment[]) => synthesizePair("A", "B", strong, judgments).tier;
  assert.equal(tierWith(), "strong");
  assert.equal(tierWith(judgment("supports")), "strong");
  assert.equal(tierWith(judgment("insufficient")), "strong");
  assert.equal(tierWith(judgment("weakens")), "moderate");
  // Several weakening judgments still lower the pair one tier.
  assert.equal(tierWith(judgment("weakens"), judgment("weakens", { dimension: "mechanism" })), "moderate");
  assert.equal(tierWith(judgment("contradicts")), "exploratory");
  assert.equal(tierWith(judgment("supports", { cap_tier: "exploratory" })), "exploratory");
  assert.equal(tierWith(judgment("weakens"), judgment("supports", { cap_tier: "none" })), "none");
  // A judgment about symptoms or shared research cannot move the biology tier; its caveats are kept.
  for (const dimension of ["phenotype", "disease", "grant"] as const) {
    const other = synthesizePair("A", "B", strong, [judgment("contradicts", { dimension, caveats: ["needs_expert_review"] })]);
    assert.equal(other.tier, "strong", dimension);
    assert.ok(other.flags.includes("needs_expert_review"));
  }

  const lowered = synthesizePair("A", "B", strong, [judgment("weakens", { caveats: ["needs_expert_review"] })]);
  assert.match(lowered.tier_reason, /^Lowered to moderate after AI review: /);
  assert.equal(lowered.judgments.length, 1);
  assert.equal(lowered.clinical_tier, synthesizePair("A", "B", strong).clinical_tier);
});

test("no judgment raises a tier, whatever it says", () => {
  const verdicts: Judgment["verdict"][] = ["supports", "weakens", "contradicts", "insufficient"];
  const caps: (Judgment["cap_tier"] | undefined)[] = [undefined, "moderate", "exploratory", "none"];
  const cases = [
    dims({ mechanism: enzyme, variant: mostlyLof }),
    dims({ mechanism: enzyme }),
    dims({ mechanism: family, variant: mostlyLof }),
    dims({ phenotype: { status: "none", score: 0.4 } }),
    dims({}),
  ];
  for (const d of cases) {
    const base = synthesizePair("A", "B", d).tier;
    for (const verdict of verdicts) {
      for (const cap of caps) {
        const tier: Tier = synthesizePair("A", "B", d, [judgment(verdict, cap ? { cap_tier: cap } : {})]).tier;
        assert.ok(TIER_ORDER[tier] <= TIER_ORDER[base], `${verdict}/${cap} raised ${base} to ${tier}`);
      }
    }
  }
});

test("pair flags are the union of dimension flags and caveats, in FLAGS order", () => {
  const grade = synthesizePair(
    "A",
    "B",
    dims({
      phenotype: { status: "match", score: 1, support: "observed", flags: ["few_annotations"] },
      variant: { status: "partial", score: 0.6, flags: ["derived_from_variant_notation"] },
      disease: { status: "partial", score: 0.6, flags: ["sources_disagree"] },
      patient_org: { status: "match", score: 0.5, flags: ["umbrella_resource", "via_mechanism"] },
    }),
    [judgment("supports", { caveats: ["needs_expert_review", "generic_symptoms_only"] })],
  );
  assert.deepEqual(grade.flags, [
    "generic_symptoms_only",
    "few_annotations",
    "derived_from_variant_notation",
    "via_mechanism",
    "umbrella_resource",
    "needs_expert_review",
    "sources_disagree",
  ]);
});

test("clinical reasons name the symptoms, then onset and inheritance when they count", () => {
  const symptoms: Spec = {
    status: "match",
    score: 1,
    percentile: 0.9992,
    support: "observed",
    flags: ["few_annotations"],
    details: { shared_exact: 6, shared_rare: 3, terms_a: 14, terms_b: 8 },
  };
  const context: Spec = { status: "match", score: 1, support: "observed", summary: "Onset: both childhood. Both autosomal recessive." };
  const grade = synthesizePair("A", "B", dims({ phenotype: symptoms, disease: context }), [], { a: "Disease A", b: "Disease B" });
  assert.equal(grade.clinical, 0.85);
  assert.equal(grade.clinical_tier, "very_similar");
  assert.equal(
    grade.clinical_reason,
    "Looks very similar: 6 shared symptoms (3 rare), about as much overlap as two records of the same disease. Few symptoms are on record for Disease B (8), so this comparison is uncertain. Onset: both childhood. Both autosomal recessive.",
  );

  // Symptoms at chance level: onset and inheritance do not count, and the reason says so.
  const chance = synthesizePair("A", "B", dims({ phenotype: { status: "none", score: 0, percentile: 0.6, details: { shared_exact: 1 } }, disease: context }));
  assert.equal(chance.clinical, 0);
  assert.equal(chance.clinical_tier, "different");
  assert.equal(
    chance.clinical_reason,
    "Looks different: 1 shared symptom, no more overlap than many unrelated diseases have. Onset and inheritance only count once the symptoms overlap.",
  );

  const missing = synthesizePair("A", "B", dims({ phenotype: { status: "unknown", summary: "No symptoms on record for Tay-Sachs disease." } }));
  assert.equal(missing.clinical_reason, "Looks different: no symptoms on record for Tay-Sachs disease.");
});

test("a thin record caps the clinical tier at somewhat similar; the score stays what the symptoms give", () => {
  const names = { a: "Disease A", b: "Disease B" };
  const symptoms = (details: Record<string, number | null>): Spec => ({
    status: "match",
    score: 1,
    percentile: 0.9999,
    support: "observed",
    flags: ["few_annotations"],
    details,
  });
  // One shared symptom between records of 2 and 1: as much overlap as one disease described twice,
  // from a single symptom.
  const one = synthesizePair("A", "B", dims({ phenotype: symptoms({ shared_exact: 1, shared_rare: 0, terms_a: 2, terms_b: 1 }) }), [], names);
  assert.equal(one.clinical, 0.75);
  assert.equal(one.clinical_tier, "somewhat");
  assert.equal(
    one.clinical_reason,
    "Capped at looks somewhat similar: few symptoms are on record for Disease A (2) and Disease B (1), and they share only one identical symptom. 1 shared symptom, about as much overlap as two records of the same disease.",
  );
  // A rare one changes nothing when it is the only one.
  assert.equal(thinClinicalEvidence(dims({ phenotype: symptoms({ shared_exact: 1, shared_rare: 1, terms_a: 2, terms_b: 1 }) })), "they share only one identical symptom");
  // Several shared, none rare, on a thin record: capped. Related symptoms only: capped.
  const common = synthesizePair("A", "B", dims({ phenotype: symptoms({ shared_exact: 2, shared_rare: 0, terms_a: 4, terms_b: 6 }) }), [], names);
  assert.equal(common.clinical_tier, "somewhat");
  assert.match(common.clinical_reason, /^Capped at looks somewhat similar: few symptoms are on record for Disease A \(4\) and Disease B \(6\), and none of the 2 symptoms they share is rare\./);
  assert.equal(thinClinicalEvidence(dims({ phenotype: symptoms({ shared_exact: 0, shared_rare: 0, terms_a: 9, terms_b: 8 }) })), "they share no identical symptom, only related ones");
  // Not capped: a rare shared symptom among several, or full records on both sides, or rarity unknown
  // (no reference) with several shared.
  for (const details of [
    { shared_exact: 6, shared_rare: 3, terms_a: 14, terms_b: 8 },
    { shared_exact: 1, shared_rare: 0, terms_a: 12, terms_b: 10 },
    { shared_exact: 3, shared_rare: null, terms_a: 3, terms_b: 3 },
  ]) {
    const grade = synthesizePair("A", "B", dims({ phenotype: symptoms(details) }), [], names);
    assert.equal(grade.clinical_tier, "very_similar", JSON.stringify(details));
    assert.ok(!grade.clinical_reason.startsWith("Capped"), JSON.stringify(details));
  }
  // The cap only lowers: a tier already below it is left alone.
  const low = synthesizePair("A", "B", dims({ phenotype: { ...symptoms({ shared_exact: 1, shared_rare: 0, terms_a: 2, terms_b: 1 }), score: 0.3 } }), [], names);
  assert.equal(low.clinical_tier, "somewhat");
  assert.ok(low.clinical_reason.startsWith("Looks somewhat similar: "));
});
