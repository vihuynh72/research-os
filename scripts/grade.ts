// Grades the atlas: reads the graph, the HPO reference and any AI judgments, then writes
// relevance.json (what the map shows) and the evidence bundles the AI grading workflow judges.
//   npm run grade          write the outputs and print a report
//   npm run grade:check    recompute and compare with the files on disk; write nothing
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { shortLabel } from "../lib/graph/labels.ts";
import type { AtlasGraph } from "../lib/graph/types.ts";
import { buildBundles, canonicalJson, gradeGraph } from "../lib/grading/grade.ts";
import {
  CLINICAL_TIER_WORD,
  ENGINE_VERSION,
  TIER_ORDER,
  type HpoReference,
  type JudgmentsDoc,
  type PairBundle,
  type RelevanceDoc,
  type Tier,
} from "../lib/grading/types.ts";

const HELP = `Usage: node scripts/grade.ts [options]
  --graph <file>      graph to grade (default public/graph.json)
  --reference <file>  HPO reference, or "none" (default data/reference/hpo-reference.json if it exists)
  --judgments <file>  AI judgments, or "none" (default public/judgments.json if it exists)
  --out <file>        relevance output (default public/relevance.json)
  --bundles <file>    evidence bundles (default data/grading/bundles.json)
  --check             recompute and compare with the files on disk; write nothing, exit 1 if anything differs`;

const { values } = parseArgs({
  options: {
    graph: { type: "string" },
    reference: { type: "string" },
    judgments: { type: "string" },
    out: { type: "string" },
    bundles: { type: "string" },
    check: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson<T>(path: string | URL): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// Paths in notes and messages are relative to the repo, so output does not depend on the machine.
function shown(path: string): string {
  return relative(process.cwd(), resolve(path)) || path;
}

// An explicit path must exist; "none" turns the input off; otherwise use the default if present.
function optionalInput(value: string | undefined, fallback: string): string | null {
  if (value === "none") return null;
  if (value !== undefined) {
    if (!existsSync(value)) fail(`Not found: ${value}`);
    return value;
  }
  return existsSync(fallback) ? fallback : null;
}

const graphPath = values.graph ?? "public/graph.json";
if (!existsSync(graphPath)) fail(`Graph not found: ${graphPath}. Run npm run data:graph first.`);
const referencePath = optionalInput(values.reference, "data/reference/hpo-reference.json");
const judgmentsPath = optionalInput(values.judgments, "public/judgments.json");
const outPath = values.out ?? "public/relevance.json";
const bundlesPath = values.bundles ?? "data/grading/bundles.json";

const graph = readJson<AtlasGraph>(graphPath);
const reference = referencePath ? readJson<HpoReference>(referencePath) : null;
if (reference && !reference.meta?.null?.quantiles?.length) fail(`${referencePath} has no null-model quantiles; rebuild it with npm run data:hpo.`);

// The AI workflow's output is checked against its schema before any of it can touch a grade.
function loadJudgments(path: string): JudgmentsDoc {
  const doc = readJson<unknown>(path);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(readJson(new URL("../lib/grading/judgments.schema.json", import.meta.url)));
  if (!validate(doc)) {
    const errors = (validate.errors ?? []).map((e) => `  - ${e.instancePath || "/"} ${e.message ?? ""}`);
    fail(`${path} does not match lib/grading/judgments.schema.json:\n${errors.slice(0, 30).join("\n")}`);
  }
  return doc as JudgmentsDoc;
}
const judgments = judgmentsPath ? loadJudgments(judgmentsPath) : null;

const judged = gradeGraph(graph, reference, judgments);
// Bundles always come from the deterministic baseline, so the hash the AI workflow judged stays
// valid after its judgments are applied.
const baseline = judgments ? gradeGraph(graph, reference, null) : judged;
const bundles: PairBundle[] = buildBundles(graph, reference, baseline);
const bundlesHash = createHash("sha256").update(canonicalJson(bundles)).digest("hex");

const notes = [
  `Inputs: ${shown(graphPath)}; HPO reference ${referencePath ? shown(referencePath) : "none"}; AI judgments ${judgmentsPath ? shown(judgmentsPath) : "none"}.`,
];
if (judgments && judgments.meta.bundles_hash !== bundlesHash) {
  const warning =
    "The AI judgments were made on a different evidence bundle (bundles_hash differs); only judgments whose citations still resolve were applied.";
  console.warn(warning);
  notes.push(warning);
}
if (judgments && judgments.meta.engine_version !== ENGINE_VERSION) {
  notes.push(`The AI judgments were made against engine ${judgments.meta.engine_version}; this is engine ${ENGINE_VERSION}.`);
}
const relevance: RelevanceDoc = { ...judged, meta: { ...judged.meta, notes: [...notes, ...judged.meta.notes] } };
const bundlesDoc = {
  meta: { engine_version: ENGINE_VERSION, graph_generated_at: graph.meta.generated_at, bundles_hash: bundlesHash },
  bundles,
};

const outputs: [string, string][] = [
  [outPath, `${JSON.stringify(relevance, null, 2)}\n`],
  [bundlesPath, `${JSON.stringify(bundlesDoc, null, 2)}\n`],
];

if (values.check) {
  const stale = outputs.filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text);
  for (const [path] of outputs) console.log(`${stale.some(([p]) => p === path) ? "DIFFERS" : "ok     "} ${shown(path)}`);
  if (stale.length) fail(`${stale.length} file${stale.length === 1 ? "" : "s"} out of date: run npm run grade.`);
  process.exit(0);
}

for (const [path, text] of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
printReport();

function printReport(): void {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const name = (id: string) => {
    const node = nodes.get(id);
    return node ? shortLabel(node) : id;
  };
  const pairName = (a: string, b: string) => `${name(a)} – ${name(b)}`;
  const doc = relevance;
  const diseases = Object.keys(doc.diseases);
  console.log(
    `Graded ${shown(graphPath)}: ${diseases.length} diseases, ${doc.pairs.length} pairs in the output ` +
      `(${reference ? `HPO ${reference.meta.hpo_version}` : "no HPO reference"}, ${doc.meta.method}).`,
  );

  const tiers: Tier[] = ["strong", "moderate", "exploratory", "none"];
  const histogram = tiers.map((tier) => `${tier} ${doc.pairs.filter((p) => p.tier === tier).length}`).join(", ");
  console.log(`\nPairs (biology tier: ${histogram})`);
  const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const ordered = [...doc.pairs].sort(
    (x, y) => TIER_ORDER[y.tier] - TIER_ORDER[x.tier] || y.biology - x.biology || text(x.a, y.a) || text(x.b, y.b),
  );
  const shownPairs = ordered.slice(0, 60);
  for (const pair of shownPairs) {
    const mechanism = pair.dimensions.mechanism;
    const phenotype = pair.dimensions.phenotype;
    // The mechanism that carries the score; a heavier one listed first may only come with a shared gene.
    const scoring = mechanism.shared.find((item) => item.id === mechanism.details?.most_specific) ?? mechanism.shared[0];
    const viaGene = mechanism.details?.through_shared_gene === true ? ", with the shared gene, not counted" : "";
    console.log(
      `  ${pairName(pair.a, pair.b).padEnd(26)} ${pair.tier.padEnd(11)} biology ${pair.biology.toFixed(4)}  ` +
        `clinical ${pair.clinical.toFixed(4)} (${CLINICAL_TIER_WORD[pair.clinical_tier].toLowerCase()})  ` +
        `collaboration ${pair.collaboration.toFixed(4)}  support ${pair.support ?? "-"}`,
    );
    console.log(
      `    lines: ${pair.lines_of_evidence.join(", ") || "-"}; gene ${pair.dimensions.gene.status}, ` +
        `variant ${pair.dimensions.variant.score.toFixed(4)} ${pair.dimensions.variant.status}, ` +
        `mechanism ${mechanism.score.toFixed(4)} ${mechanism.status}${scoring ? ` (${scoring.label}${viaGene})` : ""}; ` +
        `symptoms ${phenotype.score.toFixed(4)} ${phenotype.status}${phenotype.raw === undefined ? "" : ` (SimGIC ${phenotype.raw.toFixed(4)}, p ${(phenotype.percentile ?? 0).toFixed(4)})`}, ` +
        `onset/inheritance ${pair.dimensions.disease.score.toFixed(4)} ${pair.dimensions.disease.status}`,
    );
    console.log(`    ${pair.tier_reason}`);
    console.log(`    ${pair.clinical_reason}`);
    console.log(`    flags: ${pair.flags.join(", ") || "-"}`);
  }
  if (ordered.length > shownPairs.length) console.log(`  ... ${ordered.length - shownPairs.length} more pairs in ${shown(outPath)}`);

  console.log(`\nClusters (${doc.clusters.length})`);
  for (const cluster of doc.clusters) {
    console.log(
      `  [${cluster.color_slot ?? "-"}] ${cluster.label} (${cluster.id}, ${cluster.size}): ${cluster.members.map(name).join(", ")}`,
    );
  }
  const unclustered = diseases.filter((id) => doc.diseases[id].cluster === null);
  if (unclustered.length) console.log(`  unclustered (${unclustered.length}): ${unclustered.slice(0, 20).map(name).join(", ")}`);

  console.log(`\nBridges (${doc.bridges.length})`);
  for (const bridge of doc.bridges.slice(0, 40)) {
    console.log(`  ${pairName(bridge.a, bridge.b).padEnd(26)} ${bridge.reason}${bridge.cross_cluster ? " (across clusters)" : ""}`);
  }

  console.log("\nNeighbors (biology, the map) and look-alikes (clinical)");
  for (const id of diseases.slice(0, 40)) {
    const entry = doc.diseases[id];
    const list = entry.neighbors.map((n) => `${name(n.id)} ${n.tier} ${n.relevance.toFixed(2)}`).join("; ");
    console.log(
      `  ${name(id).padEnd(8)} centrality ${entry.centrality.toFixed(2)}${entry.bridge ? " bridge" : ""}  ${list || "no supported link"}${entry.hidden ? ` (+${entry.hidden} more)` : ""}`,
    );
    const alike = entry.clinical_neighbors.map((n) => `${name(n.id)} ${n.clinical.toFixed(2)}`).join("; ");
    console.log(`  ${"".padEnd(8)} looks like: ${alike || "none"}`);
  }

  console.log(`\nWrote ${shown(outPath)} and ${shown(bundlesPath)} (${bundles.length} bundles, sha256 ${bundlesHash.slice(0, 12)}...).`);
  for (const note of doc.meta.notes) console.log(`  note: ${note}`);
}
