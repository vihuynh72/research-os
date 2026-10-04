// Adapts the team's rare-disease graph (data/seed/rare_graph.json, team format, written by
// pipeline/build_graph.py) to a schema.json graph at public/graph.json: the graph the app shows and
// the grader grades. Run with `npm run data:graph`; the same inputs give a byte-identical file.
//
// Two things are added, both from committed reference files:
// - Phenotype labels from data/reference/hpo-reference.json. The pipeline pairs Monarch's phenotype
//   ids and names out of order, so its names are wrong; the ids are right.
// - The Reactome pathways of the graph's genes, from data/reference/reactome-pathways.json
//   (npm run data:reactome): one Mechanism node per pathway and one Gene -> Mechanism edge per
//   membership, so the map has a biology layer beyond "same gene".
// Left out, and counted in meta.notes: same_gene edges (two diseases that share a Gene node already
// say it), subclass_of edges and disease_group nodes (a MONDO category: the atlas does not group
// diseases by category), edges whose endpoints are missing, and patient-group links whose name match
// rests only on a generic word such as "disease" or "syndrome" (GENERIC_NAME_WORDS below).
//
// Flags: --seed <file>, --reference <file>, --no-reference, --pathways <file>, --no-pathways,
// --out <file>, --check (rebuild and compare with --out byte for byte; write nothing, exit 1 if it
// differs). CI runs --check, so the committed graph cannot drift from its inputs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_TYPES } from "../lib/graph/types.ts";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../lib/graph/types.ts";
import type { HpoReference } from "../lib/grading/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The pipeline fetched its sources on this day and records no publication dates, so every edge
// taken from the seed carries it. Reactome edges carry the Reactome release date instead.
const RETRIEVED = "2026-10-03";
const PIPELINE = "pipeline/build_graph.py";
const SEED_URL = "https://github.com/vihuynh72/research-os/blob/main/data/seed/rare_graph.json";
const EVIDENCE_MAX = 1000; // schema.json edge.evidence maxLength

interface SeedNode {
  id: string;
  type: string;
  name?: string | null;
  source_url?: string | null;
  [key: string]: unknown;
}

interface SeedEdge {
  id?: string;
  source: string;
  target: string;
  relation: string;
  evidence_url?: string | null;
  note?: string | null;
}

interface Seed {
  nodes: SeedNode[];
  edges: SeedEdge[];
}

// data/reference/reactome-pathways.json (scripts/fetch-reactome.ts)
interface Pathways {
  meta: { release: number; release_date: string; fetched: string; not_found?: string[] };
  pathways: { stId: string; name: string; size: number }[];
  genes: Record<string, string[]>;
}

interface NodeRule {
  type: NodeType;
  source: string;
  url: (node: SeedNode) => string | undefined;
  attributes?: (node: SeedNode) => Record<string, unknown>;
}

interface EdgeRule {
  kind: EdgeKind;
  confidence: number;
  source: string;
  // How the pipeline made the link, for links that are search or directory hits.
  method?: string;
}

// Trimmed non-blank string, else undefined.
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sanitizeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const sourceUrl = (node: SeedNode) => text(node.source_url);
const monarchUrl = (node: SeedNode) => `https://monarchinitiative.org/${node.id}`;
const hpoTermUrl = (id: string) => `https://hpo.jax.org/browse/term/${id}`;
const reactomeUrl = (stId: string) => `https://reactome.org/content/detail/${stId}`;

// The pipeline writes the Orphanet code as { code, url } (older seeds: a bare string).
function orphanetCode(value: unknown): string | undefined {
  if (value && typeof value === "object") return text((value as { code?: unknown }).code);
  return text(value);
}

const NODE_RULES: Record<string, NodeRule> = {
  disease: {
    type: "Disease",
    source: "Monarch",
    url: (n) => sourceUrl(n) ?? monarchUrl(n),
    attributes: (n) => ({ orphanet: orphanetCode(n.orpha), gaps: n.gaps }),
  },
  gene: { type: "Gene", source: "Monarch", url: monarchUrl },
  variant: {
    type: "Variant",
    source: "ClinVar",
    url: sourceUrl,
    attributes: (n) => ({ clinical_significance: n.clinical_significance }),
  },
  phenotype: { type: "Phenotype", source: "HPO", url: (n) => hpoTermUrl(n.id) },
  patient_group: {
    type: "PatientOrg",
    source: "Orphanet",
    url: sourceUrl,
    attributes: (n) => ({ country: n.country, website: n.website, checked: n.checked }),
  },
  paper: { type: "Paper", source: "PubMed", url: sourceUrl, attributes: (n) => ({ journal: n.journal, year: n.year }) },
  project: {
    type: "Grant",
    source: "NIH RePORTER",
    url: sourceUrl,
    attributes: (n) => ({ agency: n.agency, fiscal_year: n.fiscal_year, pi: n.pi }),
  },
};

// Seed node types that are not graph nodes. A disease_group is a MONDO category; the brief asks not
// to cluster by category, and the engine finds groups from shared biology instead.
const SKIPPED_NODE_TYPES = new Set(["disease_group"]);

const EDGE_RULES: Record<string, EdgeRule> = {
  causes: { kind: "observed", confidence: 1, source: "Monarch" },
  has_phenotype: { kind: "observed", confidence: 1, source: "HPO (via Monarch)" },
  variant_of: { kind: "observed", confidence: 1, source: "ClinVar" },
  about: {
    kind: "inferred",
    confidence: 0.6,
    source: "PubMed",
    method: `PubMed search hit: one of the first 3 results for the gene symbol and the disease name (${PIPELINE}), not a curated link.`,
  },
  funds: {
    kind: "inferred",
    confidence: 0.6,
    source: "NIH RePORTER",
    method: `NIH RePORTER search hit: one of the first 3 projects whose title or terms match the gene symbol and the disease name (${PIPELINE}), not a curated link.`,
  },
  // Orphanet directory results kept by a name match, never a disease-specific listing.
  works_on: {
    kind: "inferred",
    confidence: 0.5,
    source: "Orphanet",
    method: `Orphanet patient-organisation directory result for this disease, kept because the group's name contains the gene symbol or a word of the disease name (${PIPELINE}); a name match, not a curated link.`,
  },
};

// Seed relations that are not graph edges: the fact is already in the graph, or it is a category.
const SKIPPED_RELATIONS: Record<string, string> = {
  same_gene: "two diseases that share a Gene node already state it",
  subclass_of: "a MONDO category, and the atlas does not group diseases by category",
};

// The pipeline keeps an Orphanet directory result only when the group's name contains the gene
// symbol or a word of the disease name longer than 3 letters (groups() in pipeline/build_graph.py,
// a case-insensitive substring test). Words that name no disease pass that test for any general
// support group: "disease" attaches "RaDiOrg - Rare Diseases Belgium" to every disease whose name
// contains it, "syndrome" attaches "SWAN - Syndromes Without a Name", and "with" matches "Without".
// A result whose only matched words are of this kind says nothing about the disease, so it is left
// out. The list is the words of that kind in English disease names: kinds of disorder, qualifiers of
// type, severity, onset and inheritance, connecting words, and a place name used as a qualifier
// ("Finnish type amyloidosis"). Words that name a disease or a family of diseases (albinism, ataxia,
// dysplasia, immunodeficiency) stay: a group named for the family serves the disease.
const GENERIC_NAME_WORDS = new Set([
  "disease",
  "diseases",
  "disorder",
  "disorders",
  "syndrome",
  "syndromes",
  "condition",
  "conditions",
  "deficiency",
  "defect",
  "defects",
  "anomaly",
  "anomalies",
  "disability",
  "disabilities",
  "type",
  "types",
  "form",
  "forms",
  "classic",
  "mild",
  "severe",
  "isolated",
  "lethal",
  "perinatal",
  "congenital",
  "congenita",
  "hereditary",
  "inherited",
  "familial",
  "genetic",
  "rare",
  "autosomal",
  "dominant",
  "recessive",
  "linked",
  "related",
  "associated",
  "onset",
  "early",
  "late",
  "juvenile",
  "infantile",
  "adult",
  "recurrent",
  "progressive",
  "point",
  "mutation",
  "mutations",
  "with",
  "without",
  "from",
  "into",
  "finnish",
]);

interface NameMatch {
  words: { text: string; gene: boolean }[]; // the matched needles, as written, outer punctuation trimmed
  generic: boolean; // every matched word is a generic word of the disease name
}

const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

// The pipeline's name test, re-run on the names it stored, to say which word let a group through.
// Null when no word matches (the seed was not made by that test, so nothing can be said).
function groupNameMatch(group: string, disease: string, symbols: string[]): NameMatch | null {
  const needles = [
    ...symbols.map((text) => ({ text, gene: true })),
    ...disease.split(/\s+/).filter(Boolean).map((text) => ({ text, gene: false })),
  ].filter((needle) => needle.text.length > 3);
  const name = group.toLowerCase();
  const seen = new Set<string>();
  const words: NameMatch["words"] = [];
  for (const needle of needles) {
    const key = needle.text.toLowerCase();
    if (!name.includes(key) || seen.has(key)) continue;
    seen.add(key);
    words.push({ text: bare(needle.text) || needle.text, gene: needle.gene });
  }
  if (!words.length) return null;
  return { words, generic: words.every((word) => !word.gene && GENERIC_NAME_WORDS.has(word.text.toLowerCase())) };
}

// `the gene symbol "GBA1"`, `"Stickler" and "syndrome" from the disease name`.
function matchedText(match: NameMatch): string {
  const quoted = (words: NameMatch["words"]) => words.map((word) => `"${word.text}"`).join(" and ");
  const gene = match.words.filter((word) => word.gene);
  const name = match.words.filter((word) => !word.gene);
  return [
    ...(gene.length ? [`the gene symbol ${quoted(gene)}`] : []),
    ...(name.length ? [`${quoted(name)} from the disease name`] : []),
  ].join(" and ");
}

// Attribute values that carry information: finite numbers, booleans, non-blank strings and lists of
// strings (an empty list is kept: it says the list was checked and found empty).
function compact(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort(byCodeUnit);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// Sorted, case-insensitively deduplicated, without the label itself.
function cleanSynonyms(values: unknown, label: string): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set([label.toLowerCase()]);
  const out: string[] = [];
  for (const value of values.map(text).filter((v): v is string => v !== undefined).sort(byCodeUnit)) {
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out.length ? out : undefined;
}

// "COTMAN, SUSAN LYNN" -> "Susan Lynn Cotman" (RePORTER lists contact PIs as LAST, FIRST).
function personName(pi: string): string {
  const parts = pi.split(",").map((p) => p.trim()).filter(Boolean);
  const ordered = parts.length > 1 ? [...parts.slice(1), parts[0]] : parts;
  return ordered
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s'’-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

// Relations become edge types, which schema.json restricts to snake_case.
function relationType(relation: string): string {
  const type = relation.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(type) ? type : `rel_${type}`;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : many}`;
}

interface Correction {
  id: string;
  from: string;
  to: string;
}

interface Report {
  warnings: string[];
  corrections: Correction[];
  phenotypes: number;
  pathways: { mechanisms: number; links: number; genes: number; withPathway: number; release: number } | null;
}

interface MechanismLayer {
  nodes: GraphNode[];
  edges: GraphEdge[];
  genesWithPathway: number;
  notInReactome: string[];
}

// One Mechanism node per Reactome pathway any gene of the graph is in, and one Gene -> Mechanism
// edge per membership. Every gene of the graph must be in the pathways file (with an empty list
// when Reactome has no pathway for it), so a seed with new genes cannot silently lose its biology.
function mechanismLayer(pathways: Pathways, pathwaysName: string, genes: GraphNode[]): MechanismLayer {
  const problems: string[] = [];
  const release = pathways.meta?.release;
  const date = pathways.meta?.release_date;
  if (!Number.isInteger(release) || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) problems.push("meta has no release number and release date");
  const byStId = new Map((pathways.pathways ?? []).map((p) => [p.stId, p]));
  const geneBySymbol = new Map(genes.map((g) => [g.label, g]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let genesWithPathway = 0;
  for (const gene of [...genes].sort((a, b) => byCodeUnit(a.id, b.id))) {
    const list = pathways.genes?.[gene.label];
    if (!list) {
      problems.push(`gene ${gene.label} (${gene.id}) is not in the file: run npm run data:reactome`);
      continue;
    }
    if (list.length) genesWithPathway++;
    for (const stId of [...list].sort(byCodeUnit)) {
      const pathway = byStId.get(stId);
      if (!pathway || !text(pathway.name) || !(pathway.size >= 1)) {
        problems.push(`${gene.label}: pathway ${stId} is not listed with a name and size`);
        continue;
      }
      const id = `REACT:${stId}`;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          type: "Mechanism",
          label: pathway.name.trim(),
          source: "Reactome",
          url: reactomeUrl(stId),
          attributes: { gene_count: pathway.size, reactome_release: release },
        });
      }
      edges.push({
        id: sanitizeId(`e-in_pathway-${gene.id}-${id}`),
        type: "in_pathway",
        subject: gene.id,
        object: id,
        source: "Reactome",
        url: reactomeUrl(stId),
        date: date ?? RETRIEVED,
        confidence: 1,
        kind: "observed",
        evidence: clip(`Reactome lists ${gene.label} in ${pathway.name.trim()}.`, EVIDENCE_MAX),
      });
    }
  }
  for (const symbol of Object.keys(pathways.genes ?? {})) {
    if (!geneBySymbol.has(symbol)) problems.push(`${symbol} is in the file but not a gene of the seed: run npm run data:reactome`);
  }
  if (problems.length) throw new Error(`${pathwaysName}:\n  - ${problems.join("\n  - ")}`);
  const notInReactome = genes.filter((g) => !(pathways.genes[g.label]?.length)).map((g) => g.label).sort(byCodeUnit);
  return { nodes: [...nodes.values()], edges, genesWithPathway, notInReactome };
}

function adapt(
  seed: Seed,
  reference: HpoReference | null,
  seedName: string,
  pathways: { doc: Pathways; name: string } | null,
): { graph: AtlasGraph; report: Report } {
  const notes: string[] = [];
  const warnings: string[] = [];
  const corrections: Correction[] = [];
  const graphId = new Map<string, string>(); // seed id -> schema id
  const nodes: GraphNode[] = [];
  const skippedNodes = new Map<string, string[]>(); // seed type -> ids
  const unknownTypes: string[] = [];
  const notInReference: string[] = [];
  const obsolete: string[] = [];
  let phenotypes = 0;
  let duplicateNodes = 0;

  const seen = new Set<string>();
  for (const seedNode of seed.nodes) {
    if (seen.has(seedNode.id)) {
      duplicateNodes++;
      warnings.push(`duplicate seed node ${seedNode.id}: kept the first`);
      continue;
    }
    seen.add(seedNode.id);
    if (SKIPPED_NODE_TYPES.has(seedNode.type)) {
      skippedNodes.set(seedNode.type, [...(skippedNodes.get(seedNode.type) ?? []), seedNode.id]);
      continue;
    }
    const rule = NODE_RULES[seedNode.type];
    if (!rule) {
      unknownTypes.push(`${seedNode.id} (${seedNode.type})`);
      continue;
    }
    const id = seedNode.id;
    let label = text(seedNode.name);
    if (rule.type === "Phenotype") {
      phenotypes++;
      if (reference) {
        const term = reference.terms[seedNode.id];
        const hpoLabel = text(term?.label);
        if (!hpoLabel) notInReference.push(seedNode.id);
        else {
          if (hpoLabel !== label) corrections.push({ id, from: label ?? "", to: hpoLabel });
          label = hpoLabel;
        }
        if (term?.obsolete) obsolete.push(term.replaced_by ? `${seedNode.id} (replaced by ${term.replaced_by})` : seedNode.id);
      }
    }
    if (!label) {
      warnings.push(`${id} has no name: labeled by its id`);
      label = id;
    }
    let url = rule.url(seedNode);
    if (!url) {
      warnings.push(`${seedNode.id} has no source_url: linked to the seed file instead`);
      url = SEED_URL;
    }
    const synonyms = cleanSynonyms(seedNode.synonyms, label);
    const attributes = rule.attributes ? compact(rule.attributes(seedNode)) : undefined;
    graphId.set(seedNode.id, id);
    nodes.push({
      id,
      type: rule.type,
      label,
      ...(synonyms ? { synonyms } : {}),
      source: rule.source,
      url,
      ...(attributes ? { attributes } : {}),
    });
  }

  const nodeUrl = new Map(nodes.map((n) => [n.id, n.url]));
  const seedLabel = new Map(seed.nodes.map((n) => [n.id, text(n.name) ?? ""]));
  // Gene symbols per disease, for the pipeline's patient-group name test.
  const symbolsOf = new Map<string, string[]>();
  for (const e of seed.edges) {
    const symbol = e.relation === "causes" ? seedLabel.get(e.source) : undefined;
    if (symbol) symbolsOf.set(e.target, [...(symbolsOf.get(e.target) ?? []), symbol]);
  }
  const edges: GraphEdge[] = [];
  const skippedEdges = new Map<string, { count: number; dangling: number }>();
  const unknownRelations = new Set<string>();
  const genericMatches = new Map<string, number>(); // matched words -> directory results left out
  const keptGroups = new Set<string>();
  const droppedGroups = new Set<string>();
  let dangling = 0;
  for (const seedEdge of seed.edges) {
    const skipped = SKIPPED_RELATIONS[seedEdge.relation];
    if (skipped !== undefined) {
      const entry = skippedEdges.get(seedEdge.relation) ?? { count: 0, dangling: 0 };
      entry.count++;
      if (!seen.has(seedEdge.source) || !seen.has(seedEdge.target)) entry.dangling++;
      skippedEdges.set(seedEdge.relation, entry);
      continue;
    }
    const subject = graphId.get(seedEdge.source);
    const object = graphId.get(seedEdge.target);
    if (!subject || !object) {
      dangling++;
      warnings.push(`${seedEdge.relation} edge ${seedEdge.source} -> ${seedEdge.target} skipped: ${subject ? seedEdge.target : seedEdge.source} is not a mapped node`);
      continue;
    }
    let rule = EDGE_RULES[seedEdge.relation];
    if (!rule) {
      unknownRelations.add(seedEdge.relation);
      rule = { kind: "inferred", confidence: 0.5, source: `Team graph (${PIPELINE})` };
    }
    let method = rule.method;
    if (seedEdge.relation === "works_on") {
      const match = groupNameMatch(seedLabel.get(seedEdge.source) ?? "", seedLabel.get(seedEdge.target) ?? "", symbolsOf.get(seedEdge.target) ?? []);
      if (match?.generic) {
        const words = match.words.map((word) => `"${word.text.toLowerCase()}"`).join(" and ");
        genericMatches.set(words, (genericMatches.get(words) ?? 0) + 1);
        droppedGroups.add(subject);
        continue;
      }
      keptGroups.add(subject);
      if (match) {
        method = `Orphanet patient-organisation directory result for this disease, kept by ${PIPELINE} because the group's name contains ${matchedText(match)}; a name match, not a curated link.`;
      } else {
        warnings.push(`works_on edge ${seedEdge.source} -> ${seedEdge.target}: no word of the disease name or gene symbol is in the group's name`);
      }
    }
    let url = text(seedEdge.evidence_url);
    if (!url) {
      warnings.push(`${seedEdge.relation} edge ${seedEdge.source} -> ${seedEdge.target} has no evidence_url: linked to its subject's page`);
      url = nodeUrl.get(subject) ?? SEED_URL;
    }
    // The pipeline's own note when it wrote one, else how it made the link.
    const evidence = text(seedEdge.note) ?? method;
    const type = relationType(seedEdge.relation);
    edges.push({
      id: sanitizeId(text(seedEdge.id) ?? `e-${type}-${subject}-${object}`),
      type,
      subject,
      object,
      source: rule.source,
      url,
      date: RETRIEVED,
      confidence: rule.confidence,
      kind: rule.kind,
      ...(evidence ? { evidence: clip(evidence, EVIDENCE_MAX) } : {}),
    });
  }

  // A group whose every directory result rested on a generic word is linked to no disease: not a node.
  const orphanGroups = new Set([...droppedGroups].filter((id) => !keptGroups.has(id)));
  for (let i = nodes.length - 1; i >= 0; i--) if (orphanGroups.has(nodes[i].id)) nodes.splice(i, 1);

  // One Investigator per distinct contact PI, linked to each of their grants.
  const grantsByPi = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const pi = node.type === "Grant" ? text(node.attributes?.pi) : undefined;
    if (pi) grantsByPi.set(pi, [...(grantsByPi.get(pi) ?? []), node]);
  }
  const takenIds = new Set(nodes.map((n) => n.id));
  for (const pi of [...grantsByPi.keys()].sort(byCodeUnit)) {
    const grants = (grantsByPi.get(pi) ?? []).sort((a, b) => byCodeUnit(a.id, b.id));
    const base = slug(pi) || "unnamed";
    let key = base;
    for (let n = 2; takenIds.has(`reporter:pi-${key}`); n++) key = `${base}-${n}`;
    if (key !== base) warnings.push(`investigator id reporter:pi-${base} was taken: used reporter:pi-${key} for "${pi}"`);
    const id = `reporter:pi-${key}`;
    takenIds.add(id);
    nodes.push({ id, type: "Investigator", label: personName(pi), source: "NIH RePORTER", url: grants[0].url, attributes: { reporter_name: pi } });
    for (const grant of grants) {
      edges.push({
        id: `e-inv-${key}-${sanitizeId(grant.id)}`,
        type: "investigates",
        subject: id,
        object: grant.id,
        source: "NIH RePORTER",
        url: grant.url,
        date: RETRIEVED,
        confidence: 1,
        kind: "observed",
      });
    }
  }

  const layer = pathways ? mechanismLayer(pathways.doc, pathways.name, nodes.filter((n) => n.type === "Gene")) : null;
  if (layer) {
    nodes.push(...layer.nodes);
    edges.push(...layer.edges);
  }

  // Edge ids must be unique. Identical repeats (same id, same claim) are dropped; the remaining
  // reuses get -2, -3 in content order, so ids do not depend on the order the pipeline wrote them.
  const groups = new Map<string, GraphEdge[]>();
  for (const edge of edges) groups.set(edge.id, [...(groups.get(edge.id) ?? []), edge]);
  const usedIds = new Set(groups.keys());
  const uniqueEdges: GraphEdge[] = [];
  let repeats = 0;
  const renamed: string[] = [];
  for (const id of [...groups.keys()].sort(byCodeUnit)) {
    const distinct = new Map<string, GraphEdge>();
    for (const edge of groups.get(id) ?? []) distinct.set(JSON.stringify(edge), edge);
    repeats += (groups.get(id)?.length ?? 0) - distinct.size;
    const ordered = [...distinct.keys()].sort(byCodeUnit).map((k) => distinct.get(k) as GraphEdge);
    uniqueEdges.push(ordered[0]);
    let n = 2;
    for (const edge of ordered.slice(1)) {
      while (usedIds.has(`${id}-${n}`)) n++;
      const newId = `${id}-${n}`;
      usedIds.add(newId);
      renamed.push(`${id} -> ${newId}`);
      uniqueEdges.push({ ...edge, id: newId });
    }
  }

  const typeRank = (type: NodeType) => NODE_TYPES.indexOf(type);
  nodes.sort((a, b) => typeRank(a.type) - typeRank(b.type) || byCodeUnit(a.id, b.id));
  uniqueEdges.sort((a, b) => byCodeUnit(a.id, b.id));

  // Notes: provenance a reader of graph.json needs, in plain sentences.
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const diseases = nodes.filter((n) => n.type === "Disease");
  const withSymptoms = new Set(uniqueEdges.filter((e) => e.type === "has_phenotype" && typeOf.get(e.subject) === "Disease").map((e) => e.subject));
  notes.push(
    `Adapted from ${seedName} (written by ${PIPELINE}; ${plural(diseases.length, "disease")}) by scripts/seed-to-graph.ts. ` +
      `Edges from the seed carry the pipeline's retrieval date (${RETRIEVED})` +
      (layer && pathways ? `; Reactome edges carry the release date of Reactome ${pathways.doc.meta.release} (${pathways.doc.meta.release_date})` : "") +
      ". Papers, grants and patient groups are search or directory matches and are marked inferred.",
  );
  if (!reference) {
    notes.push("Phenotype labels not yet verified against HPO.");
    warnings.push("no HPO reference: phenotype labels kept from the seed, which pairs ids and names out of order");
  } else {
    const version = text(reference.meta?.hpo_version);
    notes.push(
      `Phenotype labels are from HPO${version ? ` (${version})` : ""}; ` +
        (corrections.length
          ? `${corrections.length} of ${phenotypes} seed labels were corrected because the pipeline pairs Monarch's phenotype ids and names out of order.`
          : "every seed label already matched."),
    );
  }
  // Disease pairs whose symptom lists are identical: what a filter to shared terms leaves of two
  // diseases that are alone in their cluster.
  const symptomSets = new Map<string, string[]>();
  for (const e of uniqueEdges) {
    if (e.type === "has_phenotype" && typeOf.get(e.subject) === "Disease") symptomSets.set(e.subject, [...(symptomSets.get(e.subject) ?? []), e.object]);
  }
  const keyed = countBy([...symptomSets.values()], (list) => [...list].sort(byCodeUnit).join(" "));
  const identicalPairs = [...keyed.values()].reduce((sum, k) => sum + (k * (k - 1)) / 2, 0);
  notes.push(
    `Symptoms are partial: ${PIPELINE} keeps a disease's Monarch phenotypes only where they are shared inside a Monarch cluster (the same gene, or a shared parent), ` +
      `so ${diseases.length - withSymptoms.size} of ${diseases.length} diseases have none on record, and ${plural(identicalPairs, "pair")} of diseases list identical symptoms; ` +
      "clinical resemblance inside a cluster is overstated and elsewhere understated.",
  );
  notes.push(`Variants are recorded per gene (the first 3 pathogenic ClinVar records of each gene, ${PIPELINE}), not per disease.`);
  if (layer && pathways) {
    const missing = layer.notInReactome;
    const diseasesWithout = diseases.filter((d) =>
      uniqueEdges.some((e) => e.type === "causes" && e.object === d.id && missing.includes(nodes.find((n) => n.id === e.subject)?.label ?? "")),
    ).length;
    notes.push(
      `Mechanisms: ${plural(layer.nodes.length, "Reactome pathway")} (release ${pathways.doc.meta.release}; lowest-level human pathways with at most 300 entities, ${pathways.name}) ` +
        `for ${layer.genesWithPathway} of ${layer.genesWithPathway + missing.length} genes` +
        (missing.length ? `; Reactome has no such pathway for ${missing.join(", ")}, so ${plural(diseasesWithout, "disease")} ${diseasesWithout === 1 ? "has" : "have"} no mechanism on record.` : "."),
    );
  } else {
    notes.push("No mechanisms: the Reactome pathway file was not used.");
  }
  const skipped: string[] = [];
  for (const [relation, { count, dangling: missingEnds }] of [...skippedEdges].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    skipped.push(`${plural(count, `${relation} edge`)}${missingEnds ? ` (${missingEnds} with an endpoint missing from the seed)` : ""}: ${SKIPPED_RELATIONS[relation]}`);
  }
  for (const [type, ids] of [...skippedNodes].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    skipped.push(`${plural(ids.length, `${type} node`)} (${[...ids].sort(byCodeUnit).join(", ")})`);
  }
  if (dangling) skipped.push(`${plural(dangling, "edge")} whose endpoint is missing from the seed`);
  if (repeats) skipped.push(`${plural(repeats, "exact repeat")} of an edge`);
  if (duplicateNodes) skipped.push(`${plural(duplicateNodes, "repeated node")}`);
  if (skipped.length) notes.push(`Skipped: ${skipped.join("; ")}.`);
  if (genericMatches.size) {
    const total = [...genericMatches.values()].reduce((sum, k) => sum + k, 0);
    const list = [...genericMatches]
      .sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
      .map(([words, k]) => `${words} ${k}`)
      .join(", ");
    notes.push(
      `Left out ${plural(total, "Orphanet directory result")} whose name match rests only on a generic word of the disease name (${list}): ` +
        `${PIPELINE} keeps a result when the group's name contains any word of the disease name, so such a word attaches a general support group to every disease whose name contains it` +
        (orphanGroups.size ? `; ${plural(orphanGroups.size, "patient group")} left with no disease ${orphanGroups.size === 1 ? "is" : "are"} not in the graph.` : "."),
    );
  }
  if (!grantsByPi.size) notes.push("No grant names a principal investigator, so there are no Investigator nodes.");
  if (notInReference.length) {
    notes.push(`Not in the HPO reference, so labeled as in the seed: ${notInReference.sort(byCodeUnit).join(", ")}.`);
    warnings.push(`${notInReference.length} phenotype ids are not in the HPO reference: ${notInReference.join(", ")}`);
  }
  if (obsolete.length) notes.push(`Obsolete in HPO, kept as the seed has them: ${obsolete.sort(byCodeUnit).join(", ")}.`);
  if (renamed.length) {
    notes.push(`${plural(renamed.length, "edge id")} got a -2/-3 suffix because the seed states the same link with different details.`);
    warnings.push(`renamed ${renamed.length} reused edge ids: ${renamed.join(", ")}`);
  }
  if (unknownTypes.length) {
    notes.push(`Skipped nodes of unmapped seed types: ${unknownTypes.sort(byCodeUnit).join(", ")}.`);
    warnings.push(`skipped ${unknownTypes.length} nodes of unmapped types: ${unknownTypes.join(", ")}`);
  }
  if (unknownRelations.size) {
    const list = [...unknownRelations].sort(byCodeUnit).join(", ");
    notes.push(`Unmapped seed relations kept as inferred links (confidence 0.5): ${list}.`);
    warnings.push(`unmapped relations (inferred 0.5): ${list}`);
  }

  // Fail here rather than ship a graph that check:schema would reject.
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of uniqueEdges) {
    if (!ids.has(edge.subject) || !ids.has(edge.object)) throw new Error(`edge ${edge.id} has a missing endpoint`);
  }

  const graph: AtlasGraph = {
    meta: { schema_version: "0.1.0", generated_at: `${RETRIEVED}T00:00:00Z`, notes: notes.join(" ") },
    nodes,
    edges: uniqueEdges,
  };
  const report: Report = {
    warnings,
    corrections: corrections.sort((a, b) => byCodeUnit(a.id, b.id)),
    phenotypes,
    pathways:
      layer && pathways
        ? {
            mechanisms: layer.nodes.length,
            links: layer.edges.length,
            genes: layer.genesWithPathway + layer.notInReactome.length,
            withPathway: layer.genesWithPathway,
            release: pathways.doc.meta.release,
          }
        : null,
  };
  return { graph, report };
}

function parseArgs(argv: string[]) {
  const options = {
    seed: join(ROOT, "data", "seed", "rare_graph.json"),
    reference: join(ROOT, "data", "reference", "hpo-reference.json") as string | null,
    referenceRequired: false,
    pathways: join(ROOT, "data", "reference", "reactome-pathways.json") as string | null,
    out: join(ROOT, "public", "graph.json"),
    check: false,
  };
  const usage = "Flags: --seed <file>, --reference <file>, --no-reference, --pathways <file>, --no-pathways, --out <file>, --check";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--check") {
      options.check = true;
      continue;
    }
    if (flag === "--no-reference") {
      options.reference = null;
      continue;
    }
    if (flag === "--no-pathways") {
      options.pathways = null;
      continue;
    }
    const value = argv[i + 1];
    if (!["--seed", "--reference", "--pathways", "--out"].includes(flag) || !value) {
      throw new Error(`Unexpected argument ${flag}. ${usage}`);
    }
    i++;
    if (flag === "--seed") options.seed = resolve(value);
    else if (flag === "--out") options.out = resolve(value);
    else if (flag === "--pathways") options.pathways = resolve(value);
    else {
      options.reference = resolve(value);
      options.referenceRequired = true;
    }
  }
  return options;
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
}

function display(file: string): string {
  const rel = relative(ROOT, file);
  return rel.startsWith("..") ? file : rel.split(sep).join("/");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.seed)) {
    throw new Error(`${display(options.seed)} not found. It is the team's graph (${PIPELINE} writes it).`);
  }
  const seed = readJson<Seed>(options.seed);
  if (!Array.isArray(seed.nodes) || !Array.isArray(seed.edges)) throw new Error(`${display(options.seed)} has no nodes/edges arrays`);

  let reference: HpoReference | null = null;
  if (options.reference && existsSync(options.reference)) {
    reference = readJson<HpoReference>(options.reference);
    if (!reference.terms || typeof reference.terms !== "object") throw new Error(`${display(options.reference)} has no terms map`);
  } else if (options.reference && options.referenceRequired) {
    throw new Error(`${display(options.reference)} not found`);
  }

  // The pathway file is the map's biology layer: required unless turned off explicitly.
  let pathways: { doc: Pathways; name: string } | null = null;
  if (options.pathways) {
    if (!existsSync(options.pathways)) {
      throw new Error(`${display(options.pathways)} not found: run npm run data:reactome (or pass --no-pathways).`);
    }
    pathways = { doc: readJson<Pathways>(options.pathways), name: display(options.pathways) };
  }

  const { graph, report } = adapt(seed, reference, display(options.seed), pathways);
  const output = `${JSON.stringify(graph, null, 2)}\n`;
  if (options.check) {
    const same = existsSync(options.out) && readFileSync(options.out, "utf8") === output;
    console.log(`${same ? "ok     " : "DIFFERS"} ${display(options.out)}`);
    if (!same) {
      throw new Error(`${display(options.out)} is not what ${display(options.seed)} and the reference files give: run npm run data:graph and commit the result.`);
    }
    return;
  }
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, output);

  const nodeCounts = countBy(graph.nodes, (n) => n.type);
  const edgeKinds = countBy(graph.edges, (e) => e.kind);
  const edgeTypes = countBy(graph.edges, (e) => e.type);
  console.log(`${display(options.seed)} -> ${display(options.out)}`);
  console.log(`  nodes ${graph.nodes.length}: ${NODE_TYPES.map((t) => `${t} ${nodeCounts.get(t) ?? 0}`).join(", ")}`);
  console.log(`  edges ${graph.edges.length}: ${(["observed", "inferred", "contradicted"] as const).map((k) => `${k} ${edgeKinds.get(k) ?? 0}`).join(", ")}`);
  console.log(`  edge types: ${[...edgeTypes].sort((a, b) => byCodeUnit(a[0], b[0])).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (report.pathways) {
    const p = report.pathways;
    console.log(`  Reactome ${p.release}: ${p.mechanisms} pathways, ${p.links} gene-pathway edges, ${p.withPathway} of ${p.genes} genes in a pathway`);
  } else {
    console.log("  Reactome pathways: none (--no-pathways)");
  }
  if (reference) {
    console.log(`  phenotype labels from ${display(options.reference ?? "")}: ${report.corrections.length} of ${report.phenotypes} changed`);
    for (const c of report.corrections.slice(0, 10)) console.log(`    ${c.id}: "${c.from}" -> "${c.to}"`);
    if (report.corrections.length > 10) console.log(`    ... ${report.corrections.length - 10} more`);
  } else {
    console.log(`  phenotype labels: 0 of ${report.phenotypes} changed (no HPO reference)`);
  }
  for (const note of graph.meta.notes?.split(/(?<=\.) (?=[A-Z])/) ?? []) console.log(`  note: ${note}`);
  for (const warning of report.warnings) console.warn(`  warning: ${warning}`);
}

try {
  main();
} catch (error) {
  console.error(`seed-to-graph: ${(error as Error).message}`);
  process.exit(1);
}
