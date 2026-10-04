// The atlas state that lives in the address bar, so any view can be linked to or screenshotted:
// ?d=<what is in the center>&sel=<a node or a line>&view=3d&mode=researcher&r=<relevance filter, %>
// &hide=<types>&open=<opened groups>&list=1. No ?d= means the blank start screen. No r= means the
// filter a new search opens at (defaultThreshold), so a link only pins the filter someone chose.
// Pure: the server page parses it for the first render, the app writes it back as things change.
import { NODE_TYPES, type NodeType } from "../../lib/graph/types.ts";
import type { Mode, View } from "./format";

export const DEFAULT_THRESHOLD = 0.8;

// The filter a new search opens at. 80% when a related disease reaches it (strong links first).
// Otherwise the moderate cutoff of the grade file, so every disease the engine grades at least
// "moderate" is on the map at first sight; and when even the best is under that, the best one
// rounded down to 5%. With no related disease it stays at 80%.
export function defaultThreshold(related: readonly { relevance: number }[], moderate?: number): number {
  if (!related.length) return DEFAULT_THRESHOLD;
  const best = Math.max(...related.map((r) => r.relevance));
  if (best >= DEFAULT_THRESHOLD - 1e-9) return DEFAULT_THRESHOLD;
  if (moderate !== undefined && moderate > 0 && moderate < DEFAULT_THRESHOLD && best >= moderate - 1e-9) return Math.round(moderate * 100) / 100;
  return Math.max(0.05, Math.floor(best * 20 + 1e-6) / 20);
}

export interface AtlasState {
  focusId: string | null;
  selectedId: string | null;
  view: View;
  mode: Mode;
  threshold: number | null; // 0..1, in whole percents; null: the default for what is in the center
  hidden: NodeType[]; // node types switched off with the type filters
  open: string[]; // folded groups ("bubble:<owner>:<type>") the person opened
  list: boolean;
}

export type Query = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

export function parseState(query: Query): AtlasState {
  const r = Number(first(query.r));
  const hasR = first(query.r) !== undefined && first(query.r) !== "" && Number.isFinite(r);
  return {
    focusId: first(query.d) || null,
    selectedId: first(query.sel) || null,
    view: first(query.view) === "3d" ? "3d" : "2d",
    mode: first(query.mode) === "researcher" ? "researcher" : "parent",
    threshold: hasR ? Math.round(Math.min(100, Math.max(0, r))) / 100 : null,
    hidden: NODE_TYPES.filter((t) => list(first(query.hide)).includes(t)),
    open: [...new Set(list(first(query.open)))].sort(),
    list: first(query.list) === "1",
  };
}

// Query values stay readable in the address bar: "d=MONDO:0008767", not "MONDO%3A0008767".
function value(text: string): string {
  return encodeURIComponent(text).replace(/%3A/gi, ":").replace(/%2C/gi, ",");
}

// "?d=...&..." for the state, or "" for the plain start screen. Parameters at their default are
// left out, so a shared link stays short; a filter the person set is always kept.
export function stateQuery(state: AtlasState): string {
  const params: string[] = [];
  if (state.focusId) {
    params.push(`d=${value(state.focusId)}`);
    if (state.selectedId) params.push(`sel=${value(state.selectedId)}`);
    if (state.threshold !== null) params.push(`r=${Math.round(state.threshold * 100)}`);
    if (state.hidden.length) params.push(`hide=${value(NODE_TYPES.filter((t) => state.hidden.includes(t)).join(","))}`);
    if (state.open.length) params.push(`open=${value([...state.open].sort().join(","))}`);
  }
  if (state.view !== "2d") params.push(`view=${state.view}`);
  if (state.mode !== "parent") params.push(`mode=${state.mode}`);
  if (state.list) params.push("list=1");
  return params.length ? `?${params.join("&")}` : "";
}
