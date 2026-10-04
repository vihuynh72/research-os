// The eleven dimensions of a disease pair, scored from the graph alone. Every dimension is
// derived from node types and edge endpoints, never from relation names, so the same code
// grades any graph in the schema format. "Adjacent" means any edge in either direction
// that is not contradicted; contradicted edges never score, they only raise contradicted_evidence.
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import { shortLabel } from "../graph/labels.ts";
import {
  COLLAB_BASE,
  DISEASE_FACET_WEIGHTS,
  GENERIC_IC,
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
  UMBRELLA_MIN,
  UMBRELLA_SHARE,
} from "./config.ts";
import { closeTerms, simgic } from "./simgic.ts";
import {
  COLLABORATION_DIMENSIONS,
  DIMENSION_FAMILY,
  FLAGS,
  type CollaborationDimension,
  type Dimension,
  type DimensionResult,
  type DimensionStatus,
  type Flag,
  type HpoReference,
  type HpoTerm,
  type SharedItem,
  type Support,
} from "./types.ts";
import { classifyVariant, type VariantCounts } from "./variants.ts";

const SCALE = 10 ** ROUND;

export function round(value: number): number {
  const rounded = Math.round(value * SCALE) / SCALE;
  return rounded === 0 ? 0 : rounded; // no "-0" in the output
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// Code-unit order: the same on every machine, unlike localeCompare.
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// How a disease reaches one item (a gene, a symptom, a grant...), summed over every path.
interface Reach {
  clean: boolean; // some path avoids contradicted edges; only these count
  observed: boolean; // some clean path uses observed edges only
  direct: boolean; // some clean path is a single edge from the disease
  edges: Set<string>; // every edge on the clean paths
  vias: Set<string>; // nodes the indirect clean paths attach through
  disputed: boolean; // some path uses a contradicted edge
  disputedAt: boolean; // a contradicted edge attaches the item itself
  contradicted: Set<string>; // contradicted edges on those paths
}
type ReachMap = Map<string, Reach>;

export interface DiseaseProfile {
  id: string;
  gene: ReachMap;
  variant: ReachMap;
  mechanism: ReachMap;
  phenotype: ReachMap; // aspect P (every phenotype without a reference)
  context: ReachMap; // aspects I (inheritance) and C (onset and course)
  closure: Set<string> | null; // phenotype terms plus their ancestors, for SimGIC
  collaboration: Record<CollaborationDimension, ReachMap>;
}

interface Link {
  edge: GraphEdge;
  other: string;
}

// The symptom scale (clinical): raw SimGIC at the 99th percentile of random disease pairs maps to 0,
// the median SimGIC of two records of the same disease to 1.
export interface SymptomScale {
  floor: number;
  top: number;
  sameDiseasePairs: number; // 0 when the reference has no same-disease anchor (top is the fallback)
}

export interface GradingContext {
  reference: HpoReference | null;
  scale: SymptomScale | null;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  links: Map<string, Link[]>;
  diseases: string[]; // sorted ids
  profiles: Map<string, DiseaseProfile>;
  geneReach: Map<string, number>; // gene -> diseases linked to it
  mechanismReach: Map<string, number>; // mechanism -> diseases that reach it
  mechanismDiseases: number; // diseases with at least one mechanism on record: the N of mechanism specificity
  linkedDiseases: Record<CollaborationDimension, Map<string, number>>; // item -> diseases that reach it
  collaborationDiseases: Record<CollaborationDimension, number>; // diseases with at least one such item: the N of its specificity
  missingTerms: string[]; // phenotype ids absent from the reference
  danglingEdges: number; // edges whose endpoints are not in the graph
}

export function buildContext(graph: AtlasGraph, reference: HpoReference | null): GradingContext {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map<string, GraphEdge>();
  const links = new Map<string, Link[]>();
  let danglingEdges = 0;
  for (const edge of graph.edges) {
    if (!nodes.has(edge.subject) || !nodes.has(edge.object)) {
      danglingEdges += 1;
      continue;
    }
    edges.set(edge.id, edge);
    pushTo(links, edge.subject, { edge, other: edge.object });
    if (edge.object !== edge.subject) pushTo(links, edge.object, { edge, other: edge.subject });
  }
  for (const list of links.values()) list.sort((x, y) => byText(x.edge.id, y.edge.id));

  const ctx: GradingContext = {
    reference,
    scale: reference ? symptomScale(reference.meta) : null,
    nodes,
    edges,
    links,
    diseases: [...new Set(graph.nodes.filter((node) => node.type === "Disease").map((node) => node.id))].sort(byText),
    profiles: new Map(),
    geneReach: new Map(),
    mechanismReach: new Map(),
    mechanismDiseases: 0,
    linkedDiseases: emptyRecord(() => new Map<string, number>()),
    collaborationDiseases: emptyRecord(() => 0),
    missingTerms: [],
    danglingEdges,
  };
  const missing = new Set<string>();
  for (const id of ctx.diseases) ctx.profiles.set(id, buildProfile(ctx, id, missing));
  ctx.missingTerms = [...missing].sort(byText);

  for (const profile of ctx.profiles.values()) {
    for (const id of cleanIds(profile.gene)) ctx.geneReach.set(id, (ctx.geneReach.get(id) ?? 0) + 1);
    const mechanisms = cleanIds(profile.mechanism);
    if (mechanisms.length) ctx.mechanismDiseases += 1;
    for (const id of mechanisms) ctx.mechanismReach.set(id, (ctx.mechanismReach.get(id) ?? 0) + 1);
    for (const dimension of COLLABORATION_DIMENSIONS) {
      const counts = ctx.linkedDiseases[dimension];
      const items = cleanIds(profile.collaboration[dimension]);
      if (items.length) ctx.collaborationDiseases[dimension] += 1;
      for (const id of items) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return ctx;
}

function emptyRecord<T>(make: () => T): Record<CollaborationDimension, T> {
  return {
    patient_org: make(),
    paper: make(),
    trial: make(),
    grant: make(),
    investigator: make(),
    asset: make(),
  };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function reachOf(map: ReachMap, id: string): Reach {
  let reach = map.get(id);
  if (!reach) {
    reach = {
      clean: false,
      observed: false,
      direct: false,
      edges: new Set(),
      vias: new Set(),
      disputed: false,
      disputedAt: false,
      contradicted: new Set(),
    };
    map.set(id, reach);
  }
  return reach;
}

function addAll(target: Set<string>, source: Iterable<string>): void {
  for (const value of source) target.add(value);
}

function mergeReach(map: ReachMap, id: string, from: Reach): void {
  const reach = reachOf(map, id);
  reach.clean ||= from.clean;
  reach.observed ||= from.observed;
  reach.direct ||= from.direct;
  reach.disputed ||= from.disputed;
  reach.disputedAt ||= from.disputedAt;
  addAll(reach.edges, from.edges);
  addAll(reach.vias, from.vias);
  addAll(reach.contradicted, from.contradicted);
}

// Items of `type` one edge away from the disease.
function reachDirect(ctx: GradingContext, from: string, type: NodeType, into: ReachMap = new Map()): ReachMap {
  for (const { edge, other } of ctx.links.get(from) ?? []) {
    if (ctx.nodes.get(other)?.type !== type) continue;
    const reach = reachOf(into, other);
    if (edge.kind === "contradicted") {
      reach.disputed = true;
      reach.disputedAt = true;
      reach.contradicted.add(edge.id);
      continue;
    }
    reach.clean = true;
    reach.direct = true;
    reach.edges.add(edge.id);
    if (edge.kind === "observed") reach.observed = true;
  }
  return into;
}

// Items of `type` one edge away from nodes the disease already reaches (its genes, mechanisms...).
function reachThrough(ctx: GradingContext, base: ReachMap, type: NodeType, into: ReachMap): ReachMap {
  for (const [via, path] of base) {
    for (const { edge, other } of ctx.links.get(via) ?? []) {
      if (ctx.nodes.get(other)?.type !== type) continue;
      const reach = reachOf(into, other);
      if (edge.kind === "contradicted") {
        reach.disputed = true;
        reach.disputedAt = true;
        reach.contradicted.add(edge.id);
        addAll(reach.contradicted, path.contradicted);
        continue;
      }
      if (path.clean) {
        reach.clean = true;
        reach.vias.add(via);
        addAll(reach.edges, path.edges);
        reach.edges.add(edge.id);
        if (path.observed && edge.kind === "observed") reach.observed = true;
      }
      if (path.disputed) {
        reach.disputed = true;
        addAll(reach.contradicted, path.contradicted);
      }
    }
  }
  return into;
}

function buildProfile(ctx: GradingContext, id: string, missing: Set<string>): DiseaseProfile {
  const gene = reachDirect(ctx, id, "Gene");
  const variant = reachThrough(ctx, gene, "Variant", reachDirect(ctx, id, "Variant"));
  const mechanism = reachThrough(ctx, gene, "Mechanism", reachDirect(ctx, id, "Mechanism"));
  const { phenotype, context } = splitPhenotypes(ctx, reachDirect(ctx, id, "Phenotype"), missing);

  const paper = reachDirect(ctx, id, "Paper");
  const trial = reachDirect(ctx, id, "Trial");
  const grant = reachDirect(ctx, id, "Grant");
  const investigator = reachDirect(ctx, id, "Investigator");
  for (const base of [grant, paper, trial]) reachThrough(ctx, base, "Investigator", investigator);
  const patientOrg = reachDirect(ctx, id, "PatientOrg");
  const asset = reachDirect(ctx, id, "Asset");
  for (const base of [mechanism, gene]) {
    reachThrough(ctx, base, "PatientOrg", patientOrg);
    reachThrough(ctx, base, "Asset", asset);
  }

  const reference = ctx.reference;
  const closure = reference ? closeTerms(cleanIds(phenotype), (term) => reference.terms[term]?.ancestors) : null;
  return {
    id,
    gene,
    variant,
    mechanism,
    phenotype,
    context,
    closure,
    collaboration: { patient_org: patientOrg, paper, trial, grant, investigator, asset },
  };
}

// The reference term an annotated id stands for: obsolete ids follow replaced_by, else drop out.
export function resolveTerm(reference: HpoReference, id: string): { id: string; term: HpoTerm } | null {
  let current = id;
  for (let hop = 0; hop < 5; hop++) {
    const term = reference.terms[current];
    if (!term) return null;
    if (!term.obsolete) return { id: current, term };
    if (!term.replaced_by) return null;
    current = term.replaced_by;
  }
  return null;
}

function splitPhenotypes(
  ctx: GradingContext,
  annotated: ReachMap,
  missing: Set<string>,
): { phenotype: ReachMap; context: ReachMap } {
  const reference = ctx.reference;
  if (!reference) return { phenotype: annotated, context: new Map() };
  const phenotype: ReachMap = new Map();
  const context: ReachMap = new Map();
  for (const [id, reach] of annotated) {
    if (!reference.terms[id]) {
      missing.add(id);
      continue;
    }
    const resolved = resolveTerm(reference, id);
    if (!resolved) continue;
    const aspect = resolved.term.aspect;
    if (aspect === "P") mergeReach(phenotype, resolved.id, reach);
    else if (aspect === "I" || aspect === "C") mergeReach(context, resolved.id, reach);
  }
  return { phenotype, context };
}

export function cleanIds(map: ReachMap): string[] {
  const ids: string[] = [];
  for (const [id, reach] of map) if (reach.clean) ids.push(id);
  return ids.sort(byText);
}

// An item linked to more than this many of the atlas's diseases is an umbrella resource.
export function umbrellaCutoff(diseases: number): number {
  return Math.max(UMBRELLA_MIN, UMBRELLA_SHARE * diseases);
}

export function isUmbrella(ctx: GradingContext, dimension: CollaborationDimension, id: string): boolean {
  return (ctx.linkedDiseases[dimension].get(id) ?? 0) > umbrellaCutoff(ctx.diseases.length);
}

// How well a shared group, paper, study, grant, researcher or asset tells diseases apart, as for
// mechanisms: n = diseases linked to the item, N = diseases with any item of that kind on record (a
// disease the search found nothing for says nothing about how common an item is). Listed for two
// diseases it weighs 1; listed for all of them, 0.
export function collaborationWeight(ctx: GradingContext, dimension: CollaborationDimension, id: string): number {
  return atlasSpecificity(ctx.linkedDiseases[dimension].get(id) ?? 0, ctx.collaborationDiseases[dimension]);
}

// ---- shared items, support and disputes -------------------------------------------------------

interface SharedSet {
  items: SharedItem[];
  observed: Set<string>; // items tied to both diseases by observed-only paths
}

function sharedSet(
  ctx: GradingContext,
  a: ReachMap,
  b: ReachMap,
  weightOf: (id: string) => number,
): SharedSet {
  const items: SharedItem[] = [];
  const observed = new Set<string>();
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!x.clean || !y?.clean) continue;
    const edges = [...new Set([...x.edges, ...y.edges])].sort(byText);
    // The node the link passes through, for a side that has no direct edge to the item.
    const vias = new Set<string>();
    if (!x.direct) addAll(vias, x.vias);
    if (!y.direct) addAll(vias, y.vias);
    const via = vias.size ? [...vias].sort(byText)[0] : undefined;
    items.push({
      id,
      label: itemLabel(ctx, id),
      type: ctx.nodes.get(id)?.type ?? "Phenotype",
      weight: round(weightOf(id)),
      edges,
      ...(via === undefined ? {} : { via }),
      kind: provenance(ctx, edges),
    });
    if (x.observed && y.observed) observed.add(id);
  }
  items.sort((p, q) => q.weight - p.weight || byText(p.label, q.label) || byText(p.id, q.id));
  return { items, observed };
}

// Phenotype labels come from the HPO reference when it has the term: ids are the key, and a source
// can pair ids with the wrong names (Monarch export lists did, for 295 of 303 terms).
function itemLabel(ctx: GradingContext, id: string): string {
  const node = ctx.nodes.get(id);
  const term = ctx.reference?.terms[id];
  if (term && (!node || node.type === "Phenotype")) return term.label;
  return node?.label ?? id;
}

function provenance(ctx: GradingContext, edges: string[]): EdgeKind | "mixed" {
  const kinds = new Set(edges.map((id) => ctx.edges.get(id)?.kind ?? "inferred"));
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}

function supportOf(shared: SharedSet): Support | null {
  if (shared.observed.size) return "observed";
  return shared.items.length ? "inferred" : null;
}

// Contradicted edges that bear on this pair: they decide whether an item is shared at all, or a
// source disputes a shared item itself. Disputes about items only one disease has are left out.
function disputes(a: ReachMap, b: ReachMap): string[] {
  const found = new Set<string>();
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y) continue;
    const changesSharing = !(x.clean && y.clean);
    if (changesSharing || x.disputedAt) addAll(found, x.contradicted);
    if (changesSharing || y.disputedAt) addAll(found, y.contradicted);
  }
  return [...found].sort(byText);
}

// ---- wording -----------------------------------------------------------------------------------

export function diseaseName(ctx: GradingContext, id: string): string {
  const node = ctx.nodes.get(id);
  return node ? shortLabel(node, Number.POSITIVE_INFINITY) : id;
}

export function joinList(parts: string[], max = 3, more = "more"): string {
  const shown = parts.length > max ? [...parts.slice(0, max), `${parts.length - max} ${more}`] : parts;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function sentence(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

// Lower-cases the first letter for running text, but leaves acronyms ("ER", "TGF-beta") alone, and
// names in title case ("Developmental Lineage of Pancreatic Ductal Cells", as Reactome writes many
// pathways), which would read half-changed with only the first capital lowered.
export function lowerFirst(text: string): string {
  if (!/^[A-Z][a-z]/.test(text) || /\s[A-Z][a-z]/.test(text)) return text;
  return `${text[0].toLowerCase()}${text.slice(1)}`;
}

function withArticle(text: string): string {
  return `${/^[aeiou]/i.test(text) ? "an" : "a"} ${text}`;
}

// A mechanism label in running text after "both": "Melanin biosynthesis" -> "both involve melanin
// biosynthesis"; a label ending in "missing" ("Membrane protein missing") -> "both are missing a
// membrane protein"; one naming a kind of protein ("Lysosomal membrane protein") -> "both involve a
// lysosomal membrane protein". Graph-agnostic: it reads only the label.
export function mechanismPhrase(label: string): string {
  const text = label.trim();
  const missing = /^(.*\S)\s+missing$/i.exec(text);
  if (missing) return `both are missing ${withArticle(lowerFirst(missing[1]))}`;
  const thing = /\b(protein|enzyme|channel|transporter|receptor)$/i.test(text);
  return `both involve ${thing ? withArticle(lowerFirst(text)) : lowerFirst(text)}`;
}

// "Closer than 99.6% of random disease pairs": floored to a tenth and never shown as 100%.
export function percentText(p: number): string {
  const tenths = Math.min(999, Math.floor(p * 1000 + 1e-9));
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

function missingText(ctx: GradingContext, a: string, b: string, aCount: number, bCount: number, what: string): string {
  if (!aCount && !bCount) return `No ${what} on record for either disease.`;
  return `No ${what} on record for ${diseaseName(ctx, aCount ? b : a)}.`;
}

function labelsOf(ctx: GradingContext, ids: string[]): string[] {
  return ids.map((id) => itemLabel(ctx, id)).sort(byText);
}

// ---- result assembly ---------------------------------------------------------------------------

type Details = Record<string, number | string | boolean | null>;

interface Fields {
  score: number;
  raw?: number;
  percentile?: number;
  status: DimensionStatus;
  coverage: { a: number; b: number };
  shared: SharedItem[];
  support: Support | null;
  summary: string;
  flags: Iterable<Flag>;
  details?: Details;
}

// Keys follow the DimensionResult interface so every file reads the same way.
function result(dimension: Dimension, fields: Fields): DimensionResult {
  const flags = new Set(fields.flags);
  const details = fields.details && Object.keys(fields.details).length ? fields.details : undefined;
  return {
    dimension,
    family: DIMENSION_FAMILY[dimension],
    score: fields.score,
    ...(fields.raw === undefined ? {} : { raw: fields.raw }),
    ...(fields.percentile === undefined ? {} : { percentile: fields.percentile }),
    status: fields.status,
    coverage: fields.coverage,
    shared: fields.shared,
    support: fields.support,
    summary: fields.summary,
    flags: FLAGS.filter((flag) => flags.has(flag)),
    ...(details ? { details } : {}),
  };
}

function withDisputes(flags: Flag[], details: Details, disputed: string[]): void {
  if (!disputed.length) return;
  flags.push("contradicted_evidence");
  details.contradicted_edges = disputed.join(" ");
}

// ---- biology: gene -----------------------------------------------------------------------------

function geneDimension(ctx: GradingContext, A: DiseaseProfile, B: DiseaseProfile): DimensionResult {
  const a = cleanIds(A.gene);
  const b = cleanIds(B.gene);
  const flags: Flag[] = [];
  const details: Details = {};
  withDisputes(flags, details, disputes(A.gene, B.gene));
  const coverage = { a: a.length, b: b.length };
  if (!a.length || !b.length) {
    flags.push("no_data");
    const summary = missingText(ctx, A.id, B.id, a.length, b.length, "gene");
    return result("gene", { score: 0, status: "unknown", coverage, shared: [], support: null, summary, flags, details });
  }
  const shared = sharedSet(ctx, A.gene, B.gene, () => 1);
  const support = supportOf(shared);
  let summary: string;
  if (shared.items.length) {
    flags.push("same_gene_allelic");
    if (support === "inferred") flags.push("inferred_only");
    const names = shared.items.map((item) => item.label);
    summary = `Same gene${names.length > 1 ? "s" : ""}: ${joinList(names)}.`;
  } else {
    summary = `Different genes: ${joinList(labelsOf(ctx, a), 2)} for ${diseaseName(ctx, A.id)}, ${joinList(labelsOf(ctx, b), 2)} for ${diseaseName(ctx, B.id)}.`;
  }
  const score = shared.items.length ? 1 : 0;
  return result("gene", {
    score,
    status: score ? "match" : "none",
    coverage,
    shared: shared.items,
    support,
    summary,
    flags,
    details,
  });
}

// Genes both diseases reach by a path no source disputes.
function sharedGeneIds(A: DiseaseProfile, B: DiseaseProfile): Set<string> {
  return new Set(cleanIds(A.gene).filter((id) => B.gene.get(id)?.clean));
}

// ---- biology: variant type ---------------------------------------------------------------------

export const MIN_CLASSIFIED = 2;
export const VARIANT_STATUS = { match: 0.75, partial: 0.4 };
// "Mostly": at least two of every three classified variants. Compared on exact fractions, so 2 of 3
// counts (rounded to 0.6667 it would miss a 0.67 cutoff).
export const MOSTLY_LOF = 2 / 3;
export const RARELY_LOF = 0.2;
const EPSILON = 1e-9;

// The variants that can stand for the disease itself: those linked to the disease, and those of a
// gene no other disease here has. A gene with several diseases here (the pair's shared gene, or the
// gene of a whole family such as COL2A1) has its variants recorded for the gene: they cannot say
// which of its diseases they come from, so comparing them would compare the gene, not the disease.
// For a pair that shares a gene this also keeps one list from being compared with itself.
interface OwnVariants {
  reach: ReachMap;
  geneLevel: string[]; // the disease's genes whose variants are set aside, sorted
}

function geneHasOneDisease(ctx: GradingContext, id: string): boolean {
  return (ctx.geneReach.get(id) ?? 0) <= 1;
}

function ownVariants(ctx: GradingContext, profile: DiseaseProfile): OwnVariants {
  const genes: ReachMap = new Map([...profile.gene].filter(([id]) => geneHasOneDisease(ctx, id)));
  return {
    reach: reachThrough(ctx, genes, "Variant", reachDirect(ctx, profile.id, "Variant")),
    geneLevel: cleanIds(profile.gene).filter((id) => !geneHasOneDisease(ctx, id)),
  };
}

// Whose variants a side compares: its gene's when they all come through one gene, else the disease's.
function variantOwner(ctx: GradingContext, profile: DiseaseProfile, reach: ReachMap): string {
  const vias = new Set<string>();
  let direct = false;
  for (const id of cleanIds(reach)) {
    const path = reach.get(id);
    if (path?.direct) direct = true;
    for (const via of path?.vias ?? []) vias.add(via);
  }
  return !direct && vias.size === 1 ? itemLabel(ctx, [...vias][0]) : diseaseName(ctx, profile.id);
}

// "ClinVar records" when every compared variant comes from one source, else "variants on record".
function variantNoun(ctx: GradingContext, ids: string[]): string {
  const sources = new Set(ids.map((id) => ctx.nodes.get(id)?.source ?? ""));
  const [source] = [...sources];
  return sources.size === 1 && source ? `${source} records` : "variants on record";
}

// "its gene COL2A1, which has 12 diseases here" / "MITF (2 diseases here) and TYR (2 diseases here)".
function geneCountText(ctx: GradingContext, ids: string[], own: boolean): string {
  const parts = ids
    .map((id) => ({ label: itemLabel(ctx, id), n: ctx.geneReach.get(id) ?? 0 }))
    .sort((x, y) => byText(x.label, y.label));
  if (own && parts.length === 1) return `its gene ${parts[0].label}, which has ${parts[0].n} diseases here`;
  return `${own ? "its genes " : ""}${joinList(parts.map((p) => `${p.label} (${p.n} diseases here)`), 4)}`;
}

function variantCounts(ctx: GradingContext, ids: string[]): VariantCounts {
  const counts: VariantCounts = { lof: 0, missense: 0, other: 0, unknown: 0 };
  for (const id of ids) counts[classifyVariant(ctx.nodes.get(id)?.label ?? "")] += 1;
  return counts;
}

export type LofKind = "mostly_lof" | "mostly_not_lof" | "mixed";

export function lofKind(lof: number, classified: number): LofKind {
  const f = lof / classified;
  if (f >= MOSTLY_LOF - EPSILON) return "mostly_lof";
  if (f <= RARELY_LOF + EPSILON) return "mostly_not_lof";
  return "mixed";
}

const LOF_WORDS: Record<LofKind, string> = {
  mostly_lof: "mostly loss-of-function",
  mostly_not_lof: "mostly missense or in-frame",
  mixed: "mixed",
};

function variantDimension(ctx: GradingContext, A: DiseaseProfile, B: DiseaseProfile): DimensionResult {
  const genes = sharedGeneIds(A, B);
  const ownA = ownVariants(ctx, A);
  const ownB = ownVariants(ctx, B);
  const ra = ownA.reach;
  const rb = ownB.reach;
  const allA = cleanIds(A.variant);
  const allB = cleanIds(B.variant);
  const a = cleanIds(ra);
  const b = cleanIds(rb);
  const ca = variantCounts(ctx, a);
  const cb = variantCounts(ctx, b);
  const classifiedA = ca.lof + ca.missense + ca.other;
  const classifiedB = cb.lof + cb.missense + cb.other;
  const flags: Flag[] = [];
  const details: Details = {
    lof_a: ca.lof,
    missense_a: ca.missense,
    other_a: ca.other,
    unknown_a: ca.unknown,
    lof_b: cb.lof,
    missense_b: cb.missense,
    other_b: cb.other,
    unknown_b: cb.unknown,
    lof_fraction_a: classifiedA ? round(ca.lof / classifiedA) : null,
    lof_fraction_b: classifiedB ? round(cb.lof / classifiedB) : null,
  };
  // Variants left out because their gene has several diseases here: counted, so a reader sees why a
  // pair with variants on record has none to compare.
  const compared = new Set([...a, ...b]);
  const setAside = [...new Set([...allA, ...allB])].filter((id) => !compared.has(id)).length;
  if (setAside) details.gene_level_variants = setAside;
  withDisputes(flags, details, disputes(ra, rb));
  // The variant type is read from the notation, so say so whenever a type was read.
  if (classifiedA || classifiedB) flags.push("derived_from_variant_notation");
  const shared = sharedSet(ctx, ra, rb, () => 1);
  // Coverage counts every variant on record for the disease, set aside or not.
  const coverage = { a: allA.length, b: allB.length };
  const nameA = diseaseName(ctx, A.id);
  const nameB = diseaseName(ctx, B.id);

  if (classifiedA < MIN_CLASSIFIED || classifiedB < MIN_CLASSIFIED) {
    flags.push("variant_effect_unknown");
    const missing = !allA.length || !allB.length;
    if (missing) flags.push("no_data");
    const tally = `${nameA}: ${classifiedA}, ${nameB}: ${classifiedB}; ${MIN_CLASSIFIED} needed each`;
    const geneLevel = [...new Set([...ownA.geneLevel, ...ownB.geneLevel])].sort(byText);
    const onlyShared = geneLevel.every((id) => genes.has(id));
    // A side whose every variant is set aside has nothing of its own to compare.
    const noneOwn = [
      { name: nameA, own: a.length, genes: ownA.geneLevel },
      { name: nameB, own: b.length, genes: ownB.geneLevel },
    ].filter((side) => !side.own);
    let summary: string;
    if (missing) summary = missingText(ctx, A.id, B.id, allA.length, allB.length, "variants");
    else if (!setAside) summary = `Too few variants with a readable type to compare (${tally}).`;
    else if (noneOwn.length === 2 && onlyShared) {
      summary = `The variants on record are listed for the shared gene ${joinList(labelsOf(ctx, geneLevel), 2)}, not for either disease, so variant type cannot tell the two apart.`;
    } else if (noneOwn.length === 2) {
      summary = `Variant type cannot be compared: the variants on record are listed for ${geneCountText(ctx, geneLevel, false)}, not for either disease itself.`;
    } else if (noneOwn.length === 1) {
      const [side] = noneOwn;
      summary = `Variant type cannot be compared: the variants on record for ${side.name} are listed for ${geneCountText(ctx, side.genes, true)}, not for the disease itself.`;
    } else {
      const apart = onlyShared
        ? `the variants of the shared gene ${joinList(labelsOf(ctx, geneLevel), 2)}`
        : `the variants listed for ${geneCountText(ctx, geneLevel, false)}`;
      summary = `Apart from ${apart}, too few with a readable type to compare (${tally}).`;
    }
    return result("variant", { score: 0, status: "unknown", coverage, shared: [], support: null, summary, flags, details });
  }

  const score = round(1 - Math.abs(ca.lof / classifiedA - cb.lof / classifiedB));
  const ka = lofKind(ca.lof, classifiedA);
  const kb = lofKind(cb.lof, classifiedB);
  // The same kind of lesion on both sides (mostly loss-of-function, or mostly missense) is a match
  // even when the shares differ: with three variants a side, one variant moves the share by a
  // third, so 2 of 3 against 3 of 3 is the same answer read from a small sample.
  const sameKind = ka === kb && ka !== "mixed";
  const status: DimensionStatus =
    score >= VARIANT_STATUS.match || sameKind ? "match" : score >= VARIANT_STATUS.partial ? "partial" : "none";
  if ((ka === "mostly_lof" && kb === "mostly_not_lof") || (kb === "mostly_lof" && ka === "mostly_not_lof")) {
    flags.push("variant_type_conflict");
  }
  details.kind_a = ka;
  details.kind_b = kb;
  // The comparison rests on parsed notation, so it is inferred even when the variants are curated.
  const support: Support | null = score > 0 ? "inferred" : null;
  if (shared.items.length && support === "inferred") flags.push("inferred_only");
  // Name what was compared: the records of a gene (its only disease here) or of the disease itself.
  const ownerA = variantOwner(ctx, A, ra);
  const ownerB = variantOwner(ctx, B, rb);
  const noun = variantNoun(ctx, [...a, ...b]);
  const summary =
    ka === kb
      ? `Both ${LOF_WORDS[ka]} (${noun}: ${ownerA} ${ca.lof} of ${classifiedA} loss-of-function, ${ownerB} ${cb.lof} of ${classifiedB}).`
      : `${sentence(noun)}: ${ownerA} ${LOF_WORDS[ka]} (${ca.lof} of ${classifiedA} loss-of-function), ${ownerB} ${LOF_WORDS[kb]} (${cb.lof} of ${classifiedB}).`;
  return result("variant", { score, status, coverage, shared: shared.items, support, summary, flags, details });
}

// ---- biology: mechanism ------------------------------------------------------------------------

export const HUMAN_GENES = 20000; // protein-coding genes: a pathway this big says nothing specific

// Big pathways say little: a mechanism node that records its gene count weighs less.
function sizeWeight(node: GraphNode | undefined): number {
  const geneCount = node?.attributes?.gene_count;
  if (typeof geneCount !== "number" || !Number.isFinite(geneCount) || geneCount < 1) return 1;
  return clamp(1 - Math.log(geneCount) / Math.log(HUMAN_GENES), 0.1, 1);
}

// How well a mechanism tells diseases apart within this atlas: reached by exactly 2 of N diseases
// it weighs 1, by all N it weighs 0 (the log scale is Resnik's information content, normalized).
export function atlasSpecificity(n: number, N: number): number {
  if (N < MIN_ATLAS_FOR_SPECIFICITY || n <= 2) return 1;
  const lnN = Math.log(N);
  return clamp((1 - Math.log(n) / lnN) / (1 - Math.log(2) / lnN), 0, 1);
}

export interface MechanismWeight {
  weight: number; // max(MECHANISM_FLOOR, specificity) * size weight: what the pair's score uses
  floored: boolean; // at the floor: a process most diseases here share
  n: number; // diseases in the atlas that reach it
  N: number; // diseases in the atlas with any mechanism on record
}

// N counts only the diseases that have a mechanism on record, as HPO's information content counts
// only annotated diseases. A disease with none recorded says nothing about how common a mechanism
// is; counting it would make a pathway look more specific with every disease whose gene no pathway
// database lists.
export function mechanismWeight(ctx: GradingContext, id: string): MechanismWeight {
  const N = ctx.mechanismDiseases;
  const n = ctx.mechanismReach.get(id) ?? 0;
  const specificity = atlasSpecificity(n, N);
  return {
    weight: Math.max(MECHANISM_FLOOR, specificity) * sizeWeight(ctx.nodes.get(id)),
    floored: specificity <= MECHANISM_FLOOR,
    n,
    N,
  };
}

// "2 of 5 diseases here". When some diseases have no mechanism on record, N counts only those that
// do, and the words say so.
export function reachText(n: number, N: number, atlas: number): string {
  const all = N === 2 ? "both" : `all ${N}`;
  if (N === atlas) return n === N ? `${all} diseases here` : `${n} of ${N} diseases here`;
  return n === N ? `${all} diseases with a mechanism on record` : `${n} of the ${N} diseases with a mechanism on record`;
}

// The pair's mechanism score is the weight of the most specific mechanism both reach (Resnik's
// "most informative common ancestor"), not an overlap ratio: a gene in many pathways would otherwise
// dilute the one specific pathway it shares with a neighbour.
function mechanismDimension(ctx: GradingContext, A: DiseaseProfile, B: DiseaseProfile): DimensionResult {
  const a = cleanIds(A.mechanism);
  const b = cleanIds(B.mechanism);
  const flags: Flag[] = [];
  const N = ctx.mechanismDiseases;
  const atlas = ctx.diseases.length;
  const details: Details = { most_specific: null, n: null, N, atlas };
  withDisputes(flags, details, disputes(A.mechanism, B.mechanism));
  const coverage = { a: a.length, b: b.length };
  if (!a.length || !b.length) {
    flags.push("no_data");
    const summary = missingText(ctx, A.id, B.id, a.length, b.length, "mechanism");
    return result("mechanism", { score: 0, status: "unknown", coverage, shared: [], support: null, summary, flags, details });
  }
  const shared = sharedSet(ctx, A.mechanism, B.mechanism, (id) => mechanismWeight(ctx, id).weight);
  if (!shared.items.length) {
    const summary = `Different mechanisms: ${joinList(labelsOf(ctx, a), 2)} for ${diseaseName(ctx, A.id)}, ${joinList(labelsOf(ctx, b), 2)} for ${diseaseName(ctx, B.id)}.`;
    return result("mechanism", { score: 0, status: "none", coverage, shared: [], support: null, summary, flags, details });
  }

  // A mechanism that one disease reaches only through a gene both share is shared because the gene
  // is: the same fact, not a second line of evidence. Such mechanisms are listed, and the score
  // comes from the others when there are any.
  const genes = sharedGeneIds(A, B);
  const throughGenes = (id: string): string[] | null => {
    for (const side of [A, B]) {
      const reach = side.mechanism.get(id);
      if (reach && !reach.direct && reach.vias.size && [...reach.vias].every((via) => genes.has(via))) return [...reach.vias];
    }
    return null;
  };
  const independent = genes.size ? shared.items.filter((item) => !throughGenes(item.id)) : shared.items;

  // Every shared mechanism comes with the shared gene: no line of its own. The pathways of one gene
  // cannot say whether its two diseases disrupt them the same way (the brief's "same gene, different
  // mechanisms"), so the line is unknown and scores 0; the mechanisms stay listed for the reader.
  if (!independent.length) {
    const best = shared.items[0];
    const info = mechanismWeight(ctx, best.id);
    details.most_specific = best.id;
    details.n = info.n;
    details.through_shared_gene = true;
    const geneNames = joinList(labelsOf(ctx, throughGenes(best.id) ?? [...genes]), 2);
    const k = shared.items.length;
    const what =
      k === 1
        ? `The mechanism they share, ${best.label} (${reachText(info.n, N, atlas)}), comes`
        : `The ${k} mechanisms they share (${joinList(shared.items.map((item) => item.label))}) come`;
    const summary = `${what} with their shared gene ${geneNames}, so ${k === 1 ? "it says" : "they say"} nothing the gene does not; whether both diseases disrupt ${k === 1 ? "it" : "them"} the same way is unknown.`;
    return result("mechanism", { score: 0, status: "unknown", coverage, shared: shared.items, support: null, summary, flags, details });
  }

  const best = independent[0];
  const info = mechanismWeight(ctx, best.id);
  const score = best.weight;
  const status: DimensionStatus = score >= MECHANISM_STATUS.match ? "match" : "partial";
  details.most_specific = best.id;
  details.n = info.n;
  // Both reach it through their genes (a pathway their genes are in), not by a direct link: the
  // reasons then speak of the genes, not of the diseases.
  const viaGenes = [A, B].every((side) => side.mechanism.get(best.id)?.direct === false);
  if (viaGenes) details.via_genes = true;
  // How many shared mechanisms count, when some only come with a shared gene.
  if (independent.length !== shared.items.length) details.independent_mechanisms = independent.length;
  // Support follows the mechanisms that carry the score, not a family-wide one beside them.
  const top = independent.filter((item) => item.weight === best.weight);
  const support: Support = top.some((item) => shared.observed.has(item.id)) ? "observed" : "inferred";
  if (support === "inferred") flags.push("inferred_only");

  const reach = reachText(info.n, N, atlas);
  let summary: string;
  if (independent.every((item) => mechanismWeight(ctx, item.id).floored)) {
    flags.push("family_level_only");
    const kind = info.n === N ? "the family-wide process" : "the widely shared process";
    summary = `They share only ${kind} ${best.label} (${reach}), which does not tell them apart.`;
  } else {
    summary = `${sentence(sharedMechanismClause(best.label, independent.length, viaGenes, reach))}.`;
    const others = shared.items.filter((item) => item.id !== best.id).map((item) => item.label);
    if (others.length) summary += ` Also shared: ${joinList(others, 4)}.`;
  }
  return result("mechanism", { score, status, coverage, shared: shared.items, support, summary, flags, details });
}

// The shared mechanism in running text, without presenting a pathway as the diseases' own mechanism.
// A pathway their genes are in reads as such, and when several are shared, the one that carries the
// score is named as the most specific here, which is not necessarily the one the literature would
// name: "their genes share 5 mechanisms, of which the most specific here is hyaluronan degradation
// (2 of the 81 diseases with a mechanism on record)". A mechanism linked to the diseases themselves,
// or a label that states what the gene product is ("Membrane protein missing"), reads as their own:
// "both are missing a membrane protein". `reach` may be empty.
export function sharedMechanismClause(label: string, count: number, viaGenes: boolean, reach: string): string {
  const where = reach ? ` (${reach})` : "";
  if (!viaGenes || describesProduct(label)) {
    const others = count > 1 ? `, the most specific of ${count} shared mechanisms` : "";
    return `${mechanismPhrase(label)}${where}${others}`;
  }
  return count > 1
    ? `their genes share ${count} mechanisms, of which the most specific here is ${lowerFirst(label)}${where}`
    : `their genes share one mechanism, ${lowerFirst(label)}${where}`;
}

// "Membrane protein missing", "Lysosomal membrane protein": a label about the gene product, not a
// process the gene takes part in. Process names that end in such a noun ("Signaling by Insulin
// receptor") carry a preposition; a product label does not.
function describesProduct(label: string): boolean {
  const text = label.trim();
  if (/\S\s+missing$/i.test(text)) return true;
  return /\b(protein|enzyme|channel|transporter|receptor)$/i.test(text) && !/\s(by|of|to|in|from|with|and|for|on|at)\s/i.test(text);
}

// ---- clinical: symptoms ------------------------------------------------------------------------

// Share of random disease pairs whose SimGIC is below `raw`: piecewise-linear over the null
// quantiles, flat beyond the ends. On a plateau it takes the lowest p, the cautious reading.
export function percentileOf(raw: number, quantiles: { p: number; value: number }[]): number {
  if (!quantiles.length) return 0;
  if (raw <= quantiles[0].value) return quantiles[0].p;
  for (let i = 1; i < quantiles.length; i++) {
    const hi = quantiles[i];
    if (raw <= hi.value) {
      const lo = quantiles[i - 1];
      return lo.p + ((hi.p - lo.p) * (raw - lo.value)) / (hi.value - lo.value);
    }
  }
  return quantiles[quantiles.length - 1].p;
}

// The value at share p of a stored distribution: the stored point when there is one, else linear
// between the neighbouring points, flat beyond the ends.
export function quantileValue(quantiles: { p: number; value: number }[], p: number): number {
  if (!quantiles.length) return 0;
  if (p <= quantiles[0].p) return quantiles[0].value;
  for (let i = 1; i < quantiles.length; i++) {
    const hi = quantiles[i];
    if (p <= hi.p) {
      const lo = quantiles[i - 1];
      return hi.p === lo.p ? hi.value : lo.value + ((hi.value - lo.value) * (p - lo.p)) / (hi.p - lo.p);
    }
  }
  return quantiles[quantiles.length - 1].value;
}

export function symptomScale(meta: HpoReference["meta"]): SymptomScale {
  const same = meta.same_disease;
  const top = same?.quantiles.length ? quantileValue(same.quantiles, 0.5) : SYMPTOM_TOP_FALLBACK;
  return {
    floor: round(quantileValue(meta.null.quantiles, SYMPTOM_FLOOR_PERCENTILE)),
    top: round(top),
    sameDiseasePairs: same?.quantiles.length ? same.pairs : 0,
  };
}

// 0 below the gate (most random pairs overlap this much), then linear from the floor (99th
// percentile of random pairs) to the top (two records of one disease), capped at 1.
export function symptomScore(raw: number, percentile: number, scale: SymptomScale): number {
  if (percentile < SYMPTOM_GATE_PERCENTILE) return 0;
  if (scale.top <= scale.floor) return raw > scale.floor ? 1 : 0;
  return clamp((raw - scale.floor) / (scale.top - scale.floor), 0, 1);
}

// Plain anchors for the scaled symptom score, shared by the dimension summary and the pair reason.
export const SAME_DISEASE_SCORE = 0.9;
export type SymptomAnchor = "same_disease" | "related" | "faint" | "chance";

export function symptomAnchor(score: number, percentile: number): SymptomAnchor {
  if (score >= SAME_DISEASE_SCORE) return "same_disease";
  if (score > 0) return "related";
  return percentile >= SYMPTOM_GATE_PERCENTILE ? "faint" : "chance";
}

const ANCHOR_SENTENCE: Record<SymptomAnchor, string> = {
  same_disease: "They overlap about as much as two records of the same disease.",
  related: "They overlap more than unrelated diseases, less than two records of one disease.",
  faint: "They overlap a little more than most unrelated diseases, not enough to count.",
  chance: "They overlap no more than many unrelated diseases do.",
};

function phenotypeDimension(ctx: GradingContext, A: DiseaseProfile, B: DiseaseProfile): DimensionResult {
  const reference = ctx.reference;
  const a = cleanIds(A.phenotype);
  const b = cleanIds(B.phenotype);
  const flags: Flag[] = [];
  if (!reference) flags.push("uncalibrated");
  const thin = [
    { name: diseaseName(ctx, A.id), n: a.length },
    { name: diseaseName(ctx, B.id), n: b.length },
  ].filter((side) => side.n < MIN_ANNOTATIONS);
  if (thin.length) flags.push("few_annotations");
  const ic = (id: string) => reference?.terms[id]?.ic ?? 0;
  const shared = sharedSet(ctx, A.phenotype, B.phenotype, reference ? ic : () => 1);
  const rare = reference ? shared.items.filter((item) => item.weight >= SPECIFIC_IC).length : null;
  const details: Details = {
    shared_exact: shared.items.length,
    shared_rare: rare,
    terms_a: a.length,
    terms_b: b.length,
    raw: 0,
  };
  withDisputes(flags, details, disputes(A.phenotype, B.phenotype));
  const coverage = { a: a.length, b: b.length };
  if (!a.length || !b.length) {
    flags.push("no_data");
    const summary = missingText(ctx, A.id, B.id, a.length, b.length, "symptoms");
    return result("phenotype", { score: 0, status: "unknown", coverage, shared: [], support: null, summary, flags, details });
  }
  const n = shared.items.length;
  let support = supportOf(shared);
  // A thin record makes any comparison weak, so the summary names it.
  const thinNote = thin.length
    ? ` Only ${count(thin[0].n, "symptom")} on record for ${thin[0].name}${thin[1] ? ` and ${thin[1].n} for ${thin[1].name}` : ""}.`
    : "";

  if (!reference) {
    const union = new Set([...a, ...b]).size;
    const raw = round(n / union);
    details.raw = raw;
    const status: DimensionStatus =
      raw >= PHENOTYPE_STATUS_UNCALIBRATED.match ? "match" : raw >= PHENOTYPE_STATUS_UNCALIBRATED.partial ? "partial" : "none";
    if (n && support === "inferred") flags.push("inferred_only");
    const summary = n
      ? `${count(n, "shared symptom")} out of ${union} on record (${Math.round(raw * 100)}% overlap). Not calibrated against random disease pairs.`
      : `No shared symptoms (${diseaseName(ctx, A.id)} has ${a.length}, ${diseaseName(ctx, B.id)} has ${b.length}).`;
    return result("phenotype", { score: raw, status, coverage, shared: shared.items, support, summary, flags, details });
  }

  const scale = ctx.scale ?? symptomScale(reference.meta);
  const raw = round(simgic(A.closure ?? new Set(), B.closure ?? new Set(), ic));
  const percentile = round(percentileOf(raw, reference.meta.null.quantiles));
  const score = round(symptomScore(raw, percentile, scale));
  const status: DimensionStatus = score >= PHENOTYPE_STATUS.match ? "match" : score >= PHENOTYPE_STATUS.partial ? "partial" : "none";
  details.raw = raw;
  if (n && shared.items.every((item) => item.weight < GENERIC_IC)) flags.push("generic_symptoms_only");
  // Overlap through related (ancestor) terms is computed, not stated by a source.
  if (!support && score > 0) support = "inferred";
  if (n && support === "inferred") flags.push("inferred_only");

  const anchor = ANCHOR_SENTENCE[symptomAnchor(score, percentile)];
  let summary: string;
  if (n) {
    const kind = rare
      ? rare === n
        ? n === 1
          ? "a rare one"
          : "all of them rare"
        : `${rare} of them rare`
      : n === 1
        ? "a common one"
        : "none of them rare";
    summary = `${count(n, "shared symptom")}, ${kind} (e.g. ${shared.items[0].label}). ${anchor}`;
  } else {
    summary = score > 0 ? `No identical symptoms, but related ones. ${anchor}` : `No identical symptoms. ${anchor}`;
  }
  summary += thinNote;
  return result("phenotype", { score, raw, percentile, status, coverage, shared: shared.items, support, summary, flags, details });
}

// ---- clinical: onset and inheritance (dimension "disease") -------------------------------------

const DISAGREEMENT = "Sources disagree:";
export const ONSET_NEIGHBOUR = 0.5; // neighbouring steps on the ladder
export const CONTEXT_STATUS = { match: 0.75, partial: 0.5 };

// The onset ladder steps a term stands for: the step itself, or the step it is a finer kind of
// ("Late onset" counts as adult). Other clinical-course terms ("Progressive") are not an onset.
function onsetSteps(reference: HpoReference, id: string): number[] {
  const up = [id, ...(reference.terms[id]?.ancestors ?? [])];
  return ONSET_LADDER.flatMap((step, index) => (up.includes(step) ? [index] : []));
}

function stepName(reference: HpoReference, index: number): string {
  const id = ONSET_LADDER[index];
  return lowerFirst((reference.terms[id]?.label ?? id).replace(/\s+onset$/i, ""));
}

// "Autosomal recessive inheritance" -> "autosomal recessive".
function inheritanceName(label: string): string {
  return lowerFirst(label.replace(/\s+inheritance$/i, ""));
}

interface OnsetMatch {
  score: number;
  a: number;
  b: number;
}

// The closest pair of steps across the two sides: same step 1, neighbouring 0.5, else 0.
function bestOnset(stepsA: number[], stepsB: number[]): OnsetMatch | null {
  let best: OnsetMatch | null = null;
  for (const a of stepsA) {
    for (const b of stepsB) {
      const gap = Math.abs(a - b);
      const score = gap === 0 ? 1 : gap === 1 ? ONSET_NEIGHBOUR : 0;
      if (!best || score > best.score || (score === best.score && (a < best.a || (a === best.a && b < best.b)))) best = { score, a, b };
    }
  }
  return best;
}

function contextDimension(ctx: GradingContext, A: DiseaseProfile, B: DiseaseProfile): DimensionResult {
  const reference = ctx.reference;
  if (!reference) {
    return result("disease", {
      score: 0,
      status: "unknown",
      coverage: { a: 0, b: 0 },
      shared: [],
      support: null,
      summary: "Not assessed: telling onset and inheritance apart from symptoms needs the HPO reference.",
      flags: [],
    });
  }
  const aspectOf = (id: string) => reference.terms[id]?.aspect;
  const a = cleanIds(A.context);
  const b = cleanIds(B.context);
  const flags: Flag[] = [];
  const details: Details = { onset_a: null, onset_b: null, onset_score: null, inheritance_shared: null };
  withDisputes(flags, details, disputes(A.context, B.context));
  const shared = sharedSet(ctx, A.context, B.context, (id) => reference.terms[id]?.ic ?? 0);
  const coverage = { a: a.length, b: b.length };
  const nameA = diseaseName(ctx, A.id);
  const nameB = diseaseName(ctx, B.id);

  // Onset: each side's terms on the ladder.
  const onsetTerms = (ids: string[]) => ids.filter((id) => aspectOf(id) === "C" && onsetSteps(reference, id).length);
  const onsetA = onsetTerms(a);
  const onsetB = onsetTerms(b);
  const stepsA = [...new Set(onsetA.flatMap((id) => onsetSteps(reference, id)))].sort((x, y) => x - y);
  const stepsB = [...new Set(onsetB.flatMap((id) => onsetSteps(reference, id)))].sort((x, y) => x - y);
  const onset = bestOnset(stepsA, stepsB);
  // Inheritance: any identical mode.
  const inheritA = a.filter((id) => aspectOf(id) === "I");
  const inheritB = b.filter((id) => aspectOf(id) === "I");
  const sameInheritance = shared.items.filter((item) => aspectOf(item.id) === "I");

  const parts: string[] = [];
  let disagreement = "";
  let weighted = 0;
  let weights = 0;
  if (onset) {
    weighted += DISEASE_FACET_WEIGHTS.onset * onset.score;
    weights += DISEASE_FACET_WEIGHTS.onset;
    const [sa, sb] = [stepName(reference, onset.a), stepName(reference, onset.b)];
    details.onset_a = sa;
    details.onset_b = sb;
    details.onset_score = onset.score;
    // The onset claims compared, so a reviewer can read both even when no term is identical.
    const edgesA = onsetA.flatMap((id) => [...(A.context.get(id)?.edges ?? [])]);
    const edgesB = onsetB.flatMap((id) => [...(B.context.get(id)?.edges ?? [])]);
    details.onset_edges = [...new Set([...edgesA, ...edgesB])].sort(byText).join(" ");
    const disagree = (edges: string[]) => edges.some((id) => ctx.edges.get(id)?.evidence?.includes(DISAGREEMENT));
    const disputed = [...(disagree(edgesA) ? [nameA] : []), ...(disagree(edgesB) ? [nameB] : [])];
    parts.push(
      onset.score === 1
        ? `Onset: both ${sa}.`
        : `Onset: ${sa} vs ${sb} (${onset.score > 0 ? "neighbouring" : "further apart"}).`,
    );
    if (disputed.length) {
      flags.push("sources_disagree");
      disagreement = `Sources disagree on the onset of ${joinList(disputed)}; a clinician should confirm.`;
    }
  } else if (onsetA.length || onsetB.length) {
    parts.push(`No onset on record for ${onsetA.length ? nameB : nameA}.`);
  }
  if (inheritA.length && inheritB.length) {
    const same = sameInheritance.length > 0;
    weighted += DISEASE_FACET_WEIGHTS.inheritance * (same ? 1 : 0);
    weights += DISEASE_FACET_WEIGHTS.inheritance;
    details.inheritance_shared = same;
    parts.push(
      same
        ? `Both ${joinList(sameInheritance.map((item) => inheritanceName(item.label)), 2)}.`
        : `Inheritance differs: ${inheritanceName(labelsOf(ctx, inheritA)[0])} vs ${inheritanceName(labelsOf(ctx, inheritB)[0])}.`,
    );
  } else if (inheritA.length || inheritB.length) {
    parts.push(`No inheritance on record for ${inheritA.length ? nameB : nameA}.`);
  }
  if (disagreement) parts.push(disagreement);

  if (!weights) {
    if (!a.length || !b.length) flags.push("no_data");
    const summary =
      !a.length && !b.length
        ? "No onset or inheritance on record for either disease."
        : !a.length || !b.length
          ? missingText(ctx, A.id, B.id, a.length, b.length, "onset or inheritance")
          : parts.length
            ? parts.join(" ")
            : "Onset and inheritance are recorded, but not the same kind for both diseases.";
    return result("disease", { score: 0, status: "unknown", coverage, shared: shared.items, support: null, summary, flags, details });
  }
  const score = round(weighted / weights);
  const status: DimensionStatus = score >= CONTEXT_STATUS.match ? "match" : score >= CONTEXT_STATUS.partial ? "partial" : "none";
  let support = supportOf(shared);
  if (shared.items.length && support === "inferred") flags.push("inferred_only");
  // A neighbouring onset is a comparison the engine makes, not a shared fact a source states.
  if (!support && score > 0) support = "inferred";
  return result("disease", { score, status, coverage, shared: shared.items, support, summary: parts.join(" "), flags, details });
}

// ---- collaboration -----------------------------------------------------------------------------

const COLLABORATION_NOUN: Record<CollaborationDimension, [string, string]> = {
  patient_org: ["patient group", "patient groups"],
  paper: ["paper", "papers"],
  trial: ["clinical study", "clinical studies"],
  grant: ["research grant", "research grants"],
  investigator: ["researcher", "researchers"],
  asset: ["registry or asset", "registries or assets"],
};

const INACTIVE_TRIAL = new Set(["WITHDRAWN", "TERMINATED", "UNKNOWN"]);

function collaborationDimension(
  ctx: GradingContext,
  dimension: CollaborationDimension,
  A: DiseaseProfile,
  B: DiseaseProfile,
): DimensionResult {
  const ra = A.collaboration[dimension];
  const rb = B.collaboration[dimension];
  const a = cleanIds(ra);
  const b = cleanIds(rb);
  const [singular, plural] = COLLABORATION_NOUN[dimension];
  const flags: Flag[] = [];
  const details: Details = {};
  withDisputes(flags, details, disputes(ra, rb));
  const coverage = { a: a.length, b: b.length };
  if (!a.length || !b.length) {
    flags.push("no_data");
    const summary = missingText(ctx, A.id, B.id, a.length, b.length, plural);
    return result(dimension, { score: 0, status: "unknown", coverage, shared: [], support: null, summary, flags, details });
  }
  // Items are weighed by how few diseases they are linked to, and listed most specific first.
  const shared = sharedSet(ctx, ra, rb, (id) => collaborationWeight(ctx, dimension, id));
  const n = shared.items.length;
  const support = supportOf(shared);
  if (n && support === "inferred") flags.push("inferred_only");
  const umbrella = shared.items.filter((item) => isUmbrella(ctx, dimension, item.id)).map((item) => item.id);
  if (umbrella.length) {
    flags.push("umbrella_resource");
    details.umbrella_items = umbrella.sort(byText).join(" ");
  }
  const vias = [...new Set(shared.items.flatMap((item) => (item.via ? [item.via] : [])))].sort(byText);
  if (vias.length && (dimension === "patient_org" || dimension === "asset")) flags.push("via_mechanism");
  if (dimension === "trial") {
    const inactive = shared.items.some((item) => {
      const status = ctx.nodes.get(item.id)?.attributes?.overall_status;
      return typeof status === "string" && INACTIVE_TRIAL.has(status.toUpperCase());
    });
    if (inactive) flags.push("inactive_or_withdrawn");
  }

  let summary: string;
  if (!n) {
    summary = `No shared ${plural} (${diseaseName(ctx, A.id)} has ${a.length}, ${diseaseName(ctx, B.id)} has ${b.length}).`;
  } else {
    const first = shared.items[0].label;
    summary = n === 1 ? `Same ${singular}: ${first}.` : `${n} shared ${plural}, e.g. ${first}.`;
    if (vias.length === 1) summary += ` Linked through ${itemLabel(ctx, vias[0])}.`;
    else if (vias.length > 1) summary += ` Linked through ${vias.length} shared genes, mechanisms or projects.`;
    if (umbrella.length) {
      const atlas = ctx.diseases.length;
      const linked = (id: string) => ctx.linkedDiseases[dimension].get(id) ?? 0;
      summary +=
        umbrella.length === 1 && n === 1
          ? ` It is listed for ${linked(umbrella[0])} of the ${atlas} diseases here, so it says little about this pair.`
          : umbrella.length === n
            ? ` Each is listed for more than ${Math.floor(umbrellaCutoff(atlas))} of the ${atlas} diseases here, so they say little about this pair.`
            : ` ${umbrella.length} of them ${umbrella.length === 1 ? "is" : "are"} listed for more than ${Math.floor(umbrellaCutoff(atlas))} of the ${atlas} diseases here.`;
    }
  }
  let untouched = 1;
  for (const item of shared.items) untouched *= 1 - COLLAB_BASE * item.weight;
  const score = round(1 - untouched);
  // Sharing only umbrella resources is a partial overlap: something in common, nothing specific.
  const status: DimensionStatus = !n ? "none" : umbrella.length === n ? "partial" : "match";
  return result(dimension, { score, status, coverage, shared: shared.items, support, summary, flags, details });
}

// ---- entry points ------------------------------------------------------------------------------

export function scoreDimensions(ctx: GradingContext, a: string, b: string): Record<Dimension, DimensionResult> {
  const A = ctx.profiles.get(a);
  const B = ctx.profiles.get(b);
  if (!A || !B) throw new Error(`Not a disease in this graph: ${A ? b : a}`);
  return {
    gene: geneDimension(ctx, A, B),
    variant: variantDimension(ctx, A, B),
    mechanism: mechanismDimension(ctx, A, B),
    phenotype: phenotypeDimension(ctx, A, B),
    disease: contextDimension(ctx, A, B),
    patient_org: collaborationDimension(ctx, "patient_org", A, B),
    paper: collaborationDimension(ctx, "paper", A, B),
    trial: collaborationDimension(ctx, "trial", A, B),
    grant: collaborationDimension(ctx, "grant", A, B),
    investigator: collaborationDimension(ctx, "investigator", A, B),
    asset: collaborationDimension(ctx, "asset", A, B),
  };
}

// The SimGIC value at or below which the symptom score is 0: the larger of the scale's floor and
// the value where the null percentile reaches the gate. Bisection keeps it exact for any shape of
// quantile list.
export function scoreFloor(quantiles: { p: number; value: number }[], scale: SymptomScale): number {
  if (!quantiles.length) return Number.POSITIVE_INFINITY;
  let lo = quantiles[0].value;
  let hi = quantiles[quantiles.length - 1].value;
  let gate: number;
  if (percentileOf(lo, quantiles) >= SYMPTOM_GATE_PERCENTILE) gate = Number.NEGATIVE_INFINITY;
  else if (percentileOf(hi, quantiles) < SYMPTOM_GATE_PERCENTILE) return Number.POSITIVE_INFINITY; // no pair passes
  else {
    for (let step = 0; step < 100; step++) {
      const mid = (lo + hi) / 2;
      if (percentileOf(mid, quantiles) < SYMPTOM_GATE_PERCENTILE) lo = mid;
      else hi = mid;
    }
    gate = lo;
  }
  return Math.max(gate, scale.floor);
}

// Prefix filter (a standard set-similarity join): sort a disease's closure terms rarest first and
// keep the shortest prefix whose remaining terms carry at most `floor` of its information mass.
// Two diseases whose SimGIC exceeds `floor` share a term that lies in both prefixes (the first
// shared term in this order), so indexing prefixes finds every pair whose symptoms can score.
function phenotypePrefix(closure: Iterable<string>, ic: (id: string) => number, floor: number): string[] {
  if (floor === Number.POSITIVE_INFINITY) return [];
  const terms = [...closure].sort((x, y) => ic(y) - ic(x) || byText(x, y));
  const mass = terms.reduce((sum, term) => sum + ic(term), 0);
  const leaveOut = floor > 0 ? floor * mass : -1;
  const prefix: string[] = [];
  let remaining = mass;
  for (const term of terms) {
    if (remaining <= leaveOut) break;
    prefix.push(term);
    remaining -= ic(term);
  }
  return prefix;
}

// Pairs worth grading. Every other pair shares nothing that can score: no gene, variant or
// mechanism (variant type only counts beside a gene or mechanism), too little symptom overlap to
// pass the symptom floor (onset and inheritance only count beside symptoms), and no research item
// beyond umbrella resources (which never bridge). The engine stays near O(n * k) instead of O(n^2)
// on a large atlas.
export function candidatePairs(ctx: GradingContext): [string, string][] {
  const postings = new Map<string, string[]>();
  const reference = ctx.reference;
  // Raw SimGIC and the percentile are rounded to 4 decimals before scoring, hence the margin.
  const floor = reference && ctx.scale ? scoreFloor(reference.meta.null.quantiles, ctx.scale) - 1e-4 : 0;
  const ic = (term: string) => reference?.terms[term]?.ic ?? 0;
  for (const id of ctx.diseases) {
    const profile = ctx.profiles.get(id);
    if (!profile) continue;
    const keys = new Set<string>();
    for (const gene of cleanIds(profile.gene)) keys.add(`gene ${gene}`);
    for (const variant of cleanIds(profile.variant)) keys.add(`variant ${variant}`);
    for (const mechanism of cleanIds(profile.mechanism)) keys.add(`mechanism ${mechanism}`);
    // Without a reference the score is raw Jaccard: any shared term counts.
    const terms = reference ? phenotypePrefix(profile.closure ?? [], ic, floor) : cleanIds(profile.phenotype);
    for (const term of terms) keys.add(`phenotype ${term}`);
    for (const dimension of COLLABORATION_DIMENSIONS) {
      for (const item of cleanIds(profile.collaboration[dimension])) {
        if (!isUmbrella(ctx, dimension, item)) keys.add(`${dimension} ${item}`);
      }
    }
    for (const key of keys) pushTo(postings, key, id);
  }
  const pairs = new Map<string, [string, string]>();
  for (const members of postings.values()) {
    // Members arrive in sorted disease order, so i < j gives a < b.
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs.set(`${members[i]}\u0000${members[j]}`, [members[i], members[j]]);
      }
    }
  }
  return [...pairs.values()].sort((x, y) => byText(x[0], y[0]) || byText(x[1], y[1]));
}
