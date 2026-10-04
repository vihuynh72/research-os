// Shared wording, colors and graph lookups for the atlas UI. Pure functions only: the
// components decide what to show, this file decides how it is said and where it comes from.
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../../lib/graph/types.ts";
import type {
  Dimension,
  DimensionResult,
  DimensionStatus,
  PairGrade,
  RelevanceCluster,
  RelevanceDoc,
  Tier,
} from "../../lib/grading/types.ts";
import { TIER_ORDER, pairKey } from "../../lib/grading/types.ts";
import { UMBRELLA_MIN, UMBRELLA_SHARE } from "../../lib/grading/config.ts";
import { buildGraphIndex, type GraphIndex, type SearchAliases } from "../../lib/graph/index.ts";
import type { HoodEdge, HoodNode, Neighborhood } from "../../lib/graph/neighborhood.ts";
import { relationLabel } from "../../lib/graph/vocab.ts";
import { compactSynonym, displayName } from "./names.ts";
import { plainClusterName, shortClusterName } from "./explain.ts";

export type Mode = "parent" | "researcher";
export type Kind = EdgeKind | "mixed";

export const TIER_WORD: Record<Tier, string> = {
  strong: "Strong",
  moderate: "Moderate",
  exploratory: "Exploratory",
  none: "No supported link",
};

export function isTier(tier: string): tier is Tier {
  return Object.hasOwn(TIER_ORDER, tier);
}

// The word for any tier in a grade file: the contract's word, else the file's own word
// capitalized, so a tier this app does not know is still named instead of left blank.
export function tierWord(tier: string): string {
  if (isTier(tier)) return TIER_WORD[tier];
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1).replace(/_/g, " ") : "Ungraded";
}

export const STATUS_WORD: Record<DimensionStatus, string> = {
  match: "Shared",
  partial: "Partly shared",
  none: "Not shared",
  unknown: "Not enough data",
};

// A Reactome item is a pathway (a chain of steps inside cells), never a "mechanism": two genes in
// one pathway take part in the same process, which is not the same as two diseases sharing a
// mechanism.
export const TYPE_WORD: Record<NodeType, string> = {
  Disease: "Disease",
  Gene: "Gene",
  Variant: "Gene change",
  Mechanism: "Pathway",
  Phenotype: "Symptom",
  PatientOrg: "Patient group",
  Paper: "Paper",
  Trial: "Clinical study",
  Grant: "Research grant",
  Investigator: "Researcher",
  Asset: "Registry or asset",
};

// The panel's name for each line of evidence the grades compare.
export const DIMENSION_WORD: Record<Dimension, string> = {
  gene: "Same gene",
  variant: "Type of gene change",
  mechanism: "Shared pathway",
  phenotype: "Symptoms",
  disease: "Onset and inheritance",
  patient_org: "Patient groups",
  paper: "Papers",
  grant: "Research grants",
  trial: "Clinical studies",
  investigator: "Researchers",
  asset: "Registries",
};

// The grading engine's sentences (a pair's reasons, a line's summary) call a Reactome item a
// "mechanism". They are shown through this, which says "pathway" and keeps case and plural.
export function engineText(text: string): string {
  return text.replace(/\b(mechanism|Mechanism|MECHANISM)(s|S)?\b/g, (_, word: string, plural = "") =>
    (word === "MECHANISM" ? "PATHWAY" : word[0] === "M" ? "Pathway" : "pathway") + plural,
  );
}

export function clusterColor(slot: number | null | undefined): string {
  return slot ? `var(--series-${slot})` : "var(--node-gray)";
}

export function formatScore(x: number): string {
  return x.toFixed(2);
}

// 0.449 -> "44%": always rounded down, so a percent never crosses the tier cutoff its word is
// on ("Exploratory · 45%" beside the 45% moderate line). One decimal near the top of the scale,
// so nothing short of a perfect match reads as 100%.
export function formatPercent(p: number): string {
  const pct = p * 100;
  return `${pct >= 99 && pct < 100 ? (Math.floor(pct * 10) / 10).toFixed(1) : Math.floor(pct + 1e-6)}%`;
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

export function buildModel(graph: AtlasGraph, relevance: RelevanceDoc, aliases?: SearchAliases | null): AtlasModel {
  return {
    graph,
    relevance,
    index: buildGraphIndex(graph, { aliases }),
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

// The start screen's examples: plain names a parent would search, each leading somewhere. Tay-Sachs
// disease, the gene GBA1 and the symptom "Visual impairment", in that order.
const PREFERRED_EXAMPLES: readonly { id: string; type: NodeType }[] = [
  { id: "MONDO:0010100", type: "Disease" },
  { id: "HGNC:4177", type: "Gene" },
  { id: "HP:0000505", type: "Phenotype" },
];

// Suggested first searches for the start screen: the preferred examples, each replaced by the
// automatic pick of its kind when this data does not have it (or it reaches no disease). Nothing
// here is ever focused until the person picks it.
export function exampleNodes(model: AtlasModel): GraphNode[] {
  const picked = PREFERRED_EXAMPLES.map(({ id, type }) => {
    const node = model.index.byId.get(id);
    return node?.type === type && model.index.diseasesFor(id).length > 0 ? node : undefined;
  });
  const auto = picked.every(Boolean) ? [] : automaticExamples(model);
  return PREFERRED_EXAMPLES.flatMap(({ type }, i) => {
    const node = picked[i] ?? auto.find((n) => n.type === type);
    return node ? [node] : [];
  });
}

// The automatic pick, all taken from the data: a disease that shows what RareVerse is for (it
// shares biology through a pathway with diseases caused by other genes, and has clinical
// look-alikes too), a gene that is not just the disease's own name (its own gene, else the gene of
// its closest relative), and its most specific symptom.
function automaticExamples(model: AtlasModel): GraphNode[] {
  const { index, relevance } = model;
  const demo = demoDisease(model);
  if (!demo) return [];
  const diseaseNames = new Set(index.diseases.map((d) => displayName(d, 200).toLowerCase()));
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

// The disease that tells the atlas's story best: related to diseases of other genes through a
// shared mechanism, with clinical look-alikes, then the most related and most connected.
function demoDisease(model: AtlasModel): GraphNode | undefined {
  const graded = model.index.diseases.filter((d) => model.relevance.diseases[d.id]);
  const score = (d: GraphNode) => {
    const entry = model.relevance.diseases[d.id];
    const pairs = entry.neighbors.map((n) => pairOf(model, d.id, n.id)).filter((p): p is PairGrade => !!p);
    const throughMechanism = pairs.filter((p) => p.lines_of_evidence.includes("mechanism")).length;
    return [Number(throughMechanism > 0), Number(entry.clinical_neighbors.length > 0), Number(d.label.length <= 40), throughMechanism, pairs.length, entry.centrality];
  };
  const ranked = graded.map((d) => ({ d, s: score(d) }));
  ranked.sort((x, y) => {
    for (let i = 0; i < x.s.length; i++) if (x.s[i] !== y.s[i]) return y.s[i] - x.s[i];
    return byLabel(x.d, y.d);
  });
  return ranked[0]?.d ?? mostCentralNode(model, graded);
}

function mostCentralNode(model: AtlasModel, nodes: GraphNode[]): GraphNode | undefined {
  const id = mostCentral(
    model,
    nodes.map((n) => n.id),
  );
  return id ? model.index.byId.get(id) : undefined;
}

export const OTHER_CLUSTER = "other";

export interface ClusterRow {
  id: string; // a cluster id, or OTHER_CLUSTER for clusters past the eighth color and unclustered diseases
  label: string; // in plain words: "Linked to the gene COL2A1", "Shares the melanin biosynthesis pathway"
  short: string; // for map labels and chips: "COL2A1", "Melanin biosynthesis"
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

// A cluster's name in plain words. The grade file names a cluster "Same gene: COL2A1" or after a
// Reactome pathway; a parent reads "Linked to the gene COL2A1" or "Shares the … pathway".
export function clusterName(cluster: Pick<RelevanceCluster, "label"> | null | undefined): string {
  return plainClusterName(cluster?.label);
}

export function clusterShortName(cluster: Pick<RelevanceCluster, "label"> | null | undefined): string {
  return shortClusterName(cluster?.label);
}

// Colored clusters in color-slot order (largest first), then one gray "Not in a group yet" row.
export function clusterRows(model: AtlasModel): ClusterRow[] {
  const colored = model.relevance.clusters
    .filter((c) => c.color_slot !== null)
    .sort((a, b) => (a.color_slot ?? 0) - (b.color_slot ?? 0));
  const rows: ClusterRow[] = colored.map((c) => ({
    id: c.id,
    label: clusterName(c),
    short: clusterShortName(c),
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
      label: "Not in a group yet",
      short: "Not in a group",
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

// Names for evidence sentences: in full, except that a gene and its disease often share a name
// ("CLN3"), so the sentence says which is which: "CLN3 gene causes CLN3 disease".
export function evidenceName(node: GraphNode): string {
  if (node.type === "Gene") return `${node.label} gene`;
  // A title is quoted whole, without its own closing period, so the sentence reads on.
  if (node.type === "Paper" || node.type === "Grant") return `“${node.label.replace(/\.$/, "")}”`;
  if (node.type === "Disease") {
    const short = compactSynonym(node);
    return short && short !== node.label ? `${short} disease` : node.label;
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
