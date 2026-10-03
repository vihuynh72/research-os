// Tunable constants for lib/grading. Every value is recorded in relevance.json meta so a
// grade can always be traced to the settings that produced it. Recalibrate when real data lands,
// and keep data/curated/answer_key.json passing (lib/grading/answer-key.test.ts).
import type { Dimension } from "./types.ts";

// Noisy-OR caps: how far one line of evidence can move its family's score on its own.
// score = 1 - prod(1 - cap_d * score_d) within a family (biology, clinical, collaboration).
// Agreement across lines is what makes a link strong, and no combination reaches 1: two
// different diseases are never the same disease.
export const CAPS: Record<Dimension, number> = {
  // biology: a specific shared molecular mechanism is the strongest single line; the same gene can
  // still mean different mechanisms, so it needs the variant line to agree before a link is strong.
  gene: 0.7,
  mechanism: 0.8,
  variant: 0.25, // modifier: counts only when gene or mechanism already supports the pair
  // clinical
  phenotype: 0.75,
  disease: 0.4, // onset (80%) and inheritance (20%)
  // collaboration
  patient_org: 0.5,
  asset: 0.5,
  trial: 0.4,
  investigator: 0.4,
  grant: 0.3,
  paper: 0.3,
};

// Tier cutoffs on the biology score. Strong also needs two independent lines of evidence
// with status "match" and at least one observed edge; see synthesize.ts.
export const TIER_THRESHOLDS = { strong: 0.75, moderate: 0.45, exploratory: 0.2 };

// Clinical resemblance bands, shown beside the biology tier (never used for map distance).
export const CLINICAL_THRESHOLDS = { very_similar: 0.65, similar: 0.4, somewhat: 0.2 };

export const MAX_NEIGHBORS = 10;

// Mechanism specificity within the atlas: a mechanism every disease shares cannot tell them apart.
// weight = (1 - ln n / ln N) / (1 - ln 2 / ln N) for a mechanism reaching n of N diseases, so a
// mechanism shared by exactly two diseases weighs 1 and one shared by all weighs 0, floored at
// MECHANISM_FLOOR so the family's defining process still counts a little. The pair's mechanism score
// is the weight of the most specific mechanism they share (Resnik's "most informative common
// ancestor"), not an overlap ratio: two enzymes with different substrates still share "soluble
// lysosomal enzyme", which is what decides whether a therapy can transfer.
export const MECHANISM_FLOOR = 0.15;
export const MECHANISM_STATUS = { match: 0.6 }; // partial: any shared mechanism above the floor or at it
export const MIN_ATLAS_FOR_SPECIFICITY = 3; // below this many diseases every mechanism weighs 1

// Symptom scale (clinical): raw SimGIC is placed between two empirical anchors from the HPO corpus:
// the 99th percentile of random disease pairs (0) and the median SimGIC of two records of the same
// disease, OMIM versus Orphanet (1). Pairs below the 95th percentile of random pairs score 0.
export const SYMPTOM_GATE_PERCENTILE = 0.95;
export const SYMPTOM_FLOOR_PERCENTILE = 0.99;
export const SYMPTOM_TOP_FALLBACK = 0.32; // median same-disease SimGIC measured on 497 pairs, used if the reference lacks it
export const PHENOTYPE_STATUS = { match: 0.6, partial: 0.25 }; // on the scaled symptom score
export const PHENOTYPE_STATUS_UNCALIBRATED = { match: 0.3, partial: 0.15 }; // raw Jaccard cutoffs

// Onset similarity on the HPO onset ladder (congenital, neonatal, infantile, childhood, juvenile,
// adult): same step 1, neighbouring step 0.5, further apart 0.
export const ONSET_LADDER = ["HP:0003577", "HP:0003623", "HP:0003593", "HP:0011463", "HP:0003621", "HP:0003581"];
export const DISEASE_FACET_WEIGHTS = { onset: 0.8, inheritance: 0.2 };

export const SPECIFIC_IC = 0.5; // normalized IC at or above which a symptom counts as rare
export const GENERIC_IC = 0.3; // below this a shared symptom counts as generic
export const MIN_ANNOTATIONS = 10; // fewer symptoms on record than this makes a comparison weak

// Collaboration dimensions: score = 1 - 0.5^n for n shared items.
export const COLLAB_BASE = 0.5;

// A shared collaboration item linked to at least this share of the graph's diseases is an
// umbrella resource (flagged, and not drawn as a bridge) once the graph has UMBRELLA_MIN diseases.
export const UMBRELLA_SHARE = 0.8;
export const UMBRELLA_MIN = 4;

export const ROUND = 4; // decimals kept in output, so files diff cleanly across machines
