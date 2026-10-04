// The panel as data. Each view (a disease, a pair, a gene or symptom, a selected node or line) is
// built here as a document of sections, claims and the records each claim cites, before anything is
// rendered: citations are numbered in reading order by one registry per document, so a chip's number
// and its entry in Sources always agree and never depend on what React renders first. Sentences
// come from explain.ts; nothing here adds a fact that graph.json or relevance.json does not hold.
// Pure; browser and Node.
import type { GraphEdge, GraphNode, NodeType } from "../../../lib/graph/types.ts";
import type { ClinicalTier, DimensionResult, Flag, PairGrade, Tier } from "../../../lib/grading/types.ts";
import { DIMENSIONS, DIMENSION_FAMILY } from "../../../lib/grading/types.ts";
import { classifyVariant } from "../../../lib/grading/variants.ts";
import type { HoodEdge, HoodNode, Neighborhood } from "../../../lib/graph/neighborhood.ts";
import { nextSteps, type NextStep } from "../../../lib/graph/nextStep.ts";
import { sentenceLabel } from "../../../lib/graph/labels.ts";
import { TYPE_NAME, countLabel } from "../../../lib/graph/vocab.ts";
import {
  DIMENSION_WORD,
  STATUS_WORD,
  TYPE_WORD,
  clusterName,
  clusterOf,
  clusterColor,
  diseaseColor,
  diseaseProfile,
  edgeSentence,
  engineText,
  evidenceName,
  formatPercent,
  formatScore,
  nodeOf,
  pairOf,
  umbrellaIds,
  type AtlasModel,
  type LinkedItem,
  type Mode,
} from "../format.ts";
import { evidenceBadge, evidenceBadgeOf, plainEvidence, searchedBadge, type Badge } from "../evidence.ts";
import * as say from "../explain.ts";
import { citationRegistry, type CitationInput, type CitationRegistry, type SourceRecord } from "./citations.ts";

// ---------- the document ----------

export interface Claim {
  text: string;
  cites: number[];
}

export interface ItemVM {
  id: string;
  label: string;
  url: string;
  type: NodeType;
  note?: string; // a short plain fact under the name ("Rare symptom")
  small?: string; // researcher small print ("specificity 0.72")
  cites: number[];
}

export interface RowVM {
  id: string;
  name: string;
  color: string;
  tier?: Tier; // biology grade
  clinicalTier?: ClinicalTier; // or clinical resemblance
  value: number;
  reason: Claim | null;
  small?: string; // researcher small print: lines of evidence and the three scores
}

export type Block =
  | { kind: "claims"; claims: Claim[] }
  | { kind: "note"; text: string } // a general caveat about the kind of evidence, not a fact about this data
  | { kind: "items"; heading?: string; cites?: number[]; items: ItemVM[]; limit: number; what: string; badge?: Badge | null; empty?: Claim } // cites: one set for the whole list
  | { kind: "rows"; rows: RowVM[]; limit: number; what: string; action: "select" | "focus"; empty?: Claim }
  | { kind: "bullets"; items: Claim[] };

export interface SectionVM {
  id: string;
  title: string;
  count?: string;
  hint?: string;
  open: boolean;
  blocks: Block[];
}

export interface StepVM {
  kind: NextStep["kind"];
  text: string;
  because: string;
  caveat: string | null;
  cites: number[];
  becauseCites: number[];
}

export interface Summary {
  text: string; // "Based on 12 sources: 9 stated by curated databases, 3 inferred"
  sources: string[]; // short names in order of first use
}

interface DocBase {
  sections: SectionVM[];
  steps: StepVM[];
  sources: SourceRecord[];
  summary: Summary;
}

export interface DiseaseDoc extends DocBase {
  view: "disease";
  node: GraphNode;
  title: string;
  group: { label: string; color: string } | null;
  facts: Claim[]; // quick facts; the gene and symptom facts cite their records, the counts summarize sections below
  links: { label: string; url: string }[];
}

export interface ScoreRow {
  line: string;
  status: string;
  score: string;
  cap: string;
  countsToward: string;
}

export interface PairDoc extends DocBase {
  view: "pair";
  anchor: GraphNode;
  other: GraphNode;
  title: string;
  through: string | null;
  biology: { tier: Tier; value: number; badge: Badge | null; why: Claim };
  clinical: { tier: ClinicalTier; value: number; why: Claim; compared: boolean } | null; // compared: both have symptoms on record
  totals: { label: string; value: string }[]; // the three aggregate scores, for the researcher table
  scores: ScoreRow[];
  lines: string[];
  engineNote: string[];
}

export interface NodeDoc extends DocBase {
  view: "node";
  node: GraphNode;
  center: boolean;
  eyebrow: string;
  title: string;
  relevance: Claim | null; // "63% relevant to Tay-Sachs disease"; a direct link cites its records
  intro: Claim[];
  contactIds: string[] | null; // a paper or grant: the diseases it is linked to, for "Contact the authors"
}

export interface EdgeDoc extends DocBase {
  view: "edge";
  eyebrow: string;
  title: string;
  strength: number;
  relevance: number;
  strengthMeans: string;
  pairWith: GraphNode | null; // the related disease, for "Why they're connected"
  centerable: GraphNode[];
}

// ---------- lookups ----------

interface Ctx {
  model: AtlasModel;
  reg: CitationRegistry;
  mode: Mode;
}

const shares = (d: DimensionResult | undefined) => !!d && (d.status === "match" || d.status === "partial");

function liveEdges(model: AtlasModel, id: string): GraphEdge[] {
  return model.index.edgesOf(id).filter((e) => e.kind !== "contradicted");
}

function otherEnd(edge: GraphEdge, id: string): string {
  return edge.subject === id ? edge.object : edge.subject;
}

function genesOf(model: AtlasModel, diseaseId: string): { node: GraphNode; edge: GraphEdge }[] {
  return liveEdges(model, diseaseId).flatMap((edge) => {
    const node = nodeOf(model, otherEnd(edge, diseaseId));
    return node?.type === "Gene" ? [{ node, edge }] : [];
  });
}

function edgesById(model: AtlasModel, ids: readonly string[]): GraphEdge[] {
  return ids.flatMap((id) => model.edgeById.get(id) ?? []);
}

const dateCache = new WeakMap<AtlasModel, Map<string, string | null>>();

// When a source's records were retrieved: the latest date on its edges, else the graph's own date.
function sourceDate(model: AtlasModel, source: string): string | null {
  let cache = dateCache.get(model);
  if (!cache) dateCache.set(model, (cache = new Map()));
  if (!cache.has(source)) {
    let best = "";
    for (const e of model.graph.edges) if (e.source === source && e.date > best) best = e.date;
    cache.set(source, best || model.graph.meta.generated_at?.slice(0, 10) || null);
  }
  return cache.get(source) ?? null;
}

const withDataCache = new WeakMap<AtlasModel, number>();

// How many diseases have any pathway on record, directly or through a gene.
export function pathwayDataCount(model: AtlasModel): number {
  let n = withDataCache.get(model);
  if (n === undefined) {
    const isPathway = (id: string) => nodeOf(model, id)?.type === "Mechanism";
    n = model.index.diseases.filter((d) =>
      liveEdges(model, d.id).some((e) => {
        const other = otherEnd(e, d.id);
        return isPathway(other) || (nodeOf(model, other)?.type === "Gene" && liveEdges(model, other).some((g) => isPathway(otherEnd(g, other))));
      }),
    ).length;
    withDataCache.set(model, n);
  }
  return n;
}

// ---------- citations ----------

// What one edge states, as a sentence. A search hit or a name match is said as what it is, never
// as a curated fact ("A PubMed search links “…” to …", not "“…” is about …").
export function edgeClaim(model: AtlasModel, edge: GraphEdge): string {
  if (edge.kind === "inferred") {
    const diseaseFirst = nodeOf(model, edge.subject)?.type === "Disease";
    const item = nodeOf(model, diseaseFirst ? edge.object : edge.subject);
    const disease = nodeOf(model, diseaseFirst ? edge.subject : edge.object);
    const text = item && disease?.type === "Disease" ? say.inferredLinkClaim(edge.source, evidenceName(item), disease.label) : null;
    if (text) return text;
  }
  return `${sentenceLabel(edgeSentence(model, edge))}.`;
}

export function edgeCitation(model: AtlasModel, edge: GraphEdge): CitationInput {
  if (edge.type === "variant_of") {
    const variant = nodeOf(model, edge.subject);
    if (variant) return variantCitation(model, variant, edge);
  }
  return {
    source: edge.source,
    url: edge.url,
    claim: edgeClaim(model, edge),
    badge: evidenceBadge(edge),
    date: edge.date || null,
    note: plainEvidence(edge),
  };
}

function nodeCitation(node: GraphNode, claim: string): CitationInput {
  return { source: node.source, url: node.url, claim, badge: { label: `Stated by ${node.source}`, style: "stated" } };
}

const citeEdges = (ctx: Ctx, edges: readonly GraphEdge[]) => ctx.reg.cite(edges.map((e) => edgeCitation(ctx.model, e)));
const citeIds = (ctx: Ctx, ids: readonly string[]) => citeEdges(ctx, edgesById(ctx.model, ids));

function symptomEdges(model: AtlasModel, diseaseId: string): GraphEdge[] {
  return liveEdges(model, diseaseId).filter((e) => e.type === "has_phenotype");
}

// One record for a disease's whole symptom list: every symptom of it comes from the same Monarch page.
function symptomListCitation(model: AtlasModel, disease: GraphNode): CitationInput {
  const edges = symptomEdges(model, disease.id);
  if (!edges.length) return noSymptomsCitation(model, disease);
  return {
    source: edges[0].source,
    url: edges[0].url,
    claim: `${sentenceLabel(disease.label)} has ${countLabel("Phenotype", edges.length)} on record (HPO terms through Monarch).`,
    badge: evidenceBadge(edges[0]),
    date: edges[0].date,
  };
}

function noSymptomsCitation(model: AtlasModel, disease: GraphNode): CitationInput {
  const source = "HPO (via Monarch)";
  return {
    source,
    url: disease.url,
    claim: `No symptom of ${disease.label} is kept here; the data keeps only symptoms shared inside known disease groups.`,
    badge: searchedBadge(sourceDate(model, source)),
  };
}

type Dataset = "nih" | "orphanet" | "pubmed";

// A statement of absence cites the dataset that was searched, dated by the search.
function searchCitation(model: AtlasModel, dataset: Dataset, disease: GraphNode | null, gene?: string): CitationInput {
  const what = disease ? `${gene ? `${gene} and ` : ""}${disease.label}` : null;
  if (dataset === "nih") {
    return {
      source: "NIH RePORTER",
      url: "https://reporter.nih.gov/",
      claim: what ? `NIH RePORTER, searched for ${what}: no project found.` : "NIH RePORTER, searched for each disease and gene name here.",
      badge: searchedBadge(sourceDate(model, "NIH RePORTER")),
    };
  }
  if (dataset === "pubmed") {
    return {
      source: "PubMed",
      url: what ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(what.replace(" and ", " "))}` : "https://pubmed.ncbi.nlm.nih.gov/",
      claim: what ? `PubMed, searched for ${what}: no paper kept.` : "PubMed, searched for each disease and gene name here.",
      badge: searchedBadge(sourceDate(model, "PubMed")),
    };
  }
  return {
    source: "Orphanet directory",
    url: "https://www.orpha.net/en/patient-organisations",
    claim: disease ? `Orphanet's patient-group directory, searched for ${disease.label}: no group's name matched.` : "Orphanet's patient-group directory, searched for every disease here.",
    badge: searchedBadge(sourceDate(model, "Orphanet")),
  };
}

function reactomeSearchCitation(model: AtlasModel, gene: string): CitationInput {
  return {
    source: "Reactome",
    url: `https://reactome.org/content/query?q=${encodeURIComponent(gene)}`,
    claim: `Reactome, searched for ${gene}: no specific pathway kept (only pathways of at most 300 entities are used).`,
    badge: searchedBadge(sourceDate(model, "Reactome")),
  };
}

function monarchSearchCitation(model: AtlasModel, disease: GraphNode): CitationInput {
  return { source: disease.source, url: disease.url, claim: `${disease.source} lists no gene for ${disease.label}.`, badge: searchedBadge(sourceDate(model, disease.source)) };
}

// "NM_000520.6(HEXA):c.1559del (p.Gly520fs)" -> "c.1559del (p.Gly520fs)": the change without its transcript.
const variantLabel = (label: string) => label.replace(/^[^\s:()]+\([^)]*\):/, "");

// A gene change's record, the same in every view: ClinVar lists it, and its type is read from its
// name, so the record is marked inferred (the spec's rule for gene-change types).
function variantCitation(model: AtlasModel, variant: GraphNode, edge: GraphEdge): CitationInput {
  return {
    source: edge.source,
    url: edge.url,
    claim: say.variantRecordClaim(edge.source, nodeOf(model, edge.object)?.label ?? "its gene", variantLabel(variant.label), classifyVariant(variant.label)),
    badge: { label: "Type read from name", style: "inferred" },
    date: edge.date || null,
  };
}

function variantItemCitation(model: AtlasModel, item: LinkedItem): CitationInput | null {
  const edge = item.edges.find((e) => e.type === "variant_of");
  return edge ? variantCitation(model, item.node, edge) : null;
}

function variantCitations(model: AtlasModel, diseaseId: string): CitationInput[] {
  return diseaseProfile(model, diseaseId).variants.flatMap((v) => variantItemCitation(model, v) ?? []);
}

// ---------- shared pieces ----------

function itemOf(ctx: Ctx, item: LinkedItem, extra: Partial<Pick<ItemVM, "note" | "small">> = {}, cites?: number[]): ItemVM {
  return { id: item.node.id, label: item.node.label, url: item.node.url, type: item.node.type, ...extra, cites: cites ?? citeEdges(ctx, item.edges) };
}

function mostSpecific(dim: DimensionResult) {
  return dim.shared.find((s) => s.id === dim.details?.most_specific) ?? dim.shared[0];
}

function pathwayFacts(ctx: Ctx, dim: DimensionResult, itemId: string): say.PathwayFacts {
  const item = dim.shared.find((s) => s.id === itemId) ?? dim.shared[0];
  const genes = [
    ...new Set(
      edgesById(ctx.model, item.edges)
        .filter((e) => e.type === "in_pathway")
        .map((e) => nodeOf(ctx.model, e.subject)?.label ?? e.subject),
    ),
  ];
  const reach = ctx.model.relevance.node_info?.[item.id]?.diseases;
  const withData = typeof dim.details?.N === "number" ? dim.details.N : pathwayDataCount(ctx.model);
  return { pathway: item.label, genes, reach, withData };
}

function variantClaimOf(ctx: Ctx, pair: PairGrade): Claim | null {
  const v = pair.dimensions.variant;
  if (!v) return null;
  const det = v.details ?? {};
  const num = (k: string) => (typeof det[k] === "number" ? (det[k] as number) : 0);
  if (v.status === "unknown") {
    if (!num("gene_level_variants")) return null;
    const genes = pair.dimensions.gene?.shared.map((s) => s.label) ?? [];
    return { text: say.geneLevelVariantsClaim(genes), cites: ctx.reg.cite(variantCitations(ctx.model, pair.a)) };
  }
  const side = (id: string, s: "a" | "b"): say.VariantSide => ({
    genes: genesOf(ctx.model, id).map((g) => g.node.label),
    kind: (det[`kind_${s}`] as say.LofKind | undefined) ?? null,
    lof: num(`lof_${s}`),
    classified: num(`lof_${s}`) + num(`missense_${s}`) + num(`other_${s}`),
  });
  return {
    text: say.variantClaim(v.status, side(pair.a, "a"), side(pair.b, "b")),
    cites: ctx.reg.cite([...variantCitations(ctx.model, pair.a), ...variantCitations(ctx.model, pair.b)]),
  };
}

function nothingSharedClaim(ctx: Ctx, pair: PairGrade): Claim {
  const ends = [pair.a, pair.b].flatMap((id) => nodeOf(ctx.model, id) ?? []);
  const genes = ends.flatMap((d) => genesOf(ctx.model, d.id).map((g) => g.edge));
  return {
    text: "They share no gene, pathway or type of gene change on record.",
    cites: genes.length ? citeEdges(ctx, genes) : ctx.reg.cite(ends.map((d) => monarchSearchCitation(ctx.model, d))),
  };
}

// The one-line reason a pair is related in biology, strongest line first. `short` is the row form.
function biologyWhy(ctx: Ctx, pair: PairGrade, short: boolean): Claim {
  const d = pair.dimensions;
  if (d.gene?.status === "match" && d.gene.shared.length) {
    const genes = d.gene.shared.map((s) => s.label);
    return { text: short ? say.sameGeneReason(genes) : say.sameGeneClaim(genes), cites: citeIds(ctx, d.gene.shared.flatMap((s) => s.edges)) };
  }
  const mech = d.mechanism;
  if (shares(mech) && mech.shared.length && mech.details?.through_shared_gene !== true) {
    const top = mostSpecific(mech);
    const facts = pathwayFacts(ctx, mech, top.id);
    return { text: short ? say.pathwayReason(facts) : say.pathwayClaim(facts), cites: citeIds(ctx, top.edges) };
  }
  if (shares(d.variant)) {
    const claim = variantClaimOf(ctx, pair);
    if (claim) return claim;
  }
  return nothingSharedClaim(ctx, pair);
}

// The verdict's one line: the strongest line of biology in full, or why the score can't be traced.
function verdictWhy(ctx: Ctx, pair: PairGrade): Claim {
  const why = biologyWhy(ctx, pair, false);
  const traced = pair.dimensions.gene?.status === "match" || shares(pair.dimensions.mechanism) || shares(pair.dimensions.variant);
  return traced || pair.biology <= 0 ? why : { ...why, text: `${why.text.replace(/\.$/, "")}, so this score can't be traced to a source here.` };
}

function clinicalWhy(ctx: Ctx, pair: PairGrade): Claim {
  const ends = [pair.a, pair.b].flatMap((id) => nodeOf(ctx.model, id) ?? []);
  const ph = pair.dimensions.phenotype;
  const missing = ends.filter((d) => !symptomEdges(ctx.model, d.id).length);
  if (missing.length || !ph) {
    return {
      text: say.noSymptomsClaim(missing.length === ends.length ? ends.map((d) => d.label) : missing.map((d) => d.label)),
      cites: ctx.reg.cite(ends.map((d) => symptomListCitation(ctx.model, d))),
    };
  }
  const det = ph.details ?? {};
  const num = (k: string) => (typeof det[k] === "number" ? (det[k] as number) : 0);
  return {
    text: say.symptomClaim({ shared: num("shared_exact") || ph.shared.length, rare: num("shared_rare"), score: ph.score, percentile: ph.percentile, tier: pair.clinical_tier }),
    cites: ctx.reg.cite(ends.map((d) => symptomListCitation(ctx.model, d))),
  };
}

// A row's reason without the records the header already cites for the center (its own gene or
// symptom list), so each row shows only what is particular to it. A reason keeps them if nothing
// else is left.
function without(claim: Claim, omit: ReadonlySet<number>): Claim {
  const cites = claim.cites.filter((n) => !omit.has(n));
  return cites.length ? { ...claim, cites } : claim;
}

function relatedRows(ctx: Ctx, anchorId: string, refs: readonly { id: string; relevance?: number }[], omit: ReadonlySet<number> = new Set()): RowVM[] {
  return refs.flatMap(({ id, relevance }) => {
    const node = nodeOf(ctx.model, id);
    const pair = pairOf(ctx.model, anchorId, id);
    if (!node || !pair) return [];
    return [{ id, name: sentenceLabel(node.label), color: diseaseColor(ctx.model, id), tier: pair.tier, value: relevance ?? pair.relevance, reason: without(biologyWhy(ctx, pair, true), omit), small: scoreLine(ctx, pair) }];
  });
}

function scoreLine(ctx: Ctx, pair: PairGrade): string | undefined {
  if (ctx.mode !== "researcher") return undefined;
  const lines = pair.lines_of_evidence.map((k) => DIMENSION_WORD[k].toLowerCase()).join(", ") || "none";
  return `lines: ${lines} · biology ${formatScore(pair.biology)} · clinical ${formatScore(pair.clinical)} · collaboration ${formatScore(pair.collaboration)}`;
}

function lookAlikeRows(ctx: Ctx, anchorId: string, ids: readonly string[], omit: ReadonlySet<number>): RowVM[] {
  return ids.flatMap((id) => {
    const node = nodeOf(ctx.model, id);
    const pair = pairOf(ctx.model, anchorId, id);
    if (!node || !pair || !pair.clinical_tier) return [];
    return [{ id, name: sentenceLabel(node.label), color: diseaseColor(ctx.model, id), clinicalTier: pair.clinical_tier, value: pair.clinical, reason: without(clinicalWhy(ctx, pair), omit), small: scoreLine(ctx, pair) }];
  });
}

function stepOf(ctx: Ctx, step: NextStep, disease: GraphNode, omit: ReadonlySet<number> = new Set()): StepVM {
  const { model } = ctx;
  const records = edgesById(model, step.edgeIds);
  const cites = records.length
    ? citeEdges(ctx, records)
    : ctx.reg.cite([searchCitation(model, "orphanet", disease), searchCitation(model, "nih", disease, genesOf(model, disease.id)[0]?.node.label)]);
  // The reason: a step through a related disease rests on the biology they share (the step's own
  // records are cited on the line above it); a step that starts from the disease itself says nothing
  // links it to a related disease yet, which the searches of every disease back.
  const shared = (step.relatedIds ?? []).flatMap((id) => {
    const pair = pairOf(model, disease.id, id);
    return pair ? without(biologyWhy(ctx, pair, true), omit).cites : [];
  });
  const becauseCites = step.relatedIds?.length
    ? shared.length
      ? [...new Set(shared)].sort((a, b) => a - b)
      : cites
    : step.kind === "gap" || step.kind === "study"
      ? cites
      : ctx.reg.cite((["orphanet", "pubmed", "nih"] as const).map((k) => searchCitation(model, k, null)));
  return { kind: step.kind, text: step.text, because: step.because, caveat: step.caveat ? plainEvidence({ evidence: step.caveat }) : null, cites, becauseCites };
}

function hasContent(section: SectionVM): boolean {
  return section.blocks.some((b) => (b.kind === "rows" ? b.rows.length > 0 : b.kind === "items" ? b.items.length > 0 : b.kind !== "note"));
}

// The first section always starts open (its empty state is the news when there is nothing), then
// the next one that has something to show.
function openFirstTwo(sections: SectionVM[]): SectionVM[] {
  let opened = 0;
  return sections.map((s, i) => {
    const open = opened < 2 && (i === 0 || hasContent(s));
    if (open) opened++;
    return { ...s, open };
  });
}

function finish<T extends Omit<DocBase, "sources" | "summary">>(ctx: Ctx, doc: T): T & Pick<DocBase, "sources" | "summary"> {
  const sources = ctx.reg.records();
  const by = (style: Badge["style"]) => sources.filter((r) => r.badge.style === style).length;
  const text = say.summaryText({ total: sources.length, stated: by("stated"), inferred: by("inferred"), searched: by("searched"), disputed: by("disputed") });
  return { ...doc, sections: openFirstTwo(doc.sections), sources, summary: { text, sources: [...new Set(sources.map((r) => say.shortSource(r.source)))] } };
}

const symptomOrder = (model: AtlasModel) => (a: GraphNode, b: GraphNode) => {
  const info = model.relevance.node_info ?? {};
  return (info[b.id]?.ic ?? -1) - (info[a.id]?.ic ?? -1) || a.label.localeCompare(b.label);
};

function symptomItems(ctx: Ctx, items: readonly LinkedItem[], cites: number[]): ItemVM[] {
  const info = ctx.model.relevance.node_info ?? {};
  return items.map((s) => {
    const spec = info[s.node.id]?.specificity;
    const word = say.rarityWord(spec);
    return itemOf(
      ctx,
      s,
      {
        note: word === "Rare" ? "Rare symptom" : undefined,
        small: ctx.mode === "researcher" && spec !== undefined ? `more specific than ${formatPercent(spec)} of symptoms` : undefined,
      },
      cites,
    );
  });
}

// ---------- a disease in the center ----------

export function buildDiseaseDoc(model: AtlasModel, focusId: string, mode: Mode): DiseaseDoc | null {
  const node = nodeOf(model, focusId);
  if (!node || node.type !== "Disease") return null;
  const ctx: Ctx = { model, reg: citationRegistry(), mode };
  const researcher = mode === "researcher";
  const entry = model.relevance.diseases[focusId];
  const profile = diseaseProfile(model, focusId);
  const cluster = clusterOf(model, focusId);
  const info = model.relevance.node_info ?? {};
  const geneNames = profile.genes.map((g) => g.node.label);
  const withData = pathwayDataCount(model);
  const orphanet = typeof node.attributes?.orphanet === "string" && node.attributes.orphanet ? node.attributes.orphanet : null;
  const hasSymptoms = profile.symptoms.length + profile.context.length > 0;

  // The header cites the disease's own gene and symptom records first, so the rows below can leave
  // them out and show only what each related disease adds.
  const geneCites = geneNames.length ? citeEdges(ctx, profile.genes.flatMap((g) => g.edges)) : ctx.reg.cite([monarchSearchCitation(model, node)]);
  const symptomCite = ctx.reg.cite([symptomListCitation(model, node)]);
  const facts: Claim[] = [
    { text: geneNames.length === 1 ? `${geneNames[0]} gene` : geneNames.length ? countLabel("Gene", geneNames.length) : "No gene on record", cites: geneCites },
    { text: profile.symptoms.length ? `${countLabel("Phenotype", profile.symptoms.length)} on record` : "No symptoms on record", cites: symptomCite },
    ...[
      profile.orgs.length ? countLabel("PatientOrg", profile.orgs.length) : "No patient group",
      profile.papers.length ? countLabel("Paper", profile.papers.length) : "No papers",
      ...(profile.grants.length ? [countLabel("Grant", profile.grants.length)] : []),
    ].map((text) => ({ text, cites: [] })), // counts of the cited lists under People and research
  ];
  const own = new Set([...geneCites, ...symptomCite]);
  const links = [{ label: node.source, url: node.url }, ...(orphanet ? [{ label: "Orphanet", url: `https://www.orpha.net/en/disease/detail/${orphanet}` }] : [])];
  const sections: SectionVM[] = [];

  // Most related diseases, by biology.
  const related = relatedRows(ctx, focusId, entry?.neighbors ?? [], own);
  sections.push({
    id: "related",
    title: "Most related diseases",
    count: String(related.length),
    hint: "Ranked by shared biology: the same gene, the same type of gene change or a shared pathway. This sets the distance on the map.",
    open: false,
    blocks: [
      {
        kind: "rows",
        rows: related,
        limit: 5,
        what: "related diseases",
        action: "select",
        empty: related.length ? undefined : { text: `No disease here shares its biology yet.`, cites: geneCites },
      },
      ...(entry?.hidden ? [{ kind: "note" as const, text: `${entry.hidden} weaker ${entry.hidden === 1 ? "link is" : "links are"} not listed.` }] : []),
    ],
  });

  // Looks similar, by symptoms.
  const alike = lookAlikeRows(
    ctx,
    focusId,
    (entry?.clinical_neighbors ?? []).map((n) => n.id),
    own,
  );
  sections.push({
    id: "alike",
    title: "Looks similar (symptoms)",
    count: String(alike.length),
    hint: "Similar symptoms, shown beside the biology. It never moves a disease on the map.",
    open: false,
    blocks: [
      {
        kind: "rows",
        rows: alike,
        limit: 3,
        what: "look-alikes",
        action: "select",
        empty: alike.length
          ? undefined
          : hasSymptoms
            ? { text: "No disease here looks similar enough in symptoms.", cites: symptomCite }
            : { text: `No symptoms on record for ${node.label}, so it can't be compared by symptoms.`, cites: symptomCite },
      },
    ],
  });

  // Biology: genes, pathways, gene changes, cited in that reading order. A statement of absence is
  // built (and its search cited) only when its list is empty.
  const genes = profile.genes.map((g) => itemOf(ctx, g));
  const pathways = profile.mechanisms.map((m) => {
    const reach = info[m.node.id]?.diseases;
    const spec = info[m.node.id]?.specificity;
    return itemOf(ctx, m, {
      note: typeof reach === "number" ? (reach >= withData ? `Shared by all ${withData} diseases with pathway data` : `Shared by ${reach} of ${withData} diseases with pathway data`) : undefined,
      small: researcher && typeof spec === "number" ? `specificity ${formatScore(spec)}` : undefined,
    });
  });
  const noPathway: Claim | undefined =
    geneNames.length && !pathways.length ? { text: `No pathway on record for ${say.joinAnd(geneNames)}.`, cites: ctx.reg.cite(geneNames.map((g) => reactomeSearchCitation(model, g))) } : undefined;
  const variantCites = ctx.reg.cite(profile.variants.flatMap((v) => variantItemCitation(model, v) ?? []));
  const geneShared = profile.genes.some((g) => model.index.diseasesFor(g.node.id).length > 1);
  const bio: Block[] = [
    {
      kind: "items",
      heading: geneNames.length === 1 ? "Gene" : "Genes",
      items: genes,
      limit: 4,
      what: "genes",
      empty: genes.length ? undefined : { text: "No gene on record.", cites: geneCites },
    },
    { kind: "items", heading: "Pathways", items: pathways, limit: 3, what: "pathways", empty: noPathway },
  ];
  if (pathways.length) bio.push({ kind: "note", text: `${say.PATHWAY_MEANS} ${say.PATHWAY_NOTE}` });
  if (profile.variants.length) {
    bio.push({
      kind: "claims",
      claims: [{ text: `ClinVar lists ${countLabel("Variant", profile.variants.length)} in ${say.joinAnd(geneNames) || "its genes"}.`, cites: variantCites }],
    });
    if (researcher) {
      bio.push({
        kind: "items",
        heading: "Gene changes",
        items: profile.variants.map((v) => ({
          id: v.node.id,
          label: variantLabel(v.node.label),
          url: v.node.url,
          type: v.node.type,
          small: say.EFFECT_WORDS[classifyVariant(v.node.label)],
          cites: ctx.reg.cite([variantItemCitation(model, v) ?? []].flat()),
        })),
        limit: 6,
        what: "gene changes",
      });
    }
    if (geneShared) bio.push({ kind: "note", text: "Gene changes are recorded per gene, not per disease, so they may belong to another disease of the same gene." });
  }
  sections.push({
    id: "biology",
    title: "Biology",
    count: [countLabel("Gene", profile.genes.length), countLabel("Mechanism", pathways.length)].join(" · "),
    open: false,
    blocks: bio,
  });

  // Symptoms on record, rarest first.
  const symptomBlocks: Block[] = [
    {
      kind: "items",
      heading: profile.symptoms.length ? "Rarest first" : undefined,
      cites: symptomCite,
      items: symptomItems(ctx, [...profile.symptoms].sort((a, b) => symptomOrder(model)(a.node, b.node)), []),
      limit: 6,
      what: "symptoms",
      empty: { text: "No symptoms on record.", cites: symptomCite },
    },
  ];
  if (profile.context.length) symptomBlocks.push({ kind: "items", heading: "Onset and inheritance", cites: symptomCite, items: profile.context.map((c) => itemOf(ctx, c, {}, [])), limit: 4, what: "facts" });
  if (!profile.symptoms.length) symptomBlocks.push({ kind: "note", text: say.SYMPTOM_DATA_NOTE });
  sections.push({
    id: "symptoms",
    title: "Symptoms on record",
    count: String(profile.symptoms.length),
    hint: profile.symptoms.length ? "The rarest symptoms say the most about a disease." : undefined,
    open: false,
    blocks: symptomBlocks,
  });

  // People and research.
  const people: Block[] = [];
  const listOf = (heading: string, items: readonly LinkedItem[], what: string, limit: number) => {
    if (!items.length) return;
    people.push({ kind: "items", heading, items: items.map((i) => itemOf(ctx, i)), limit, what, badge: evidenceBadgeOf(items.flatMap((i) => i.edges)) });
  };
  listOf("Patient groups", profile.orgs, "patient groups", 3);
  listOf("Papers", profile.papers, "papers", 3);
  listOf("Research grants", profile.grants, "grants", 3);
  if (!people.length) {
    people.push({
      kind: "claims",
      claims: [{ text: "No patient group, paper or research grant on record.", cites: ctx.reg.cite((["orphanet", "pubmed", "nih"] as const).map((d) => searchCitation(model, d, node, geneNames[0]))) }],
    });
  }
  sections.push({
    id: "people",
    title: "People and research",
    count: String(profile.orgs.length + profile.papers.length + profile.grants.length),
    hint: "What already exists that families and researchers can build on.",
    open: false,
    blocks: people,
  });

  // What we don't know.
  const unknown: Claim[] = [];
  if (!geneNames.length) unknown.push({ text: "No gene on record.", cites: geneCites });
  else if (noPathway) unknown.push(noPathway);
  if (!profile.symptoms.length) unknown.push({ text: `No symptoms on record. ${say.SYMPTOM_DATA_NOTE}`, cites: symptomCite });
  const gaps = Array.isArray(node.attributes?.gaps) ? (node.attributes.gaps as unknown[]).filter((g): g is string => typeof g === "string") : [];
  for (const gap of gaps) {
    const dataset = say.gapDataset(gap);
    unknown.push({ text: say.gapText(gap), cites: dataset ? ctx.reg.cite([searchCitation(model, dataset, node, geneNames[0])]) : ctx.reg.cite([nodeCitation(node, `${node.source} record for ${node.label}.`)]) });
  }
  if (unknown.length) sections.push({ id: "unknown", title: "What we don't know", count: String(unknown.length), open: false, blocks: [{ kind: "bullets", items: unknown }] });

  const steps = nextSteps(model.graph, model.relevance, focusId, null).map((s) => stepOf(ctx, s, node, own));
  return finish(ctx, {
    view: "disease" as const,
    node,
    title: sentenceLabel(node.label),
    group: { label: clusterName(cluster), color: clusterColor(cluster?.color_slot) },
    facts,
    links,
    sections,
    steps,
  });
}

// ---------- a related disease selected: the pair ----------

const FAMILY_WORD = { biology: "Biology (sets the distance)", clinical: "Clinical resemblance", collaboration: "Working together" } as const;

export function buildPairDoc(model: AtlasModel, focusId: string, anchorId: string, other: GraphNode, pair: PairGrade, mode: Mode): PairDoc | null {
  const anchor = nodeOf(model, anchorId);
  const focus = nodeOf(model, focusId);
  if (!anchor || !focus) return null;
  const ctx: Ctx = { model, reg: citationRegistry(), mode };
  const d = pair.dimensions;
  const name = (id: string) => nodeOf(model, id)?.label ?? id;

  // The verdict comes first, so its records are [1], [2]…
  const biologyEdges = (["gene", "mechanism", "variant"] as const).filter((k) => shares(d[k])).flatMap((k) => edgesById(model, d[k].shared.flatMap((s) => s.edges)));
  const biology = { tier: pair.tier, value: pair.relevance, badge: evidenceBadgeOf(biologyEdges, pair.support), why: verdictWhy(ctx, pair) };
  const compared = [pair.a, pair.b].every((id) => symptomEdges(model, id).length > 0);
  const clinical = pair.clinical_tier ? { tier: pair.clinical_tier, value: pair.clinical, why: clinicalWhy(ctx, pair), compared } : null;

  const sections: SectionVM[] = [];

  // What they share (reusable): the evidence item by item; the verdict above already says it in a sentence.
  const shared: Block[] = [];
  const sharedGene = d.gene?.status === "match" ? d.gene.shared.map((s) => s.label) : [];
  if (sharedGene.length) {
    shared.push({
      kind: "items",
      heading: "Same gene",
      items: d.gene.shared.map((s) => ({ id: s.id, label: s.label, url: nodeOf(model, s.id)?.url ?? "", type: s.type, cites: citeIds(ctx, s.edges) })),
      limit: 4,
      what: "genes",
    });
    shared.push({ kind: "note", text: say.SAME_GENE_CAVEAT });
  }
  const mech = d.mechanism;
  if (mech && mech.shared.length) {
    if (mech.details?.through_shared_gene === true) {
      shared.push({ kind: "claims", claims: [{ text: say.pathwaysWithGeneClaim(mech.shared.length, say.joinAnd(sharedGene)), cites: citeIds(ctx, mostSpecific(mech).edges) }] });
    } else if (shares(mech)) {
      const info = model.relevance.node_info ?? {};
      const withData = typeof mech.details?.N === "number" ? mech.details.N : pathwayDataCount(model);
      shared.push({
        kind: "items",
        heading: mech.shared.length === 1 ? "Shared pathway" : `Shared pathways (${mech.shared.length})`,
        items: mech.shared.map((s) => {
          const reach = info[s.id]?.diseases;
          return {
            id: s.id,
            label: s.label,
            url: nodeOf(model, s.id)?.url ?? "",
            type: "Mechanism" as const,
            note: typeof reach === "number" ? `Shared by ${reach} of ${withData} diseases with pathway data` : undefined,
            small: mode === "researcher" && typeof info[s.id]?.specificity === "number" ? `specificity ${formatScore(info[s.id]!.specificity!)}` : undefined,
            cites: citeIds(ctx, s.edges),
          };
        }),
        limit: 3,
        what: "pathways",
      });
      shared.push({ kind: "note", text: say.PATHWAY_NOTE });
    }
  }
  if (shares(d.variant)) {
    const claim = variantClaimOf(ctx, pair);
    if (claim) shared.push({ kind: "claims", claims: [claim] }, { kind: "note", text: say.VARIANT_SOURCE_NOTE });
  }
  const ends = [anchorId, other.id].flatMap((id) => nodeOf(model, id) ?? []);
  // Cited only where a sentence uses it, so Sources never lists a record nothing on screen cites.
  const symptomCites = () => ctx.reg.cite(ends.map((n) => symptomListCitation(model, n)));
  if (d.phenotype?.shared.length) {
    const info = model.relevance.node_info ?? {};
    const items = [...d.phenotype.shared]
      .sort((a, b) => (info[b.id]?.ic ?? b.weight) - (info[a.id]?.ic ?? a.weight) || a.label.localeCompare(b.label))
      .map((s): ItemVM => {
        const spec = info[s.id]?.specificity;
        return {
          id: s.id,
          label: s.label,
          url: nodeOf(model, s.id)?.url ?? "",
          type: "Phenotype",
          note: say.rarityWord(spec) === "Rare" ? "Rare symptom" : undefined,
          small: mode === "researcher" && spec !== undefined ? `more specific than ${formatPercent(spec)} of symptoms` : undefined,
          cites: [],
        };
      });
    shared.push({ kind: "items", heading: `Symptoms in both (${items.length})`, cites: symptomCites(), items, limit: 6, what: "shared symptoms" });
  }
  if (!shared.length) shared.push({ kind: "claims", claims: [nothingSharedClaim(ctx, pair)] });
  sections.push({ id: "shared", title: "What they share", hint: "What a study of one could reuse for the other.", open: false, blocks: shared });

  // What differs.
  const differs: Claim[] = [];
  if (d.gene?.status === "none") {
    const sides = ends.map((n) => ({ name: n.label, genes: genesOf(model, n.id).map((g) => g.node.label) }));
    differs.push({ text: say.differentGenesClaim(sides), cites: citeEdges(ctx, ends.flatMap((n) => genesOf(model, n.id).map((g) => g.edge))) });
  }
  if (d.variant?.status === "none") {
    const claim = variantClaimOf(ctx, pair);
    if (claim) differs.push(claim);
  }
  const sharedSymptoms = new Set((d.phenotype?.shared ?? []).map((s) => s.id));
  if (ends.every((n) => symptomEdges(model, n.id).length)) {
    for (const n of ends) {
      const only = diseaseProfile(model, n.id)
        .symptoms.map((s) => s.node)
        .filter((s) => !sharedSymptoms.has(s.id))
        .sort(symptomOrder(model));
      differs.push({ text: say.onlyInClaim(n.label, only.length, only.slice(0, 3).map((s) => s.label)), cites: ctx.reg.cite([symptomListCitation(model, n)]) });
    }
  }
  if (!differs.length) differs.push({ text: "Nothing on record sets them apart yet.", cites: ctx.reg.cite(ends.map((n) => nodeCitation(n, `${n.source} record for ${n.label}.`))) });
  sections.push({ id: "differs", title: "What differs", count: String(differs.length), open: false, blocks: [{ kind: "bullets", items: differs }] });

  // Needs expert review: the flags as tasks, plus the caveats that come with each kind of evidence.
  const review: Claim[] = [];
  const fewFor = ends.flatMap((n) => {
    const k = symptomEdges(model, n.id).length;
    return k > 0 && k < 5 ? [{ name: n.label, n: k }] : [];
  });
  const flagCites: Partial<Record<Flag, () => number[]>> = {
    same_gene_allelic: () => citeIds(ctx, d.gene?.shared.flatMap((s) => s.edges) ?? []),
    variant_effect_unknown: () => ctx.reg.cite(variantCitations(model, pair.a)),
    derived_from_variant_notation: () => ctx.reg.cite([...variantCitations(model, pair.a), ...variantCitations(model, pair.b)]),
    variant_type_conflict: () => ctx.reg.cite([...variantCitations(model, pair.a), ...variantCitations(model, pair.b)]),
    few_annotations: symptomCites,
    generic_symptoms_only: symptomCites,
  };
  for (const flag of new Set(pair.flags)) {
    if (flag === "few_annotations" && !fewFor.length) continue;
    const text = say.reviewText(flag, { gene: say.joinAnd(sharedGene) || undefined, fewFor });
    if (text) review.push({ text, cites: flagCites[flag]?.() ?? [] });
  }
  if (shares(mech) && mech.shared.length && mech.details?.through_shared_gene !== true) review.push({ text: say.PATHWAY_REVIEW, cites: citeIds(ctx, mostSpecific(mech).edges) });
  const together = DIMENSIONS.filter((k) => DIMENSION_FAMILY[k] === "collaboration" && d[k]?.shared.length);
  const inferredTogether = together.filter((k) => d[k].shared.some((s) => s.kind !== "observed"));
  if (inferredTogether.length) {
    review.push({
      text: say.inferredReview(say.joinAnd(inferredTogether.map((k) => DIMENSION_WORD[k].toLowerCase()))),
      cites: citeIds(ctx, inferredTogether.flatMap((k) => d[k].shared.filter((s) => s.kind !== "observed").flatMap((s) => s.edges))),
    });
  }
  // Missing evidence, for the kinds this data has at all, citing each search.
  const missing: { text: string; cites: CitationInput[] }[] = [];
  for (const n of ends) {
    const p = diseaseProfile(model, n.id);
    const gene = genesOf(model, n.id)[0]?.node.label;
    const none: string[] = [];
    const cites: CitationInput[] = [];
    if (!p.symptoms.length) (none.push("symptoms"), cites.push(noSymptomsCitation(model, n)));
    if (!p.orgs.length) (none.push("patient groups"), cites.push(searchCitation(model, "orphanet", n)));
    if (!p.papers.length) (none.push("papers"), cites.push(searchCitation(model, "pubmed", n, gene)));
    if (!p.grants.length) (none.push("research grants"), cites.push(searchCitation(model, "nih", n, gene)));
    if (none.length) missing.push({ text: `Not on record for ${n.label}: ${say.joinAnd(none)}.`, cites });
  }
  for (const m of missing) review.push({ text: m.text, cites: ctx.reg.cite(m.cites) });
  if (!review.length) review.push({ text: "No caveat on record beyond the usual: an expert should still confirm the link.", cites: biology.why.cites });
  sections.push({ id: "review", title: "Needs expert review", count: String(review.length), open: false, blocks: [{ kind: "bullets", items: review }] });

  // Already connecting them.
  const bridge: Block[] = [];
  for (const k of together) {
    const dim = d[k];
    const umbrellas = umbrellaIds(model, dim);
    bridge.push({
      kind: "items",
      heading: DIMENSION_WORD[k],
      items: dim.shared.map((s) => ({
        id: s.id,
        label: s.label,
        url: nodeOf(model, s.id)?.url ?? "",
        type: s.type,
        note: umbrellas.has(s.id) ? "Covers most diseases here, so it says little about this pair" : undefined,
        cites: citeIds(ctx, s.edges),
      })),
      limit: 4,
      what: DIMENSION_WORD[k].toLowerCase(),
      badge: evidenceBadgeOf(edgesById(model, dim.shared.flatMap((s) => s.edges)), dim.support),
    });
  }
  if (!bridge.length) {
    bridge.push({
      kind: "claims",
      claims: [{ text: "No shared patient group, paper or research grant on record yet.", cites: ctx.reg.cite((["orphanet", "pubmed", "nih"] as const).map((k) => searchCitation(model, k, null))) }],
    });
  }
  sections.push({ id: "together", title: "Already connecting them", count: String(together.reduce((n, k) => n + d[k].shared.length, 0)), open: false, blocks: bridge });

  const steps = nextSteps(model.graph, model.relevance, anchorId, other.id).map((s) => stepOf(ctx, s, anchor));

  const caps = model.relevance.meta.caps;
  const scores: ScoreRow[] = DIMENSIONS.flatMap((k) => {
    const dim = d[k];
    if (!dim) return [];
    return [{ line: DIMENSION_WORD[k], status: STATUS_WORD[dim.status], score: formatScore(dim.score), cap: caps[k] !== undefined ? formatScore(caps[k]) : "–", countsToward: FAMILY_WORD[dim.family] }];
  });

  return finish(ctx, {
    view: "pair" as const,
    anchor,
    other,
    title: `${sentenceLabel(anchor.label)} and ${other.label}`,
    through: anchorId !== focusId ? `Graded against ${anchor.label}, which ${focus.label} is linked to.` : null,
    biology,
    clinical,
    totals: [
      { label: "Biology (relevance)", value: formatScore(pair.biology) },
      { label: "Clinical", value: formatScore(pair.clinical) },
      { label: "Working together", value: formatScore(pair.collaboration) },
    ],
    scores,
    lines: pair.lines_of_evidence.map((k) => DIMENSION_WORD[k]),
    engineNote: [engineText(pair.tier_reason), ...(pair.clinical_reason ? [engineText(pair.clinical_reason)] : [])],
    sections,
    steps,
  });
}

// ---------- a gene, symptom, pathway, group, paper or grant: in the center or selected ----------

// What the item is, in one or two cited sentences.
function introClaims(ctx: Ctx, node: GraphNode): Claim[] {
  const { model } = ctx;
  const own = (claim: string) => ctx.reg.cite([nodeCitation(node, claim)]);
  const info = model.relevance.node_info?.[node.id];
  const diseases = model.index.diseasesFor(node.id).filter((id) => id !== node.id);
  switch (node.type) {
    case "Gene": {
      const causes = liveEdges(model, node.id).filter((e) => nodeOf(model, otherEnd(e, node.id))?.type === "Disease");
      const only = causes.length === 1 ? nodeOf(model, otherEnd(causes[0], node.id)) : undefined;
      return [{ text: `${node.label} is a gene. Monarch links changes in it to ${only ? only.label : `${countLabel("Disease", causes.length)} here`}.`, cites: citeEdges(ctx, causes) }];
    }
    case "Phenotype": {
      const out: Claim[] = [{ text: `${sentenceLabel(node.label)} is a symptom recorded for ${countLabel("Disease", diseases.length)} here.`, cites: own(`HPO term ${node.label} (${node.id}).`) }];
      const rarity = say.rarityClaim(sentenceLabel(node.label), info?.specificity, formatPercent);
      if (rarity) out.push({ text: rarity, cites: own(`HPO term ${node.label} (${node.id}).`) });
      return out;
    }
    case "Mechanism": {
      const withData = pathwayDataCount(model);
      const reach = info?.diseases;
      return [
        { text: `${sentenceLabel(node.label)} is a Reactome pathway. ${say.PATHWAY_MEANS}`, cites: own(`Reactome pathway ${node.label}.`) },
        ...(typeof reach === "number"
          ? [{ text: reach >= withData ? `All ${withData} diseases with pathway data reach it, so on its own it does not tell them apart.` : `${reach} of the ${withData} diseases with pathway data reach it through their genes.`, cites: citeEdges(ctx, liveEdges(model, node.id).filter((e) => e.type === "in_pathway")) }]
          : []),
      ];
    }
    case "PatientOrg":
      return [{ text: `${node.label} is a patient group in Orphanet's directory.`, cites: own(`Orphanet directory entry for ${node.label}.`) }];
    case "Paper":
      return [{ text: "A paper indexed in PubMed.", cites: own(`PubMed record: “${node.label.replace(/\.$/, "")}”.`) }];
    case "Grant":
      return [{ text: "A research project funded by the NIH.", cites: own(`NIH RePORTER record: “${node.label.replace(/\.$/, "")}”.`) }];
    case "Variant": {
      const of = liveEdges(model, node.id).filter((e) => e.type === "variant_of");
      return [{ text: `A gene change recorded in ClinVar.`, cites: citeEdges(ctx, of) }];
    }
    case "Disease":
      return [{ text: `${sentenceLabel(node.label)} is a disease in RareVerse.`, cites: own(`${node.source} record for ${node.label}.`) }];
    default:
      return [{ text: `${TYPE_WORD[node.type]} on record.`, cites: own(`${node.source} record for ${node.label}.`) }];
  }
}

// Why a disease is linked to the item: its own edges, or the path through a gene.
function linkReason(ctx: Ctx, node: GraphNode, diseaseId: string): Claim | null {
  const { model } = ctx;
  const direct = liveEdges(model, node.id).filter((e) => otherEnd(e, node.id) === diseaseId);
  if (direct.length) {
    const first = direct[0];
    const text =
      node.type === "Gene"
        ? `Linked to changes in ${node.label}.`
        : node.type === "Phenotype"
          ? "Has this symptom."
          : node.type === "PatientOrg"
            ? "Matched to it by name in Orphanet's directory."
            : node.type === "Paper" || node.type === "Grant"
              ? `Linked by a ${first.source} search.`
              : edgeClaim(model, first);
    return { text, cites: citeEdges(ctx, direct) };
  }
  // Through a gene: the disease's gene, then the gene's link to the item.
  for (const g of genesOf(model, diseaseId)) {
    const hop = liveEdges(model, g.node.id).filter((e) => otherEnd(e, g.node.id) === node.id);
    if (hop.length) return { text: `Through its gene ${g.node.label}.`, cites: citeEdges(ctx, [g.edge, ...hop]) };
  }
  return null;
}

export function buildNodeDoc(
  model: AtlasModel,
  hood: Neighborhood,
  focusId: string,
  node: GraphNode,
  hoodNode: HoodNode | undefined,
  threshold: number,
  mode: Mode,
): NodeDoc {
  const ctx: Ctx = { model, reg: citationRegistry(), mode };
  const center = node.id === focusId;
  const focus = nodeOf(model, focusId);
  const centerName = focus?.label ?? focusId;
  const researcher = mode === "researcher";

  // Selected around a center: the records that put it on the map. A direct link cites them in the
  // header line, which reads first; the intro then states each one unless a sentence already did.
  const onMap = (() => {
    if (center || !hoodNode) return [];
    const lines = hood.edges.filter((e) => e.role !== "bridge" && (e.a === node.id || e.b === node.id) && (e.a === hoodNode.owner || e.b === hoodNode.owner || e.role === "similarity"));
    return [...new Map(lines.flatMap((l) => edgesById(model, l.edgeIds)).map((e) => [e.id, e])).values()].slice(0, 4);
  })();
  const relevance: Claim | null = center
    ? null
    : !hoodNode
      ? { text: `Not on the map around ${centerName}.`, cites: [] }
      : hoodNode.relevance >= 1
        ? { text: `Directly linked to ${centerName}`, cites: citeEdges(ctx, onMap) }
        : { text: `${formatPercent(hoodNode.relevance)} relevant to ${centerName}${hoodNode.relevance < threshold - 1e-9 ? `, under your ${formatPercent(threshold)} filter` : ""}`, cites: [] };
  const intro = introClaims(ctx, node);
  for (const e of onMap) {
    const cites = citeEdges(ctx, [e]);
    if (!cites.every((n) => intro.some((c) => c.cites.includes(n)))) intro.push({ text: edgeClaim(model, e), cites });
  }

  const sections: SectionVM[] = [];
  const diseaseIds = center ? hood.anchors : model.index.diseasesFor(node.id).filter((id) => id !== node.id);
  if (node.type !== "Disease" || !center) {
    const folded = hood.nodes.find((n) => n.role === "bubble" && n.bubbleType === "Disease");
    const rows: RowVM[] = diseaseIds.flatMap((id) => {
      const d = nodeOf(model, id);
      if (!d || d.type !== "Disease") return [];
      const hn = hood.nodes.find((n) => n.id === id);
      const at = folded?.members?.indexOf(id) ?? -1;
      const value = hn?.relevance ?? (at >= 0 ? folded!.memberRelevance![at] : center ? 1 : 0);
      return [{ id, name: sentenceLabel(d.label), color: diseaseColor(model, id), value, reason: linkReason(ctx, node, id) }];
    });
    if (rows.length || center) {
      sections.push({
        id: "linked",
        title: node.type === "Phenotype" ? "Diseases with this symptom" : node.type === "Gene" ? "Diseases linked to this gene" : "Linked diseases",
        count: String(rows.length),
        hint: center && rows.length ? "They sit closest to the center of the map. Select one for its evidence." : undefined,
        open: false,
        blocks: [
          {
            kind: "rows",
            rows,
            limit: 6,
            what: "diseases",
            action: center ? "select" : "focus",
            empty: rows.length ? undefined : { text: `${sentenceLabel(node.label)} is not linked to any disease here yet.`, cites: intro[0]?.cites ?? [] },
          },
        ],
      });
    }
  }

  // In the center: the diseases that share biology with the ones it belongs to. Their rows leave out
  // the records the intro already cites (the item's own links).
  if (center && hood.anchors.length) {
    const introCites = new Set(intro.flatMap((c) => c.cites));
    const related: RowVM[] = hood.related.flatMap((r) => {
      let best: { anchor: string; pair: PairGrade } | null = null;
      for (const a of hood.anchors) {
        const pair = pairOf(model, a, r.id);
        if (pair && (!best || pair.relevance > best.pair.relevance)) best = { anchor: a, pair };
      }
      const d = nodeOf(model, r.id);
      if (!d || !best) return [];
      return [{ id: r.id, name: sentenceLabel(d.label), color: diseaseColor(model, r.id), tier: r.tier, value: r.relevance, reason: without(biologyWhy(ctx, best.pair, true), introCites) }];
    });
    sections.push({
      id: "related",
      title: "Share biology with them",
      count: String(related.length),
      hint: "Graded against the diseases above; their relevance carries through that link.",
      open: false,
      blocks: [{ kind: "rows", rows: related, limit: 5, what: "related diseases", action: "select", empty: related.length ? undefined : { text: "No other disease here shares their biology yet.", cites: rowsCites(sections) } }],
    });
  }

  // A gene's own biology: its pathways and recorded changes.
  if (node.type === "Gene") {
    const info = model.relevance.node_info ?? {};
    const pathways = liveEdges(model, node.id).filter((e) => e.type === "in_pathway");
    const variants = liveEdges(model, node.id).filter((e) => e.type === "variant_of");
    const blocks: Block[] = [
      {
        kind: "items",
        heading: "Pathways",
        items: pathways
          .flatMap((e) => nodeOf(model, otherEnd(e, node.id)) ?? [])
          .sort((a, b) => (info[b.id]?.specificity ?? 0) - (info[a.id]?.specificity ?? 0) || a.label.localeCompare(b.label))
          .map((p) => ({
            id: p.id,
            label: p.label,
            url: p.url,
            type: p.type,
            small: researcher && typeof info[p.id]?.specificity === "number" ? `specificity ${formatScore(info[p.id]!.specificity!)}` : undefined,
            cites: citeEdges(ctx, pathways.filter((e) => otherEnd(e, node.id) === p.id)),
          })),
        limit: 3,
        what: "pathways",
        empty: pathways.length ? undefined : { text: `No pathway on record for ${node.label}.`, cites: ctx.reg.cite([reactomeSearchCitation(model, node.label)]) },
      },
    ];
    if (pathways.length) blocks.push({ kind: "note", text: say.PATHWAY_MEANS });
    if (variants.length) blocks.push({ kind: "claims", claims: [{ text: `ClinVar lists ${countLabel("Variant", variants.length)} in ${node.label}, recorded for the gene, not for one disease.`, cites: citeEdges(ctx, variants) }] });
    sections.push({ id: "biology", title: "Biology", count: countLabel("Mechanism", pathways.length), open: false, blocks });
  }

  const contactIds = node.type === "Paper" || node.type === "Grant" ? model.index.diseasesFor(node.id).filter((id) => id !== node.id).slice(0, 2) : null;
  return finish(ctx, {
    view: "node" as const,
    node,
    center,
    eyebrow: center ? `${TYPE_WORD[node.type]} · in the center` : TYPE_WORD[node.type],
    title: sentenceLabel(node.label),
    relevance,
    intro,
    contactIds: contactIds?.length ? contactIds : null,
    sections,
    steps: [],
  });
}

// The citations of the rows already built, for a statement about them ("none of them …").
function rowsCites(sections: SectionVM[]): number[] {
  return [
    ...new Set(sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "rows" ? b.rows.flatMap((r) => r.reason?.cites ?? []) : [])))),
  ].sort((a, b) => a - b);
}

// ---------- a line selected ----------

const STRENGTH_MEANS: Record<HoodEdge["role"], string> = {
  similarity: "how much biology the two diseases share",
  evidence: "how strong this one link is: 100% for a gene, a pathway or a direct link, the symptom's rarity for a symptom",
  bridge: "how much research and how many groups are linked to both diseases",
  bubble: "the strongest link in the folded group",
};

export function buildEdgeDoc(model: AtlasModel, hood: Neighborhood, focusId: string, edge: HoodEdge, threshold: number, mode: Mode): EdgeDoc {
  const ctx: Ctx = { model, reg: citationRegistry(), mode };
  const focus = nodeOf(model, focusId);
  const centerName = focus?.label ?? focusId;
  const a = nodeOf(model, edge.a);
  const b = nodeOf(model, edge.b);
  const edges = edgesById(model, edge.edgeIds);
  const nameA = a?.label ?? edge.a;
  const nameB = b?.label ?? edge.b;
  const sections: SectionVM[] = [];
  let title: string;
  let eyebrow = "Line · evidence";
  let pairWith: GraphNode | null = null;

  const bubble = hood.nodes.find((n) => n.role === "bubble" && (n.id === edge.a || n.id === edge.b));
  if (edge.role === "bubble" && bubble) {
    // A folded line stands for a group: title it by the group and list the members it carries. A
    // bubble can gather items of several diseases or genes; this line carries those its records touch.
    const ownerId = bubble.id === edge.a ? edge.b : edge.a;
    const owner = nodeOf(model, ownerId);
    const type = bubble.bubbleType ?? "Phenotype";
    const touched = new Set(edges.flatMap((e) => [e.subject, e.object]));
    const members = (bubble.members ?? []).filter((id) => !edges.length || touched.has(id)).flatMap((id) => nodeOf(model, id) ?? []);
    eyebrow = "Line · folded group";
    title = `${sentenceLabel(owner?.label ?? ownerId)} has ${members.length} more ${members.length === 1 ? TYPE_NAME[type].one : TYPE_NAME[type].many} on record`;
    const listCite = owner?.type === "Disease" && type === "Phenotype" ? ctx.reg.cite([symptomListCitation(model, owner)]) : null;
    sections.push({
      id: "members",
      title: "What it stands for",
      count: String(members.length),
      open: false,
      blocks: [
        {
          kind: "items",
          heading: listCite ? `On record for ${owner?.label ?? ownerId}` : undefined,
          cites: listCite ?? undefined,
          items: members.map((m) => ({
            id: m.id,
            label: m.label,
            url: m.url,
            type: m.type,
            cites: listCite ? [] : citeEdges(ctx, edges.filter((e) => e.subject === m.id || e.object === m.id)),
          })),
          limit: 12,
          what: TYPE_NAME[type].many,
        },
      ],
    });
  } else {
    if (edge.role === "similarity") {
      eyebrow = "Line · shared biology";
      title = `${sentenceLabel(nameA)} and ${nameB} share biology`;
      const pair = a && b ? pairOf(model, a.id, b.id) : undefined;
      if (pair) {
        const claims = [biologyWhy(ctx, pair, false)];
        const blocks: Block[] = [{ kind: "claims", claims }];
        if (pair.dimensions.gene?.status === "match") blocks.push({ kind: "note", text: say.SAME_GENE_CAVEAT });
        else if (shares(pair.dimensions.mechanism)) blocks.push({ kind: "note", text: say.PATHWAY_NOTE });
        sections.push({ id: "why", title: "Why they're linked", open: false, blocks });
      }
      pairWith = a?.id === focusId ? b ?? null : b?.id === focusId ? a ?? null : b ?? null;
    } else if (edge.role === "bridge") {
      // Shared items are mostly search and name matches, so the title says what links them, not
      // that the two already work together.
      eyebrow = "Line · linked to both";
      const items = new Set(edges.flatMap((e) => [e.subject, e.object]).flatMap((id) => nodeOf(model, id) ?? []).filter((n) => n.type !== "Disease"));
      title = say.sharedWorkTitle(nameA, nameB, [...items].map((n) => n.type));
    } else {
      title = edges[0] ? edgeClaim(model, edges[0]).replace(/\.$/, "") : `${sentenceLabel(nameA)} and ${nameB}`;
    }
    // Every graph edge behind the line, one cited statement per subject, relation and object.
    const groups = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = [e.type, e.subject, e.object].join("|");
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const claims = [...groups.values()].map((group) => ({ text: edgeClaim(model, group[0]), cites: citeEdges(ctx, group) }));
    sections.push({
      id: "rests-on",
      title: "What this line rests on",
      count: String(claims.length),
      open: false,
      blocks: claims.length
        ? [{ kind: "claims", claims }]
        : [{ kind: "note", text: "No single record states this line; its grade combines the evidence of the pair. Select the disease to read it." }],
    });
  }

  return finish(ctx, {
    view: "edge" as const,
    eyebrow,
    title,
    strength: edge.strength,
    relevance: edge.relevance,
    strengthMeans: `Strength is ${STRENGTH_MEANS[edge.role]}. Relevance is that strength carried back to ${centerName}${
      edge.relevance < threshold - 1e-9 ? `; it is under your ${formatPercent(threshold)} filter, so the line is drawn faint.` : "."
    }`,
    pairWith: pairWith && pairWith.id !== focusId ? pairWith : null,
    centerable: [a, b].filter((n): n is GraphNode => !!n && n.id !== focusId && !n.id.startsWith("bubble:")),
    sections,
    steps: [],
  });
}
