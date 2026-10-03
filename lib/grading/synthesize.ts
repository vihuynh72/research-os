// Turns the eleven dimension results of a pair into three scores that are never mixed: biology
// (the only number that moves a disease on the map) with its tier, clinical resemblance with its
// own tier, and collaboration. Caps and AI judgments can only lower the biology tier, never raise it.
import { CAPS, CLINICAL_THRESHOLDS, MIN_ANNOTATIONS, TIER_THRESHOLDS } from "./config.ts";
import { joinList, mechanismPhrase, round, sentence, symptomAnchor, type LofKind } from "./dimensions.ts";
import {
  BIOLOGY_DIMENSIONS,
  CLINICAL_DIMENSIONS,
  CLINICAL_TIER_WORD,
  COLLABORATION_DIMENSIONS,
  DIMENSIONS,
  FLAGS,
  TIER_ORDER,
  type BiologyDimension,
  type ClinicalDimension,
  type ClinicalTier,
  type Dimension,
  type DimensionResult,
  type Flag,
  type Judgment,
  type PairGrade,
  type Support,
  type Tier,
} from "./types.ts";

type Dimensions = Record<Dimension, DimensionResult>;

const PRIMARY_BIOLOGY: readonly BiologyDimension[] = ["gene", "mechanism"];

// 1 - prod(1 - cap * score): each line of evidence can move a pair only so far on its own, and
// agreement between lines is what makes a link strong.
export function noisyOr(terms: { cap: number; score: number }[]): number {
  let untouched = 1;
  for (const { cap, score } of terms) untouched *= 1 - cap * score;
  return 1 - untouched;
}

const agrees = (result: DimensionResult) => result.status === "match" || result.status === "partial";

// Variant type only counts once the pair shares a gene or a mechanism, at least partly. Otherwise
// every two diseases with mostly loss-of-function variants would look related.
export function countedBiology(dimensions: Dimensions): BiologyDimension[] {
  const primary = PRIMARY_BIOLOGY.some((d) => agrees(dimensions[d]));
  return BIOLOGY_DIMENSIONS.filter((d) => primary || d !== "variant");
}

// Onset and inheritance only count once the symptoms overlap beyond chance (a symptom score above
// 0, i.e. closer than 99% of random disease pairs). Being autosomal recessive with infantile onset
// is common; on its own it does not make two diseases look alike.
export function countedClinical(dimensions: Dimensions): ClinicalDimension[] {
  return CLINICAL_DIMENSIONS.filter((d) => d !== "disease" || dimensions.phenotype.score > 0);
}

function familyScore(dimensions: Dimensions, counted: readonly Dimension[]): number {
  return round(noisyOr(counted.map((d) => ({ cap: CAPS[d], score: dimensions[d].score }))));
}

export function biologyScore(dimensions: Dimensions): number {
  return familyScore(dimensions, countedBiology(dimensions));
}

export function clinicalScore(dimensions: Dimensions): number {
  return familyScore(dimensions, countedClinical(dimensions));
}

export function collaborationScore(dimensions: Dimensions): number {
  return familyScore(dimensions, COLLABORATION_DIMENSIONS);
}

export function tierFor(biology: number): Tier {
  if (biology >= TIER_THRESHOLDS.strong) return "strong";
  if (biology >= TIER_THRESHOLDS.moderate) return "moderate";
  if (biology >= TIER_THRESHOLDS.exploratory) return "exploratory";
  return "none";
}

export function clinicalTierFor(clinical: number): ClinicalTier {
  if (clinical >= CLINICAL_THRESHOLDS.very_similar) return "very_similar";
  if (clinical >= CLINICAL_THRESHOLDS.similar) return "similar";
  if (clinical >= CLINICAL_THRESHOLDS.somewhat) return "somewhat";
  return "different";
}

const ONE_DOWN: Record<Tier, Tier> = { strong: "moderate", moderate: "exploratory", exploratory: "none", none: "none" };

function isBiology(dimension: Judgment["dimension"]): boolean {
  return (BIOLOGY_DIMENSIONS as readonly string[]).includes(dimension);
}

interface Cap {
  by: "engine" | "review" | "review-lowered";
  reason: string;
}

interface TierState {
  tier: Tier;
  cap: Cap | null; // the last cap that changed the tier
}

function capAt(state: TierState, max: Tier, cap: Cap): TierState {
  return TIER_ORDER[state.tier] > TIER_ORDER[max] ? { tier: max, cap } : state;
}

// Display names for the two diseases, used only in the plain-language reasons.
export interface PairNames {
  a: string;
  b: string;
}

export function synthesizePair(
  a: string,
  b: string,
  dimensions: Dimensions,
  judgments: Judgment[] = [],
  names: PairNames | null = null,
): PairGrade {
  const counted = countedBiology(dimensions);
  const biology = biologyScore(dimensions);
  const clinical = clinicalScore(dimensions);
  const collaboration = collaborationScore(dimensions);
  const lines = counted.filter((d) => dimensions[d].status === "match");
  // The link is drawn solid when some biology it rests on (a full or partial match) is stated by a
  // curated source on both sides, dashed when all of it is inferred.
  const agreeing = counted.filter((d) => agrees(dimensions[d]));
  const support: Support | null = agreeing.some((d) => dimensions[d].support === "observed")
    ? "observed"
    : biology > 0
      ? "inferred"
      : null;

  // Only biology caveats cap the biology tier: a disputed grant link or symptom says nothing about
  // shared molecular biology.
  const biologyFlags = new Set<Flag>(BIOLOGY_DIMENSIONS.flatMap((d) => dimensions[d].flags));
  let state: TierState = { tier: tierFor(biology), cap: null };
  if (state.tier === "strong" && lines.length < 2) {
    const reason = lines.length === 1 ? "only one line of evidence is a full match" : "no line of evidence is a full match";
    state = capAt(state, "moderate", { by: "engine", reason });
  } else if (state.tier === "strong" && !lines.some((d) => dimensions[d].support === "observed")) {
    state = capAt(state, "moderate", { by: "engine", reason: "the main evidence is inferred, not observed" });
  }
  if (biologyFlags.has("variant_type_conflict")) {
    const reason = "one disease's variants are mostly loss-of-function and the other's are not";
    state = capAt(state, "moderate", { by: "engine", reason });
  }
  if (biologyFlags.has("contradicted_evidence")) {
    state = capAt(state, "exploratory", { by: "engine", reason: "a source disputes part of the evidence" });
  }

  // Judgments on clinical or collaboration dimensions add caveats only; the tier is about biology.
  const binding = judgments.filter((j) => j.dimension === "overall" || isBiology(j.dimension));
  if (binding.some((j) => j.verdict === "weakens") && state.tier !== "none") {
    const reason = "the reviewer found the evidence weaker than the scores suggest";
    state = { tier: ONE_DOWN[state.tier], cap: { by: "review-lowered", reason } };
  }
  if (binding.some((j) => j.verdict === "contradicts")) {
    state = capAt(state, "exploratory", { by: "review", reason: "the reviewer found evidence against this link" });
  }
  for (const judgment of binding) {
    if (judgment.cap_tier) state = capAt(state, judgment.cap_tier, { by: "review", reason: "the reviewer capped this link" });
  }

  const flagSet = new Set<Flag>(DIMENSIONS.flatMap((d) => dimensions[d].flags));
  for (const judgment of judgments) for (const caveat of judgment.caveats) flagSet.add(caveat);
  const order = (j: Judgment) => (j.dimension === "overall" ? DIMENSIONS.length : DIMENSIONS.indexOf(j.dimension));
  const applied = judgments
    .map((j) => ({ ...j, a, b }))
    .sort((x, y) => order(x) - order(y));
  const clinicalTier = clinicalTierFor(clinical);

  return {
    a,
    b,
    biology,
    clinical,
    collaboration,
    relevance: biology,
    tier: state.tier,
    tier_reason: tierReason(state, biology, biologyEvidence(dimensions, counted)),
    clinical_tier: clinicalTier,
    clinical_reason: clinicalReason(clinicalTier, dimensions, names),
    support,
    lines_of_evidence: lines,
    dimensions,
    flags: FLAGS.filter((flag) => flagSet.has(flag)),
    judgments: applied,
  };
}

// ---- the tier sentence -------------------------------------------------------------------------

// "A, and B" / "A, B, and C": the clauses are full statements, so they keep their own commas.
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function geneClause(result: DimensionResult): string | null {
  if (result.status !== "match") return null;
  return `both are caused by the same gene (${joinList(result.shared.map((item) => item.label))})`;
}

function mechanismClause(result: DimensionResult): string | null {
  const best = result.shared[0];
  if (!best || (result.status !== "match" && result.status !== "partial")) return null;
  const n = Number(result.details?.n);
  const N = Number(result.details?.N);
  const counted = Number.isFinite(n) && Number.isFinite(N);
  const reach = !counted ? "" : n === N ? ` (all ${N} diseases here)` : ` (${n} of ${N} diseases here)`;
  if (result.flags.includes("family_level_only")) {
    return `they share only ${counted && n !== N ? "a widely shared" : "the family-wide"} process ${best.label}${reach}`;
  }
  const phrase = mechanismPhrase(best.label);
  return result.status === "match" ? phrase : `${phrase}${reach}`;
}

const LOF_CLAUSE: Partial<Record<LofKind, string>> = {
  mostly_lof: "both carry mostly loss-of-function variants",
  mostly_not_lof: "both carry mostly missense or in-frame variants",
};

function variantClause(result: DimensionResult): string | null {
  if (result.status === "partial") return "their variant types partly agree";
  if (result.status !== "match") return null;
  const kind = result.details?.kind_a;
  const same = kind === result.details?.kind_b ? LOF_CLAUSE[kind as LofKind] : undefined;
  return same ?? "their variants have a similar loss-of-function share";
}

// The biology lines in plain words, gene and mechanism first, then the variant modifier.
export function biologyEvidence(dimensions: Dimensions, counted: BiologyDimension[]): string {
  const clauses = [
    counted.includes("gene") ? geneClause(dimensions.gene) : null,
    counted.includes("mechanism") ? mechanismClause(dimensions.mechanism) : null,
    counted.includes("variant") ? variantClause(dimensions.variant) : null,
  ].filter((clause): clause is string => clause !== null);
  return joinClauses(clauses);
}

const TIER_WORD: Record<Tier, string> = { strong: "Strong", moderate: "Moderate", exploratory: "Exploratory", none: "No link" };

function tierReason(state: TierState, biology: number, evidence: string): string {
  const { tier, cap } = state;
  if (cap) {
    let head: string;
    if (cap.by === "engine") head = tier === "none" ? "Not shown" : `Capped at ${tier}`;
    else if (tier === "none") head = "Removed after AI review";
    else head = cap.by === "review-lowered" ? `Lowered to ${tier} after AI review` : `Capped at ${tier} after AI review`;
    return evidence ? `${head}: ${cap.reason}. ${sentence(evidence)}.` : `${head}: ${cap.reason}.`;
  }
  if (tier === "none") {
    return biology > 0
      ? `Too little shared biology to show: ${evidence || "a faint overlap"}.`
      : "No shared biology on record: no common gene or mechanism.";
  }
  return `${TIER_WORD[tier]}: ${evidence || "some shared biology"}.`;
}

// ---- the clinical sentence ---------------------------------------------------------------------

function symptomClause(result: DimensionResult): string {
  if (result.status === "unknown") return result.summary.replace(/\.$/, "").replace(/^No /, "no ");
  const n = Number(result.details?.shared_exact ?? 0);
  const rare = Number(result.details?.shared_rare ?? 0);
  if (result.flags.includes("uncalibrated")) {
    return n ? `${n} shared symptom${n === 1 ? "" : "s"} (raw overlap ${Math.round(result.score * 100)}%, not calibrated)` : "no shared symptoms";
  }
  const shared = n
    ? `${n} shared symptom${n === 1 ? "" : "s"}${rare ? ` (${rare} rare)` : ""}`
    : result.score > 0
      ? "related symptoms but no identical ones"
      : "no identical symptoms";
  const anchor = symptomAnchor(result.score, result.percentile ?? 0);
  const overlap = {
    same_disease: "about as much overlap as two records of the same disease",
    related: "more overlap than unrelated diseases have",
    faint: "a little more overlap than most unrelated diseases, not enough to count",
    chance: "no more overlap than many unrelated diseases have",
  }[anchor];
  return `${shared}, ${overlap}`;
}

// "CLN6 (8)", or "one of them" without names.
function thinRecords(result: DimensionResult, names: PairNames | null): string {
  const sides = [
    { name: names?.a, n: Number(result.details?.terms_a ?? 0) },
    { name: names?.b, n: Number(result.details?.terms_b ?? 0) },
  ].filter((side) => side.n < MIN_ANNOTATIONS);
  if (!names) return sides.length > 1 ? "both of them" : "one of them";
  return joinList(sides.map((side) => `${side.name} (${side.n})`));
}

// The clinical evidence in plain words: symptoms first, then onset and inheritance when they count.
function clinicalReason(tier: ClinicalTier, dimensions: Dimensions, names: PairNames | null): string {
  const phenotype = dimensions.phenotype;
  const context = dimensions.disease;
  const sentences = [`${CLINICAL_TIER_WORD[tier]}: ${symptomClause(phenotype)}.`];
  if (phenotype.flags.includes("few_annotations") && phenotype.status !== "unknown") {
    sentences.push(`Few symptoms are on record for ${thinRecords(phenotype, names)}, so this comparison is uncertain.`);
  }
  if (context.status !== "unknown") {
    if (countedClinical(dimensions).includes("disease")) sentences.push(context.summary);
    else if (context.score > 0) sentences.push("Onset and inheritance only count once the symptoms overlap.");
  }
  return sentences.join(" ");
}
