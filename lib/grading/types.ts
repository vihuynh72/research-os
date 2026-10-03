// Contract for the grading layer: what lib/grading computes from graph.json, what
// public/relevance*.json holds for the UI, and what the AI grading workflow may return.
// Keep in sync with lib/grading/judgments.schema.json and docs/grading.md.
import type { EdgeKind, NodeType } from "../graph/types.ts";

export const ENGINE_VERSION = "0.2.0";

// Three questions, three scores, never mixed:
// biology       "who shares our biology?"  (gene, variant type, molecular mechanism) sets map distance;
// clinical      "who looks like us?"        (symptoms, onset, inheritance) shown beside it;
// collaboration "who already works alongside us?" (groups, papers, studies, grants, people, assets).
// Shared funding never makes two diseases look biologically similar, and two diseases that look
// alike clinically can still be broken in different ways (the NCLs are the textbook case).
export const BIOLOGY_DIMENSIONS = ["gene", "variant", "mechanism"] as const;
export const CLINICAL_DIMENSIONS = ["phenotype", "disease"] as const;
export const COLLABORATION_DIMENSIONS = ["patient_org", "paper", "trial", "grant", "investigator", "asset"] as const;
export const DIMENSIONS = [...BIOLOGY_DIMENSIONS, ...CLINICAL_DIMENSIONS, ...COLLABORATION_DIMENSIONS] as const;

export type BiologyDimension = (typeof BIOLOGY_DIMENSIONS)[number];
export type ClinicalDimension = (typeof CLINICAL_DIMENSIONS)[number];
export type CollaborationDimension = (typeof COLLABORATION_DIMENSIONS)[number];
export type Dimension = BiologyDimension | ClinicalDimension | CollaborationDimension;
export type Family = "biology" | "clinical" | "collaboration";

export const DIMENSION_FAMILY: Record<Dimension, Family> = {
  gene: "biology",
  variant: "biology",
  mechanism: "biology",
  phenotype: "clinical",
  disease: "clinical",
  patient_org: "collaboration",
  paper: "collaboration",
  trial: "collaboration",
  grant: "collaboration",
  investigator: "collaboration",
  asset: "collaboration",
};

// Plain-language names for the UI and for prompts.
export const DIMENSION_LABEL: Record<Dimension, string> = {
  gene: "Same gene",
  variant: "Variant type",
  mechanism: "Same mechanism",
  phenotype: "Shared symptoms",
  disease: "Onset and inheritance",
  patient_org: "Patient groups",
  paper: "Papers",
  trial: "Clinical studies",
  grant: "Research grants",
  investigator: "Researchers",
  asset: "Registries and assets",
};

// Coded caveats. The engine sets some deterministically; the AI judge may add any of them.
export const FLAGS = [
  "generic_symptoms_only", // every shared symptom is common across diseases
  "few_annotations", // one disease has fewer than MIN_ANNOTATIONS symptoms on record
  "uncalibrated", // no background reference; scores are raw overlap, not percentiles
  "same_gene_allelic", // same gene: can still mean different mechanisms, check variant effect
  "variant_type_conflict", // one side loss-of-function, the other not
  "variant_effect_unknown", // too few classified variants to compare
  "derived_from_variant_notation", // variant type parsed from HGVS notation, not curated
  "via_mechanism", // linked through a shared mechanism node, not directly to the disease
  "keyword_match_only", // supported only by title or keyword search hits
  "name_match_only", // supported only by a directory name match
  "inferred_only", // no observed edge supports this line of evidence
  "contradicted_evidence", // a contradicted edge touches this link
  "umbrella_resource", // the shared item covers most diseases in the graph, so it says little
  "inactive_or_withdrawn", // shared study is withdrawn, terminated or unknown status
  "no_data", // one or both diseases have nothing recorded in this dimension
  "needs_expert_review", // the AI judge asks for a specialist to check
  "family_level_only", // the only shared mechanism is one most diseases here share (e.g. the family's defining process)
  "sources_disagree", // curated sources give different values (e.g. age at onset); a clinician should confirm
] as const;
export type Flag = (typeof FLAGS)[number];

export type Tier = "strong" | "moderate" | "exploratory" | "none";
export const TIER_ORDER: Record<Tier, number> = { strong: 3, moderate: 2, exploratory: 1, none: 0 };
export type ClinicalTier = "very_similar" | "similar" | "somewhat" | "different";
export const CLINICAL_TIER_WORD: Record<ClinicalTier, string> = {
  very_similar: "Looks very similar",
  similar: "Looks similar",
  somewhat: "Looks somewhat similar",
  different: "Looks different",
};
export type Support = "observed" | "inferred";
export type DimensionStatus = "match" | "partial" | "none" | "unknown";

export interface SharedItem {
  id: string;
  label: string;
  type: NodeType;
  weight: number; // 0..1 informativeness (normalized IC for symptoms, 1 otherwise)
  edges: string[]; // edge ids that tie both diseases to this item, sorted
  via?: string; // node the link passes through, e.g. a Mechanism shared by an org
  kind: EdgeKind | "mixed"; // provenance of `edges`
}

export interface DimensionResult {
  dimension: Dimension;
  family: Family;
  score: number; // 0..1, the input to synthesis
  raw?: number; // uncalibrated measure when it differs from score (e.g. phenotype SimGIC)
  percentile?: number; // phenotype: share of random disease pairs scoring lower (0..1)
  status: DimensionStatus;
  coverage: { a: number; b: number }; // items each disease has in this dimension
  shared: SharedItem[]; // sorted by weight desc, then label, then id
  support: Support | null; // observed when a shared item has observed edges on both sides
  summary: string; // deterministic plain-language sentence
  flags: Flag[];
  details?: Record<string, number | string | boolean | null>;
}

export type Verdict = "supports" | "weakens" | "contradicts" | "insufficient";
export type Confidence = "high" | "medium" | "low";

// One AI judgment. It can only lower a tier or add caveats; it never raises a grade.
export interface Judgment {
  a: string;
  b: string;
  dimension: Dimension | "overall";
  verdict: Verdict;
  confidence: Confidence;
  cap_tier?: Exclude<Tier, "strong">;
  rationale: string;
  cited_edges: string[];
  caveats: Flag[];
  runs: number;
  agreement: number; // share of runs that returned this verdict
}

export interface JudgmentsDoc {
  meta: {
    generated_at: string;
    workflow: string;
    prompt_version: string;
    models: Record<string, string>;
    engine_version: string;
    bundles_hash: string;
    runs_per_judgment?: number;
  };
  judgments: Judgment[];
}

export interface PairGrade {
  a: string; // a < b (string order)
  b: string;
  biology: number; // noisy-OR over biology dimensions
  clinical: number; // noisy-OR over clinical dimensions
  collaboration: number; // noisy-OR over collaboration dimensions
  relevance: number; // = biology; the number the map's distance encodes
  tier: Tier; // biology tier
  tier_reason: string;
  clinical_tier: ClinicalTier;
  clinical_reason: string;
  support: Support | null;
  lines_of_evidence: BiologyDimension[]; // biology dimensions with status "match"
  dimensions: Record<Dimension, DimensionResult>;
  flags: Flag[];
  judgments: Judgment[]; // applied AI judgments, empty for the deterministic baseline
}

export interface NeighborRef {
  id: string;
  tier: Tier;
  relevance: number;
  clinical: number;
  collaboration: number;
}

export interface DiseaseEntry {
  id: string;
  cluster: string | null;
  centrality: number; // 0..1 normalized weighted degree over strong and moderate links
  bridge: boolean; // has strong or moderate links into another cluster
  coords3d: [number, number, number]; // classical MDS of (1 - biology), unit sphere
  neighbors: NeighborRef[]; // top MAX_NEIGHBORS with tier != "none", best first (biology)
  hidden: number; // further links with tier != "none" beyond MAX_NEIGHBORS
  clinical_neighbors: NeighborRef[]; // top MAX_NEIGHBORS by clinical score with clinical tier != "different"
}

export interface RelevanceCluster {
  id: string;
  label: string;
  size: number;
  members: string[];
  mechanisms: string[]; // mechanism ids that name the cluster
  color_slot: number | null; // 1..8 categorical slot, null folds into "Other"
}

export interface Bridge {
  a: string;
  b: string;
  cross_cluster: boolean;
  reason: string; // e.g. "Same NIH grant and researcher"
  dimensions: CollaborationDimension[];
  edges: string[];
}

export interface RelevanceDoc {
  meta: {
    version: "0.2.0";
    engine_version: string;
    graph_generated_at: string;
    generated_at: string; // equals graph_generated_at so output is reproducible
    method: "deterministic-baseline" | "agent-judged";
    ic_source: "hpo-annotations" | "uniform";
    reference?: { hpo_version: string; n_diseases: number; null_pairs: number };
    caps: Record<Dimension, number>;
    thresholds: { strong: number; moderate: number; exploratory: number };
    clinical_thresholds: { very_similar: number; similar: number; somewhat: number };
    // Symptom scale: raw SimGIC at the 99th percentile of random pairs maps to 0, the median SimGIC
    // of two records of the same disease (OMIM vs Orphanet) maps to 1.
    symptom_scale?: { floor: number; top: number; same_disease_pairs: number };
    max_neighbors: number;
    notes: string[];
  };
  clusters: RelevanceCluster[];
  diseases: Record<string, DiseaseEntry>;
  pairs: PairGrade[];
  bridges: Bridge[];
  // Per-node facts the map needs that graph.json does not carry. Phenotype nodes: normalized
  // information content, specificity and HPO aspect. Mechanism nodes: specificity within this atlas
  // (how few diseases share it) and how many diseases it reaches.
  node_info?: Record<string, { ic?: number; specificity?: number; aspect?: HpoAspect; diseases?: number }>;
}

// Background reference for symptoms, built by scripts/build-hpo-reference.ts.
export type HpoAspect = "P" | "I" | "C" | "M" | "other"; // phenotype, inheritance, clinical course, modifier

export interface HpoTerm {
  label: string;
  ic: number; // normalized information content 0..1: -ln(share of diseases with the term) / ln(N)
  // Share of recorded disease-symptom annotations (aspect P) whose term is more common than this one:
  // "more specific than X% of the symptoms recorded for rare diseases". Drives symptom relevance on the map.
  specificity?: number;
  ancestors: string[]; // every ancestor up to the root, excluding the term itself, sorted
  aspect: HpoAspect;
  obsolete?: boolean;
  replaced_by?: string;
}

export interface HpoReference {
  meta: {
    hpo_version: string;
    annotations_version: string;
    n_diseases: number;
    ic_formula: string;
    sources: string[];
    null: {
      pairs: number;
      seed: number;
      mean: number;
      quantiles: { p: number; value: number }[]; // SimGIC of random disease pairs, ascending p
    };
    // SimGIC between two records of the same disease (OMIM and Orphanet entries with the same name,
    // both with >= 5 symptoms): the realistic ceiling for "looks the same".
    same_disease?: { pairs: number; quantiles: { p: number; value: number }[] };
  };
  terms: Record<string, HpoTerm>;
}

// Self-contained evidence for one pair, sent to the AI grading workflow.
export interface PairBundle {
  a: string;
  b: string;
  labels: { a: string; b: string };
  dimensions: Record<Dimension, DimensionResult>;
  edges: Record<string, { id: string; type: string; subject: string; object: string; source: string; url: string; kind: EdgeKind; confidence: number; evidence?: string }>;
  nodes: Record<string, { id: string; type: NodeType; label: string; url: string }>;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
