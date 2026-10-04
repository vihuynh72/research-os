// Builds data/reference/reactome-pathways.json: the Reactome pathways each gene of the atlas takes
// part in, the source of the graph's Mechanism nodes (scripts/seed-to-graph.ts adds them).
//
// One over-representation analysis (Reactome Analysis Service) with every gene symbol of
// data/seed/rare_graph.json lists the human pathways that contain them. Its token then gives, for
// each pathway kept, which of our symbols Reactome found in it (POST /token/{token}/found/all, the
// batch form of GET /token/{token}/found/entities/{pathway}; the analysis runs without interactors,
// so it returns curated entities only, which this script checks) and the pathway's size in proteins
// (the same result read with resource=UNIPROT). Kept: lowest-level pathways ("llp") of Homo sapiens,
// not disease pathways, with at most MAX_ENTITIES entities. A broad pathway says little about two
// diseases; the grading engine discounts the rest by size and by how many diseases share them.
//
// Responses are cached in data/raw/reactome/ (gitignored), so a rebuild is offline and gives a
// byte-identical file. --refresh fetches again; a changed gene list also fetches again.
//
// Usage: node scripts/fetch-reactome.ts [--refresh] [--seed <file>] [--out <file>] [--release-date YYYY-MM-DD]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE = join(ROOT, "data/raw/reactome/analysis-cache.json");
const SERVICE = "https://reactome.org/AnalysisService";
const HOME = "https://reactome.org/";
const HUMAN = "9606";
const MAX_ENTITIES = 300;
// The analysis the team spec asks for, plus the documented species filter: without it the service
// returns the pathways of every species that has an orthologous gene (11 species for this gene list).
const ANALYSIS_PARAMS =
  "interactors=false&species=9606&pageSize=1000&page=1&sortBy=ENTITIES_PVALUE&order=ASC&resource=TOTAL&pValue=1&includeDisease=false";
const TIMEOUT_MS = 120_000;

const rel = (path: string): string => {
  const inside = relative(ROOT, path);
  return inside.startsWith("..") ? path : inside || ".";
};
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface PathwaySummary {
  stId: string;
  name: string;
  llp: boolean;
  inDisease: boolean;
  species: { taxId: string; name: string };
  entities: { total: number; found: number };
}

interface AnalysisResult {
  summary: { token: string };
  pathwaysFound: number;
  identifiersNotFound: number;
  pathways: PathwaySummary[];
}

interface FoundElements {
  pathway: string;
  entities: { id: string }[];
  foundEntities: number;
  foundInteractors: number;
}

interface Cache {
  fetched: string; // the day the service was queried
  symbols: string[];
  database_version: number;
  release_date: string;
  release_source: string;
  analysis: PathwaySummary[]; // every page of the TOTAL result
  pathways_found: number;
  uniprot: PathwaySummary[]; // the same token read with resource=UNIPROT
  found: FoundElements[];
  not_found: string[];
}

function parseArgs(argv: string[]) {
  const options = {
    refresh: false,
    seed: join(ROOT, "data/seed/rare_graph.json"),
    out: join(ROOT, "data/reference/reactome-pathways.json"),
    releaseDate: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--refresh") {
      options.refresh = true;
      continue;
    }
    const value = argv[i + 1];
    if (!["--seed", "--out", "--release-date"].includes(flag) || !value) {
      throw new Error(`Unexpected argument ${flag}. Usage: node scripts/fetch-reactome.ts [--refresh] [--seed <file>] [--out <file>] [--release-date YYYY-MM-DD]`);
    }
    i++;
    if (flag === "--seed") options.seed = resolve(value);
    else if (flag === "--out") options.out = resolve(value);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) options.releaseDate = value;
    else throw new Error(`--release-date needs YYYY-MM-DD, got ${value}`);
  }
  return options;
}

// Gene symbols of the team-format seed ("gene" nodes, named by their HGNC symbol).
function geneSymbols(seedPath: string): string[] {
  if (!existsSync(seedPath)) throw new Error(`${rel(seedPath)} not found`);
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as { nodes?: { type?: string; name?: unknown }[] };
  if (!Array.isArray(seed.nodes)) throw new Error(`${rel(seedPath)} has no nodes array`);
  const symbols = new Set<string>();
  for (const node of seed.nodes) {
    if (node.type !== "gene") continue;
    const name = typeof node.name === "string" ? node.name.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) throw new Error(`${rel(seedPath)}: gene name "${String(node.name)}" is not a gene symbol`);
    symbols.add(name);
  }
  if (!symbols.size) throw new Error(`${rel(seedPath)} has no gene nodes`);
  return [...symbols].sort(byText);
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${init.method ?? "GET"} ${url} failed: ${reason}`);
}

const getJson = async <T>(url: string, init?: RequestInit) => (await (await request(url, init)).json()) as T;
const plainText = (body: string): RequestInit => ({ method: "POST", headers: { "Content-Type": "text/plain" }, body });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// reactome.org states each release on its home page: "Version 97 released on June 30, 2026".
async function releaseDate(version: number, given: string | null): Promise<{ date: string; source: string }> {
  if (given) return { date: given, source: "--release-date" };
  const page = await (await request(HOME)).text();
  const match = /Version\s+(\d+)\s+released on\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(page);
  if (!match || Number(match[1]) !== version || !MONTHS.includes(match[2])) {
    throw new Error(
      `Could not read the release date of Reactome ${version} from ${HOME}` +
        (match ? ` (it states version ${match[1]})` : "") +
        ". Pass --release-date YYYY-MM-DD from the release notes.",
    );
  }
  const month = String(MONTHS.indexOf(match[2]) + 1).padStart(2, "0");
  const date = `${match[4]}-${month}-${match[3].padStart(2, "0")}`;
  return { date, source: `${HOME} ("Version ${match[1]} released on ${match[2]} ${match[3]}, ${match[4]}")` };
}

// Every page of an analysis result: the first comes with the analysis, the rest from its token.
async function allPages(first: AnalysisResult, resource: string): Promise<PathwaySummary[]> {
  const pathways = [...first.pathways];
  const token = first.summary.token;
  for (let page = 2; pathways.length < first.pathwaysFound; page++) {
    const params = ANALYSIS_PARAMS.replace("&page=1&", `&page=${page}&`).replace("resource=TOTAL", `resource=${resource}`);
    const next = await getJson<AnalysisResult>(`${SERVICE}/token/${token}?${params}`);
    if (!next.pathways.length) break;
    pathways.push(...next.pathways);
  }
  return pathways;
}

const kept = (p: PathwaySummary) => p.species.taxId === HUMAN && p.llp && !p.inDisease && p.entities.total <= MAX_ENTITIES;

async function fetchAll(symbols: string[], givenRelease: string | null): Promise<Cache> {
  console.log(`Querying ${SERVICE} with ${symbols.length} gene symbols`);
  const version = Number((await (await request(`${SERVICE}/database/version`)).text()).trim());
  if (!Number.isInteger(version)) throw new Error(`${SERVICE}/database/version did not return a version number`);
  const release = await releaseDate(version, givenRelease);

  const first = await getJson<AnalysisResult>(`${SERVICE}/identifiers/?${ANALYSIS_PARAMS}`, plainText(symbols.join("\n")));
  const token = first.summary?.token;
  if (!token) throw new Error("The analysis returned no token");
  const analysis = await allPages(first, "TOTAL");
  const uniprotFirst = await getJson<AnalysisResult>(`${SERVICE}/token/${token}?${ANALYSIS_PARAMS.replace("resource=TOTAL", "resource=UNIPROT")}`);
  const uniprot = await allPages(uniprotFirst, "UNIPROT");
  const ids = analysis.filter(kept).map((p) => p.stId).sort(byText);
  const found = ids.length ? await getJson<FoundElements[]>(`${SERVICE}/token/${token}/found/all?resource=TOTAL`, plainText(ids.join(","))) : [];
  const notFound = await getJson<{ id: string }[]>(`${SERVICE}/token/${token}/notFound`);

  // The local calendar day, as the graph's other retrieval dates.
  const now = new Date();
  const fetched = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return {
    fetched,
    symbols,
    database_version: version,
    release_date: release.date,
    release_source: release.source,
    analysis,
    pathways_found: first.pathwaysFound,
    uniprot,
    found,
    not_found: notFound.map((item) => item.id).sort(byText),
  };
}

function build(cache: Cache) {
  const problems: string[] = [];
  const bySymbol = new Map(cache.symbols.map((s) => [s.toUpperCase(), s]));
  const sizes = new Map(cache.uniprot.map((p) => [p.stId, p.entities.total]));
  const found = new Map(cache.found.map((f) => [f.pathway, f]));
  if (cache.analysis.length !== cache.pathways_found) {
    problems.push(`the analysis lists ${cache.pathways_found} pathways but ${cache.analysis.length} were read`);
  }
  const pathways: { stId: string; name: string; size: number; entities: number }[] = [];
  const genes = new Map<string, Set<string>>(cache.symbols.map((s) => [s, new Set()]));
  for (const p of [...cache.analysis].filter(kept).sort((x, y) => byText(x.stId, y.stId))) {
    const hits = found.get(p.stId);
    const size = sizes.get(p.stId);
    if (!hits) problems.push(`no found entities for ${p.stId}`);
    if (size === undefined) problems.push(`no protein count for ${p.stId}`);
    if (!hits || size === undefined) continue;
    if (hits.foundInteractors || hits.foundEntities !== hits.entities.length) {
      problems.push(`${p.stId}: found entities include interactors or do not add up`);
    }
    const symbols = hits.entities.map((e) => bySymbol.get(e.id.toUpperCase()));
    if (symbols.some((s) => s === undefined)) problems.push(`${p.stId}: found an identifier that is not one of the symbols sent`);
    if (!symbols.length) continue;
    pathways.push({ stId: p.stId, name: p.name.trim(), size, entities: p.entities.total });
    for (const symbol of symbols) if (symbol) genes.get(symbol)?.add(p.stId);
  }
  if (problems.length) throw new Error(`Reactome responses in ${rel(CACHE)} are inconsistent:\n  - ${problems.join("\n  - ")}`);

  const symbolsWithout = cache.symbols.filter((s) => !genes.get(s)?.size);
  const doc = {
    meta: {
      source: "Reactome Analysis Service (https://reactome.org/AnalysisService)",
      release: cache.database_version,
      release_date: cache.release_date,
      release_source: cache.release_source,
      fetched: cache.fetched,
      query:
        `POST ${SERVICE}/identifiers/?${ANALYSIS_PARAMS} with the ${cache.symbols.length} gene symbols of data/seed/rare_graph.json, one per line; ` +
        `then, on its token, GET ?resource=UNIPROT (pathway size in proteins) and POST /found/all?resource=TOTAL (our symbols found in each kept pathway).`,
      kept: `Lowest-level pathways (llp) of Homo sapiens, disease pathways excluded, with at most ${MAX_ENTITIES} entities: ${pathways.length} of the ${cache.pathways_found} pathways hit.`,
      size: "Proteins (UniProt entries, isoforms counted apart) Reactome counts in the pathway; entities counts every molecule type, small molecules included.",
      symbols: cache.symbols.length,
      not_found: cache.not_found,
      without_pathway: symbolsWithout,
    },
    pathways,
    genes: Object.fromEntries([...genes].map(([symbol, set]) => [symbol, [...set].sort(byText)])),
  };
  return doc;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const symbols = geneSymbols(options.seed);
  let cache: Cache | null = null;
  if (existsSync(CACHE) && !options.refresh) {
    const cached = JSON.parse(readFileSync(CACHE, "utf8")) as Cache;
    if (cached.symbols.join("\n") === symbols.join("\n")) cache = cached;
    else console.log(`The gene list of ${rel(options.seed)} changed since ${rel(CACHE)} was fetched; fetching again.`);
  }
  if (!cache) {
    cache = await fetchAll(symbols, options.releaseDate);
    mkdirSync(dirname(CACHE), { recursive: true });
    // Written beside the target and renamed, so an interrupted run never passes for a cached copy.
    writeFileSync(`${CACHE}.part`, `${JSON.stringify(cache)}\n`);
    renameSync(`${CACHE}.part`, CACHE);
    console.log(`  saved ${rel(CACHE)}`);
  } else {
    console.log(`Using ${rel(CACHE)} (fetched ${cache.fetched}; --refresh to query Reactome again)`);
  }

  const doc = build(cache);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(doc, null, 2)}\n`);

  const memberships = Object.values(doc.genes).reduce((sum, list) => sum + list.length, 0);
  const sizes = doc.pathways.map((p) => p.size).sort((x, y) => x - y);
  console.log(`Reactome ${doc.meta.release} (released ${doc.meta.release_date}), fetched ${doc.meta.fetched}`);
  console.log(`  ${doc.meta.kept}`);
  console.log(`  ${symbols.length - doc.meta.without_pathway.length} of ${symbols.length} genes in at least one kept pathway (${memberships} gene-pathway links)`);
  console.log(`  not found in Reactome: ${doc.meta.not_found.join(", ") || "none"}`);
  const foundButNone = doc.meta.without_pathway.filter((s) => !doc.meta.not_found.includes(s));
  if (foundButNone.length) console.log(`  found, but in no kept pathway: ${foundButNone.join(", ")}`);
  if (sizes.length) console.log(`  pathway size in proteins: min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}`);
  console.log(`Wrote ${rel(options.out)}`);
}

main().catch((error: unknown) => {
  console.error(`fetch-reactome: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
