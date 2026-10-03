// Lookup and search over graph.json. Pure and isomorphic: the server page and the browser
// search box build the same index from the same graph. "Adjacent" follows the grading model:
// any edge that is not contradicted, in either direction.
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "./types.ts";

export interface SearchHit {
  node: GraphNode;
  matched: string; // the label, synonym or id that matched the query
  diseases: string[]; // diseasesFor(node.id); never empty, hits without a disease are dropped
}

export interface GraphIndex {
  byId: Map<string, GraphNode>;
  edgesOf(id: string): GraphEdge[]; // every edge touching the node, contradicted ones included, sorted by id
  diseases: GraphNode[]; // sorted by label, numbers in reading order ("... 2" before "... 10")
  diseasesFor(id: string): string[]; // disease ids a node leads to, sorted, unique
  search(query: string, limit?: number): SearchHit[];
}

// Equal matches list what a parent most likely means first.
const SEARCH_TYPE_ORDER: readonly NodeType[] = [
  "Disease",
  "Gene",
  "Phenotype",
  "PatientOrg",
  "Mechanism",
  "Asset",
  "Trial",
  "Grant",
  "Investigator",
  "Paper",
  "Variant",
];

// Neighbor types that pass their diseases on to a node of this type, mirroring how the grading
// dimensions reach a disease: a group working on a mechanism serves that mechanism's diseases,
// a variant belongs to its gene's diseases, a researcher to the diseases of their grants.
const VIA: Record<NodeType, readonly NodeType[]> = {
  Disease: [],
  Gene: [],
  Phenotype: [],
  Trial: [],
  Paper: [],
  Grant: [],
  Mechanism: ["Gene"],
  PatientOrg: ["Mechanism", "Gene"],
  Asset: ["Mechanism", "Gene"],
  Variant: ["Gene"],
  Investigator: ["Grant", "Paper", "Trial"],
};

const EXACT = 0;
const PREFIX = 1;
const WORD_PREFIX = 2;
const SUBSTRING = 3;
const DEFAULT_LIMIT = 8;

// Letters that NFD does not split into a base letter plus an accent.
const FOLDED_LETTERS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

// Case-, accent- and punctuation-insensitive form, words separated by single spaces:
// "Stüve-Wiedemann" -> "stuve wiedemann", "HP:0001250" -> "hp 0001250".
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[øæœßłđðþı]/g, (letter) => FOLDED_LETTERS[letter] ?? letter)
    .replace(/['’ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function matchRank(text: string, query: string): number {
  if (text === query) return EXACT;
  if (text.startsWith(query)) return PREFIX;
  if (text.includes(` ${query}`)) return WORD_PREFIX;
  if (text.includes(query)) return SUBSTRING;
  return -1;
}

// Plain code-unit order: the same on every machine and in every browser, unlike localeCompare.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function naturalCompare(a: string, b: string): number {
  const x = a.match(/\d+|\D+/g) ?? [];
  const y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (/^\d/.test(x[i]) && /^\d/.test(y[i])) {
      const p = x[i].replace(/^0+/, "");
      const q = y[i].replace(/^0+/, "");
      if (p.length !== q.length) return p.length - q.length;
      if (p !== q) return byCodeUnit(p, q);
    }
    return byCodeUnit(x[i], y[i]);
  }
  return x.length - y.length;
}

interface Entry {
  node: GraphNode;
  names: [raw: string, folded: string][]; // label first, then synonyms
  foldedId: string;
  typeRank: number;
}

export function buildGraphIndex(graph: AtlasGraph): GraphIndex {
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) if (!byId.has(node.id)) byId.set(node.id, node);

  const edgesByNode = new Map<string, GraphEdge[]>();
  const neighbors = new Map<string, Set<string>>();
  const addEdge = (id: string, edge: GraphEdge) => {
    const list = edgesByNode.get(id);
    if (list) list.push(edge);
    else edgesByNode.set(id, [edge]);
  };
  const link = (from: string, to: string) => {
    const set = neighbors.get(from);
    if (set) set.add(to);
    else neighbors.set(from, new Set([to]));
  };
  for (const edge of graph.edges) {
    addEdge(edge.subject, edge);
    if (edge.object !== edge.subject) addEdge(edge.object, edge);
    // A disputed edge is shown as evidence but never leads search to a disease.
    if (edge.kind !== "contradicted") {
      link(edge.subject, edge.object);
      link(edge.object, edge.subject);
    }
  }
  for (const list of edgesByNode.values()) list.sort((a, b) => byCodeUnit(a.id, b.id));

  const entries: Entry[] = [];
  for (const node of byId.values()) {
    const rank = SEARCH_TYPE_ORDER.indexOf(node.type);
    entries.push({
      node,
      names: [node.label, ...(node.synonyms ?? [])].map((name): [string, string] => [name, fold(name)]),
      foldedId: fold(node.id),
      typeRank: rank < 0 ? SEARCH_TYPE_ORDER.length : rank,
    });
  }

  const foldedLabel = new Map(entries.map((e) => [e.node.id, e.names[0][1]]));
  const diseases = [...byId.values()]
    .filter((node) => node.type === "Disease")
    .sort(
      (a, b) =>
        naturalCompare(foldedLabel.get(a.id) ?? "", foldedLabel.get(b.id) ?? "") ||
        byCodeUnit(a.label, b.label) ||
        byCodeUnit(a.id, b.id),
    );

  const memo = new Map<string, string[]>();
  const diseasesOf = (id: string): string[] => {
    let result = memo.get(id);
    if (!result) {
      result = computeDiseases(id);
      memo.set(id, result);
    }
    return result;
  };
  const computeDiseases = (id: string): string[] => {
    const node = byId.get(id);
    if (!node) return [];
    if (node.type === "Disease") return [id];
    const found = new Set<string>();
    const addAdjacentDiseases = (from: string) => {
      for (const other of neighbors.get(from) ?? []) if (byId.get(other)?.type === "Disease") found.add(other);
    };
    addAdjacentDiseases(id);
    const via = VIA[node.type] ?? [];
    for (const other of neighbors.get(id) ?? []) {
      const type = byId.get(other)?.type;
      if (!type || !via.includes(type)) continue;
      // A mechanism's diseases include those of its genes, so ask it rather than its edges.
      if (type === "Mechanism") for (const disease of diseasesOf(other)) found.add(disease);
      else addAdjacentDiseases(other);
    }
    return [...found].sort(byCodeUnit);
  };

  const search = (query: string, limit = DEFAULT_LIMIT): SearchHit[] => {
    const q = fold(query);
    const max = Math.floor(limit);
    if (!q || !(max > 0)) return [];
    // Ids only count when the query has a digit, so a word like "hp" or "mon" does not list
    // every phenotype or disease through its id prefix.
    const withIds = /\p{N}/u.test(q);
    const scored: { entry: Entry; rank: number; matched: string }[] = [];
    for (const entry of entries) {
      let rank = -1;
      let matched = "";
      for (const [raw, folded] of entry.names) {
        const r = matchRank(folded, q);
        if (r >= 0 && (rank < 0 || r < rank)) {
          rank = r;
          matched = raw;
        }
      }
      if (withIds) {
        const r = matchRank(entry.foldedId, q);
        if (r >= 0 && (rank < 0 || r < rank)) {
          rank = r;
          matched = entry.node.id;
        }
      }
      if (rank >= 0) scored.push({ entry, rank, matched });
    }
    // Equal-length labels read in order ("CLN1" before "CLN2") before the id settles the rest.
    scored.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entry.typeRank - b.entry.typeRank ||
        a.entry.node.label.length - b.entry.node.label.length ||
        naturalCompare(a.entry.names[0][1], b.entry.names[0][1]) ||
        byCodeUnit(a.entry.node.id, b.entry.node.id),
    );
    const hits: SearchHit[] = [];
    for (const { entry, matched } of scored) {
      if (hits.length >= max) break;
      const found = diseasesOf(entry.node.id);
      if (found.length) hits.push({ node: entry.node, matched, diseases: [...found] });
    }
    return hits;
  };

  return {
    byId,
    edgesOf: (id) => [...(edgesByNode.get(id) ?? [])],
    diseases,
    diseasesFor: (id) => [...diseasesOf(id)],
    search,
  };
}
