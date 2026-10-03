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
  assert.equal(two.tier_reason, "Strong: both are missing a soluble lysosomal enzyme, and both carry mostly loss-of-function variants.");

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
    "Capped at moderate: only one line of evidence is a full match. Both are missing a soluble lysosomal enzyme, and their variant types partly agree.",
  );
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
  const grade = synthesizePair("A", "B", dims({ phenotype: symptoms, disease: context }), [], { a: "CLN2", b: "CLN6" });
  assert.equal(grade.clinical, 0.85);
  assert.equal(grade.clinical_tier, "very_similar");
  assert.equal(
    grade.clinical_reason,
    "Looks very similar: 6 shared symptoms (3 rare), about as much overlap as two records of the same disease. Few symptoms are on record for CLN6 (8), so this comparison is uncertain. Onset: both childhood. Both autosomal recessive.",
  );

  // Symptoms at chance level: onset and inheritance do not count, and the reason says so.
  const chance = synthesizePair("A", "B", dims({ phenotype: { status: "none", score: 0, percentile: 0.6, details: { shared_exact: 1 } }, disease: context }));
  assert.equal(chance.clinical, 0);
  assert.equal(chance.clinical_tier, "different");
  assert.equal(
    chance.clinical_reason,
    "Looks different: 1 shared symptom, no more overlap than many unrelated diseases have. Onset and inheritance only count once the symptoms overlap.",
  );

  const missing = synthesizePair("A", "B", dims({ phenotype: { status: "unknown", summary: "No symptoms on record for CLN9." } }));
  assert.equal(missing.clinical_reason, "Looks different: no symptoms on record for CLN9.");
});
