// Plain sentences for the panel, composed from the grades' structured fields (shared items, counts,
// flags, details) instead of the engine's prose, which speaks of "mechanisms" and "allelic" genes.
// Every sentence here is short enough for a tired parent; the panel adds the citations. Pure.
import type { ClinicalTier, DimensionStatus, Flag } from "../../lib/grading/types.ts";
import type { VariantEffect } from "../../lib/grading/variants.ts";

// "A", "A and B", "A, B and C".
export function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------- shared biology ----------

export function sameGeneClaim(genes: readonly string[]): string {
  return genes.length > 1
    ? `Both are linked to changes in the same genes, ${joinAnd(genes)}.`
    : `Both are linked to changes in the same gene, ${genes[0] ?? "on record"}.`;
}

// The short form for a row in a list of related diseases.
export function sameGeneReason(genes: readonly string[]): string {
  return `Both are linked to the gene ${joinAnd(genes)}.`;
}

export const SAME_GENE_CAVEAT = "One gene can cause different diseases in different ways, so this alone doesn't show they work the same way.";

export const PATHWAY_MEANS = "A pathway is a chain of steps inside cells.";

export const PATHWAY_NOTE =
  "Being in the same pathway means the genes take part in the same process inside cells, not that the diseases share a mechanism.";

export interface PathwayFacts {
  pathway: string;
  genes: readonly string[]; // the genes of both diseases listed in it, each once
  reach?: number; // how many diseases here reach it
  withData?: number; // how many diseases here have any pathway on record
}

function reachClause(f: PathwayFacts, lead: string): string {
  if (!f.reach || !f.withData) return "";
  return `${lead}${f.reach <= 3 ? "only " : ""}${f.reach} of the ${f.withData} diseases with pathway data share`;
}

export function pathwayClaim(f: PathwayFacts): string {
  const who = f.genes.length > 1 ? `Their genes, ${joinAnd(f.genes)}, are both` : `Their gene, ${f.genes[0] ?? "on record"}, is`;
  return `${who} listed in the Reactome pathway “${f.pathway}”${reachClause(f, ", which ")}.`;
}

export function pathwayReason(f: PathwayFacts): string {
  const reach = f.reach && f.withData ? ` (${f.reach} of ${f.withData} diseases with pathway data)` : "";
  return `Their genes share the pathway “${f.pathway}”${reach}.`;
}

// Pathways that come only with the shared gene are the same evidence, counted once.
export function pathwaysWithGeneClaim(n: number, gene: string): string {
  return n === 1
    ? `The pathway they share comes with ${gene} itself, so it adds nothing beyond the shared gene.`
    : `The ${n} pathways they share come with ${gene} itself, so they add nothing beyond the shared gene.`;
}

// ---------- type of gene change ----------

export type LofKind = "mostly_lof" | "mostly_not_lof" | "mixed";

export interface VariantSide {
  genes: readonly string[];
  kind?: LofKind | null;
  lof: number; // changes that switch the gene off
  classified: number; // changes whose type could be read from the name
}

function possessive(genes: readonly string[]): string {
  return genes.length ? `${joinAnd(genes)}'s` : "Its";
}

function sideText(s: VariantSide): string {
  const of = s.classified ? ` (${s.lof} of ${s.classified} switch it off)` : "";
  if (s.kind === "mostly_lof") return `${possessive(s.genes)} mostly switch the gene off${s.classified ? ` (${s.lof} of ${s.classified})` : ""}`;
  if (s.kind === "mostly_not_lof") return `${possessive(s.genes)} mostly alter the protein without switching the gene off${of}`;
  return `${possessive(s.genes)} are a mix of types${of}`;
}

export function variantClaim(status: DimensionStatus, a: VariantSide, b: VariantSide): string {
  const lead =
    status === "match" ? "Their gene changes are of the same type" : status === "partial" ? "Their gene changes partly agree in type" : "Their gene changes differ in type";
  return `${lead}: ${sideText(a)}; ${sideText(b)}.`;
}

export function geneLevelVariantsClaim(genes: readonly string[]): string {
  return `The gene changes on record belong to ${joinAnd(genes) || "the shared gene"} itself, not to either disease, so their type can't tell the two apart.`;
}

// What one gene change does, read from its name, in words for families.
export const EFFECT_WORDS: Record<VariantEffect, string> = {
  lof: "switches the gene off",
  missense: "swaps one building block of the protein",
  other: "in-frame or silent",
  unknown: "type unclear",
};

export const VARIANT_SOURCE_NOTE = "The type of each change is read from its ClinVar name, not from a curated source.";

const TYPE_FROM_NAME: Record<VariantEffect, string> = {
  lof: "its name shows it switches the gene off",
  missense: "its name shows it swaps one building block of the protein",
  other: "its name shows it is in-frame or silent",
  unknown: "its type isn't clear from its name",
};

// One gene-change record in words: who lists it, its gene, and its type as read from its name.
// A plain-word name ("Single allele") reads in lower case; a notation keeps its case.
export function variantRecordClaim(source: string, gene: string, name: string, effect: VariantEffect): string {
  const shown = /^[A-Z][a-z]+( [a-z]+)*$/.test(name) ? name.toLowerCase() : name.replace(/\s*\((p\.[^()]*)\)$/, ", $1");
  return `${source} lists a gene change in ${gene} (${shown}); ${TYPE_FROM_NAME[effect]}.`;
}

// ---------- symptoms ----------

export interface SymptomFacts {
  shared: number;
  rare: number;
  score: number; // the scaled symptom score, 0..1
  percentile?: number; // share of random disease pairs scoring lower
  tier?: ClinicalTier;
}

// How the overlap compares with chance and with two records of one disease. It never contradicts the
// tier word next to it: a pair that "looks different" is never said to overlap a lot.
export function symptomComparison(f: SymptomFacts): string {
  if (f.score >= 0.999) return "about as much overlap as two records of the same disease";
  if (f.tier === "different") {
    return f.score > 0 || (f.percentile ?? 0) >= 0.95
      ? "slightly more overlap than unrelated diseases, too little to look alike"
      : "no more overlap than many unrelated diseases";
  }
  if (f.score > 0) return "more overlap than unrelated diseases, less than two records of one disease";
  return (f.percentile ?? 0) >= 0.95 ? "a little more overlap than most unrelated diseases, not enough to count" : "no more overlap than many unrelated diseases";
}

export function symptomCountText(shared: number, rare: number): string {
  if (!shared) return "No identical symptoms, but related ones";
  if (!rare) return `${count(shared, "shared symptom")}, ${shared === 1 ? "a common one" : "none of them rare"}`;
  return `${count(shared, "shared symptom")}, ${rare === shared && shared > 1 ? "all" : rare} of them rare`;
}

export function symptomClaim(f: SymptomFacts): string {
  return `${symptomCountText(f.shared, f.rare)}: ${symptomComparison(f)}.`;
}

export function noSymptomsClaim(names: readonly string[]): string {
  return names.length > 1 ? "No symptoms on record for either disease, so they can't be compared." : `No symptoms on record for ${names[0]}, so they can't be compared.`;
}

export const SYMPTOM_DATA_NOTE = "The data keeps only symptoms shared inside known disease groups, so a disease can have more than is listed here.";

// A symptom's rarity in words, from how specific it is among symptoms recorded for rare diseases.
export function rarityWord(specificity: number | undefined): "Rare" | "Uncommon" | "Common" | null {
  if (specificity === undefined) return null;
  return specificity >= 0.85 ? "Rare" : specificity >= 0.5 ? "Uncommon" : "Common";
}

export function rarityClaim(label: string, specificity: number | undefined, pct: (x: number) => string): string | null {
  const word = rarityWord(specificity);
  if (!word || specificity === undefined) return null;
  return word === "Common"
    ? `${label} is a common symptom: more specific than only ${pct(specificity)} of symptoms recorded for rare diseases.`
    : `${label} is ${word === "Rare" ? "a rare" : "an uncommon"} symptom: more specific than ${pct(specificity)} of symptoms recorded for rare diseases.`;
}

// ---------- what differs ----------

export function onlyInClaim(name: string, n: number, rarest: readonly string[]): string {
  if (!n) return `Every symptom on record for ${name} is shared.`;
  return `Only ${name}: ${count(n, "symptom")}${rarest.length ? `, rarest ${joinAnd(rarest)}` : ""}.`;
}

export function differentGenesClaim(sides: readonly { name: string; genes: readonly string[] }[]): string {
  return `Different genes: ${sides.map((s) => `${joinAnd(s.genes) || "none on record"} for ${s.name}`).join(", ")}.`;
}

// ---------- what we don't know ----------

// The data's own gap notes (attributes.gaps), in plain words.
const GAP_TEXT: Record<string, string> = {
  "no NIH RePORTER project": "No NIH-funded project found.",
  "no name-matched Orphanet group": "No patient group found in Orphanet's directory by name.",
  "no PubMed hit": "No PubMed paper found.",
};

export function gapText(gap: string): string {
  const known = GAP_TEXT[gap];
  if (known) return known;
  const text = gap.trim().replace(/\.$/, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// Which dataset a gap note is about, so its absence can cite the search.
export function gapDataset(gap: string): "nih" | "orphanet" | "pubmed" | null {
  if (/nih|reporter/i.test(gap)) return "nih";
  if (/orphanet/i.test(gap)) return "orphanet";
  if (/pubmed/i.test(gap)) return "pubmed";
  return null;
}

// ---------- needs expert review ----------

export interface ReviewContext {
  gene?: string; // the shared gene
  fewFor?: { name: string; n: number }[]; // diseases with few symptoms on record
}

// A flag as a task for an expert, or null when another sentence of the panel already says it.
export function reviewText(flag: Flag, ctx: ReviewContext = {}): string | null {
  switch (flag) {
    case "same_gene_allelic":
      return `Check whether both diseases change ${ctx.gene ?? "the shared gene"} in the same way.`;
    case "variant_effect_unknown":
      return "Ask which gene changes each disease carries: the ones on record are listed per gene, not per disease.";
    case "derived_from_variant_notation":
      return "Confirm the type of each gene change: it is read from the change's name, not from a curated source.";
    case "variant_type_conflict":
      return "In one disease the gene changes mostly switch the gene off; in the other they mostly do not. Ask whether they act differently.";
    case "few_annotations":
      return ctx.fewFor?.length
        ? `Few symptoms are on record for ${joinAnd(ctx.fewFor.map((f) => `${f.name} (${f.n})`))}, so the symptom comparison is uncertain.`
        : "One of the two diseases has few symptoms on record, so the symptom comparison is uncertain.";
    case "generic_symptoms_only":
      return "The shared symptoms are common ones; they say little on their own.";
    case "uncalibrated":
      return "Symptom overlap is not yet compared with all other diseases.";
    case "inferred_only":
    case "keyword_match_only":
    case "name_match_only":
      return null; // said per item, with the records that were matched by name or search
    case "via_mechanism":
      return "Some groups or resources are linked through a shared pathway, not to the disease itself.";
    case "contradicted_evidence":
      return "A source disputes part of this link.";
    case "umbrella_resource":
      return "A shared group or resource covers most diseases here, so it says little about these two.";
    case "inactive_or_withdrawn":
      return "A shared study was withdrawn, stopped early or has an unknown status.";
    case "no_data":
      return null; // said as the missing evidence itself
    case "needs_expert_review":
      return "A specialist should check this link.";
    case "family_level_only":
      return "They share only the process that defines the whole disease family, which does not tell them apart.";
    case "sources_disagree":
      return "Published sources give different values here, for example the age symptoms start. A clinician should confirm.";
    default:
      return null;
  }
}

export const PATHWAY_REVIEW = "Confirm the shared pathway matters in both diseases: being in the same process inside cells is not sharing a mechanism.";

export function inferredReview(what: string): string {
  return `The ${what} linked to both were found by a name or search match; confirm before relying on them.`;
}

// ---------- links found by a search or a name match ----------

// An inferred link said as what it is, never as a curated fact. `item` is already quoted when it
// is a title. Null for a source whose links are stated.
export function inferredLinkClaim(source: string, item: string, disease: string): string | null {
  if (source === "PubMed") return `A PubMed search links ${item} to ${disease}.`;
  if (source === "NIH RePORTER") return `An NIH RePORTER search links ${item} to ${disease}.`;
  if (source === "Orphanet") return `Orphanet's directory lists ${item}, matched to ${disease} by name.`;
  return null;
}

// The title of a line drawn through the items linked to two diseases, naming what kind they are.
export function sharedWorkTitle(a: string, b: string, types: readonly string[]): string {
  const groups = types.filter((t) => t === "PatientOrg").length;
  const research = types.length > groups;
  const what = research ? (groups ? "Shared research and patient groups link" : "Shared research links") : groups === 1 ? "A shared patient group links" : "Shared patient groups link";
  return `${what} ${a} and ${b}`;
}

// ---------- the evidence summary ----------

export interface SummaryCounts {
  total: number;
  stated: number;
  inferred: number;
  searched: number;
  disputed: number;
}

export function summaryText(c: SummaryCounts): string {
  if (!c.total) return "No sources cited yet.";
  const parts = [
    c.stated ? `${c.stated} stated by curated databases` : "",
    c.inferred ? `${c.inferred} inferred` : "",
    c.searched ? `${count(c.searched, "search", "searches")} with no result` : "",
    c.disputed ? `${c.disputed} disputed` : "",
  ].filter(Boolean);
  return `Based on ${count(c.total, "source")}: ${parts.join(", ")}`;
}

// The short name of a source for the summary line ("HPO (via Monarch)" -> "HPO").
export function shortSource(source: string): string {
  return source
    .replace(/\s*\(via [^)]*\)/i, "")
    .replace(/\s+(directory|search)$/i, "")
    .trim();
}

// ---------- cluster names ----------

// "Same gene: COL2A1" -> "Linked to the gene COL2A1"; a pathway name -> "Shares the … pathway".
export function plainClusterName(label: string | null | undefined): string {
  if (!label) return "Not in a group yet";
  const gene = /^Same gene:\s*(.+)$/i.exec(label)?.[1];
  if (gene) return `Linked to the gene ${gene}`;
  const pathway = label.replace(/\s+pathway$/i, "");
  // Sentence-case names read in lower case mid-sentence; acronyms and Title Case names stay as written.
  const [first, ...rest] = pathway.split(" ");
  const sentenceCase = /^[A-Z][a-z]+$/.test(first) && !rest.some((w) => /^[A-Z][a-z]/.test(w));
  return `Shares the ${sentenceCase ? first.toLowerCase() + (rest.length ? ` ${rest.join(" ")}` : "") : pathway} pathway`;
}

// The short form for map labels and chips: "COL2A1", "Melanin biosynthesis".
export function shortClusterName(label: string | null | undefined): string {
  if (!label) return "Not in a group";
  return /^Same gene:\s*(.+)$/i.exec(label)?.[1] ?? label;
}
