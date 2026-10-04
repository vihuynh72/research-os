// Builds data/reference/hpo-reference.json: the background the grading engine needs to judge
// shared symptoms. It holds HPO labels, ancestors, information content (how rare a symptom is
// across all annotated rare diseases), specificity (the same rarity as a share of recorded
// symptoms, for plain-language display), a null model of SimGIC scores for random disease
// pairs ("closer than 99% of random disease pairs"), and the SimGIC of two records of the same
// disease (OMIM versus Orphanet), the realistic ceiling for "looks the same".
// The HPO release files are cached in data/raw/hpo/ (gitignored). The output keeps only the
// terms our graphs use plus their ancestors (and the onset ladder), so it stays small enough to commit.
//
// Usage: node scripts/build-hpo-reference.ts [--refresh] [graph.json ...]
//   --refresh    download the HPO files again even when cached copies exist
//   graph.json   extra schema-format graphs whose Phenotype ids the reference must cover
//                (data/seed/rare_graph.json is always read, public/graph.json when present)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { shortLabel } from "../lib/graph/labels.ts";
import { ONSET_LADDER, PHENOTYPE_STATUS, ROUND } from "../lib/grading/config.ts";
import { percentileOf, symptomScale, symptomScore } from "../lib/grading/dimensions.ts";
import { closeTerms, simgic } from "../lib/grading/simgic.ts";
import type { HpoAspect, HpoReference, HpoTerm } from "../lib/grading/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const RAW_DIR = join(ROOT, "data/raw/hpo");
const OUT = join(ROOT, "data/reference/hpo-reference.json");
// The team's graph in its own format, written by pipeline/build_graph.py.
const SEED_GRAPH = join(ROOT, "data/seed/rare_graph.json");
const OPTIONAL_GRAPHS = [join(ROOT, "public/graph.json")];

const ONTOLOGY_URL = "https://purl.obolibrary.org/obo/hp.json";
const ANNOTATIONS_URL = "https://purl.obolibrary.org/obo/hp/hpoa/phenotype.hpoa";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const IC_FORMULA = "-ln(n_t/N)/ln(N) over diseases in phenotype.hpoa, is_a-propagated";

const NULL_PAIRS = 20000;
const NULL_SEED = 20261003;
const NULL_QUANTILES = [0, 0.5, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99, 0.995, 0.999, 1];

// Same-disease anchor: an OMIM and an Orphanet record with the same normalized name, each with at
// least this many symptoms, so a thin record does not drag the ceiling down.
const SAME_DISEASE_MIN_TERMS = 5;
const SAME_DISEASE_QUANTILES = [0, 0.25, 0.5, 0.75, 1];

// The branch a term sits under decides its aspect. Clinical course is itself a child of
// Clinical modifier, so C has to be tested before M.
const ASPECT_ROOTS: ReadonlyArray<readonly [HpoAspect, string]> = [
  ["P", "HP:0000118"],
  ["I", "HP:0000005"],
  ["C", "HP:0031797"],
  ["M", "HP:0012823"],
];

const HP_ID = /^HP:\d{7}$/;
const SCALE = 10 ** ROUND;
// "+ 0" turns the -0 of -ln(1) into 0.
const round = (x: number): number => Math.round(x * SCALE) / SCALE + 0;
const rel = (path: string): string => {
  const inside = relative(ROOT, path);
  return inside.startsWith("..") ? path : inside || ".";
};
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

async function ensureDownloaded(url: string, path: string, refresh: boolean): Promise<void> {
  if (existsSync(path) && !refresh) return;
  mkdirSync(dirname(path), { recursive: true });
  console.log(`Downloading ${url}`);
  let body: Buffer;
  try {
    // fetch follows the PURL redirects to the GitHub release asset.
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not download ${url}: ${reason}. To build offline, place the file at ${rel(path)} by hand.`);
  }
  // Write beside the target and rename, so an interrupted download never passes for a cached copy.
  const partial = `${path}.part`;
  writeFileSync(partial, body);
  renameSync(partial, path);
  console.log(`  saved ${rel(path)} (${(body.length / 1e6).toFixed(1)} MB)`);
}

interface PropertyValue {
  pred: string;
  val: string;
}

interface OboGraph {
  meta?: { version?: string; basicPropertyValues?: PropertyValue[] };
  nodes?: { id: string; lbl?: string; meta?: { deprecated?: boolean; basicPropertyValues?: PropertyValue[] } }[];
  edges?: { sub: string; pred: string; obj: string }[];
}

interface Ontology {
  version: string;
  labels: Map<string, string>; // every HP id we can name, obsolete and merged ids included
  parents: Map<string, string[]>; // is_a
  obsolete: Set<string>; // deprecated classes and ids merged into another term (alt_id)
  replacedBy: Map<string, string>; // obsolete id -> the live term to use instead
}

// "http://purl.obolibrary.org/obo/HP_0000118", "obo:HP_0000118" or "HP:0000118" -> "HP:0000118".
function hpId(value: string): string | null {
  const match = /(?:^|[/:#])HP[_:](\d{7})$/.exec(value);
  return match ? `HP:${match[1]}` : null;
}

// ".../hp/releases/2026-09-01/hp.json" -> "2026-09-01".
function releaseDate(value: string): string | null {
  return /\/releases\/(\d{4}-\d{2}-\d{2})\//.exec(value)?.[1] ?? null;
}

function loadOntology(path: string): Ontology {
  const graph = (readJson(path) as { graphs?: OboGraph[] }).graphs?.[0];
  if (!graph?.nodes || !graph.edges) throw new Error(`${rel(path)}: not an OBO Graphs file (graphs[0] has no nodes or edges)`);

  const labels = new Map<string, string>();
  const obsolete = new Set<string>();
  const listedReplacements = new Map<string, string[]>();
  const mergedInto = new Map<string, string>(); // alt_id -> the live term that absorbed it
  for (const node of graph.nodes) {
    const id = hpId(node.id);
    if (!id) continue; // annotation properties and imported classes
    labels.set(id, node.lbl ?? id);
    const values = node.meta?.basicPropertyValues ?? [];
    if (node.meta?.deprecated) {
      obsolete.add(id);
      const targets = values.filter((v) => v.pred.endsWith("IAO_0100001")).map((v) => hpId(v.val));
      listedReplacements.set(id, targets.filter((t) => t !== null).sort());
    } else {
      for (const v of values) {
        const alt = v.pred.endsWith("hasAlternativeId") ? hpId(v.val) : null;
        if (alt) mergedInto.set(alt, id);
      }
    }
  }
  // Most merged ids are not classes in hp.json at all. Keep them resolvable, because older
  // sources (and Monarch exports) can still use them.
  for (const [alt, id] of mergedInto) {
    if (labels.has(alt)) continue;
    labels.set(alt, labels.get(id) ?? alt);
    obsolete.add(alt);
  }
  // One obsolete term lists two replacements; the smallest id keeps the choice independent of
  // file order. Chains are followed until they reach a live term.
  const nextOf = (id: string) => listedReplacements.get(id)?.[0] ?? mergedInto.get(id);
  const replacedBy = new Map<string, string>();
  for (const id of obsolete) {
    const seen = new Set([id]);
    let target = nextOf(id);
    while (target && obsolete.has(target) && !seen.has(target)) {
      seen.add(target);
      target = nextOf(target);
    }
    if (target && labels.has(target) && !obsolete.has(target)) replacedBy.set(id, target);
  }

  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const child = hpId(edge.sub);
    const parent = hpId(edge.obj);
    if (edge.pred !== "is_a" || !child || !parent) continue;
    const list = parents.get(child);
    if (list) list.push(parent);
    else parents.set(child, [parent]);
  }

  const versionIri = graph.meta?.version ?? "";
  const versionInfo = graph.meta?.basicPropertyValues?.find((v) => v.pred.endsWith("versionInfo"))?.val;
  const version = releaseDate(versionIri) ?? versionInfo ?? (versionIri || "unknown");
  return { version, labels, parents, obsolete, replacedBy };
}

// The id to use for an HPO id: itself when live, its replacement when obsolete, else null.
function currentId(ontology: Ontology, id: string): string | null {
  if (!ontology.labels.has(id)) return null;
  return ontology.obsolete.has(id) ? (ontology.replacedBy.get(id) ?? null) : id;
}

interface Hierarchy {
  ancestorsOf(id: string): readonly string[];
  aspectOf(id: string): HpoAspect;
}

function hierarchy(parents: Map<string, string[]>): Hierarchy {
  const ancestors = new Map<string, readonly string[]>();
  const aspects = new Map<string, HpoAspect>();
  const visiting = new Set<string>();
  const ancestorsOf = (id: string): readonly string[] => {
    const known = ancestors.get(id);
    if (known) return known;
    if (visiting.has(id)) throw new Error(`hp.json: is_a cycle through ${id}`);
    visiting.add(id);
    const found = new Set<string>();
    for (const parent of parents.get(id) ?? []) {
      found.add(parent);
      for (const ancestor of ancestorsOf(parent)) found.add(ancestor);
    }
    visiting.delete(id);
    const sorted = [...found].sort();
    ancestors.set(id, sorted);
    return sorted;
  };
  const aspectOf = (id: string): HpoAspect => {
    let aspect = aspects.get(id);
    if (!aspect) {
      const up = ancestorsOf(id);
      aspect = ASPECT_ROOTS.find(([, root]) => id === root || up.includes(root))?.[0] ?? "other";
      aspects.set(id, aspect);
    }
    return aspect;
  };
  return { ancestorsOf, aspectOf };
}

interface Annotations {
  version: string;
  hpoVersion: string | null; // the HPO release the annotation file was built against
  diseases: Map<string, string[]>; // database_id -> annotated live terms, sorted
  names: Map<string, string>; // database_id -> disease_name of its first row
  listedDiseases: number; // distinct database_id in the file, before any row is skipped
  rows: number;
  notRows: number;
  remapped: number; // rows whose obsolete term was replaced
  dropped: Set<string>; // unknown ids, or obsolete ones without a replacement
}

function loadAnnotations(path: string, ontology: Ontology): Annotations {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const header = new Map<string, string>();
  let columns: string[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at++];
    const field = /^#\s*([\w-]+):\s*(.*)$/.exec(line);
    if (field) header.set(field[1].toLowerCase(), field[2].trim());
    else if (line.includes("\t")) {
      // The column row has no "#" in current releases and one in older ones.
      columns = line.replace(/^#/, "").split("\t").map((c) => c.toLowerCase().replace(/[^a-z]/g, ""));
      break;
    }
  }
  const column = (name: string): number => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`${rel(path)}: no ${name} column in the header row`);
    return index;
  };
  const diseaseCol = column("databaseid");
  const nameCol = column("diseasename");
  const qualifierCol = column("qualifier");
  const termCol = column("hpoid");

  const terms = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const listed = new Set<string>();
  const dropped = new Set<string>();
  let rows = 0;
  let notRows = 0;
  let remapped = 0;
  for (; at < lines.length; at++) {
    const line = lines[at];
    if (!line || line.startsWith("#")) continue;
    const cells = line.split("\t");
    const disease = cells[diseaseCol];
    rows++;
    listed.add(disease);
    if (!names.has(disease)) names.set(disease, cells[nameCol] ?? "");
    if (cells[qualifierCol] === "NOT") {
      notRows++;
      continue;
    }
    const term = currentId(ontology, cells[termCol]);
    if (!term) {
      dropped.add(cells[termCol]);
      continue;
    }
    if (term !== cells[termCol]) remapped++;
    const set = terms.get(disease);
    if (set) set.add(term);
    else terms.set(disease, new Set([term]));
  }

  const diseases = new Map<string, string[]>();
  for (const id of [...terms.keys()].sort()) diseases.set(id, [...(terms.get(id) ?? [])].sort());
  const version = header.get("date") ?? header.get("version") ?? "unknown";
  const hpoVersion = header.get("hpo-version") ?? null;
  return {
    version,
    hpoVersion: hpoVersion && (releaseDate(hpoVersion) ?? hpoVersion),
    diseases,
    names,
    listedDiseases: listed.size,
    rows,
    notRows,
    remapped,
    dropped,
  };
}

// n_t = number of diseases whose annotations, closed under is_a, include t.
function termCounts(diseases: Map<string, string[]>, h: Hierarchy): Map<string, number> {
  const counts = new Map<string, number>();
  for (const terms of diseases.values()) {
    const closure = new Set<string>();
    for (const term of terms) {
      closure.add(term);
      for (const ancestor of h.ancestorsOf(term)) closure.add(ancestor);
    }
    for (const term of closure) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

// Index of the first element of an ascending array that is >= value (or > value when `after`).
function lowerBound(sorted: Float64Array, value: number, after: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value || (after && sorted[mid] === value)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// specificity(t) = mid-rank percentile of ic(t) among every recorded symptom annotation (distinct
// disease-term pairs whose term is a phenotypic abnormality, NOT rows skipped):
// (annotations with a lower ic + half of those with the same ic) / all annotations. It ranks the
// same way as IC but reads as a percentage: "more specific than 92% of recorded symptoms". The
// half-weight on ties keeps a term from counting its own annotations as "less specific".
function specificityIndex(
  diseases: Map<string, string[]>,
  h: Hierarchy,
  icOf: (id: string) => number,
): { specificityOf: (id: string) => number; annotations: number } {
  const recorded: number[] = [];
  for (const terms of diseases.values()) {
    for (const term of terms) if (h.aspectOf(term) === "P") recorded.push(icOf(term));
  }
  const sorted = Float64Array.from(recorded).sort();
  const specificityOf = (id: string): number => {
    const ic = icOf(id);
    const lower = lowerBound(sorted, ic, false);
    const same = lowerBound(sorted, ic, true) - lower;
    return round((lower + 0.5 * same) / sorted.length);
  };
  return { specificityOf, annotations: sorted.length };
}

// mulberry32: tiny seeded PRNG, so the null sample is the same on every machine.
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nearest rank: the smallest score with at least a share p of the sample at or below it.
// The epsilon keeps p * n from landing a hair above a whole number.
const nearestRankIndex = (p: number, n: number): number => Math.max(0, Math.ceil(p * n - 1e-9) - 1);

type NullModel = HpoReference["meta"]["null"];

// Each disease's phenotypic-abnormality terms closed under is_a with the roots left out: exactly
// what the engine compares for a real pair, so random pairs, same-disease pairs and seed pairs are
// all scored the same way, with the rounded IC the engine reads from the JSON.
interface SymptomProfiles {
  terms: Map<string, string[]>; // diseases with at least one P term
  closureOf(id: string): Set<string>;
}

function symptomProfiles(diseases: Map<string, string[]>, h: Hierarchy): SymptomProfiles {
  const terms = new Map<string, string[]>();
  for (const [id, annotated] of diseases) {
    const p = annotated.filter((t) => h.aspectOf(t) === "P");
    if (p.length) terms.set(id, p);
  }
  const closures = new Map<string, Set<string>>();
  const closureOf = (id: string): Set<string> => {
    let closure = closures.get(id);
    if (!closure) {
      closure = closeTerms(terms.get(id) ?? [], h.ancestorsOf);
      closures.set(id, closure);
    }
    return closure;
  };
  return { terms, closureOf };
}

const quantilesOf = (sorted: number[], ps: number[]) => ps.map((p) => ({ p, value: round(sorted[nearestRankIndex(p, sorted.length)]) }));

// SimGIC of random pairs of distinct diseases.
function buildNullModel(profiles: SymptomProfiles, icOf: (id: string) => number): { model: NullModel; eligible: number } {
  const eligible = [...profiles.terms.keys()].sort();
  if (eligible.length < 2) throw new Error("The annotation file has fewer than 2 diseases with phenotype annotations");
  const random = mulberry32(NULL_SEED);
  const scores: number[] = [];
  for (let k = 0; k < NULL_PAIRS; k++) {
    const i = Math.floor(random() * eligible.length);
    let j = Math.floor(random() * (eligible.length - 1));
    if (j >= i) j += 1; // uniform over pairs of two different diseases
    scores.push(simgic(profiles.closureOf(eligible[i]), profiles.closureOf(eligible[j]), icOf));
  }
  scores.sort((x, y) => x - y);
  const mean = scores.reduce((sum, x) => sum + x, 0) / scores.length;
  return { model: { pairs: NULL_PAIRS, seed: NULL_SEED, mean: round(mean), quantiles: quantilesOf(scores, NULL_QUANTILES) }, eligible: eligible.length };
}

type SameDisease = NonNullable<HpoReference["meta"]["same_disease"]>;

// "Developmental and epileptic encephalopathy 96" -> "developmental and epileptic encephalopathy 96".
const normalizedName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// SimGIC between two records of one disease: HPO annotates many diseases twice, once from OMIM and
// once from Orphanet, by different curators. For every normalized name with an OMIM and an Orphanet
// record that both have >= SAME_DISEASE_MIN_TERMS symptoms, the first of each (sorted ids) form one
// pair. Their spread shows how alike "the same disease" looks once two curators describe it.
function buildSameDisease(
  annotations: Annotations,
  profiles: SymptomProfiles,
  icOf: (id: string) => number,
): { anchor: SameDisease; examples: { omim: string; orpha: string; name: string; value: number }[] } {
  const byName = new Map<string, { omim?: string; orpha?: string }>();
  for (const id of [...profiles.terms.keys()].sort()) {
    if ((profiles.terms.get(id)?.length ?? 0) < SAME_DISEASE_MIN_TERMS) continue;
    const name = normalizedName(annotations.names.get(id) ?? "");
    if (!name) continue;
    const entry = byName.get(name) ?? {};
    if (id.startsWith("OMIM:")) entry.omim ??= id;
    else if (id.startsWith("ORPHA:")) entry.orpha ??= id;
    byName.set(name, entry);
  }
  const pairs: { omim: string; orpha: string; name: string; value: number }[] = [];
  for (const [name, { omim, orpha }] of [...byName].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (!omim || !orpha) continue;
    pairs.push({ omim, orpha, name, value: simgic(profiles.closureOf(omim), profiles.closureOf(orpha), icOf) });
  }
  if (!pairs.length) throw new Error("No disease has both an OMIM and an Orphanet record with enough symptoms");
  const scores = pairs.map((pair) => pair.value).sort((x, y) => x - y);
  return { anchor: { pairs: pairs.length, quantiles: quantilesOf(scores, SAME_DISEASE_QUANTILES) }, examples: pairs };
}

// Phenotype node ids of a graph in the schema format ("Phenotype") or the team seed format ("phenotype").
function phenotypeIdsOf(path: string): string[] {
  const doc = readJson(path) as { nodes?: { id?: unknown; type?: unknown }[] };
  if (!Array.isArray(doc.nodes)) throw new Error(`${rel(path)}: no nodes array`);
  return doc.nodes.filter((n) => n.type === "Phenotype" || n.type === "phenotype").map((n) => String(n.id));
}

interface Rarity {
  icOf(id: string): number;
  specificityOf(id: string): number;
}

function buildTerms(ids: Iterable<string>, ontology: Ontology, h: Hierarchy, rarity: Rarity): Record<string, HpoTerm> {
  // Key order follows HpoTerm. Every term gets a specificity, placed on the symptom scale, so
  // the map can size an onset or inheritance term the same way as a symptom.
  const term = (label: string, rarityId: string, ancestors: string[], aspect: HpoAspect): HpoTerm => ({
    label,
    ic: rarity.icOf(rarityId),
    specificity: rarity.specificityOf(rarityId),
    ancestors,
    aspect,
  });

  const wanted = new Set<string>();
  const include = (id: string) => {
    wanted.add(id);
    for (const ancestor of h.ancestorsOf(id)) wanted.add(ancestor);
  };
  for (const id of ids) {
    if (!ontology.labels.has(id)) continue;
    include(id);
    const replacement = ontology.replacedBy.get(id);
    if (replacement) include(replacement);
  }

  const terms: Record<string, HpoTerm> = {};
  for (const id of [...wanted].sort()) {
    const label = ontology.labels.get(id) ?? id;
    if (!ontology.obsolete.has(id)) {
      terms[id] = term(label, id, [...h.ancestorsOf(id)], h.aspectOf(id));
      continue;
    }
    // An obsolete id has no place in the hierarchy. Annotations that used it are counted under
    // its replacement, so it carries the replacement's rarity and aspect; the engine maps it anyway.
    const replacement = ontology.replacedBy.get(id);
    terms[id] = replacement
      ? { ...term(label, replacement, [], h.aspectOf(replacement)), obsolete: true, replaced_by: replacement }
      : { label, ic: 1, specificity: rarity.specificityOf(id), ancestors: [], aspect: "other", obsolete: true };
  }
  return terms;
}

// HPO ids the engine needs whatever the graphs contain: every step of the onset ladder.
function requiredIds(): string[] {
  return [...new Set(ONSET_LADDER)].sort();
}

interface SeedGraph {
  nodes: { id: string; type: string; name?: string | null; synonyms?: string[] }[];
  edges: { source: string; target: string; relation?: string }[];
}

const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const fixed = (x: number) => x.toFixed(ROUND);

function printSeedReport(seed: SeedGraph, ontology: Ontology, h: Hierarchy, rarity: Rarity, meta: HpoReference["meta"]): void {
  const { icOf, specificityOf } = rarity;
  const phenotypes = seed.nodes.filter((n) => n.type === "phenotype");
  const live = [...new Set(phenotypes.map((n) => currentId(ontology, n.id)).filter((id) => id !== null))];
  const row = (id: string) => `  ${fixed(icOf(id))}  ${fixed(specificityOf(id))}       ${id}  ${ontology.labels.get(id)}`;
  const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  console.log(`\nRarest seed terms (ic: 1 = on a single disease, 0 = on all; specificity: share of recorded symptoms that are more common):`);
  console.log(`  ic      specificity  term`);
  for (const id of [...live].sort((x, y) => icOf(y) - icOf(x) || byId(x, y)).slice(0, 10)) console.log(row(id));
  console.log(`Commonest seed terms:`);
  for (const id of [...live].sort((x, y) => icOf(x) - icOf(y) || byId(x, y)).slice(0, 10)) console.log(row(id));

  // pipeline/build_graph.py zips Monarch's phenotype id and label lists, which come in different orders.
  const idByLabel = new Map<string, string>();
  for (const [id, label] of ontology.labels) {
    if (!ontology.obsolete.has(id) && !idByLabel.has(normalized(label))) idByLabel.set(normalized(label), id);
  }
  const mismatches = phenotypes.filter((n) => ontology.labels.has(n.id) && normalized(n.name ?? "") !== normalized(ontology.labels.get(n.id) ?? ""));
  console.log(`\nSeed label mismatches: ${mismatches.length} of ${phenotypes.length} seed phenotype names differ from the HPO label of their id.`);
  for (const n of mismatches.slice(0, 10)) {
    const owner = idByLabel.get(normalized(n.name ?? ""));
    const note = owner ? ` (that name is ${owner})` : "";
    console.log(`  ${n.id}  seed "${n.name}"  HPO "${ontology.labels.get(n.id)}"${note}`);
  }

  // For information: the symptom comparison the engine will make, summarized over the seed's pairs.
  const diseases = seed.nodes.filter((n) => n.type === "disease").sort((x, y) => (x.id < y.id ? -1 : 1));
  const phenotypeIds = new Set(phenotypes.map((n) => n.id));
  const directP = new Map<string, string[]>();
  for (const disease of diseases) {
    const ids = new Set<string>();
    for (const edge of seed.edges) {
      const other = edge.source === disease.id ? edge.target : edge.target === disease.id ? edge.source : null;
      const term = other && phenotypeIds.has(other) ? currentId(ontology, other) : null;
      if (term && h.aspectOf(term) === "P") ids.add(term);
    }
    directP.set(disease.id, [...ids].sort());
  }
  const name = (n: SeedGraph["nodes"][number]) => shortLabel({ label: n.name ?? n.id, synonyms: n.synonyms });
  // The engine's own scale (lib/grading/dimensions.ts), so these numbers match npm run grade.
  const scale = symptomScale(meta);
  const withSymptoms = diseases.filter((d) => directP.get(d.id)?.length);
  const rows: { pair: string; terms: string; exact: number; raw: number; percentile: number; score: number }[] = [];
  for (let i = 0; i < withSymptoms.length; i++) {
    for (let j = i + 1; j < withSymptoms.length; j++) {
      const a = directP.get(withSymptoms[i].id) ?? [];
      const b = directP.get(withSymptoms[j].id) ?? [];
      const raw = round(simgic(closeTerms(a, h.ancestorsOf), closeTerms(b, h.ancestorsOf), icOf));
      const percentile = round(percentileOf(raw, meta.null.quantiles));
      const score = round(symptomScore(raw, percentile, scale));
      const exact = a.filter((t) => b.includes(t)).length;
      rows.push({ pair: `${name(withSymptoms[i])} - ${name(withSymptoms[j])}`, terms: `${a.length}/${b.length}`, exact, raw, percentile, score });
    }
  }
  const status = (score: number) => (score >= PHENOTYPE_STATUS.match ? "match" : score >= PHENOTYPE_STATUS.partial ? "partial" : "none");
  console.log(
    `\nSeed symptom comparison. Symptom scale: SimGIC ${fixed(scale.floor)} (99th percentile of random pairs) -> 0, ` +
      `${fixed(scale.top)} (median of ${scale.sameDiseasePairs} same-disease pairs) -> 1; below the 95th percentile of random pairs -> 0.`,
  );
  console.log(
    `  ${withSymptoms.length} of ${diseases.length} seed diseases have phenotypic-abnormality terms; of their ${rows.length} pairs, ` +
      `${rows.filter((r) => r.score > 0).length} score above 0 and ${rows.filter((r) => status(r.score) === "match").length} are a match.`,
  );
  console.log(`  highest raw SimGIC:`);
  console.log(`  terms   exact  raw     percentile  score   status   pair`);
  for (const r of [...rows].sort((x, y) => y.raw - x.raw || (x.pair < y.pair ? -1 : 1)).slice(0, 10)) {
    console.log(`  ${r.terms.padEnd(6)}  ${String(r.exact).padEnd(5)}  ${fixed(r.raw)}  ${fixed(r.percentile)}      ${fixed(r.score)}  ${status(r.score).padEnd(7)}  ${r.pair}`);
  }
}

function parseArgs(args: string[]): { refresh: boolean; graphs: string[] } {
  const unknown = args.filter((a) => a.startsWith("-") && a !== "--refresh");
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(" ")}. Usage: node scripts/build-hpo-reference.ts [--refresh] [graph.json ...]`);
  const extra = args.filter((a) => !a.startsWith("-")).map((a) => resolve(a));
  const missing = extra.filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`Graph file not found: ${missing.join(", ")}`);
  // Checked before any download: the seed's terms and the seed report are part of every build.
  if (!existsSync(SEED_GRAPH)) {
    throw new Error(`${rel(SEED_GRAPH)} not found. It is the team's graph the reference covers (pipeline/build_graph.py writes it).`);
  }
  const graphs = [...new Set([SEED_GRAPH, ...extra, ...OPTIONAL_GRAPHS.filter((path) => existsSync(path))])];
  return { refresh: args.includes("--refresh"), graphs };
}

async function main(): Promise<void> {
  const { refresh, graphs } = parseArgs(process.argv.slice(2));
  const ontologyPath = join(RAW_DIR, "hp.json");
  const annotationsPath = join(RAW_DIR, "phenotype.hpoa");
  await ensureDownloaded(ONTOLOGY_URL, ontologyPath, refresh);
  await ensureDownloaded(ANNOTATIONS_URL, annotationsPath, refresh);

  const ontology = loadOntology(ontologyPath);
  const h = hierarchy(ontology.parents);
  const annotations = loadAnnotations(annotationsPath, ontology);
  const n = annotations.diseases.size;
  if (n < 2) throw new Error(`${rel(annotationsPath)}: fewer than 2 annotated diseases`);
  console.log(`HPO ${ontology.version}, annotations ${annotations.version}`);
  if (annotations.hpoVersion && annotations.hpoVersion !== ontology.version) {
    console.warn(`Warning: phenotype.hpoa was built against HPO ${annotations.hpoVersion}; obsolete ids are remapped. Run with --refresh to fetch matching files.`);
  }
  console.log(
    `Annotations: ${annotations.rows} rows, ${annotations.notRows} NOT rows skipped, ` +
      `${annotations.remapped} remapped from obsolete ids, ${annotations.dropped.size} unknown ids dropped`,
  );
  console.log(`N = ${n} diseases` + (n !== annotations.listedDiseases ? ` (${annotations.listedDiseases} listed; the rest have no usable annotation)` : ""));

  const counts = termCounts(annotations.diseases, h);
  const lnN = Math.log(n);
  const icCache = new Map<string, number>();
  // Rounded once here and used everywhere below, so the engine, which reads the rounded values
  // from the JSON, reproduces these numbers exactly.
  const icOf = (id: string): number => {
    let ic = icCache.get(id);
    if (ic === undefined) {
      const count = counts.get(id) ?? 0;
      ic = count === 0 ? 1 : round(-Math.log(count / n) / lnN);
      icCache.set(id, ic);
    }
    return ic;
  };

  const specificity = specificityIndex(annotations.diseases, h, icOf);
  const rarity: Rarity = { icOf, specificityOf: specificity.specificityOf };
  console.log(`Specificity: mid-rank of ic among ${specificity.annotations} recorded symptom annotations (distinct disease-term pairs, aspect P)`);
  const profiles = symptomProfiles(annotations.diseases, h);
  const { model, eligible } = buildNullModel(profiles, icOf);
  const sameDisease = buildSameDisease(annotations, profiles, icOf);

  const inputIds = new Set<string>();
  const skipped = new Set<string>();
  console.log(`\nInput graphs:`);
  for (const path of graphs) {
    const ids = phenotypeIdsOf(path);
    for (const id of ids) (HP_ID.test(id) ? inputIds : skipped).add(id);
    console.log(`  ${rel(path)}: ${ids.length} phenotype nodes`);
  }
  for (const id of requiredIds()) inputIds.add(id);
  console.log(`  the onset ladder: ${ONSET_LADDER.length} onset steps`);
  if (skipped.size) console.warn(`Warning: ${skipped.size} phenotype ids are not HPO ids and were skipped: ${[...skipped].sort().slice(0, 10).join(", ")}`);
  const unknown = [...inputIds].filter((id) => !ontology.labels.has(id)).sort();
  if (unknown.length) console.warn(`Warning: ${unknown.length} ids are not in HPO ${ontology.version}: ${unknown.slice(0, 10).join(", ")}`);
  const obsoleteInput = [...inputIds].filter((id) => ontology.obsolete.has(id)).sort();
  console.log(`Obsolete input terms: ${obsoleteInput.length || "none"}`);
  for (const id of obsoleteInput) console.log(`  ${id} "${ontology.labels.get(id)}" -> ${ontology.replacedBy.get(id) ?? "no replacement (dropped by the engine)"}`);

  const terms = buildTerms([...inputIds].sort(), ontology, h, rarity);
  const reference: HpoReference = {
    meta: {
      hpo_version: ontology.version,
      annotations_version: annotations.version,
      n_diseases: n,
      ic_formula: IC_FORMULA,
      sources: [ONTOLOGY_URL, ANNOTATIONS_URL],
      null: model,
      same_disease: sameDisease.anchor,
    },
    terms,
  };

  const aspects = new Map<string, number>();
  for (const term of Object.values(terms)) aspects.set(term.aspect, (aspects.get(term.aspect) ?? 0) + 1);
  const byAspect = ASPECT_ROOTS.map(([aspect]) => aspect)
    .concat("other")
    .filter((aspect) => aspects.has(aspect))
    .map((aspect) => `${aspect} ${aspects.get(aspect)}`)
    .join(", ");
  const known = inputIds.size - unknown.length;
  console.log(`Terms written: ${Object.keys(terms).length} (${known} input terms plus their ancestors; aspects ${byAspect})`);

  console.log(`\nNull model: SimGIC of ${model.pairs} random pairs from ${eligible} diseases with phenotype annotations, seed ${model.seed}`);
  console.log(`  mean   ${fixed(model.mean)}`);
  for (const q of model.quantiles) console.log(`  p ${String(q.p).padEnd(5)}  ${fixed(q.value)}`);

  const { anchor, examples } = sameDisease;
  console.log(
    `\nSame disease, two records: SimGIC of ${anchor.pairs} OMIM/Orphanet pairs with the same normalized name, ` +
      `each with >= ${SAME_DISEASE_MIN_TERMS} symptoms`,
  );
  for (const q of anchor.quantiles) console.log(`  p ${String(q.p).padEnd(5)}  ${fixed(q.value)}`);
  const byValue = [...examples].sort((x, y) => x.value - y.value || (x.name < y.name ? -1 : 1));
  const median = byValue[Math.floor(byValue.length / 2)];
  for (const [what, pair] of [["lowest", byValue[0]], ["median", median], ["highest", byValue[byValue.length - 1]]] as const) {
    console.log(`  ${what.padEnd(7)}  ${fixed(round(pair.value))}  ${pair.omim} / ${pair.orpha}  "${pair.name}"`);
  }

  printSeedReport(readJson(SEED_GRAPH) as SeedGraph, ontology, h, rarity, reference.meta);

  const json = `${JSON.stringify(reference, null, 2)}\n`;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`\nWrote ${rel(OUT)} (${Object.keys(terms).length} terms, ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
