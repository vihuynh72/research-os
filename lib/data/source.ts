// Loads the graph and its grades for the app. Server only: it reads the files from disk with fs.
// The real pair (graph.json + relevance.json) wins when both exist; otherwise the sample pair.
// Files are only ever used in matching pairs, because grades computed for one graph are
// meaningless on another.
import fs from "node:fs";
import path from "node:path";
import type { AtlasGraph } from "../graph/types.ts";
import { ENGINE_VERSION, type RelevanceDoc } from "../grading/types.ts";

export interface AtlasData {
  graph: AtlasGraph;
  relevance: RelevanceDoc;
  sample: boolean;
  notes: string[]; // shown to people: stale grades, a graph waiting to be graded
}

export type AtlasDataResult = { ok: true; data: AtlasData } | { ok: false; dir: string; missing: string[]; error?: string };

const PAIRS = [
  { graph: "graph.json", relevance: "relevance.json", sample: false },
  { graph: "graph.sample.json", relevance: "relevance.sample.json", sample: true },
] as const;

export function dataDir(): string {
  return process.env.ATLAS_DATA_DIR ?? path.join(process.cwd(), "public");
}

// Parsed files are kept per path and reused until the file changes, so a multi-megabyte graph
// is not parsed again on every request.
const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

function readJson(file: string): unknown {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function isGraph(value: unknown): value is AtlasGraph {
  const v = value as AtlasGraph;
  return !!v && typeof v === "object" && Array.isArray(v.nodes) && Array.isArray(v.edges) && !!v.meta;
}

function isRelevance(value: unknown): value is RelevanceDoc {
  const v = value as RelevanceDoc;
  return !!v && typeof v === "object" && !!v.meta && !!v.diseases && typeof v.diseases === "object" && Array.isArray(v.pairs);
}

export function loadAtlasData(): AtlasDataResult {
  const dir = dataDir();
  const exists = (name: string) => fs.existsSync(path.join(dir, name));
  const pair = PAIRS.find((p) => exists(p.graph) && exists(p.relevance));
  if (!pair) {
    const missing = [PAIRS[1].graph, PAIRS[1].relevance].filter((name) => !exists(name));
    return { ok: false, dir, missing };
  }
  let graph: unknown;
  let relevance: unknown;
  try {
    graph = readJson(path.join(dir, pair.graph));
    relevance = readJson(path.join(dir, pair.relevance));
  } catch (err) {
    return { ok: false, dir, missing: [], error: `Could not read ${pair.graph} or ${pair.relevance}: ${(err as Error).message}` };
  }
  if (!isGraph(graph) || !isRelevance(relevance)) {
    return { ok: false, dir, missing: [], error: `${pair.graph} or ${pair.relevance} does not have the expected shape.` };
  }

  const notes: string[] = [];
  if (pair.sample && exists(PAIRS[0].graph)) {
    notes.push("A full graph (graph.json) is present but not graded yet, so the sample is shown. Run npm run grade.");
  }
  if (relevance.meta.graph_generated_at !== graph.meta.generated_at) {
    notes.push("The grades were computed for a different build of the graph. Run npm run grade again.");
  } else if (relevance.meta.engine_version !== ENGINE_VERSION) {
    // The sample graph pins generated_at for reproducible builds, so the date cannot reveal
    // stale grades; an engine upgrade without a regrade still can.
    notes.push(`The grades come from engine ${relevance.meta.engine_version}; this app expects ${ENGINE_VERSION}. Run npm run grade again.`);
  }
  return { ok: true, data: { graph, relevance, sample: pair.sample, notes } };
}
