// Builds public/search-aliases.json: the other names people search by ("Krabbe disease" is also
// "globoid cell leukodystrophy"). The search box uses them to find a node; they change no graph data,
// no grade and no link, and the app works without the file.
//
// Disease and gene names come from the Monarch Initiative API (field "synonym", plus a gene's full
// name), one request at a time with a short pause, retried once, skipped when it still fails. Symptom
// names come from the Human Phenotype Ontology file: exact, plural and layperson synonyms. A name equal
// to the label (ignoring case, accents and punctuation) is skipped, and so is a gene name that names
// a disease (Monarch lists "Best disease" for BEST1): search would show it as the gene's name.
//
// Standalone and run by hand; no part of the data pipeline calls it.
// Usage: node scripts/build-search-aliases.ts [--hpo <hp.json>] [--graph <graph.json>] [--out <file>]
//   --hpo    the HPO release file. Default: data/raw/hpo/hp.json in this checkout (written by
//            scripts/build-hpo-reference.ts); a copy without data/raw must pass it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MONARCH = "https://api-v3.monarchinitiative.org/v3/api/entity/";
const PAUSE_MS = 150;
const RETRY_MS = 2000;
const TIMEOUT_MS = 20_000;
const HPO_PREFIX = "http://purl.obolibrary.org/obo/HP_";
const HPO_TYPE = "http://purl.obolibrary.org/obo/hp#";

interface Node {
  id: string;
  type: string;
  label: string;
}

interface HpoSynonym {
  pred: string;
  val: string;
  synonymType?: string;
}

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : fallback;
}

// The same folding the search uses: case, accents and punctuation do not make a new name.
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Disease names write types both ways ("type III", "type 3"); compared as numbers.
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9" };
const nameKey = (value: string) =>
  fold(value)
    .split(" ")
    .map((word) => ROMAN[word] ?? word)
    .join(" ");
// Words that make a name a disease's, also when it is filed as a gene name ("GM2 gangliosidosis").
const DISEASE_WORD = /\b(?:disease|syndrome|dystrophy|albinism|amyloidosis|aniridia|ataxia|gangliosidosis|xanthomatosis)\b/;

// A gene name that is really a disease: one of the diseases' names here (a note in brackets
// aside), or a name with a disease word in it.
function namesDisease(name: string, diseaseKeys: ReadonlySet<string>): boolean {
  return DISEASE_WORD.test(fold(name)) || diseaseKeys.has(nameKey(name)) || diseaseKeys.has(nameKey(name.replace(/\([^)]*\)/g, " ")));
}

// Distinct names other than the label, sorted so a rebuild gives the same file.
function cleanNames(label: string, names: unknown[]): string[] {
  const seen = new Set([fold(label)]);
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const text = name.replace(/\s+/g, " ").trim();
    const key = fold(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.sort((a, b) => (fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0));
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function monarchEntity(id: string): Promise<{ synonym?: unknown[]; full_name?: unknown }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(MONARCH + encodeURIComponent(id), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as { synonym?: unknown[]; full_name?: unknown };
    } catch (err) {
      if (attempt >= 1) throw err;
      await pause(RETRY_MS);
    }
  }
}

// HPO synonyms a parent might type: every exact synonym (UK spellings and abbreviations included),
// and plural and layperson forms even when HPO files them as related or broad.
function hpoNames(file: string): { byId: Map<string, string[]>; version: string } {
  const graph = (JSON.parse(readFileSync(file, "utf8")) as { graphs: { meta?: { version?: string }; nodes: { id: string; meta?: { synonyms?: HpoSynonym[] } }[] }[] }).graphs[0];
  const byId = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (!node.id.startsWith(HPO_PREFIX)) continue;
    const kept = (node.meta?.synonyms ?? []).filter((s) => {
      const kind = s.synonymType?.startsWith(HPO_TYPE) ? s.synonymType.slice(HPO_TYPE.length) : "";
      if (kind === "obsolete_synonym" || kind === "allelic_requirement") return false;
      return s.pred === "hasExactSynonym" || kind === "plural_form" || kind === "layperson";
    });
    if (kept.length) byId.set(`HP:${node.id.slice(HPO_PREFIX.length)}`, kept.map((s) => s.val));
  }
  return { byId, version: graph.meta?.version ?? "unknown" };
}

async function main() {
  const graphFile = arg("--graph", join(ROOT, "public/graph.json"));
  const hpoFile = arg("--hpo", join(ROOT, "data/raw/hpo/hp.json"));
  const out = arg("--out", join(ROOT, "public/search-aliases.json"));
  // Checked before the slow Monarch part, so a wrong path fails at once.
  if (!existsSync(hpoFile)) {
    console.error(`No HPO file at ${hpoFile}. Pass --hpo <path to hp.json>.`);
    process.exit(1);
  }
  const hpo = hpoNames(hpoFile);
  const nodes = (JSON.parse(readFileSync(graphFile, "utf8")) as { nodes: Node[] }).nodes;

  const aliases: Record<string, string[]> = {};
  const byType: Record<string, number> = {};
  const failed: string[] = [];
  const keep = (node: Node, names: unknown[]) => {
    const clean = cleanNames(node.label, names);
    if (!clean.length) return;
    aliases[node.id] = clean;
    byType[node.type] = (byType[node.type] ?? 0) + clean.length;
  };

  const remote = nodes.filter((n) => n.type === "Disease" || n.type === "Gene");
  const fetched = new Map<string, unknown[]>();
  for (const [i, node] of remote.entries()) {
    try {
      const entity = await monarchEntity(node.id);
      fetched.set(node.id, [...(entity.synonym ?? []), ...(node.type === "Gene" ? [entity.full_name] : [])]);
    } catch (err) {
      failed.push(node.id);
      console.warn(`skipped ${node.id}: ${(err as Error).message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`Monarch: ${i + 1}/${remote.length}`);
    await pause(PAUSE_MS);
  }

  // Every disease name first, so a gene can be checked against all of them.
  const diseaseKeys = new Set<string>();
  for (const node of remote) {
    if (node.type !== "Disease") continue;
    for (const name of [node.label, ...(fetched.get(node.id) ?? [])]) if (typeof name === "string") diseaseKeys.add(nameKey(name));
  }
  const dropped: string[] = [];
  for (const node of remote) {
    const names = fetched.get(node.id);
    if (!names) continue;
    if (node.type !== "Gene") keep(node, names);
    else
      keep(
        node,
        names.filter((name) => {
          if (typeof name !== "string" || !namesDisease(name, diseaseKeys)) return true;
          dropped.push(`${node.label}: ${name}`);
          return false;
        }),
      );
  }
  if (dropped.length) console.log(`Left out ${dropped.length} gene names that name a disease: ${dropped.join("; ")}`);

  for (const node of nodes) if (node.type === "Phenotype") keep(node, hpo.byId.get(node.id) ?? []);

  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1)));
  const doc = {
    meta: {
      generated_at: new Date().toISOString(),
      generated_by: "scripts/build-search-aliases.ts",
      purpose: "Other names for search only; no graph data, grade or link comes from this file.",
      sources: [
        { name: "Monarch Initiative API v3", url: MONARCH, types: ["Disease", "Gene"], fields: ["synonym", "full_name (genes)"] },
        { name: "Human Phenotype Ontology", url: "https://hpo.jax.org/", version: hpo.version, types: ["Phenotype"], kinds: ["exact", "plural", "layperson"] },
      ],
      counts: { nodes: Object.keys(sorted).length, aliases: Object.values(sorted).reduce((n, list) => n + list.length, 0), by_type: byType, failed },
    },
    aliases: sorted,
  };
  // One node per line: small, and a rebuild reads well in a diff.
  const body = Object.entries(sorted)
    .map(([id, list]) => `    ${JSON.stringify(id)}: ${JSON.stringify(list)}`)
    .join(",\n");
  const text = `{\n  "meta": ${JSON.stringify(doc.meta)},\n  "aliases": {\n${body}\n  }\n}\n`;
  JSON.parse(text); // never write a file the app cannot read
  writeFileSync(`${out}.tmp`, text);
  renameSync(`${out}.tmp`, out);
  console.log(`Wrote ${relative(process.cwd(), out)}: ${doc.meta.counts.aliases} names for ${doc.meta.counts.nodes} nodes (${(text.length / 1024).toFixed(0)} KB)${failed.length ? `; skipped ${failed.join(", ")}` : ""}.`);
}

await main();
