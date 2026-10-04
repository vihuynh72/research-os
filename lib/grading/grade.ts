// Entry points of the grading engine: grade a whole graph into relevance.json, and build the
// evidence bundles the AI grading workflow judges. Pure functions with no file or network
// access, so scripts, tests and the app all get the same result from the same inputs.
import type { AtlasGraph, GraphNode } from "../graph/types.ts";
import { analyze } from "./analytics.ts";
import {
  CAPS,
  CLINICAL_THRESHOLDS,
  COLLAB_BASE,
  DISEASE_FACET_WEIGHTS,
  GENERIC_IC,
  MAX_NEIGHBORS,
  MECHANISM_FLOOR,
  MECHANISM_STATUS,
  MIN_ANNOTATIONS,
  MIN_ATLAS_FOR_SPECIFICITY,
  ONSET_LADDER,
  PHENOTYPE_STATUS,
  PHENOTYPE_STATUS_UNCALIBRATED,
  ROUND,
  SPECIFIC_IC,
  SYMPTOM_FLOOR_PERCENTILE,
  SYMPTOM_GATE_PERCENTILE,
  SYMPTOM_TOP_FALLBACK,
  TIER_THRESHOLDS,
  UMBRELLA_MIN,
  UMBRELLA_SHARE,
} from "./config.ts";
import {
  CONTEXT_STATUS,
  HUMAN_GENES,
  MIN_CLASSIFIED,
  MOSTLY_LOF,
  ONSET_NEIGHBOUR,
  RARELY_LOF,
  SAME_DISEASE_SCORE,
  VARIANT_STATUS,
  buildContext,
  byText,
  candidatePairs,
  diseaseName,
  isUmbrella,
  mechanismWeight,
  resolveTerm,
  round,
  scoreDimensions,
  umbrellaCutoff,
  type GradingContext,
} from "./dimensions.ts";
import { CLINICAL_ORDER, synthesizePair } from "./synthesize.ts";
import {
  CLINICAL_TIER_WORD,
  DIMENSIONS,
  ENGINE_VERSION,
  TIER_ORDER,
  pairKey,
  type Dimension,
  type DimensionResult,
  type DiseaseEntry,
  type HpoReference,
  type Judgment,
  type JudgmentsDoc,
  type NeighborRef,
  type PairBundle,
  type PairGrade,
  type RelevanceDoc,
} from "./types.ts";

type Dimensions = Record<Dimension, DimensionResult>;

// Edge lists a dimension keeps in its details because they bear on the pair without being behind a
// shared item: contradicted edges, and the onset claims compared when the onsets differ.
const DETAIL_EDGE_LISTS = ["contradicted_edges", "onset_edges"];

// Every edge a pair's evidence rests on: the edges behind each shared item, plus the edges a
// dimension lists in its details. A judgment may only cite these.
export function bundleEdgeIds(dimensions: Dimensions): string[] {
  const ids = new Set<string>();
  for (const dimension of DIMENSIONS) {
    const result = dimensions[dimension];
    for (const item of result.shared) for (const edge of item.edges) ids.add(edge);
    for (const key of DETAIL_EDGE_LISTS) {
      const list = result.details?.[key];
      if (typeof list === "string") for (const edge of list.split(" ")) if (edge) ids.add(edge);
    }
  }
  return [...ids].sort(byText);
}

interface Review {
  byPair: Map<string, Judgment[]>;
  applied: number;
  badCitations: number;
  unknownPairs: number;
}

// A judgment counts only for a pair the engine graded and only if every edge it cites is in
// that pair's evidence. Anything else is ignored and reported, never guessed at.
function acceptJudgments(doc: JudgmentsDoc | null, scored: Map<string, { dimensions: Dimensions }>): Review {
  const review: Review = { byPair: new Map(), applied: 0, badCitations: 0, unknownPairs: 0 };
  for (const judgment of doc?.judgments ?? []) {
    const key = pairKey(judgment.a, judgment.b);
    const pair = judgment.a === judgment.b ? undefined : scored.get(key);
    if (!pair) {
      review.unknownPairs += 1;
      continue;
    }
    const evidence = new Set(bundleEdgeIds(pair.dimensions));
    if (!judgment.cited_edges.every((edge) => evidence.has(edge))) {
      review.badCitations += 1;
      continue;
    }
    const list = review.byPair.get(key);
    if (list) list.push(judgment);
    else review.byPair.set(key, [judgment]);
    review.applied += 1;
  }
  const ignored = review.badCitations + review.unknownPairs;
  if (ignored) {
    console.warn(
      `Ignored ${count(ignored, "AI judgment")}: ${review.badCitations} cite${review.badCitations === 1 ? "s" : ""} edges outside the pair's evidence, ${review.unknownPairs} name${review.unknownPairs === 1 ? "s" : ""} a pair the engine did not grade.`,
    );
  }
  return review;
}

function count(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

// Facts the map needs that graph.json does not carry. Phenotype nodes: how specific the term is and
// its HPO aspect (symptom, inheritance, onset...); obsolete ids report their replacement. Mechanism
// nodes: the weight the engine gives them in this atlas (floored specificity times the pathway-size
// weight) and how many diseases reach them.
function nodeInfo(ctx: GradingContext, graph: AtlasGraph, reference: HpoReference | null): NonNullable<RelevanceDoc["node_info"]> {
  const info: NonNullable<RelevanceDoc["node_info"]> = {};
  const nodes = new Map(graph.nodes.filter((node) => node.type === "Phenotype" || node.type === "Mechanism").map((node) => [node.id, node]));
  for (const id of [...nodes.keys()].sort(byText)) {
    if (nodes.get(id)?.type === "Mechanism") {
      const { weight, n } = mechanismWeight(ctx, id);
      info[id] = { specificity: round(weight), diseases: n };
      continue;
    }
    const resolved = reference ? resolveTerm(reference, id) : null;
    if (!resolved) continue;
    const { ic, specificity, aspect } = resolved.term;
    info[id] = { ic: round(ic), ...(specificity === undefined ? {} : { specificity: round(specificity) }), aspect };
  }
  return info;
}

function byNeighborOrder(x: NeighborRef, y: NeighborRef): number {
  return (
    TIER_ORDER[y.tier] - TIER_ORDER[x.tier] ||
    y.relevance - x.relevance ||
    y.collaboration - x.collaboration ||
    byText(x.id, y.id)
  );
}

// Look-alikes by clinical tier first, as neighbors go by biology tier: a tier capped for a thin
// record ranks below the tiers it was capped from, whatever its score.
function byClinicalOrder(x: { grade: PairGrade; ref: NeighborRef }, y: { grade: PairGrade; ref: NeighborRef }): number {
  return (
    CLINICAL_ORDER[y.grade.clinical_tier] - CLINICAL_ORDER[x.grade.clinical_tier] ||
    y.ref.clinical - x.ref.clinical ||
    y.ref.relevance - x.ref.relevance ||
    y.ref.collaboration - x.ref.collaboration ||
    byText(x.ref.id, y.ref.id)
  );
}

// Every setting behind a grade that the meta fields do not already hold (caps, tier and clinical
// thresholds, the symptom scale and MAX_NEIGHBORS have their own), so a grade can be traced to the
// settings that produced it: the constants of config.ts and the fixed rules of dimensions.ts.
function settingsNote(diseases: number): string {
  return [
    `Settings (lib/grading/config.ts and the fixed rules in lib/grading/dimensions.ts):`,
    `mechanism match at ${MECHANISM_STATUS.match}, specificity once ${MIN_ATLAS_FOR_SPECIFICITY} diseases have a mechanism, pathway size weighed against ${HUMAN_GENES} genes;`,
    `variant type compares only variants that can stand for the disease (linked to it, or of a gene with no other disease here), needs ${MIN_CLASSIFIED} classified a side, matches at ${VARIANT_STATUS.match} or the same kind on both sides (mostly loss-of-function from ${MOSTLY_LOF === 2 / 3 ? "2/3" : round(MOSTLY_LOF)}, mostly missense or in-frame up to ${RARELY_LOF}), partial at ${VARIANT_STATUS.partial}, and counts toward biology only at match or partial;`,
    `symptoms match at ${PHENOTYPE_STATUS.match} and partial at ${PHENOTYPE_STATUS.partial} on the scaled score (raw overlap ${PHENOTYPE_STATUS_UNCALIBRATED.match} and ${PHENOTYPE_STATUS_UNCALIBRATED.partial} without a reference), top ${SYMPTOM_TOP_FALLBACK} when a reference has no same-disease anchor, worded "as much as two records of the same disease" from ${SAME_DISEASE_SCORE};`,
    `a symptom is rare at ic ${SPECIFIC_IC} or more and generic below ${GENERIC_IC}, and fewer than ${MIN_ANNOTATIONS} symptoms is a thin record: a pair with a thin record that shares at most one identical symptom, or no rare one, is at most "${CLINICAL_TIER_WORD.somewhat}";`,
    `onset ladder ${ONSET_LADDER.join(", ")} with neighbouring steps at ${ONSET_NEIGHBOUR}, onset ${DISEASE_FACET_WEIGHTS.onset} and inheritance ${DISEASE_FACET_WEIGHTS.inheritance}, match at ${CONTEXT_STATUS.match} and partial at ${CONTEXT_STATUS.partial};`,
    `collaboration 1 - prod(1 - ${COLLAB_BASE} x w) over shared items, w the item's specificity among the diseases with any item of that kind on record;`,
    `umbrella resources (flagged, never a bridge) are items linked to more than max(${UMBRELLA_MIN}, ${UMBRELLA_SHARE} x N) diseases, ${round(umbrellaCutoff(diseases))} here;`,
    `numbers rounded to ${ROUND} decimals.`,
  ].join(" ");
}

// Which variants can stand for a disease: those linked to it, and those of a gene no other disease
// here has. A gene of several diseases records its variants for the gene.
function variantNote(ctx: GradingContext): string {
  const genes = [...ctx.geneReach.values()];
  const single = genes.filter((n) => n === 1).length;
  return `Variant type compares only the variants that can stand for each disease: those linked to the disease, and those of a gene with no other disease here (${single} of ${genes.length} genes); a gene of several diseases records its variants for the gene, not for any one of its diseases, so those are set aside.`;
}

export function gradeGraph(
  graph: AtlasGraph,
  reference: HpoReference | null,
  judgments: JudgmentsDoc | null = null,
): RelevanceDoc {
  const ctx = buildContext(graph, reference);
  const candidates = candidatePairs(ctx);
  const scored = new Map<string, { a: string; b: string; dimensions: Dimensions }>();
  for (const [a, b] of candidates) scored.set(pairKey(a, b), { a, b, dimensions: scoreDimensions(ctx, a, b) });

  const review = acceptJudgments(judgments, scored);
  const grades = new Map<string, PairGrade>();
  for (const [key, { a, b, dimensions }] of scored) {
    const names = { a: diseaseName(ctx, a), b: diseaseName(ctx, b) };
    grades.set(key, synthesizePair(a, b, dimensions, review.byPair.get(key) ?? [], names));
  }

  const analysis = analyze({
    diseases: ctx.diseases,
    grades: [...grades.values()],
    isUmbrella: (dimension, id) => isUmbrella(ctx, dimension, id),
  });

  const involving = new Map<string, PairGrade[]>();
  for (const grade of grades.values()) {
    for (const id of [grade.a, grade.b]) {
      const list = involving.get(id);
      if (list) list.push(grade);
      else involving.set(id, [grade]);
    }
  }
  const listed = new Set<string>();
  const diseases: Record<string, DiseaseEntry> = {};
  for (const id of ctx.diseases) {
    const refs = (involving.get(id) ?? []).map((grade) => {
      const ref: NeighborRef = {
        id: grade.a === id ? grade.b : grade.a,
        tier: grade.tier,
        relevance: grade.biology,
        clinical: grade.clinical,
        collaboration: grade.collaboration,
      };
      return { grade, ref };
    });
    const links = refs.filter(({ grade }) => grade.tier !== "none").map(({ ref }) => ref).sort(byNeighborOrder);
    const neighbors = links.slice(0, MAX_NEIGHBORS);
    // Diseases that look alike, whatever their biology: the second question a parent asks.
    const lookAlikes = refs
      .filter(({ grade }) => CLINICAL_ORDER[grade.clinical_tier] > CLINICAL_ORDER.different)
      .sort(byClinicalOrder)
      .map(({ ref }) => ref)
      .slice(0, MAX_NEIGHBORS);
    for (const neighbor of [...neighbors, ...lookAlikes]) listed.add(pairKey(id, neighbor.id));
    diseases[id] = {
      id,
      cluster: analysis.clusterOf.get(id) ?? null,
      centrality: analysis.centrality.get(id) ?? 0,
      bridge: analysis.bridgeNodes.has(id),
      coords3d: analysis.coords.get(id) ?? [0, 0, 0],
      neighbors,
      hidden: links.length - neighbors.length,
      clinical_neighbors: lookAlikes,
    };
  }
  // A research bridge between two diseases that list each other nowhere stays in `bridges`, which
  // carries its reason and edges. Adding the whole pair (eleven dimensions) here would let one broad
  // directory listing, such as a group listed for a quarter of the atlas, fill the file the browser
  // loads with hundreds of pairs that share no biology.
  const pairs = [...listed]
    .flatMap((key) => grades.get(key) ?? [])
    .sort((x, y) => byText(x.a, y.a) || byText(x.b, y.b));
  const bridgeOnly = analysis.bridges.filter((bridge) => !listed.has(pairKey(bridge.a, bridge.b))).length;

  const n = ctx.diseases.length;
  const possible = (n * (n - 1)) / 2;
  const notes: string[] = [
    candidates.length === possible
      ? `Graded all ${possible} disease pairs.`
      : `Graded ${candidates.length} of ${possible} disease pairs; the others share no gene, variant or mechanism, too little symptom overlap to score, and no research item beyond umbrella resources.`,
    "Three scores, never mixed: biology (gene, variant type, mechanism) sets the distance on the map; clinical resemblance (symptoms, onset, inheritance) is shown beside it; collaboration (shared groups, papers, studies, grants, researchers, registries) never moves a disease.",
    `Pairs listed: every pair in a disease's biology neighbors or clinical look-alikes${bridgeOnly ? `; ${count(bridgeOnly, "research bridge")} between diseases outside those lists ${bridgeOnly === 1 ? "is" : "are"} in bridges only` : ""}.`,
    `Mechanism specificity within this atlas: a mechanism reached by n of the N diseases that have any mechanism on record (N = ${ctx.mechanismDiseases} of ${n} here) weighs (1 - ln n / ln N) / (1 - ln 2 / ln N), at least ${MECHANISM_FLOOR}; a pair scores the weight of the most specific mechanism both reach, and a mechanism that comes only with a gene the pair shares is not counted again.`,
    variantNote(ctx),
  ];
  if (reference && ctx.scale) {
    const { meta } = reference;
    const { floor, top, sameDiseasePairs } = ctx.scale;
    const anchor = sameDiseasePairs
      ? `the median SimGIC of ${sameDiseasePairs} pairs of OMIM and Orphanet records of the same disease`
      : "a fallback ceiling, because the reference has no same-disease anchor (rebuild it with npm run data:hpo)";
    notes.push(
      `Symptom similarity: SimGIC over HPO ${meta.hpo_version} (annotations ${meta.annotations_version}). Scaled 0 at ${floor} (the ${SYMPTOM_FLOOR_PERCENTILE * 100}th percentile of ${meta.null.pairs} random disease pairs) to 1 at ${top} (${anchor}); pairs below the ${SYMPTOM_GATE_PERCENTILE * 100}th percentile of random pairs score 0. Onset and inheritance count only once the symptoms score above 0.`,
    );
  } else {
    notes.push("No HPO reference: symptom overlap is raw Jaccard (uncalibrated) and onset and inheritance are not assessed.");
  }
  notes.push(settingsNote(n));
  if (ctx.missingTerms.length) {
    notes.push(
      `${ctx.missingTerms.length} phenotype ids are missing from the HPO reference and were left out (rebuild it with npm run data:hpo).`,
    );
  }
  if (ctx.danglingEdges) notes.push(`${ctx.danglingEdges} edges point to nodes missing from the graph and were skipped.`);
  if (judgments) {
    const { meta } = judgments;
    notes.push(`AI review: applied ${review.applied} of ${count(judgments.judgments.length, "judgment")} (${meta.workflow}, prompt ${meta.prompt_version}).`);
    if (review.badCitations) {
      notes.push(`Ignored ${count(review.badCitations, "judgment")} citing edges outside the pair's evidence.`);
    }
    if (review.unknownPairs) notes.push(`Ignored ${count(review.unknownPairs, "judgment")} about pairs the engine did not grade.`);
  }

  const info = nodeInfo(ctx, graph, reference);
  return {
    meta: {
      version: "0.2.0",
      engine_version: ENGINE_VERSION,
      graph_generated_at: graph.meta.generated_at,
      generated_at: graph.meta.generated_at,
      method: review.applied ? "agent-judged" : "deterministic-baseline",
      ic_source: reference ? "hpo-annotations" : "uniform",
      ...(reference
        ? {
            reference: {
              hpo_version: reference.meta.hpo_version,
              n_diseases: reference.meta.n_diseases,
              null_pairs: reference.meta.null.pairs,
            },
          }
        : {}),
      caps: { ...CAPS },
      thresholds: { ...TIER_THRESHOLDS },
      clinical_thresholds: { ...CLINICAL_THRESHOLDS },
      ...(ctx.scale
        ? { symptom_scale: { floor: ctx.scale.floor, top: ctx.scale.top, same_disease_pairs: ctx.scale.sameDiseasePairs } }
        : {}),
      max_neighbors: MAX_NEIGHBORS,
      notes,
    },
    clusters: analysis.clusters,
    diseases,
    pairs,
    bridges: analysis.bridges,
    ...(Object.keys(info).length ? { node_info: info } : {}),
  };
}

// Phenotype labels follow the HPO reference when it has the term (ids are the key; names can be wrong).
function nodeLabel(node: GraphNode, reference: HpoReference | null): string {
  const term = node.type === "Phenotype" ? reference?.terms[node.id] : undefined;
  return term ? term.label : node.label;
}

// One self-contained evidence bundle per output pair, for the AI grading workflow: the 11
// dimension results plus every edge and node they reference (edge endpoints included, so each
// cited edge can be read on its own). Record keys are sorted.
export function buildBundles(graph: AtlasGraph, reference: HpoReference | null, doc: RelevanceDoc): PairBundle[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  return doc.pairs.map((pair) => {
    const nodeIds = new Set<string>([pair.a, pair.b]);
    for (const dimension of DIMENSIONS) {
      for (const item of pair.dimensions[dimension].shared) {
        nodeIds.add(item.id);
        if (item.via) nodeIds.add(item.via);
      }
    }
    const bundleEdges: PairBundle["edges"] = {};
    for (const id of bundleEdgeIds(pair.dimensions)) {
      const edge = edges.get(id);
      if (!edge) continue;
      nodeIds.add(edge.subject);
      nodeIds.add(edge.object);
      bundleEdges[id] = {
        id: edge.id,
        type: edge.type,
        subject: edge.subject,
        object: edge.object,
        source: edge.source,
        url: edge.url,
        kind: edge.kind,
        confidence: edge.confidence,
        ...(edge.evidence === undefined ? {} : { evidence: edge.evidence }),
      };
    }
    const bundleNodes: PairBundle["nodes"] = {};
    for (const id of [...nodeIds].sort(byText)) {
      const node = nodes.get(id);
      const term = reference?.terms[id];
      if (node) bundleNodes[id] = { id, type: node.type, label: nodeLabel(node, reference), url: node.url };
      else if (term) bundleNodes[id] = { id, type: "Phenotype", label: term.label, url: `https://hpo.jax.org/browse/term/${id}` };
    }
    return {
      a: pair.a,
      b: pair.b,
      labels: { a: nodes.get(pair.a)?.label ?? pair.a, b: nodes.get(pair.b)?.label ?? pair.b },
      dimensions: pair.dimensions,
      edges: bundleEdges,
      nodes: bundleNodes,
    };
  });
}

// JSON with object keys sorted at every level and no whitespace: the form bundles_hash is taken
// over, so the hash does not depend on how a file happens to be formatted.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
