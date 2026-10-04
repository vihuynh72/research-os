// Display names that fit tight spaces without losing what tells similar names apart. Disease
// names here are long and come in families that differ only at the end ("oculocutaneous albinism
// type 1A", "... type 1B", "... type 2"), so cutting a name at a fixed length removes exactly the
// part that matters. These helpers keep that tail, wrap names over lines where there is room, and
// make sure two different diseases never get the same short name. Pure; browser and Node.
import type { AtlasGraph, GraphEdge, GraphNode } from "../../lib/graph/types.ts";

type Named = Pick<GraphNode, "label" | "synonyms">;

// Some source records arrive HTML-escaped ("The Cure &amp; Action for Tay-Sachs"). The named
// entities that turn up in names and titles (names are case-sensitive, as in HTML), plus every
// decimal and hex one. An entity not listed here is left as written.
const ENTITIES: Record<string, string> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  micro: "µ",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  kappa: "κ",
  aacute: "á",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  auml: "ä",
  Auml: "Ä",
  ouml: "ö",
  Ouml: "Ö",
  uuml: "ü",
  Uuml: "Ü",
  ccedil: "ç",
  ntilde: "ñ",
  szlig: "ß",
};

function decodeOnce(text: string): string {
  return text.replace(/&(#\d+|#[xX][\da-fA-F]+|[A-Za-z]+\d*);/g, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

// Plain text from text that may carry HTML entities. Text escaped twice ("&amp;amp;") is decoded twice.
export function decodeEntities(text: string): string {
  let out = text;
  for (let pass = 0; pass < 3 && out.includes("&"); pass++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// The graph with every label, synonym and evidence string decoded, built once so the map, the list,
// the panel and search all read the same text. Unchanged nodes and edges are reused as they are.
export function cleanGraph(graph: AtlasGraph): AtlasGraph {
  let changed = false;
  const nodes = graph.nodes.map((node): GraphNode => {
    const label = decodeEntities(node.label);
    const synonyms = node.synonyms?.map(decodeEntities);
    if (label === node.label && (synonyms ?? []).every((s, i) => s === node.synonyms![i])) return node;
    changed = true;
    return { ...node, label, ...(synonyms ? { synonyms } : {}) };
  });
  const edges = graph.edges.map((edge): GraphEdge => {
    const evidence = edge.evidence === undefined ? undefined : decodeEntities(edge.evidence);
    if (evidence === edge.evidence) return edge;
    changed = true;
    return { ...edge, evidence };
  });
  return changed ? { ...graph, nodes, edges } : graph;
}

// The compact synonym rule of lib/graph/labels.ts (e.g. "CLN3"): short, capitalized, with a digit.
const SHORT_NAME = /^[A-Z][A-Za-z0-9-]{1,9}$/;

export function compactSynonym(node: Named): string | null {
  const compact = (node.synonyms ?? []).filter((s) => SHORT_NAME.test(s) && /\d/.test(s)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  return compact[0] ?? null;
}

// The end of a name that tells it apart from its siblings: "type 1A", "2", "II", "15/16", or the
// clause after the last comma ("Stanescu type", "classic form").
const TAIL_WORD = /^(\d+[A-Za-z]?|[IVX]+|[A-Z]\d+[A-Za-z]?|[A-Z]|\d+\/\d+)$/;
const TAIL_LEAD = /^(type|types|group|form|class|subtype)$/i;

function naturalTail(label: string): string | null {
  const words = label.split(" ");
  const last = words[words.length - 1];
  if (words.length > 1 && TAIL_WORD.test(last)) {
    const lead = words[words.length - 2];
    return words.length > 2 && TAIL_LEAD.test(lead) ? `${lead} ${last}` : last;
  }
  const comma = label.lastIndexOf(", ");
  if (comma > 0 && label.length - comma - 2 <= 18) return label.slice(comma + 2);
  return null;
}

const TRIM_END = /[\s,;:\-–/(]+$/;

// The start of `text` in at most `room` characters: at a word boundary (a space, or after a hyphen
// or slash) when that keeps most of the room, else cut inside the word.
function cutStart(text: string, room: number): string {
  if (text.length <= room) return text;
  const window = text.slice(0, room + 1);
  let at = -1;
  for (let k = window.length - 1; k > 0; k--) {
    if (window[k] === " " || window[k - 1] === "-" || window[k - 1] === "/") {
      at = k;
      break;
    }
  }
  const cut = at >= room * 0.6 ? text.slice(0, at) : text.slice(0, room);
  return cut.replace(TRIM_END, "");
}

// A name in at most `max` characters. Too long, it keeps its distinguishing tail when it has one
// ("oculocutaneous… type 1A"), else its start ("spondyloepiphyseal…"). `tail` forces a given tail.
export function fitName(label: string, max: number, tail: string | null = naturalTail(label)): string {
  if (label.length <= max) return label;
  if (tail && tail.length <= max - 7 && label.endsWith(tail)) {
    const head = label.slice(0, label.length - tail.length).replace(TRIM_END, "");
    return `${cutStart(head, max - tail.length - 2)}… ${tail}`;
  }
  return `${cutStart(label, max - 1)}…`;
}

// Places a long name may break: after a space, a hyphen or a slash, but never inside its tail, so
// "type 1" stays together on one line.
function tokens(label: string): string[] {
  const split = (text: string) => text.match(/[^\s\-/]+[\-/]?\s*|[\-/]\s*/g) ?? [text];
  const tail = naturalTail(label);
  if (!tail || !tail.includes(" ") || tail.length >= label.length) return split(label);
  return [...split(label.slice(0, label.length - tail.length)), tail];
}

// A name over at most `maxLines` lines of `perLine` characters. When it does not fit, the last line
// keeps the name's tail (fitName), so "mild spondyloepiphyseal / dysplasia due to COL2A1…" still
// reads as one name.
export function wrapName(label: string, perLine: number, maxLines: number): string[] {
  if (label.length <= perLine) return [label];
  const parts = tokens(label);
  // Greedy lines first, each starting at a token index.
  const starts: number[] = [0];
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    const next = current + parts[i];
    if (next.trimEnd().length <= perLine || !current) current = next;
    else {
      starts.push(i);
      current = parts[i];
    }
  }
  const lineOf = (k: number) => parts.slice(starts[k], starts[k + 1] ?? parts.length).join("").trimEnd();
  if (starts.length > maxLines) {
    const lines = Array.from({ length: maxLines - 1 }, (_, k) => lineOf(k));
    const rest = parts.slice(starts[maxLines - 1]).join("").trim();
    const tail = naturalTail(label);
    lines.push(fitName(rest, perLine, tail && rest.endsWith(tail) ? tail : naturalTail(rest)));
    return lines.map((line) => (line.length > perLine ? fitName(line, perLine) : line));
  }
  const lines = starts.map((_, k) => lineOf(k));
  // A single word longer than a line: cut it.
  if (lines.some((line) => line.length > perLine)) return lines.map((line) => (line.length > perLine ? fitName(line, perLine) : line));
  return balanced(parts, lines.length, perLine) ?? lines;
}

// The same number of lines with lengths as even as possible ("Hermansky-Pudlak / syndrome 10",
// not "Hermansky-Pudlak syndrome / 10"). Names have few words, so every split is tried.
function balanced(parts: string[], count: number, perLine: number): string[] | null {
  if (count < 2 || count > 3) return null;
  const join = (from: number, to: number) => parts.slice(from, to).join("").trimEnd();
  let best: string[] | null = null;
  let bestWidth = Infinity;
  for (let i = 1; i < parts.length; i++) {
    for (let j = count === 3 ? i + 1 : parts.length; j <= parts.length - (count === 3 ? 1 : 0); j++) {
      const lines = count === 3 ? [join(0, i), join(i, j), join(j, parts.length)] : [join(0, i), join(i, parts.length)];
      const width = Math.max(...lines.map((l) => l.length));
      if (width <= perLine && width < bestWidth) {
        best = lines;
        bestWidth = width;
      }
      if (count === 2) break;
    }
  }
  return best;
}

// The name for running text and buttons: a compact synonym ("CLN3") when there is one, else the
// label, kept to `max` characters without losing its tail.
export function displayName(node: Named, max = 40): string {
  return compactSynonym(node) ?? fitName(node.label, max);
}

// Short names for a whole set (every disease of the atlas, or every node on the map) that are all
// different: where two would read the same, each keeps more of its own end until they differ.
export function distinctNames(nodes: readonly (Named & { id: string })[], max: number): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, (Named & { id: string })[]>();
  for (const n of nodes) {
    const name = displayName(n, max);
    out.set(n.id, name);
    const list = groups.get(name);
    if (list) list.push(n);
    else groups.set(name, [n]);
  }
  for (const [name, members] of groups) {
    if (members.length < 2 || members.every((m) => m.label === members[0].label)) continue;
    // Keep the shortest end of each name that no other member shares.
    for (const m of members) {
      const words = m.label.split(" ");
      let best = name;
      for (let k = 1; k < words.length; k++) {
        const tail = words.slice(-k).join(" ");
        if (members.some((o) => o !== m && o.label.endsWith(tail))) continue;
        best = fitName(m.label, max, tail);
        break;
      }
      out.set(m.id, best);
    }
  }
  return out;
}
