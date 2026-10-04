// The map's knowledge-graph neighborhood around any node: a disease, gene, variant, mechanism,
// symptom, group, study, paper, grant or researcher. It finds the diseases that node belongs to
// (anchors), the diseases related to them by the grading layer, and the evidence around all of them
// (genes, variants, mechanisms, symptoms, groups, research), including indirect evidence that comes
// through a related disease. Every node carries a relevance to the searched node and every line a
// strength, so one threshold filters the whole map. Pure and deterministic; browser and Node.
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "./types.ts";
import type { PairGrade, RelevanceDoc, Tier } from "../grading/types.ts";
import { TIER_ORDER, pairKey } from "../grading/types.ts";
import { shortLabel } from "./labels.ts";
import { countLabel, relationLabel } from "./vocab.ts";

export const HOOD = {
  direct: 1, // a disease's own gene, mechanism, variants, groups and research
  viaGene: 0.95, // a mechanism reached through the disease's gene
  viaHop: 0.9, // one step removed: a group on the disease's mechanism, a researcher on its grant
  symptomDefault: 0.5, // symptom relevance when no HPO reference is loaded
  maxSymptoms: 8, // symptom nodes for the searched disease before the rest fold into a bubble
  maxGroups: 4, // patient groups (and, separately, registries) for the searched disease
  maxMechanisms: 4, // mechanisms for the searched disease, most specific first
  maxRelatedSymptoms: 2, // the same caps for a related disease's own evidence
  maxRelatedGroups: 1,
  maxRelatedMechanisms: 1,
  maxRelated: 10, // related diseases on the map
  maxAnchors: 12, // diseases a gene, symptom or group belongs to, before the rest fold into a bubble
  mergeAfter: 2, // more owners than this folding one type: one shared bubble instead of one each
  ghostBand: 0.25, // items this far below the threshold still show, faintly, without labels
};

// Individual nodes of a type on the whole map, whoever brings them: a ring holds only so many
// nodes, and a crowded sector would otherwise push them away from the distance that encodes their
// relevance. The rest fold into numbered bubbles.
export const MAP_CAP: Partial<Record<NodeType, number>> = { Gene: 8, Mechanism: 6, Phenotype: 10, PatientOrg: 5, Asset: 3 };

// The owner of a bubble that gathers one type from several diseases on the map.
export const SHARED_BUBBLE_OWNER = "others";

// Variants and research always start folded into count bubbles ("3 clinical studies").
export const FOLDED_TYPES: readonly NodeType[] = ["Variant", "Trial", "Paper", "Grant", "Investigator"];

export type HoodRole = "focus" | "anchor" | "related" | "attribute" | "symptom" | "group" | "research" | "bubble";
export type HoodEdgeRole = "evidence" | "similarity" | "bridge" | "bubble";
export type LinkKind = EdgeKind | "mixed";

export interface HoodNode {
  id: string; // graph node id, or "bubble:<owner>:<type>"
  type: NodeType | "Bubble";
  label: string;
  relevance: number; // 0..1 relevance to the searched node
  role: HoodRole;
  owner: string; // the disease (or the searched node) this one hangs off; itself for diseases
  ownerRank: number; // 0 for the searched node and its anchor diseases, then 1, 2... by related-disease order
  hop: number; // steps from the searched node; orders the reveal animation
  why: string; // plain reason for the relevance value
  kind: LinkKind | null; // provenance of the link that put the node here
  tier?: Tier; // related diseases
  cluster?: string | null; // diseases
  bubbleType?: NodeType; // bubbles
  members?: string[]; // bubbles: folded node ids, best first
  memberRelevance?: number[]; // bubbles: relevance of each member, aligned with members
}

export interface HoodEdge {
  id: string;
  a: string;
  b: string;
  strength: number; // how strong this one relationship is, 0..1 (a symptom's specificity, a pair's biology score)
  relevance: number; // strength carried to the searched node; drives width, opacity, glow and filtering
  kind: LinkKind; // dashed unless observed
  role: HoodEdgeRole;
  label: string;
  edgeIds: string[]; // graph edges behind this line, for the evidence panel
}

export interface Neighborhood {
  focus: string;
  focusType: NodeType | null;
  nodes: HoodNode[];
  edges: HoodEdge[];
  anchors: string[]; // diseases the searched node belongs to (the searched disease itself, if it is one)
  related: { id: string; relevance: number; tier: Tier }[]; // graded related diseases, best first
}

export interface HoodOptions {
  expanded?: ReadonlySet<string>; // bubble ids the user opened
  maxSymptoms?: number;
}

interface GraphCache {
  byId: Map<string, GraphNode>;
  edgeById: Map<string, GraphEdge>;
  adjacent: Map<string, Map<string, GraphEdge[]>>; // node -> other node -> edges, contradicted left out
}

const caches = new WeakMap<AtlasGraph, GraphCache>();

function cacheFor(graph: AtlasGraph): GraphCache {
  const hit = caches.get(graph);
  if (hit) return hit;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  const adjacent = new Map<string, Map<string, GraphEdge[]>>();
  const link = (from: string, to: string, edge: GraphEdge) => {
    let row = adjacent.get(from);
    if (!row) adjacent.set(from, (row = new Map()));
    const list = row.get(to);
    if (list) list.push(edge);
    else row.set(to, [edge]);
  };
  for (const edge of [...graph.edges].sort((x, y) => cmp(x.id, y.id))) {
    // Contradicted edges never support a link on the map; the panels list them on their own.
    if (edge.kind === "contradicted" || edge.subject === edge.object) continue;
    link(edge.subject, edge.object, edge);
    link(edge.object, edge.subject, edge);
  }
  const cache = { byId, edgeById, adjacent };
  caches.set(graph, cache);
  return cache;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// "70%"; just under 100% keeps a decimal ("99.6%") so nothing reads as a perfect match.
function pct(x: number): string {
  const p = x * 100;
  return p < 100 && Math.round(p) >= 100 ? `${(Math.floor(p * 10) / 10).toFixed(1)}%` : `${Math.round(p)}%`;
}

// Names inside sentences ("Gene behind ..."): whole up to a long length, so similar diseases
// ("... type 1A", "... type 1B") never read the same.
const NAME_MAX = 64;

export function kindOf(kinds: readonly EdgeKind[]): LinkKind {
  if (!kinds.length) return "inferred";
  return kinds.every((k) => k === kinds[0]) ? kinds[0] : "mixed";
}

interface Adjacent {
  node: GraphNode;
  edges: GraphEdge[];
}

function adjacentOfType(cache: GraphCache, id: string, ...types: NodeType[]): Adjacent[] {
  const out: Adjacent[] = [];
  for (const [other, edges] of cache.adjacent.get(id) ?? []) {
    const node = cache.byId.get(other);
    if (node && types.includes(node.type)) out.push({ node, edges });
  }
  return out.sort((x, y) => cmp(x.node.id, y.node.id));
}

function hasWebsite(node: GraphNode): boolean {
  return typeof node.attributes?.website === "string" && node.attributes.website.length > 0;
}

// specificity: share of recorded rare-disease symptoms that are more common than this one.
export function symptomWhy(specificity: number | undefined): string {
  if (specificity === undefined) return "Symptom. How specific it is is unknown without the HPO reference.";
  const share = Math.round(specificity * 100);
  if (specificity >= 0.85) return `Rare symptom: more specific than ${share}% of recorded symptoms, so sharing it says a lot.`;
  if (specificity >= 0.5) return `Fairly specific symptom: more specific than ${share}% of recorded symptoms.`;
  return `Common symptom: more specific than only ${share}% of recorded symptoms, so sharing it says little.`;
}

export function bubbleId(owner: string, type: NodeType): string {
  return `bubble:${owner}:${type}`;
}

const ROLE_OF: Partial<Record<NodeType, HoodRole>> = {
  Gene: "attribute",
  Variant: "attribute",
  Mechanism: "attribute",
  Phenotype: "symptom",
  PatientOrg: "group",
  Asset: "group",
  Trial: "research",
  Paper: "research",
  Grant: "research",
  Investigator: "research",
};

// One way a node is tied to a disease on the map.
interface Tie {
  node: GraphNode;
  t: number; // strength of this relationship
  hop: number; // 1 direct, 2 through a gene, hub or research item
  via: string; // the node the line is drawn from (the disease, its gene, its mechanism, its grant)
  edges: GraphEdge[];
  why: string;
}

// Everything a disease brings to the map, with the strength of each relationship.
function tiesOf(cache: GraphCache, relevance: RelevanceDoc | null, diseaseId: string): Tie[] {
  const disease = cache.byId.get(diseaseId)!;
  const name = shortLabel(disease, NAME_MAX);
  const info = relevance?.node_info;
  const ties: Tie[] = [];
  const genes = adjacentOfType(cache, diseaseId, "Gene");
  for (const { node, edges } of genes) ties.push({ node, t: HOOD.direct, hop: 1, via: diseaseId, edges, why: `Gene behind ${name}.` });
  for (const { node, edges } of adjacentOfType(cache, diseaseId, "Mechanism")) {
    ties.push({ node, t: HOOD.direct, hop: 1, via: diseaseId, edges, why: `Process disrupted in ${name}.` });
  }
  for (const { node: gene } of genes) {
    for (const { node, edges } of adjacentOfType(cache, gene.id, "Mechanism")) {
      ties.push({ node, t: HOOD.viaGene, hop: 2, via: gene.id, edges, why: `Mechanism of ${gene.label}, the gene behind ${name}.` });
    }
    for (const { node, edges } of adjacentOfType(cache, gene.id, "Variant")) {
      ties.push({ node, t: HOOD.direct, hop: 2, via: gene.id, edges, why: `Variant in ${gene.label}, the gene behind ${name}.` });
    }
  }
  for (const { node, edges } of adjacentOfType(cache, diseaseId, "Variant")) {
    ties.push({ node, t: HOOD.direct, hop: 1, via: diseaseId, edges, why: `Variant recorded for ${name}.` });
  }
  for (const { node, edges } of adjacentOfType(cache, diseaseId, "Phenotype")) {
    const meta = info?.[node.id];
    if (meta?.aspect && meta.aspect !== "P") continue; // onset and inheritance are context, shown in the panel
    // Calibrated specificity reads as a percentage; raw information content is the fallback.
    const specificity = meta?.specificity ?? meta?.ic;
    ties.push({ node, t: specificity ?? HOOD.symptomDefault, hop: 1, via: diseaseId, edges, why: symptomWhy(specificity) });
  }
  const hubs = ties.filter((x) => x.node.type === "Mechanism" || x.node.type === "Gene");
  for (const { node, edges } of adjacentOfType(cache, diseaseId, "PatientOrg", "Asset")) {
    ties.push({ node, t: HOOD.direct, hop: 1, via: diseaseId, edges, why: `Linked directly to ${name}.` });
  }
  for (const hub of hubs) {
    for (const { node, edges } of adjacentOfType(cache, hub.node.id, "PatientOrg", "Asset")) {
      const what = hub.node.type === "Mechanism" ? "mechanism" : "gene";
      ties.push({
        node,
        t: hub.t * HOOD.viaHop,
        hop: hub.hop + 1,
        via: hub.node.id,
        edges,
        why: `Works on the ${what} ${hub.node.label}, which ${name} has.`,
      });
    }
  }
  const research = adjacentOfType(cache, diseaseId, "Trial", "Paper", "Grant");
  for (const { node, edges } of research) ties.push({ node, t: HOOD.direct, hop: 1, via: diseaseId, edges, why: `Linked directly to ${name}.` });
  for (const { node, edges } of adjacentOfType(cache, diseaseId, "Investigator")) {
    ties.push({ node, t: HOOD.direct, hop: 1, via: diseaseId, edges, why: `Works on ${name}.` });
  }
  for (const item of research) {
    for (const { node, edges } of adjacentOfType(cache, item.node.id, "Investigator")) {
      ties.push({
        node,
        t: HOOD.viaHop,
        hop: 2,
        via: item.node.id,
        edges,
        why: `Leads ${item.node.type === "Grant" ? "a grant" : "work"} on ${name}: ${shortLabel(item.node, 60)}.`,
      });
    }
  }
  return ties;
}

// The diseases a non-disease node belongs to, with the path that ties them (genes, hubs, research).
function anchorsOf(cache: GraphCache, focus: GraphNode): { disease: string; r: number; path: Tie[] }[] {
  const out = new Map<string, { disease: string; r: number; path: Tie[] }>();
  const offer = (disease: string, r: number, path: Tie[]) => {
    const prev = out.get(disease);
    if (!prev || r > prev.r) out.set(disease, { disease, r, path });
  };
  const name = shortLabel(focus, NAME_MAX);
  const direct = adjacentOfType(cache, focus.id, "Disease");
  for (const { node, edges } of direct) offer(node.id, HOOD.direct, [{ node, t: HOOD.direct, hop: 1, via: focus.id, edges, why: `${node.label} is linked directly to ${name}.` }]);
  // One step further for nodes that reach diseases through a gene, hub or research item.
  const through: Partial<Record<NodeType, NodeType[]>> = {
    Variant: ["Gene"],
    Mechanism: ["Gene"],
    PatientOrg: ["Mechanism", "Gene"],
    Asset: ["Mechanism", "Gene"],
    Investigator: ["Grant", "Paper", "Trial"],
  };
  const t1 = focus.type === "Variant" || focus.type === "Mechanism" ? HOOD.direct : HOOD.viaHop;
  for (const { node: mid, edges: e1 } of adjacentOfType(cache, focus.id, ...(through[focus.type] ?? []))) {
    for (const { node, edges } of adjacentOfType(cache, mid.id, "Disease")) {
      offer(node.id, t1, [
        { node: mid, t: HOOD.direct, hop: 1, via: focus.id, edges: e1, why: `${mid.label} is linked directly to ${name}.` },
        { node, t: t1, hop: 2, via: mid.id, edges, why: `${node.label} is linked to ${name} through ${shortLabel(mid, NAME_MAX)}.` },
      ]);
    }
  }
  return [...out.values()].sort((x, y) => y.r - x.r || cmp(x.disease, y.disease));
}

export function buildNeighborhood(
  graph: AtlasGraph,
  relevance: RelevanceDoc | null,
  focusId: string,
  opts: HoodOptions = {},
): Neighborhood {
  const cache = cacheFor(graph);
  const focus = cache.byId.get(focusId);
  if (!focus) return { focus: focusId, focusType: null, nodes: [], edges: [], anchors: [], related: [] };

  const expanded = opts.expanded ?? new Set<string>();
  const clusterOf = (id: string) => relevance?.diseases[id]?.cluster ?? null;
  const pairs = new Map<string, PairGrade>((relevance?.pairs ?? []).map((p) => [pairKey(p.a, p.b), p]));
  const nodes = new Map<string, HoodNode>();
  const edges = new Map<string, HoodEdge>();
  const addEdge = (edge: HoodEdge) => {
    if (edge.a === edge.b) return;
    const prev = edges.get(edge.id);
    if (!prev || edge.relevance > prev.relevance) edges.set(edge.id, { ...edge, strength: round(edge.strength), relevance: round(edge.relevance) });
  };

  // 1. The searched node and the diseases it belongs to.
  const anchorList = focus.type === "Disease" ? [{ disease: focusId, r: 1, path: [] as Tie[] }] : anchorsOf(cache, focus);
  nodes.set(focusId, {
    id: focusId,
    type: focus.type,
    label: focus.label,
    relevance: 1,
    role: "focus",
    owner: focusId,
    ownerRank: 0,
    hop: 0,
    why: "What you searched for.",
    kind: null,
    cluster: focus.type === "Disease" ? clusterOf(focusId) : undefined,
  });
  // A gene, symptom or group can belong to many diseases. Past maxAnchors the rest fold into one
  // bubble (the best connected stay out), so the ring of direct links stays readable; the panel
  // still lists every one.
  const anchorBubble = bubbleId(focusId, "Disease");
  const centralityOf = (id: string) => relevance?.diseases[id]?.centrality ?? 0;
  const byWeight = [...anchorList].sort((x, y) => y.r - x.r || centralityOf(y.disease) - centralityOf(x.disease) || cmp(x.disease, y.disease));
  const foldAnchors = focus.type !== "Disease" && anchorList.length > HOOD.maxAnchors && !expanded.has(anchorBubble);
  const mapped = new Set((foldAnchors ? byWeight.slice(0, HOOD.maxAnchors) : byWeight).map((a) => a.disease));
  const diseaseR = new Map<string, number>();
  for (const a of anchorList) {
    diseaseR.set(a.disease, a.r);
    if (!mapped.has(a.disease)) continue;
    for (const step of a.path) {
      const prev = nodes.get(step.node.id);
      const isDisease = step.node.type === "Disease";
      const r = isDisease ? a.r : step.t;
      if (!prev || r > prev.relevance) {
        nodes.set(step.node.id, {
          id: step.node.id,
          type: step.node.type,
          label: step.node.label,
          relevance: round(r),
          role: isDisease ? "anchor" : (ROLE_OF[step.node.type] ?? "attribute"),
          owner: isDisease ? step.node.id : focusId,
          ownerRank: 0,
          hop: step.hop,
          why: step.why,
          kind: kindOf(step.edges.map((e) => e.kind)),
          cluster: isDisease ? clusterOf(step.node.id) : undefined,
        });
      }
      addEdge({
        id: `ev:${step.via}|${step.node.id}`,
        a: step.via,
        b: step.node.id,
        strength: step.t,
        relevance: r,
        kind: kindOf(step.edges.map((e) => e.kind)),
        role: "evidence",
        label: relationLabel(step.edges[0].type),
        edgeIds: step.edges.map((e) => e.id).sort(cmp),
      });
    }
  }
  const anchors = anchorList.map((a) => a.disease);
  if (foldAnchors) {
    const members = byWeight.slice(HOOD.maxAnchors);
    const pathEdges = members.flatMap((m) => m.path.flatMap((s) => s.edges));
    const r = Math.max(...members.map((m) => m.r));
    const kind = kindOf(pathEdges.map((e) => e.kind));
    nodes.set(anchorBubble, {
      id: anchorBubble,
      type: "Bubble",
      label: countLabel("Disease", members.length).replace(/^(\d+) /, "$1 more "),
      relevance: round(r),
      role: "bubble",
      owner: focusId,
      ownerRank: 0,
      hop: 1,
      why: `${countLabel("Disease", members.length)} more ${focus.type === "Phenotype" ? "have this symptom" : `${members.length === 1 ? "is" : "are"} linked to ${shortLabel(focus, NAME_MAX)}`}. Open to see each one.`,
      kind,
      bubbleType: "Disease",
      members: members.map((m) => m.disease),
      memberRelevance: members.map((m) => round(m.r)),
    });
    addEdge({
      id: `bub:${focusId}|${anchorBubble}`,
      a: focusId,
      b: anchorBubble,
      strength: r,
      relevance: r,
      kind,
      role: "bubble",
      label: "",
      edgeIds: [...new Set(pathEdges.map((e) => e.id))].sort(cmp),
    });
  }

  // 2. Related diseases from the grading layer: relevance carried from the best anchor.
  const relatedBest = new Map<string, { r: number; tier: Tier; from: string }>();
  for (const a of anchorList) {
    for (const n of relevance?.diseases[a.disease]?.neighbors ?? []) {
      if (diseaseR.has(n.id) || cache.byId.get(n.id)?.type !== "Disease") continue;
      const r = a.r * n.relevance;
      const prev = relatedBest.get(n.id);
      if (!prev || r > prev.r) relatedBest.set(n.id, { r, tier: n.tier, from: a.disease });
    }
  }
  const related = [...relatedBest]
    .sort((x, y) => y[1].r - x[1].r || TIER_ORDER[y[1].tier] - TIER_ORDER[x[1].tier] || cmp(x[0], y[0]))
    .slice(0, HOOD.maxRelated)
    .map(([id, v]) => ({ id, relevance: round(v.r), tier: v.tier, from: v.from }));
  related.forEach((d, i) => {
    diseaseR.set(d.id, d.relevance);
    const node = cache.byId.get(d.id)!;
    const pair = pairs.get(pairKey(d.from, d.id));
    nodes.set(d.id, {
      id: d.id,
      type: "Disease",
      label: node.label,
      relevance: d.relevance,
      role: "related",
      owner: d.id,
      ownerRank: i + 1,
      hop: d.from === focusId ? 1 : 2,
      why: pair?.tier_reason ?? "Shares biology with what you searched for.",
      kind: pair?.support === "observed" ? "observed" : "inferred",
      tier: d.tier,
      cluster: clusterOf(d.id),
    });
  });
  for (const a of anchors) {
    const node = nodes.get(a);
    if (node && node.role !== "focus") node.ownerRank = 0;
  }

  // 3. Evidence around every disease on the map, strength times the disease's relevance.
  const rankOf = (id: string) => nodes.get(id)?.ownerRank ?? 0;
  // Diseases folded into the anchor bubble bring nothing until it is opened.
  const onMapIds = [...diseaseR.keys()].filter((id) => mapped.has(id) || !anchors.includes(id));
  const diseasesOnMap = [...onMapIds].sort((x, y) => rankOf(x) - rankOf(y) || cmp(x, y));
  interface Offer {
    tie: Tie;
    owner: string;
    r: number;
  }
  const best = new Map<string, Offer>();
  const allTies: Offer[] = [];
  for (const d of diseasesOnMap) {
    const rD = diseaseR.get(d)!;
    const isAnchor = anchors.includes(d);
    for (const tie of tiesOf(cache, relevance, d)) {
      if (tie.node.id === focusId) continue;
      // A related disease brings its gene, mechanisms, top symptoms, top groups and research; its
      // variants and individual researchers are one click away by centering on it.
      if (!isAnchor && (tie.node.type === "Variant" || tie.node.type === "Investigator")) continue;
      const offer: Offer = { tie, owner: d, r: rD * tie.t };
      allTies.push(offer);
      const prev = best.get(tie.node.id);
      if (
        !prev ||
        offer.r > prev.r + 1e-12 ||
        (Math.abs(offer.r - prev.r) <= 1e-12 && (rankOf(d) < rankOf(prev.owner) || (isAnchor && !anchors.includes(prev.owner))))
      ) {
        best.set(tie.node.id, offer);
      }
    }
  }

  // 4. Fold: overflow per owner (symptoms, groups, mechanisms), overflow on the whole map (MAP_CAP),
  // and variants and research always. Within an owner the most specific items stay single.
  const specificity = (id: string) => relevance?.node_info?.[id]?.specificity ?? 0;
  const ordered = [...best.values()].sort(
    (x, y) =>
      rankOf(x.owner) - rankOf(y.owner) ||
      y.r - x.r ||
      specificity(y.tie.node.id) - specificity(x.tie.node.id) ||
      Number(hasWebsite(y.tie.node)) - Number(hasWebsite(x.tie.node)) ||
      cmp(x.tie.node.label, y.tie.node.label) ||
      cmp(x.tie.node.id, y.tie.node.id),
  );
  const capFor = (type: NodeType, owner: string): number | undefined => {
    const main = owner === focusId || anchors.includes(owner);
    if (type === "Phenotype") return main ? (opts.maxSymptoms ?? HOOD.maxSymptoms) : HOOD.maxRelatedSymptoms;
    if (type === "PatientOrg" || type === "Asset") return main ? HOOD.maxGroups : HOOD.maxRelatedGroups;
    if (type === "Mechanism") return main ? HOOD.maxMechanisms : HOOD.maxRelatedMechanisms;
    return undefined;
  };
  // The searched disease, or the one disease a gene, symptom or group belongs to, keeps bubbles of
  // its own; other owners share one bubble per type once more than mergeAfter of them fold it.
  const primary = (owner: string) => owner === focusId || (anchors.length === 1 && owner === anchors[0]);
  const ownerOf = (o: Offer) => (o.tie.node.type === "Variant" ? o.tie.via : o.owner);
  const shownCount = new Map<string, number>();
  const typeCount = new Map<NodeType, number>();
  const toFold: Offer[] = [];
  for (const o of ordered) {
    const type = o.tie.node.type;
    if (FOLDED_TYPES.includes(type)) {
      toFold.push(o);
      continue;
    }
    const key = `${o.owner}|${type}`;
    const count = shownCount.get(key) ?? 0;
    const total = typeCount.get(type) ?? 0;
    const cap = capFor(type, o.owner);
    if ((cap !== undefined && count >= cap) || total >= (MAP_CAP[type] ?? Infinity)) toFold.push(o);
    else {
      shownCount.set(key, count + 1);
      typeCount.set(type, total + 1);
    }
  }
  const sharers = new Map<NodeType, Set<string>>();
  for (const o of toFold) {
    if (primary(o.owner)) continue;
    const set = sharers.get(o.tie.node.type) ?? new Set<string>();
    set.add(ownerOf(o));
    sharers.set(o.tie.node.type, set);
  }
  const bubbleOf = (o: Offer) =>
    !primary(o.owner) && (sharers.get(o.tie.node.type)?.size ?? 0) > HOOD.mergeAfter ? bubbleId(SHARED_BUBBLE_OWNER, o.tie.node.type) : bubbleId(ownerOf(o), o.tie.node.type);
  const folded = new Map<string, Offer[]>();
  for (const o of toFold) {
    const bubble = bubbleOf(o);
    if (expanded.has(bubble)) continue; // opened: its members are shown one by one
    const list = folded.get(bubble);
    if (list) list.push(o);
    else folded.set(bubble, [o]);
  }
  const foldedInto = new Map<string, string>();
  for (const [bubble, members] of folded) for (const m of members) foldedInto.set(m.tie.node.id, bubble);
  const anchor = (id: string) => foldedInto.get(id) ?? id;

  for (const o of ordered) {
    if (foldedInto.has(o.tie.node.id) || nodes.has(o.tie.node.id)) continue;
    const ownerName = shortLabel(cache.byId.get(o.owner) ?? focus, NAME_MAX);
    const indirect = !anchors.includes(o.owner) && o.owner !== focusId;
    nodes.set(o.tie.node.id, {
      id: o.tie.node.id,
      type: o.tie.node.type,
      label: o.tie.node.label,
      relevance: round(o.r),
      role: ROLE_OF[o.tie.node.type] ?? "attribute",
      owner: o.owner,
      ownerRank: rankOf(o.owner),
      hop: (nodes.get(o.owner)?.hop ?? 0) + o.tie.hop,
      why: indirect ? `${o.tie.why} Through ${ownerName}, ${pct(diseaseR.get(o.owner) ?? 0)} related to what you searched.` : o.tie.why,
      kind: kindOf(o.tie.edges.map((e) => e.kind)),
    });
  }
  for (const [bubble, members] of [...folded].sort((x, y) => cmp(x[0], y[0]))) {
    const type = members[0].tie.node.type;
    const shared = bubble === bubbleId(SHARED_BUBBLE_OWNER, type);
    const owner = shared ? focusId : ownerOf(members[0]);
    const ownerNode = cache.byId.get(owner) ?? focus;
    // Folded because the map already shows some ("3 more symptoms"), or because the type always folds.
    const capped = !FOLDED_TYPES.includes(type);
    const label = capped ? countLabel(type, members.length).replace(/^(\d+) /, "$1 more ") : countLabel(type, members.length);
    const owners = new Set(members.map((m) => m.owner)).size;
    nodes.set(bubble, {
      id: bubble,
      type: "Bubble",
      label,
      relevance: round(Math.max(...members.map((m) => m.r))),
      role: "bubble",
      owner: anchor(owner),
      ownerRank: rankOf(members[0].owner),
      hop: (nodes.get(members[0].owner)?.hop ?? 0) + Math.min(...members.map((m) => m.tie.hop)),
      why: shared
        ? `${countLabel(type, members.length)} linked to ${owners} of the diseases on this map. Open to see each one.`
        : `${countLabel(type, members.length)} linked to ${shortLabel(ownerNode, NAME_MAX)}. Open to see each one.`,
      kind: kindOf(members.flatMap((m) => m.tie.edges.map((e) => e.kind))),
      bubbleType: type,
      members: members.map((m) => m.tie.node.id),
      memberRelevance: members.map((m) => round(m.r)),
    });
  }

  // 5. Evidence lines: from every disease on the map to each item it shares, not only the item's owner,
  // so shared genes, mechanisms and symptoms visibly tie diseases together.
  for (const o of allTies) {
    const target = anchor(o.tie.node.id);
    const targetNode = nodes.get(target);
    if (!targetNode) continue;
    const from = anchor(o.tie.via);
    if (!nodes.has(from) || from === target) continue;
    // A folded item draws only its owner's line into the bubble; other diseases sharing it would point
    // into someone else's bubble, which reads as noise.
    if (targetNode.role === "bubble" && best.get(o.tie.node.id)?.owner !== o.owner) continue;
    const role: HoodEdgeRole = targetNode.role === "bubble" ? "bubble" : "evidence";
    const id = `${role === "bubble" ? "bub" : "ev"}:${from}|${target}`;
    const prev = edges.get(id);
    const edgeIds = [...new Set([...(prev?.edgeIds ?? []), ...o.tie.edges.map((e) => e.id)])].sort(cmp);
    const r = Math.max(prev?.relevance ?? 0, o.r);
    edges.set(id, {
      id,
      a: from,
      b: target,
      strength: round(Math.max(prev?.strength ?? 0, o.tie.t)),
      relevance: round(r),
      kind: kindOf(edgeIds.map((e) => cache.edgeById.get(e)?.kind ?? "inferred")),
      role,
      label: role === "bubble" ? "" : relationLabel(o.tie.edges[0].type),
      edgeIds,
    });
  }

  // 6. Disease-to-disease lines: biology between every pair of diseases on the map that the grading
  // layer links, so clusters and cross-links are visible, not only spokes from the center.
  const onMap = [...onMapIds].sort(cmp);
  for (let i = 0; i < onMap.length; i++) {
    for (let j = i + 1; j < onMap.length; j++) {
      const p = pairs.get(pairKey(onMap[i], onMap[j]));
      if (!p || p.tier === "none") continue;
      const touchesFocus = onMap[i] === focusId || onMap[j] === focusId;
      if (!touchesFocus && TIER_ORDER[p.tier] < TIER_ORDER.moderate) continue;
      if (!touchesFocus) {
        // Two related diseases of one cluster already sit inside one halo; a line between them
        // repeats it. Between the diseases a gene, symptom or group belongs to, lines stay, except
        // those that only restate the searched gene or mechanism ("both are caused by COL2A1").
        const ci = clusterOf(onMap[i]);
        const anchored = anchors.includes(onMap[i]) || anchors.includes(onMap[j]);
        if (!anchored && ci !== null && ci === clusterOf(onMap[j])) continue;
        const restates = p.lines_of_evidence.length > 0 && p.lines_of_evidence.every((d) => (d === "gene" || d === "mechanism") && p.dimensions[d].shared.some((x) => x.id === focusId));
        if (restates) continue;
      }
      const evidence = [...new Set(["gene", "mechanism", "variant"].flatMap((d) => p.dimensions[d as "gene"].shared.flatMap((s) => s.edges)))].sort(cmp);
      addEdge({
        id: `sim:${pairKey(onMap[i], onMap[j])}`,
        a: onMap[i],
        b: onMap[j],
        strength: p.biology,
        relevance: Math.min(diseaseR.get(onMap[i])!, diseaseR.get(onMap[j])!) * (touchesFocus ? 1 : p.biology),
        kind: p.support === "observed" ? "observed" : "inferred",
        role: "similarity",
        label: `Shares biology (${p.tier})`,
        edgeIds: evidence,
      });
    }
  }
  // Bridges: existing collaboration (a shared grant, researcher, study) between diseases on the map.
  for (const bridge of relevance?.bridges ?? []) {
    if (!onMapIds.includes(bridge.a) || !onMapIds.includes(bridge.b)) continue;
    addEdge({
      id: `br:${pairKey(bridge.a, bridge.b)}`,
      a: bridge.a,
      b: bridge.b,
      strength: 1,
      relevance: Math.min(diseaseR.get(bridge.a)!, diseaseR.get(bridge.b)!),
      kind: kindOf(bridge.edges.map((id) => cache.edgeById.get(id)?.kind ?? "inferred")),
      role: "bridge",
      label: bridge.reason,
      edgeIds: [...bridge.edges].sort(cmp),
    });
  }

  return {
    focus: focusId,
    focusType: focus.type,
    nodes: [...nodes.values()].sort((x, y) => x.hop - y.hop || y.relevance - x.relevance || cmp(x.id, y.id)),
    edges: [...edges.values()].sort((x, y) => cmp(x.id, y.id)),
    anchors,
    related: related.map(({ id, relevance: r, tier }) => ({ id, relevance: r, tier })),
  };
}

export interface ThresholdResult {
  nodes: HoodNode[]; // at or above the threshold
  ghosts: HoodNode[]; // within HOOD.ghostBand below it: drawn faintly, without labels
  edges: HoodEdge[]; // both ends shown and the line itself at or above the threshold
  faintEdges: HoodEdge[]; // lines just under the threshold, or touching a ghost
  shown: number; // items on the map, bubbles counted by their members, focus excluded
  total: number;
  relatedShown: number;
  relatedTotal: number;
  byType: Partial<Record<NodeType, { shown: number; total: number }>>;
  closestHidden: { id: string; relevance: number } | null; // best related disease below the threshold
}

// Filters the neighborhood by relevance and by type. Items a little under the threshold stay as
// ghosts so the user sees there is more; a node whose links all run through nodes under the
// threshold is dropped. A type filter only hides that type: a hidden node still holds what hangs
// off it, so "only genes" shows every gene that passes the bar, including a related disease's.
export function applyThreshold(
  hood: Neighborhood,
  threshold: number,
  hiddenTypes: ReadonlySet<NodeType> = new Set(),
  ghostBand: number = HOOD.ghostBand,
): ThresholdResult {
  const cut = threshold - 1e-9;
  const typeOf = (n: HoodNode): NodeType => (n.type === "Bubble" ? n.bubbleType! : n.type);
  const reach = new Map<string, "shown" | "ghost">();
  for (const n of hood.nodes) {
    if (n.role === "focus" || n.relevance >= cut) reach.set(n.id, "shown");
    else if (n.relevance >= cut - ghostBand) reach.set(n.id, "ghost");
  }
  // Drop nodes left without a link toward the searched node's side of the map.
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of hood.nodes) {
      if (n.role === "focus" || !reach.has(n.id)) continue;
      const anchored = hood.edges.some(
        (e) => e.role !== "bridge" && ((e.a === n.id && reach.has(e.b)) || (e.b === n.id && reach.has(e.a))),
      );
      if (!anchored) {
        reach.delete(n.id);
        changed = true;
      }
    }
  }
  const nodeById = new Map(hood.nodes.map((n) => [n.id, n]));
  const level = new Map(
    [...reach].filter(([id]) => {
      const n = nodeById.get(id)!;
      return n.role === "focus" || !hiddenTypes.has(typeOf(n));
    }),
  );

  const byType: Partial<Record<NodeType, { shown: number; total: number }>> = {};
  let shown = 0;
  let total = 0;
  for (const n of hood.nodes) {
    if (n.role === "focus") continue;
    const type = typeOf(n);
    const size = n.members?.length ?? 1;
    const row = (byType[type] ??= { shown: 0, total: 0 });
    row.total += size;
    total += size;
    if (level.get(n.id) === "shown") {
      row.shown += size;
      shown += size;
    }
  }
  const edgesShown: HoodEdge[] = [];
  const faint: HoodEdge[] = [];
  for (const e of hood.edges) {
    const la = level.get(e.a);
    const lb = level.get(e.b);
    if (!la || !lb) continue;
    if (la === "shown" && lb === "shown" && e.relevance >= cut) edgesShown.push(e);
    else if (e.relevance >= cut - ghostBand) faint.push(e);
  }
  const relatedShown = hood.related.filter((r) => level.get(r.id) === "shown").length;
  // Only a disease under the bar can be brought in by lowering it; one hidden by a type filter cannot.
  const below = hood.related.filter((r) => r.relevance < cut).sort((x, y) => y.relevance - x.relevance || cmp(x.id, y.id));
  return {
    nodes: hood.nodes.filter((n) => level.get(n.id) === "shown"),
    ghosts: hood.nodes.filter((n) => level.get(n.id) === "ghost"),
    edges: edgesShown,
    faintEdges: faint,
    shown,
    total,
    relatedShown,
    relatedTotal: hood.related.length,
    byType,
    closestHidden: below.length ? { id: below[0].id, relevance: below[0].relevance } : null,
  };
}

// Count of items per relevance bucket (bucket 0 = [0, 1/n), last bucket includes 1), focus excluded.
export function relevanceHistogram(hood: Neighborhood, buckets = 20): number[] {
  const counts = new Array<number>(buckets).fill(0);
  const put = (r: number) => {
    counts[Math.min(buckets - 1, Math.max(0, Math.floor(r * buckets)))] += 1;
  };
  for (const n of hood.nodes) {
    if (n.role === "focus") continue;
    if (n.memberRelevance) n.memberRelevance.forEach(put);
    else put(n.relevance);
  }
  return counts;
}
