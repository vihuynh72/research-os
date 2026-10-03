// Adapts the team seed (data/seed/cln_graph.json, team format) to a schema.json graph at
// public/graph.sample.json, so the app and the grader run on real CLN data before the full
// pipeline lands. Run with `npm run data:sample`; the same inputs give a byte-identical file.
//
// Phenotype labels come from data/reference/hpo-reference.json when it exists. The seed's
// names are misaligned with their HPO ids: pipeline/fetch_cln_seed.py zips Monarch's
// has_phenotype and has_phenotype_label lists, which are not in the same order.
//
// After the seed, the hand-curated facts in data/curated/ncl_facts.json are added: what each
// gene's protein is and does (Mechanism nodes and gene -> mechanism edges), and each disease's
// onset and inheritance, every link with a sentence quoted verbatim from its source. The seed's
// one mechanism is the family's definition and is linked to every disease, so on its own it
// cannot tell the subtypes apart.
//
// Flags: --seed <file>, --reference <file>, --no-reference, --facts <file>, --no-facts, --out <file>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_TYPES } from "../lib/graph/types.ts";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "../lib/graph/types.ts";
import type { HpoReference } from "../lib/grading/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The seed was fetched on this day and records no publication dates, so every edge carries it.
const RETRIEVED = "2026-10-03";
const SEED_URL = "https://github.com/vihuynh72/research-os/blob/main/data/seed/cln_graph.json";
const EVIDENCE_MAX = 1000; // schema.json edge.evidence maxLength

interface SeedNode {
  id: string;
  type: string;
  name?: string | null;
  [key: string]: unknown;
}

interface SeedEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  status?: string;
  evidence_url?: string | null;
  note?: string | null;
}

interface Seed {
  slice?: string;
  nodes: SeedNode[];
  edges: SeedEdge[];
  not_fetched?: unknown[];
}

// data/curated/ncl_facts.json
interface FactSource {
  label: string;
  url: string;
  date: string;
}

interface Facts {
  checked?: string;
  sources: Record<string, FactSource>;
  mechanisms: { id: string; label: string; description?: string; source: string; quote: string }[];
  genes: { id: string; symbol?: string; links: { mechanism: string; source: string; quote: string }[] }[];
  diseases: {
    id: string;
    short?: string;
    onset?: { hpo: string; label?: string; source: string; quote: string; context?: string; conflict?: string };
    inheritance?: { hpo: string; label?: string; source: string; quote: string };
  }[];
}

// Inheritance comes from HPO's annotation of the disease's OMIM record.
const INHERITANCE_SOURCE = "HPO (OMIM annotation)";
const hpoTermUrl = (id: string) => `https://hpo.jax.org/browse/term/${id}`;

interface NodeRule {
  type: NodeType;
  source: string;
  id?: (seedId: string) => string;
  url: (node: SeedNode) => string | undefined;
  attributes?: (node: SeedNode) => Record<string, unknown>;
}

interface EdgeRule {
  kind: EdgeKind;
  confidence: number;
  source: string;
  evidence?: (edge: SeedEdge, seedNodes: Map<string, SeedNode>) => string | undefined;
}

// Trimmed non-blank string, else undefined.
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sanitizeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const sourceUrl = (node: SeedNode) => text(node.source_url);
const monarchUrl = (node: SeedNode) => `https://monarchinitiative.org/${node.id}`;
const edgeNote = (edge: SeedEdge) => text(edge.note);

const NODE_RULES: Record<string, NodeRule> = {
  disease: {
    type: "Disease",
    source: "Monarch",
    url: (n) => sourceUrl(n) ?? monarchUrl(n),
    attributes: (n) => ({ orphanet: n.orpha }),
  },
  gene: { type: "Gene", source: "Monarch", url: monarchUrl },
  variant: {
    type: "Variant",
    source: "ClinVar",
    url: sourceUrl,
    attributes: (n) => ({ clinical_significance: n.clinical_significance }),
  },
  mechanism: { type: "Mechanism", source: "Team seed (curated)", url: () => SEED_URL },
  phenotype: { type: "Phenotype", source: "HPO", url: (n) => `https://hpo.jax.org/browse/term/${n.id}` },
  patient_group: {
    type: "PatientOrg",
    source: "Orphanet",
    url: sourceUrl,
    attributes: (n) => ({ country: n.country, website: n.website, checked: n.checked }),
  },
  paper: { type: "Paper", source: "PubMed", url: sourceUrl, attributes: (n) => ({ journal: n.journal, year: n.year }) },
  // Schema ids are prefixed CURIEs; ClinicalTrials.gov ids in the seed are bare NCT numbers.
  study: {
    type: "Trial",
    source: "ClinicalTrials.gov",
    id: (id) => (id.startsWith("clinicaltrials:") ? id : `clinicaltrials:${id}`),
    url: sourceUrl,
    attributes: (n) => ({ overall_status: n.overall_status }),
  },
  project: {
    type: "Grant",
    source: "NIH RePORTER",
    url: sourceUrl,
    attributes: (n) => ({ agency: n.agency, fiscal_year: n.fiscal_year, pi: n.pi }),
  },
  // The scraped Orphanet seed gives registries a country, as it does patient groups.
  registry: {
    type: "Asset",
    source: "Orphanet",
    url: sourceUrl,
    attributes: (n) => ({ kind: "registry", country: n.country, website: n.website, checked: n.checked }),
  },
};

const EDGE_RULES: Record<string, EdgeRule> = {
  causes: { kind: "observed", confidence: 1, source: "Monarch" },
  has_phenotype: { kind: "observed", confidence: 1, source: "HPO (via Monarch)" },
  variant_of: { kind: "observed", confidence: 1, source: "ClinVar", evidence: edgeNote },
  // The mechanism is a grouping the team chose for this slice, not a pathway database entry.
  disrupts_process: {
    kind: "inferred",
    confidence: 0.9,
    source: "Team seed (curated)",
    evidence: (edge, seedNodes) => {
      const mechanism = [edge.target, edge.source].map((id) => seedNodes.get(id)).find((n) => n?.type === "mechanism");
      return `Team-curated shared process for the CLN slice. ${text(mechanism?.note) ?? ""}`.trim();
    },
  },
  studies: {
    kind: "inferred",
    confidence: 0.6,
    source: "ClinicalTrials.gov",
    evidence: () => "Study title matched a keyword for this disease (pipeline search, not a curated condition link).",
  },
  about: { kind: "inferred", confidence: 0.6, source: "PubMed", evidence: edgeNote },
  funds: { kind: "inferred", confidence: 0.6, source: "NIH RePORTER", evidence: edgeNote },
  // Orphanet directory matches ("results including this disease"), never a disease-specific
  // listing, so they stay inferred whichever status the seed gives them.
  works_on: { kind: "inferred", confidence: 0.5, source: "Orphanet", evidence: edgeNote },
  registers: { kind: "inferred", confidence: 0.5, source: "Orphanet", evidence: edgeNote },
};

// Attribute values that carry information: finite numbers, booleans and non-blank strings.
function compact(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") out[key] = value;
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

interface Correction {
  id: string;
  from: string;
  to: string;
}

interface Report {
  notes: string[];
  warnings: string[];
  corrections: Correction[];
  phenotypes: number;
  curated: CuratedCounts | null;
}

interface CuratedCounts {
  mechanisms: number;
  geneLinks: number;
  onsets: number;
  inheritances: number;
  newPhenotypes: string[];
  conflicts: string[]; // short names of diseases whose onset sources disagree
}

const CURIE = /^[A-Za-z][A-Za-z0-9_.-]*:[^\s]+$/;
const HPO_ID = /^HP:\d{7}$/;

// Adds the hand-curated facts to the adapted seed, in place. Anything that does not resolve (an
// unknown gene, disease, mechanism or source, a missing quote) stops the build: a curated claim
// that cannot be traced is worse than no claim.
function addCuratedFacts(
  facts: Facts,
  factsName: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  reference: HpoReference | null,
): CuratedCounts {
  const problems: string[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sources = facts.sources ?? {};
  const sourceOf = (key: string, where: string): FactSource => {
    const found = sources[key];
    if (!found || !text(found.label) || !text(found.url) || !/^\d{4}-\d{2}-\d{2}$/.test(found.date ?? "")) {
      problems.push(`${where} cites source "${key}", which is not in "sources" with a label, url and date`);
    }
    return found ?? { label: key, url: SEED_URL, date: RETRIEVED };
  };
  const quoted = (quote: unknown, where: string): string => {
    const value = text(quote);
    if (!value) problems.push(`${where} has no quote`);
    else if (value.length > EVIDENCE_MAX) problems.push(`${where} quote is longer than ${EVIDENCE_MAX} characters`);
    return value ?? "";
  };
  const counts: CuratedCounts = { mechanisms: 0, geneLinks: 0, onsets: 0, inheritances: 0, newPhenotypes: [], conflicts: [] };

  const mechanisms = new Set<string>();
  for (const m of facts.mechanisms ?? []) {
    const where = `mechanism ${m.id}`;
    if (!CURIE.test(m.id ?? "")) problems.push(`${where}: not a prefixed id`);
    if (mechanisms.has(m.id) || byId.has(m.id)) problems.push(`${where}: id already used`);
    if (!text(m.label)) problems.push(`${where}: no label`);
    const source = sourceOf(m.source, where);
    const quote = quoted(m.quote, where);
    mechanisms.add(m.id);
    const node: GraphNode = {
      id: m.id,
      type: "Mechanism",
      label: text(m.label) ?? m.id,
      ...(text(m.description) ? { description: text(m.description) } : {}),
      source: source.label,
      url: source.url,
      attributes: { curated: true, quote },
    };
    nodes.push(node);
    byId.set(m.id, node);
    counts.mechanisms++;
  }

  for (const gene of facts.genes ?? []) {
    if (byId.get(gene.id)?.type !== "Gene") {
      problems.push(`gene ${gene.id}${gene.symbol ? ` (${gene.symbol})` : ""} is not a gene in the seed`);
      continue;
    }
    for (const link of gene.links ?? []) {
      const where = `gene ${gene.id} -> ${link.mechanism}`;
      if (!mechanisms.has(link.mechanism)) problems.push(`${where}: mechanism not listed in "mechanisms"`);
      const source = sourceOf(link.source, where);
      edges.push({
        id: sanitizeId(`e-cur-${gene.id}-${link.mechanism}`),
        type: "has_mechanism",
        subject: gene.id,
        object: link.mechanism,
        source: source.label,
        url: source.url,
        date: source.date,
        confidence: 0.9,
        kind: "observed",
        evidence: quoted(link.quote, where),
      });
      counts.geneLinks++;
    }
  }

  // Onset and inheritance terms the seed does not have become Phenotype nodes, labeled from HPO.
  const phenotypeNode = (id: string, label: string | undefined, where: string) => {
    if (!HPO_ID.test(id ?? "")) {
      problems.push(`${where}: "${id}" is not an HPO id`);
      return;
    }
    const existing = byId.get(id);
    if (existing) {
      if (existing.type !== "Phenotype") problems.push(`${where}: ${id} is a ${existing.type} in the seed`);
      return;
    }
    const node: GraphNode = {
      id,
      type: "Phenotype",
      label: text(reference?.terms[id]?.label) ?? text(label) ?? id,
      source: "HPO",
      url: hpoTermUrl(id),
    };
    nodes.push(node);
    byId.set(id, node);
    counts.newPhenotypes.push(id);
  };

  for (const disease of facts.diseases ?? []) {
    const name = disease.short ?? disease.id;
    if (byId.get(disease.id)?.type !== "Disease") {
      problems.push(`disease ${disease.id} (${name}) is not a disease in the seed`);
      continue;
    }
    const onset = disease.onset;
    if (onset) {
      const where = `${name} onset`;
      phenotypeNode(onset.hpo, onset.label, where);
      const source = sourceOf(onset.source, where);
      const quote = quoted(onset.quote, where);
      const evidence = `${quote}${text(onset.context) ? ` (${text(onset.context)})` : ""}${text(onset.conflict) ? ` Sources disagree: ${text(onset.conflict)}` : ""}`;
      if (evidence.length > EVIDENCE_MAX) problems.push(`${where}: evidence is longer than ${EVIDENCE_MAX} characters`);
      if (text(onset.conflict)) counts.conflicts.push(name);
      edges.push({
        id: sanitizeId(`e-cur-${disease.id}-onset`),
        type: "has_phenotype",
        subject: disease.id,
        object: onset.hpo,
        source: source.label,
        url: source.url,
        date: source.date,
        confidence: 0.9,
        kind: "observed",
        evidence,
      });
      counts.onsets++;
    }
    const inheritance = disease.inheritance;
    if (inheritance) {
      const where = `${name} inheritance`;
      phenotypeNode(inheritance.hpo, inheritance.label, where);
      const source = sourceOf(inheritance.source, where);
      edges.push({
        id: sanitizeId(`e-cur-${disease.id}-inheritance`),
        type: "has_phenotype",
        subject: disease.id,
        object: inheritance.hpo,
        source: INHERITANCE_SOURCE,
        url: hpoTermUrl(inheritance.hpo),
        date: source.date,
        confidence: 1,
        kind: "observed",
        evidence: quoted(inheritance.quote, where),
      });
      counts.inheritances++;
    }
  }

  if (problems.length) throw new Error(`${factsName}:\n  - ${problems.join("\n  - ")}`);
  counts.newPhenotypes.sort(byCodeUnit);
  return counts;
}

function adapt(
  seed: Seed,
  reference: HpoReference | null,
  seedName: string,
  facts: { doc: Facts; name: string } | null,
): { graph: AtlasGraph; report: Report } {
  const notes: string[] = [];
  const warnings: string[] = [];
  const corrections: Correction[] = [];
  const seedNodes = new Map<string, SeedNode>();
  const graphId = new Map<string, string>(); // seed id -> schema id
  const nodes: GraphNode[] = [];
  const gapNodes: SeedNode[] = [];
  const skippedTypes: string[] = [];
  const unnamed: string[] = [];
  const notInReference: string[] = [];
  const obsolete: string[] = [];
  let phenotypes = 0;

  for (const seedNode of seed.nodes) {
    if (seedNodes.has(seedNode.id)) {
      warnings.push(`duplicate seed node ${seedNode.id}: kept the first`);
      continue;
    }
    seedNodes.set(seedNode.id, seedNode);
    if (seedNode.type === "gap") {
      gapNodes.push(seedNode);
      continue;
    }
    const rule = NODE_RULES[seedNode.type];
    if (!rule) {
      skippedTypes.push(`${seedNode.id} (${seedNode.type})`);
      continue;
    }
    const id = rule.id ? rule.id(seedNode.id) : seedNode.id;

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
      unnamed.push(id);
      label = id;
    }

    let url = rule.url(seedNode);
    if (!url) {
      warnings.push(`${seedNode.id} has no source_url: linked to the seed file instead`);
      url = SEED_URL;
    }
    const synonyms = cleanSynonyms(seedNode.synonyms, label);
    const description = rule.type === "Mechanism" ? text(seedNode.note) : undefined;
    const attributes = rule.attributes ? compact(rule.attributes(seedNode)) : undefined;

    graphId.set(seedNode.id, id);
    nodes.push({
      id,
      type: rule.type,
      label,
      ...(synonyms ? { synonyms } : {}),
      ...(description ? { description } : {}),
      source: rule.source,
      url,
      ...(attributes ? { attributes } : {}),
    });
  }

  const nodeUrl = new Map(nodes.map((n) => [n.id, n.url]));
  const edges: GraphEdge[] = [];
  const gapIds = new Set(gapNodes.map((n) => n.id));
  const unknownRelations = new Set<string>();
  let gapEdges = 0;
  for (const seedEdge of seed.edges) {
    if (seedEdge.status === "gap" || seedEdge.relation === "missing_group" || gapIds.has(seedEdge.source) || gapIds.has(seedEdge.target)) {
      gapEdges++;
      continue;
    }
    const subject = graphId.get(seedEdge.source);
    const object = graphId.get(seedEdge.target);
    if (!subject || !object) {
      warnings.push(`edge ${seedEdge.id} skipped: ${subject ? seedEdge.target : seedEdge.source} is not a mapped node`);
      continue;
    }
    let rule = EDGE_RULES[seedEdge.relation];
    if (!rule) {
      unknownRelations.add(seedEdge.relation);
      rule = seedEdge.status === "sourced"
        ? { kind: "observed", confidence: 1, source: "Team seed", evidence: edgeNote }
        : { kind: "inferred", confidence: 0.5, source: "Team seed", evidence: edgeNote };
    }
    let url = text(seedEdge.evidence_url);
    if (!url) {
      warnings.push(`edge ${seedEdge.id} has no evidence_url: linked to its subject's page`);
      url = nodeUrl.get(subject) ?? SEED_URL;
    }
    const evidence = rule.evidence?.(seedEdge, seedNodes);
    edges.push({
      id: sanitizeId(text(seedEdge.id) ?? `e-${seedEdge.source}-${seedEdge.target}`),
      type: relationType(seedEdge.relation),
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
    nodes.push({
      id,
      type: "Investigator",
      label: personName(pi),
      source: "NIH RePORTER",
      url: grants[0].url,
      attributes: { reporter_name: pi },
    });
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

  // The seed's family-wide mechanism and its edges stay as they are; the curated facts add the
  // protein-level detail that tells the subtypes apart.
  const curated = facts ? addCuratedFacts(facts.doc, facts.name, nodes, edges, reference) : null;

  // Edge ids must be unique. Identical repeats (same id, same claim) are dropped; the
  // remaining reuses (one grant, several RePORTER records) get -2, -3 in content order, so
  // ids do not depend on the order the pipeline happened to append them.
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
  const diseases = nodes.filter((n) => n.type === "Disease").length;
  notes.push(
    `Adapted from ${seedName} (${text(seed.slice) ?? "seed"} slice, ${diseases} diseases) by scripts/seed-to-graph.ts. ` +
      `${curated ? "Seed edge dates are retrieval dates; curated edges carry their source's date." : "Edge dates are retrieval dates."} ` +
      "Keyword and directory matches are marked inferred.",
  );
  if (!reference) {
    notes.push("Phenotype labels not yet verified against HPO.");
    warnings.push("no HPO reference: phenotype labels kept from the seed, which pairs ids and names out of order");
  } else {
    const version = text(reference.meta?.hpo_version);
    notes.push(
      `Phenotype labels are from HPO${version ? ` (${version})` : ""}; ` +
        (corrections.length
          ? `${corrections.length} of ${phenotypes} seed labels were corrected because the seed paired Monarch's phenotype ids and names out of order.`
          : "every seed label already matched."),
    );
  }
  if (curated && facts) {
    const checked = text(facts.doc.checked);
    notes.push(
      `Hand-curated from ${facts.name}${checked ? ` (checked ${checked})` : ""}: ${curated.mechanisms} mechanisms of the missing proteins, ` +
        `${curated.geneLinks} gene-mechanism links, and onset and inheritance for ${Math.max(curated.onsets, curated.inheritances)} diseases; ` +
        "every link quotes its source verbatim in its evidence. The seed's own mechanism is kept: it is the family's definition and links every disease.",
    );
    if (curated.conflicts.length) {
      notes.push(`Sources disagree on the onset of ${curated.conflicts.join(" and ")}; the edge evidence says how, and a clinician should confirm.`);
    }
    const unlabeled = curated.newPhenotypes.filter((id) => !text(reference?.terms[id]?.label));
    if (unlabeled.length) {
      warnings.push(`curated terms labeled from the facts file, not HPO (no reference entry): ${unlabeled.join(", ")}`);
    }
  }
  if (notInReference.length) {
    notes.push(`Not in the HPO reference, so labeled as in the seed: ${notInReference.sort(byCodeUnit).join(", ")}.`);
    warnings.push(`${notInReference.length} phenotype ids are not in the HPO reference: ${notInReference.join(", ")}`);
  }
  if (obsolete.length) {
    notes.push(`Obsolete in HPO, kept as the seed has them: ${obsolete.sort(byCodeUnit).join(", ")}.`);
  }
  if (repeats) {
    notes.push(`Dropped ${repeats} exact repeats of seed edges.`);
    warnings.push(`dropped ${repeats} exact duplicate edges`);
  }
  if (renamed.length) {
    notes.push(`${renamed.length} edge ids got a -2/-3 suffix because the seed reused them for different source records.`);
    warnings.push(`renamed ${renamed.length} reused edge ids: ${renamed.join(", ")}`);
  }
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const linkedTrials = new Set<string>();
  for (const e of uniqueEdges) {
    if (typeOf.get(e.subject) === "Trial" && typeOf.get(e.object) === "Disease") linkedTrials.add(e.subject);
    if (typeOf.get(e.object) === "Trial" && typeOf.get(e.subject) === "Disease") linkedTrials.add(e.object);
  }
  const trials = nodes.filter((n) => n.type === "Trial");
  const unlinked = trials.filter((n) => !linkedTrials.has(n.id)).length;
  if (unlinked) {
    notes.push(`${unlinked} of ${trials.length} clinical studies are search hits that matched no disease keyword; they are kept without a disease link.`);
  }
  if (unnamed.length) {
    notes.push(`No name in the seed, so labeled by id: ${unnamed.sort(byCodeUnit).join(", ")}.`);
    warnings.push(`${unnamed.length} nodes have no name: ${unnamed.join(", ")}`);
  }
  if (gapNodes.length || gapEdges) {
    const listed = gapNodes.map((n) => `${n.id}${text(n.name) ? ` ("${text(n.name)}")` : ""}`).sort(byCodeUnit);
    notes.push(`Skipped ${gapNodes.length} gap nodes${listed.length ? ` (${listed.join(", ")})` : ""} and ${gapEdges} gap edges; a gap is a statement of missing data, not a node.`);
  }
  if (skippedTypes.length) {
    notes.push(`Skipped nodes of unmapped seed types: ${skippedTypes.sort(byCodeUnit).join(", ")}.`);
    warnings.push(`skipped ${skippedTypes.length} nodes of unmapped types: ${skippedTypes.join(", ")}`);
  }
  if (unknownRelations.size) {
    const list = [...unknownRelations].sort(byCodeUnit).join(", ");
    notes.push(`Unmapped seed relations kept with default provenance (sourced = observed, else inferred): ${list}.`);
    warnings.push(`unmapped relations (sourced -> observed 1, else inferred 0.5): ${list}`);
  }
  const notFetched = (seed.not_fetched ?? []).map(text).filter((v): v is string => v !== undefined);
  if (notFetched.length) notes.push(`Not fetched for the seed: ${notFetched.join("; ")}.`);

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
  return { graph, report: { notes, warnings, corrections: corrections.sort((a, b) => byCodeUnit(a.id, b.id)), phenotypes, curated } };
}

function parseArgs(argv: string[]) {
  const options = {
    seed: join(ROOT, "data", "seed", "cln_graph.json"),
    reference: join(ROOT, "data", "reference", "hpo-reference.json") as string | null,
    referenceRequired: false,
    facts: join(ROOT, "data", "curated", "ncl_facts.json") as string | null,
    factsRequired: false,
    out: join(ROOT, "public", "graph.sample.json"),
  };
  const usage = "Flags: --seed <file>, --reference <file>, --no-reference, --facts <file>, --no-facts, --out <file>";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--no-reference") {
      options.reference = null;
      continue;
    }
    if (flag === "--no-facts") {
      options.facts = null;
      continue;
    }
    const value = argv[i + 1];
    if (!["--seed", "--reference", "--facts", "--out"].includes(flag) || !value) {
      throw new Error(`Unexpected argument ${flag}. ${usage}`);
    }
    i++;
    if (flag === "--seed") options.seed = resolve(value);
    else if (flag === "--out") options.out = resolve(value);
    else if (flag === "--facts") {
      options.facts = resolve(value);
      options.factsRequired = true;
    } else {
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
  const seed = readJson<Seed>(options.seed);
  if (!Array.isArray(seed.nodes) || !Array.isArray(seed.edges)) throw new Error(`${display(options.seed)} has no nodes/edges arrays`);

  let reference: HpoReference | null = null;
  if (options.reference && existsSync(options.reference)) {
    reference = readJson<HpoReference>(options.reference);
    if (!reference.terms || typeof reference.terms !== "object") throw new Error(`${display(options.reference)} has no terms map`);
  } else if (options.reference && options.referenceRequired) {
    throw new Error(`${display(options.reference)} not found`);
  }

  let facts: { doc: Facts; name: string } | null = null;
  if (options.facts && existsSync(options.facts)) {
    facts = { doc: readJson<Facts>(options.facts), name: display(options.facts) };
  } else if (options.facts && options.factsRequired) {
    throw new Error(`${display(options.facts)} not found`);
  }

  const { graph, report } = adapt(seed, reference, display(options.seed), facts);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(graph, null, 2)}\n`);

  const nodeCounts = countBy(graph.nodes, (n) => n.type);
  const edgeCounts = countBy(graph.edges, (e) => e.kind);
  console.log(`${display(options.seed)} -> ${display(options.out)}`);
  console.log(`  nodes ${graph.nodes.length}: ${NODE_TYPES.map((t) => `${t} ${nodeCounts.get(t) ?? 0}`).join(", ")}`);
  console.log(`  edges ${graph.edges.length}: ${(["observed", "inferred", "contradicted"] as const).map((k) => `${k} ${edgeCounts.get(k) ?? 0}`).join(", ")}`);
  const curated = report.curated;
  if (curated && facts) {
    console.log(
      `  curated from ${facts.name}: ${curated.mechanisms} mechanisms, ${curated.geneLinks} gene-mechanism links, ` +
        `${curated.onsets} onset and ${curated.inheritances} inheritance edges` +
        (curated.newPhenotypes.length ? `, new phenotype nodes ${curated.newPhenotypes.join(", ")}` : "") +
        (curated.conflicts.length ? `; sources disagree on the onset of ${curated.conflicts.join(", ")}` : ""),
    );
  } else {
    console.log("  curated facts: none (no data/curated/ncl_facts.json, or --no-facts)");
  }
  if (reference) {
    console.log(`  phenotype labels from ${display(options.reference ?? "")}: ${report.corrections.length} of ${report.phenotypes} changed`);
    for (const c of report.corrections.slice(0, 10)) console.log(`    ${c.id}: "${c.from}" -> "${c.to}"`);
    if (report.corrections.length > 10) console.log(`    ... ${report.corrections.length - 10} more`);
  } else {
    console.log(`  phenotype labels: 0 of ${report.phenotypes} changed (no HPO reference)`);
  }
  for (const warning of report.warnings) console.warn(`  warning: ${warning}`);
}

try {
  main();
} catch (error) {
  console.error(`seed-to-graph: ${(error as Error).message}`);
  process.exit(1);
}
