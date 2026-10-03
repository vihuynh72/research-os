// Shared wording, colors and graph lookups for the atlas UI. Pure functions only: the
// components decide what to show, this file decides how it is said and where it comes from.
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../../lib/graph/types.ts";
import type {
  ClinicalTier,
  Dimension,
  DimensionResult,
  DimensionStatus,
  Flag,
  PairGrade,
  RelevanceCluster,
  RelevanceDoc,
  SharedItem,
  Tier,
} from "../../lib/grading/types.ts";
import { COLLABORATION_DIMENSIONS, pairKey } from "../../lib/grading/types.ts";
import { UMBRELLA_MIN, UMBRELLA_SHARE } from "../../lib/grading/config.ts";
import { classifyVariant, type VariantEffect } from "../../lib/grading/variants.ts";
import { buildGraphIndex, type GraphIndex } from "../../lib/graph/index.ts";
import type { HoodEdge, HoodNode, Neighborhood } from "../../lib/graph/neighborhood.ts";
import { shortLabel } from "../../lib/graph/labels.ts";
import { countLabel, relationLabel } from "../../lib/graph/vocab.ts";

export type Mode = "parent" | "researcher";
export type View = "2d" | "3d";
export type Kind = EdgeKind | "mixed";

// The team's demo disease (CLN3). It only ever appears as a suggested search on the start screen;
// the atlas opens blank and nothing is focused until the person picks something.
export const EXAMPLE_DISEASE = "MONDO:0008767";

export const TIER_WORD: Record<Tier, string> = {
  strong: "Strong",
  moderate: "Moderate",
  exploratory: "Exploratory",
  none: "No supported link",
};

// "How alike they look: very similar", for running text beside the biology tier.
const LOOK_WORD: Record<ClinicalTier, string> = {
  very_similar: "very similar",
  similar: "similar",
  somewhat: "somewhat similar",
  different: "different",
};

export function lookAlikeText(tier: ClinicalTier): string {
  return `How alike they look: ${LOOK_WORD[tier]}`;
}

export const STATUS_WORD: Record<DimensionStatus, string> = {
  match: "Shared",
  partial: "Partly shared",
  none: "Not shared",
  unknown: "Not enough data",
};

export const KIND_WORD: Record<Kind, string> = {
  observed: "observed",
  inferred: "inferred",
  contradicted: "disputed",
  mixed: "observed and inferred",
};

// Coded flags in words a parent can act on. Keep them short and free of jargon.
export const FLAG_TEXT: Record<Flag, string> = {
  generic_symptoms_only: "The shared symptoms are common ones.",
  few_annotations: "One of the two diseases has few symptoms on record.",
  uncalibrated: "Symptom overlap is not yet compared with all other diseases.",
  same_gene_allelic: "They share a gene. Different changes in one gene can still act differently.",
  variant_type_conflict: "In one disease the gene changes mostly switch the gene off; in the other they mostly do not.",
  variant_effect_unknown: "Too few gene changes are on record to compare their type.",
  derived_from_variant_notation: "The type of gene change is read from the variant names, not from a curated source.",
  via_mechanism: "Some groups or resources are linked through the shared mechanism, not to the disease itself.",
  keyword_match_only: "Some links come only from a keyword search.",
  name_match_only: "Some links come only from a directory name match.",
  inferred_only: "No curated source states this link directly; it is inferred.",
  contradicted_evidence: "A source disputes part of this link.",
  umbrella_resource: "A shared group or resource covers most diseases here, so it says little about these two.",
  inactive_or_withdrawn: "A shared study was withdrawn, stopped early or has an unknown status.",
  no_data: "One or both diseases have nothing on record for some kinds of evidence.",
  needs_expert_review: "The AI review asks a specialist to check this link.",
  family_level_only: "They share only the process that defines the whole disease family, which does not tell them apart.",
  sources_disagree: "Published sources give different values here, for example the age symptoms start. A clinician should confirm.",
};

export const TYPE_WORD: Record<NodeType, string> = {
  Disease: "Disease",
  Gene: "Gene",
  Variant: "Variant",
  Mechanism: "Mechanism",
  Phenotype: "Symptom",
  PatientOrg: "Patient group",
  Paper: "Paper",
  Trial: "Clinical study",
  Grant: "Research grant",
  Investigator: "Researcher",
  Asset: "Registry or asset",
};

const TRIAL_STATUS: Record<string, string> = {
  RECRUITING: "Recruiting",
  NOT_YET_RECRUITING: "Not yet recruiting",
  ENROLLING_BY_INVITATION: "Enrolling by invitation",
  ACTIVE_NOT_RECRUITING: "Active, not recruiting",
  COMPLETED: "Completed",
  SUSPENDED: "Suspended",
  TERMINATED: "Stopped early",
  WITHDRAWN: "Withdrawn",
  UNKNOWN: "Status unknown",
};

export function trialStatus(node: GraphNode): string | null {
  const raw = node.attributes?.overall_status;
  if (typeof raw !== "string" || !raw) return null;
  return TRIAL_STATUS[raw] ?? raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, " ");
}

export function isRecruiting(node: GraphNode): boolean {
  return node.attributes?.overall_status === "RECRUITING";
}

export function clusterColor(slot: number | null | undefined): string {
  return slot ? `var(--series-${slot})` : "var(--node-gray)";
}

export function formatScore(x: number): string {
  return x.toFixed(2);
}

// 0.9963 -> "99.6%": one decimal near the top of the scale, where the difference matters.
export function formatPercent(p: number): string {
  const pct = p * 100;
  return `${pct >= 99 && pct < 100 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function kindOf(edges: GraphEdge[]): Kind {
  const kinds = new Set(edges.map((e) => e.kind));
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}

export function byLabel(a: GraphNode, b: GraphNode): number {
  return a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---------- the model the components share ----------

export interface AtlasModel {
  graph: AtlasGraph;
  relevance: RelevanceDoc;
  index: GraphIndex;
  edgeById: Map<string, GraphEdge>;
  pairs: Map<string, PairGrade>;
  clusters: Map<string, RelevanceCluster>;
  diseaseCount: number;
}

export function buildModel(graph: AtlasGraph, relevance: RelevanceDoc): AtlasModel {
  return {
    graph,
    relevance,
    index: buildGraphIndex(graph),
    edgeById: new Map(graph.edges.map((e) => [e.id, e])),
    pairs: new Map(relevance.pairs.map((p) => [pairKey(p.a, p.b), p])),
    clusters: new Map(relevance.clusters.map((c) => [c.id, c])),
    diseaseCount: graph.nodes.filter((n) => n.type === "Disease").length,
  };
}

export function nodeOf(model: AtlasModel, id: string): GraphNode | undefined {
  return model.index.byId.get(id);
}

export function pairOf(model: AtlasModel, a: string, b: string): PairGrade | undefined {
  return model.pairs.get(pairKey(a, b));
}

export function clusterOf(model: AtlasModel, diseaseId: string): RelevanceCluster | null {
  const id = model.relevance.diseases[diseaseId]?.cluster;
  return id ? model.clusters.get(id) ?? null : null;
}

export function diseaseColor(model: AtlasModel, diseaseId: string): string {
  return clusterColor(clusterOf(model, diseaseId)?.color_slot);
}

// Suggested first searches for the start screen, all taken from the data: the demo disease (or
// the most central one), a gene that is not just the disease's own name (its own gene, else the
// gene of its closest relative), and its most specific symptom. Nothing here is ever focused
// until the person picks it.
export function exampleNodes(model: AtlasModel): GraphNode[] {
  const { index, relevance } = model;
  const graded = index.diseases.filter((d) => relevance.diseases[d.id]);
  const demo = index.byId.get(EXAMPLE_DISEASE)?.type === "Disease" ? index.byId.get(EXAMPLE_DISEASE)! : mostCentralNode(model, graded);
  if (!demo) return [];
  const diseaseNames = new Set(index.diseases.map((d) => shortLabel(d).toLowerCase()));
  const genesOf = (id: string) =>
    index
      .edgesOf(id)
      .filter((e) => e.kind !== "contradicted")
      .map((e) => index.byId.get(e.subject === id ? e.object : e.subject))
      .filter((n): n is GraphNode => n?.type === "Gene" && !diseaseNames.has(n.label.toLowerCase()))
      .sort(byLabel);
  const related = relevance.diseases[demo.id]?.neighbors ?? [];
  const gene =
    genesOf(demo.id)[0] ??
    related.map((n) => genesOf(n.id)[0]).find(Boolean) ??
    model.graph.nodes.filter((n) => n.type === "Gene" && !diseaseNames.has(n.label.toLowerCase())).sort(byLabel)[0];
  const info = relevance.node_info ?? {};
  const symptom = diseaseProfile(model, demo.id).symptoms
    .map((s) => s.node)
    .sort((a, b) => (info[b.id]?.specificity ?? info[b.id]?.ic ?? 0) - (info[a.id]?.specificity ?? info[a.id]?.ic ?? 0) || byLabel(a, b))[0];
  return [demo, gene, symptom].filter((n): n is GraphNode => !!n);
}

function mostCentralNode(model: AtlasModel, nodes: GraphNode[]): GraphNode | undefined {
  const id = mostCentral(
    model,
    nodes.map((n) => n.id),
  );
  return id ? model.index.byId.get(id) : undefined;
}

// A short display name for any node: the compact synonym of a disease ("CLN3"), otherwise the
// label cut to fit.
export function nodeName(node: Pick<GraphNode, "label" | "synonyms" | "type">, max = 40): string {
  return node.type === "Disease" ? shortLabel(node) : shortLabel({ label: node.label }, max);
}

export const OTHER_CLUSTER = "other";

export interface ClusterRow {
  id: string; // a cluster id, or OTHER_CLUSTER for clusters past the eighth color and unclustered diseases
  label: string;
  size: number;
  color: string;
  lead: string | null; // the most central member, focused when the row is picked
  members: string[];
}

function mostCentral(model: AtlasModel, ids: string[]): string | null {
  const centrality = (id: string) => model.relevance.diseases[id]?.centrality ?? 0;
  const label = (id: string) => model.index.byId.get(id)?.label ?? id;
  return (
    ids
      .filter((id) => model.index.byId.has(id) && model.relevance.diseases[id])
      .sort((a, b) => centrality(b) - centrality(a) || label(a).localeCompare(label(b), "en", { sensitivity: "base" }) || (a < b ? -1 : 1))[0] ?? null
  );
}

// Colored clusters in color-slot order (largest first), then one gray "Other / unclustered" row.
export function clusterRows(model: AtlasModel): ClusterRow[] {
  const colored = model.relevance.clusters
    .filter((c) => c.color_slot !== null)
    .sort((a, b) => (a.color_slot ?? 0) - (b.color_slot ?? 0));
  const rows: ClusterRow[] = colored.map((c) => ({
    id: c.id,
    label: c.label,
    size: c.size,
    color: clusterColor(c.color_slot),
    lead: mostCentral(model, c.members),
    members: [...c.members],
  }));
  const other = [
    ...model.relevance.clusters.filter((c) => c.color_slot === null).flatMap((c) => c.members),
    ...Object.values(model.relevance.diseases)
      .filter((d) => !d.cluster)
      .map((d) => d.id),
  ];
  if (other.length) {
    rows.push({
      id: OTHER_CLUSTER,
      label: "Other / unclustered",
      size: other.length,
      color: clusterColor(null),
      lead: mostCentral(model, other),
      members: other,
    });
  }
  return rows;
}

// ---------- what is selected ----------

export type Selection =
  | { kind: "edge"; id: string; edge: HoodEdge }
  | { kind: "pair"; id: string; node: GraphNode; pair: PairGrade; anchor: string; hoodNode?: HoodNode }
  | { kind: "node"; id: string; node: GraphNode; hoodNode?: HoodNode };

// What the panel explains, in order of precedence: a line on the map; a disease graded against
// the disease in the center (or, when a gene or symptom is in the center, against the disease it
// belongs to that grades it best); any other node. The center itself, a folded group or an id
// the atlas does not know select nothing.
export function resolveSelection(model: AtlasModel, hood: Neighborhood, focusId: string, selectedId: string | null): Selection | null {
  if (!selectedId || selectedId === focusId) return null;
  const edge = hood.edges.find((e) => e.id === selectedId);
  if (edge) return { kind: "edge", id: selectedId, edge };
  const node = nodeOf(model, selectedId);
  if (!node) return null;
  const hoodNode = hood.nodes.find((n) => n.id === selectedId);
  if (hoodNode?.role === "bubble") return null;
  if (node.type === "Disease" && !hood.anchors.includes(node.id)) {
    let best: { pair: PairGrade; anchor: string } | null = null;
    for (const anchor of hood.anchors) {
      const pair = pairOf(model, anchor, node.id);
      if (pair && (!best || pair.relevance > best.pair.relevance)) best = { pair, anchor };
    }
    if (best) return { kind: "pair", id: selectedId, node, pair: best.pair, anchor: best.anchor, hoodNode };
  }
  return { kind: "node", id: selectedId, node, hoodNode };
}

export function clusterRowOf(model: AtlasModel, diseaseId: string): string {
  const cluster = clusterOf(model, diseaseId);
  return cluster && cluster.color_slot !== null ? cluster.id : OTHER_CLUSTER;
}

// A shared item linked to most diseases of the graph says little about one pair (same rule as
// the engine's umbrella_resource flag).
export function isUmbrella(model: AtlasModel, itemId: string): boolean {
  if (model.diseaseCount < UMBRELLA_MIN) return false;
  return model.index.diseasesFor(itemId).length >= UMBRELLA_SHARE * model.diseaseCount;
}

// The umbrella items of one dimension result. The engine lists them in details.umbrella_items,
// so the panel says exactly what was graded; the local rule is only a fallback for files that
// carry the flag without the list.
export function umbrellaIds(model: AtlasModel, dim: DimensionResult | undefined): Set<string> {
  if (!dim || dim.family !== "collaboration") return new Set();
  const listed = dim.details?.umbrella_items;
  if (typeof listed === "string") return new Set(listed.split(" ").filter(Boolean));
  if (!dim.flags.includes("umbrella_resource")) return new Set();
  return new Set(dim.shared.filter((s) => isUmbrella(model, s.id)).map((s) => s.id));
}

export interface SharedResearch {
  dimension: Dimension;
  specific: SharedItem[];
  umbrella: SharedItem[];
}

export function sharedResearch(model: AtlasModel, pair: PairGrade): SharedResearch[] {
  return COLLABORATION_DIMENSIONS.map((dimension) => {
    const dim = pair.dimensions[dimension];
    const shared = dim?.shared ?? [];
    const umbrella = umbrellaIds(model, dim);
    return {
      dimension,
      specific: shared.filter((s) => !umbrella.has(s.id)),
      umbrella: shared.filter((s) => umbrella.has(s.id)),
    };
  }).filter((r) => r.specific.length || r.umbrella.length);
}

const RESEARCH_TYPE: Record<string, NodeType> = {
  patient_org: "PatientOrg",
  paper: "Paper",
  trial: "Trial",
  grant: "Grant",
  investigator: "Investigator",
  asset: "Asset",
};

// "1 research grant, 1 researcher": shared work that is specific to the two diseases.
// Umbrella items (covering most diseases here) are left out because they say little.
export function researchSummary(model: AtlasModel, pair: PairGrade): string {
  return sharedResearch(model, pair)
    .filter((r) => r.specific.length)
    .map((r) => countLabel(RESEARCH_TYPE[r.dimension], r.specific.length))
    .join(", ");
}

export interface NeighborRow {
  id: string;
  node: GraphNode;
  short: string;
  color: string;
  tier: Tier;
  relevance: number;
  reason: string;
  clinicalTier: ClinicalTier | null; // how alike they look; null in grade files before engine 0.2.0
  research: string; // shared work specific to the pair, e.g. "1 research grant, 1 researcher"
  broadOnly: boolean; // nothing specific, but they share resources that cover most diseases here
  pair: PairGrade;
}

// What the list says about shared work, in one phrase.
export function researchText(row: Pick<NeighborRow, "research" | "broadOnly">): string {
  return row.research || (row.broadOnly ? "Only resources shared by most diseases here" : "None on record");
}

export function neighborRows(model: AtlasModel, focusId: string): NeighborRow[] {
  const entry = model.relevance.diseases[focusId];
  if (!entry) return [];
  return entry.neighbors.flatMap((n) => {
    const node = nodeOf(model, n.id);
    const pair = pairOf(model, focusId, n.id);
    if (!node || !pair) return [];
    return [
      {
        id: n.id,
        node,
        short: shortLabel(node),
        color: diseaseColor(model, n.id),
        tier: n.tier,
        relevance: n.relevance,
        reason: pair.tier_reason,
        clinicalTier: pair.clinical_tier ?? null,
        research: researchSummary(model, pair),
        broadOnly: sharedResearch(model, pair).some((r) => r.umbrella.length > 0),
        pair,
      },
    ];
  });
}

// ---------- what the graph says about one disease ----------

export interface LinkedItem {
  node: GraphNode;
  edges: GraphEdge[]; // the edges that tie the disease to the item, sorted by id
  via?: GraphNode; // the node the link passes through, when it is not direct
  kind: Kind;
}

export interface DiseaseProfile {
  genes: LinkedItem[];
  variants: LinkedItem[];
  mechanisms: LinkedItem[];
  symptoms: LinkedItem[]; // most specific first when the reference gives information content
  context: LinkedItem[]; // inheritance and onset terms
  orgs: LinkedItem[];
  assets: LinkedItem[];
  papers: LinkedItem[];
  trials: LinkedItem[];
  grants: LinkedItem[];
  investigators: LinkedItem[];
  disputed: { edge: GraphEdge; other: GraphNode }[];
}

// Mirrors the engine's adjacency rules (spec section 2) so the panel shows the same items
// the grades were computed from: direct links, plus links through a gene, mechanism or grant.
export function diseaseProfile(model: AtlasModel, diseaseId: string): DiseaseProfile {
  const { index } = model;
  const live = (id: string) => index.edgesOf(id).filter((e) => e.kind !== "contradicted");
  const neighbors = (id: string, type: NodeType) =>
    live(id).flatMap((edge) => {
      const other = index.byId.get(edge.subject === id ? edge.object : edge.subject);
      return other && other.type === type && other.id !== id ? [{ node: other, edge }] : [];
    });

  const collect = () => new Map<string, { node: GraphNode; edges: Map<string, GraphEdge>; via?: GraphNode; direct: boolean }>();
  const add = (
    into: ReturnType<typeof collect>,
    node: GraphNode,
    edges: GraphEdge[],
    via?: GraphNode,
  ) => {
    const cur = into.get(node.id);
    if (cur) {
      for (const e of edges) cur.edges.set(e.id, e);
      if (!via) cur.direct = true;
      return;
    }
    into.set(node.id, { node, edges: new Map(edges.map((e) => [e.id, e])), via, direct: !via });
  };
  const finish = (from: ReturnType<typeof collect>): LinkedItem[] =>
    [...from.values()]
      .map(({ node, edges, via, direct }) => {
        const list = [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
        return { node, edges: list, via: direct ? undefined : via, kind: kindOf(list) };
      })
      .sort((a, b) => byLabel(a.node, b.node));

  const genes = collect();
  for (const g of neighbors(diseaseId, "Gene")) add(genes, g.node, [g.edge]);

  const variants = collect();
  for (const v of neighbors(diseaseId, "Variant")) add(variants, v.node, [v.edge]);
  for (const g of genes.values()) {
    const geneEdges = [...g.edges.values()];
    for (const v of neighbors(g.node.id, "Variant")) add(variants, v.node, [...geneEdges, v.edge], g.node);
  }

  const mechanisms = collect();
  for (const m of neighbors(diseaseId, "Mechanism")) add(mechanisms, m.node, [m.edge]);
  for (const g of genes.values()) {
    const geneEdges = [...g.edges.values()];
    for (const m of neighbors(g.node.id, "Mechanism")) add(mechanisms, m.node, [...geneEdges, m.edge], g.node);
  }

  const info = model.relevance.node_info ?? {};
  const symptoms = collect();
  const context = collect();
  for (const p of neighbors(diseaseId, "Phenotype")) {
    const aspect = info[p.node.id]?.aspect;
    if (aspect === "I" || aspect === "C") add(context, p.node, [p.edge]);
    else if (aspect === undefined || aspect === "P") add(symptoms, p.node, [p.edge]);
  }

  const throughHubs = (type: NodeType, hubs: ReturnType<typeof collect>[]) => {
    const out = collect();
    for (const x of neighbors(diseaseId, type)) add(out, x.node, [x.edge]);
    for (const hub of hubs) {
      for (const h of hub.values()) {
        const hubEdges = [...h.edges.values()];
        for (const x of neighbors(h.node.id, type)) add(out, x.node, [...hubEdges, x.edge], h.node);
      }
    }
    return out;
  };
  const direct = (type: NodeType) => {
    const out = collect();
    for (const x of neighbors(diseaseId, type)) add(out, x.node, [x.edge]);
    return out;
  };

  const papers = direct("Paper");
  const trials = direct("Trial");
  const grants = direct("Grant");
  const ic = (id: string) => info[id]?.ic ?? -1;
  // Grade files from engine 0.2.0 on rate how specific a mechanism is within the atlas: the one
  // that tells diseases apart comes first, the family-wide process last.
  const specificity = (id: string) => info[id]?.specificity ?? 0;

  return {
    genes: finish(genes),
    variants: finish(variants),
    mechanisms: finish(mechanisms).sort((a, b) => specificity(b.node.id) - specificity(a.node.id) || byLabel(a.node, b.node)),
    symptoms: finish(symptoms).sort((a, b) => ic(b.node.id) - ic(a.node.id) || byLabel(a.node, b.node)),
    context: finish(context),
    orgs: finish(throughHubs("PatientOrg", [mechanisms, genes])),
    assets: finish(throughHubs("Asset", [mechanisms, genes])),
    papers: finish(papers),
    trials: finish(trials),
    grants: finish(grants),
    investigators: finish(throughHubs("Investigator", [grants, papers, trials])),
    disputed: index
      .edgesOf(diseaseId)
      .filter((e) => e.kind === "contradicted")
      .flatMap((edge) => {
        const other = index.byId.get(edge.subject === diseaseId ? edge.object : edge.subject);
        return other ? [{ edge, other }] : [];
      }),
  };
}

// What the engine had to compare for one disease, per dimension, for the "no connection" state.
export function coverageOf(profile: DiseaseProfile): Record<Dimension, number> {
  return {
    gene: profile.genes.length,
    variant: profile.variants.length,
    mechanism: profile.mechanisms.length,
    phenotype: profile.symptoms.length,
    disease: profile.context.length,
    patient_org: profile.orgs.length,
    paper: profile.papers.length,
    trial: profile.trials.length,
    grant: profile.grants.length,
    investigator: profile.investigators.length,
    asset: profile.assets.length,
  };
}

// ---------- the evidence path between two diseases ----------

export interface PathConnector {
  edges: GraphEdge[];
  kind: Kind;
}

export interface PathStep {
  node: GraphNode;
  connector?: PathConnector; // how this step is reached from the previous one
}

// Shortest walk from one node to another using only the given edges (the edges the engine
// cites for a shared item), so every step on screen is an edge with a source.
function walk(model: AtlasModel, from: string, to: string, edgeIds: string[]): GraphEdge[] | null {
  const edges = edgeIds.flatMap((id) => {
    const e = model.edgeById.get(id);
    return e ? [e] : [];
  });
  const prev = new Map<string, { node: string; edge: GraphEdge } | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) break;
    for (const e of edges) {
      const next = e.subject === at ? e.object : e.object === at ? e.subject : null;
      if (next && !prev.has(next)) {
        prev.set(next, { node: at, edge: e });
        queue.push(next);
      }
    }
  }
  if (!prev.has(to)) return null;
  const out: GraphEdge[] = [];
  for (let at = to; prev.get(at); at = prev.get(at)!.node) out.unshift(prev.get(at)!.edge);
  return out;
}

export interface EvidencePath {
  steps: PathStep[];
  sharedTie: SharedItem | null; // the gene, mechanism or symptom in the middle
  sharedGroup: SharedItem | null; // the patient group or registry at the end
  groupIsUmbrella: boolean; // the only shared group covers most diseases here
}

export function evidencePath(model: AtlasModel, pair: PairGrade, focusId: string, otherId: string): EvidencePath | null {
  const focus = nodeOf(model, focusId);
  const other = nodeOf(model, otherId);
  if (!focus || !other) return null;
  const d = pair.dimensions;
  const sharedTie = d.gene?.shared[0] ?? d.mechanism?.shared[0] ?? d.phenotype?.shared[0] ?? null;
  const umbrella = new Set([...umbrellaIds(model, d.patient_org), ...umbrellaIds(model, d.asset)]);
  const groups = [...(d.patient_org?.shared ?? []), ...(d.asset?.shared ?? [])];
  const sharedGroup = groups.find((g) => !umbrella.has(g.id)) ?? groups[0] ?? null;
  const groupIsUmbrella = !!sharedGroup && umbrella.has(sharedGroup.id);

  const steps: PathStep[] = [{ node: focus }];
  const connect = (fromId: string, item: SharedItem, toNode: GraphNode) => {
    const edges = walk(model, fromId, toNode.id, item.edges);
    if (!edges?.length) return false;
    steps.push({ node: toNode, connector: { edges, kind: kindOf(edges) } });
    return true;
  };

  // No single shared item that walks from one disease to the other: show the two ends only.
  const tieNode = sharedTie ? nodeOf(model, sharedTie.id) : undefined;
  if (!sharedTie || !tieNode || !connect(focusId, sharedTie, tieNode) || !connect(tieNode.id, sharedTie, other)) {
    return { steps: [{ node: focus }, { node: other }], sharedTie: null, sharedGroup, groupIsUmbrella };
  }
  const groupNode = sharedGroup ? nodeOf(model, sharedGroup.id) : undefined;
  if (sharedGroup && groupNode) connect(otherId, sharedGroup, groupNode);
  return { steps, sharedTie, sharedGroup, groupIsUmbrella };
}

// The graph edges behind a dimension's shared items, each once, in the dimension's item order
// (strongest item first) so the first sources listed back the strongest claims.
export function sharedEdges(model: AtlasModel, dim: DimensionResult): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const item of dim.shared) {
    for (const id of item.edges) {
      const edge = model.edgeById.get(id);
      if (!edge || seen.has(id)) continue;
      seen.add(id);
      out.push(edge);
    }
  }
  return out;
}

export interface VariantRow {
  node: GraphNode;
  name: string; // the change without its transcript prefix: "c.70_73del (p.Arg24fs)"
  effect: VariantEffect;
}

// The variants the variant-type line was computed from (the disease's own and its genes'),
// classified with the engine's own reader, so the panel can show how "2 of 3" was counted.
export function variantRows(model: AtlasModel, diseaseId: string): VariantRow[] {
  return diseaseProfile(model, diseaseId).variants.map(({ node }) => ({
    node,
    name: node.label.replace(/^[^\s:()]+\([^)]*\):/, ""),
    effect: classifyVariant(node.label),
  }));
}

// Names for evidence sentences: in full, except that a gene and its disease often share a name
// ("CLN3"), so the sentence says which is which: "CLN3 gene causes CLN3 disease".
export function evidenceName(node: GraphNode): string {
  if (node.type === "Gene") return `${node.label} gene`;
  if (node.type === "Disease") {
    const short = shortLabel(node);
    return short !== node.label && !short.endsWith("…") ? `${short} disease` : node.label;
  }
  return node.label;
}

// "BDFA UK works on Lysosomal lipofuscin accumulation": an edge read as a sentence, always in
// the edge's own direction so the wording matches the source.
export function edgeSentence(model: AtlasModel, edge: GraphEdge, name: (n: GraphNode) => string = evidenceName): string {
  const s = nodeOf(model, edge.subject);
  const o = nodeOf(model, edge.object);
  // Onset and inheritance are stored as phenotypes, but they are not symptoms.
  const aspect = model.relevance.node_info?.[edge.object]?.aspect;
  const relation = edge.type === "has_phenotype" && (aspect === "I" || aspect === "C") ? "has" : relationLabel(edge.type);
  return `${s ? name(s) : edge.subject} ${relation} ${o ? name(o) : edge.object}`;
}
