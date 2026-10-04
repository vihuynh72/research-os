// Lookup and search over graph.json. Pure and isomorphic: the server page and the browser
// search box build the same index from the same graph. "Adjacent" follows the grading model:
// any edge that is not contradicted, in either direction.
//
// Search forgives the way people type: case, accents and punctuation do not matter, plurals fold
// ("seizures"), words may come in any order with the last one still being typed, small typos pass
// ("gauchr"), and the other names of the optional alias file count ("globoid cell leukodystrophy"
// finds Krabbe disease). Ranking, best first: exact name, prefix, word prefix, all words, another
// name (alias), typo; then type order, then the shorter label.
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "./types.ts";

export interface SearchHit {
  node: GraphNode;
  // The label, synonym, alias or id that matched the query; when the words came from several names,
  // the other name that holds the most of them. Equal to the label when the label matched.
  matched: string;
  diseases: string[]; // diseasesFor(node.id); never empty, hits without a disease are dropped
}

// Other names people search by, per node id: public/search-aliases.json, written by
// scripts/build-search-aliases.ts from Monarch and HPO. Search only: they never add a node or a link.
export type SearchAliases = Readonly<Record<string, readonly string[]>>;

export interface GraphIndexOptions {
  aliases?: SearchAliases | null;
}

export interface GraphIndex {
  byId: Map<string, GraphNode>;
  edgesOf(id: string): GraphEdge[]; // every edge touching the node, contradicted ones included, sorted by id
  diseases: GraphNode[]; // sorted by label, numbers in reading order ("... 2" before "... 10")
  diseasesFor(id: string): string[]; // disease ids a node leads to, sorted, unique
  // types narrows the search to those node types (the search box's "Only symptoms" and so on).
  search(query: string, limit?: number, types?: readonly NodeType[]): SearchHit[];
  // Close names for a query that search finds nothing for ("gaushur" -> Gaucher disease): bigger
  // typos, partial words, and names that share only some of the words.
  didYouMean(query: string, limit?: number, types?: readonly NodeType[]): SearchHit[];
  // With an empty search box and a type filter: the nodes of those types that reach the most
  // diseases, so "Symptoms" opens on the symptoms that tie the atlas together.
  suggest(types: readonly NodeType[], limit?: number): SearchHit[];
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

// Match tiers, best first. An alias typed in full is as exact as the label; otherwise every alias
// match ranks below the label's own (prefix, word prefix, all words in one name, words across names).
// A typo match adds a tenth per edit, so one typo beats two.
const EXACT = 0;
const PREFIX = 1;
const WORD_PREFIX = 2;
const ALL_WORDS = 3;
const ALIAS = 4;
const ALIAS_STEP = 0.1;
const SUBSTRING = 5; // inside a word of the label: "seizure" in "antiseizure"
const TYPO = 6;
const TYPO_IN_ALIAS = 0.05;
const TYPO_ACROSS = 0.08;
// A typo in a long paper or grant title is mostly chance, so it ranks below every other typo.
const TYPO_IN_TITLE = 1;
const TITLE_TYPES: readonly NodeType[] = ["Paper", "Grant"];
// Shorter queries are too common inside other words: "fit" is in "sulfite".
const SUBSTRING_MIN = 5;
// Below this, a slip at the start of a longer word matches too much: "fits" for "first", "Witschel".
const START_TYPO_MIN = 5;
const DEFAULT_LIMIT = 8;
const DEFAULT_NEAR = 3;

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

// Disease names write types both ways ("type II", "type 2").
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9" };

// One form for the singular and the plural of a folded word: "seizures" -> "seizure",
// "abnormalities" -> "abnormality", "mucopolysaccharidoses" -> "mucopolysaccharidosis",
// "gauchers" (from "Gaucher's") -> "gaucher". Names and queries go through the same rules, so a
// rule only has to be consistent, not correct English.
function stem(word: string): string {
  const roman = ROMAN[word];
  if (roman) return roman;
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 6 && word.endsWith("oses")) return `${word.slice(0, -4)}osis`;
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (/(?:sses|ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

const stemAll = (folded: string) => folded.split(" ").map(stem).join(" ");

// Typos forgiven in a word: none below 4 letters, one up to 7, two from 8. The shorter of the two
// words sets the budget, so "fits" is not "its". A word that names something exactly is never
// second-guessed, and numbers never bend ("CLN3" is not "CLN5").
const typoBudget = (word: string) => (/\d/.test(word) ? 0 : word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0);
// "Did you mean" looks further: one typo from 3 letters, two from 5, three from 7.
const nearBudget = (word: string) => (/\d/.test(word) ? 0 : word.length >= 7 ? 3 : word.length >= 5 ? 2 : 1);
// Words too common to suggest a name on their own.
const GENERIC = new Set(["the", "and", "for", "with", "from", "type", "disease", "syndrome", "disorder"]);

// Optimal string alignment distance (Damerau: swapping two neighbors is one edit), or max + 1 as
// soon as it must exceed max.
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      row.push(d);
      if (d < low) low = d;
    }
    if (low > max) return max + 1;
    before = prev;
    prev = row;
  }
  return Math.min(prev[b.length], max + 1);
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

interface Name {
  raw: string;
  folded: string;
  stemmed: string;
  words: number[]; // vocabulary ids
  alias: boolean; // from the alias file, not the graph
}

interface Entry {
  node: GraphNode;
  names: Name[]; // label first, then the graph's synonyms, then aliases
  foldedId: string;
  typeRank: number;
}

interface Word {
  raw: string;
  stem: string;
}

interface QueryWord extends Word {
  last: boolean; // still being typed, so it may be a prefix
}

// For each query word: the vocabulary words it matches, with the edits it took (0 = as typed).
type WordMatches = Map<number, number>[];

// Per query word, the fewest edits it needs to meet a word of this name (Infinity: none does).
function editsPerWord(name: Name, matches: WordMatches): number[] {
  return matches.map((found) => {
    let low = Infinity;
    for (const word of name.words) {
      const d = found.get(word);
      if (d !== undefined && d < low) low = d;
    }
    return low;
  });
}

// The same across all of a node's names, and which name supplied each word: "vision loss" meets
// "Impaired vision" and "Loss of eyesight", two names HPO gives Visual impairment.
function editsAcross(names: Name[], matches: WordMatches): { edits: number[]; from: (Name | null)[] } {
  const edits = matches.map(() => Infinity);
  const from: (Name | null)[] = matches.map(() => null);
  for (const name of names) {
    editsPerWord(name, matches).forEach((d, i) => {
      if (d < edits[i]) {
        edits[i] = d;
        from[i] = name;
      }
    });
  }
  return { edits, from };
}

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

export function buildGraphIndex(graph: AtlasGraph, options: GraphIndexOptions = {}): GraphIndex {
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

  // Every distinct word of every name, so a query word is compared with each word once.
  const vocab: (Word & { digit: boolean })[] = [];
  const vocabId = new Map<string, number>();
  const wordIds = (folded: string) =>
    folded.split(" ").map((raw) => {
      let id = vocabId.get(raw);
      if (id === undefined) {
        id = vocab.length;
        vocab.push({ raw, stem: stem(raw), digit: /\d/.test(raw) });
        vocabId.set(raw, id);
      }
      return id;
    });

  const aliases = options.aliases ?? {};
  const entries: Entry[] = [];
  for (const node of byId.values()) {
    const rank = SEARCH_TYPE_ORDER.indexOf(node.type);
    const names: Name[] = [];
    const seen = new Set<string>();
    const add = (raw: string, alias: boolean) => {
      const folded = fold(raw);
      if (!folded || seen.has(folded)) return;
      seen.add(folded);
      names.push({ raw, folded, stemmed: stemAll(folded), words: wordIds(folded), alias });
    };
    add(node.label, false);
    // A label that folds to nothing still leads the list, so names[0] is always the label.
    if (!names.length) names.push({ raw: node.label, folded: "", stemmed: "", words: [], alias: false });
    for (const synonym of node.synonyms ?? []) add(synonym, false);
    for (const alias of aliases[node.id] ?? []) if (typeof alias === "string") add(alias, true);
    entries.push({ node, names, foldedId: fold(node.id), typeRank: rank < 0 ? SEARCH_TYPE_ORDER.length : rank });
  }

  const foldedLabel = new Map(entries.map((e) => [e.node.id, e.names[0].folded]));
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

  const queryWords = (folded: string): QueryWord[] => {
    const raws = folded.split(" ");
    return raws.map((raw, i) => ({ raw, stem: stem(raw), last: i === raws.length - 1 }));
  };

  // Search: a word matches the vocabulary words with the same stem, or that it begins when it is the
  // last word. Only a word that matches nothing that way may take typos.
  const strictMatches = (words: QueryWord[]): WordMatches =>
    words.map((word) => {
      const found = new Map<number, number>();
      vocab.forEach((v, id) => {
        if (v.stem === word.stem || (word.last && (v.raw.startsWith(word.raw) || v.stem.startsWith(word.stem)))) found.set(id, 0);
      });
      const budget = typoBudget(word.raw);
      if (found.size || !budget) return found;
      const startTypos = word.last && word.raw.length >= START_TYPO_MIN;
      vocab.forEach((v, id) => {
        if (v.digit) return;
        const pair = Math.min(budget, typoBudget(v.raw));
        let d = pair ? editDistance(word.raw, v.raw, pair) : Infinity;
        if (d > pair) d = Infinity;
        // The last word may be a mistyped start: "lysosm" for "lysosomal".
        if (startTypos && v.raw.length > word.raw.length) d = Math.min(d, editDistance(word.raw, v.raw.slice(0, word.raw.length), budget));
        if (d <= budget) found.set(id, d);
      });
      return found;
    });

  // Did you mean: any word may be a start, and typos reach further, but only on whole words that
  // begin with the same letter, so "morkio" finds "morquio" and not "portion".
  const nearMatches = (words: Word[]): WordMatches =>
    words.map((word) => {
      const found = new Map<number, number>();
      const budget = nearBudget(word.raw);
      vocab.forEach((v, id) => {
        if (v.stem === word.stem || v.raw.startsWith(word.raw)) found.set(id, 0);
        else if (budget && !v.digit && v.raw[0] === word.raw[0]) {
          const d = editDistance(word.raw, v.raw, budget);
          if (d <= budget) found.set(id, d);
        }
      });
      return found;
    });

  const allowed = (entry: Entry, types?: readonly NodeType[]) => !types || !types.length || types.includes(entry.node.type);

  // One name to explain a match whose words came from several: the other name that supplied the
  // most of them, the shorter on a tie ("vision loss": "Impaired vision"); the label when it alone did.
  const matchedName = (entry: Entry, sources: (Name | null)[]): string => {
    const count = new Map<Name, number>();
    for (const name of sources) if (name && name !== entry.names[0]) count.set(name, (count.get(name) ?? 0) + 1);
    let best: Name | null = null;
    for (const [name, n] of count) {
      const lead = best ? (count.get(best) ?? 0) : 0;
      if (!best || n > lead || (n === lead && name.raw.length < best.raw.length)) best = name;
    }
    return (best ?? entry.names[0]).raw;
  };

  const rankEntry = (entry: Entry, q: string, qs: string, matches: WordMatches, withIds: boolean): { rank: number; matched: string } | null => {
    let rank = Infinity;
    let matched = "";
    // On a tie the label stays; between other names the shorter one reads better ("Costeff syndrome").
    const consider = (r: number, text: string) => {
      if (r < 0) return;
      if (r < rank || (r === rank && matched !== entry.names[0].raw && text.length < matched.length)) {
        rank = r;
        matched = text;
      }
    };
    const inside = q.length >= SUBSTRING_MIN;
    for (const name of entry.names) {
      if (name.folded === q || name.stemmed === qs) consider(EXACT, name.raw);
      else if (name.folded.startsWith(q) || name.stemmed.startsWith(qs)) consider(name.alias ? ALIAS : PREFIX, name.raw);
      else if (name.folded.includes(` ${q}`) || name.stemmed.includes(` ${qs}`)) consider(name.alias ? ALIAS + ALIAS_STEP : WORD_PREFIX, name.raw);
      else if (inside && !name.alias && (name.folded.includes(q) || name.stemmed.includes(qs))) consider(SUBSTRING, name.raw);
    }
    if (withIds) consider(matchRank(entry.foldedId, q), entry.node.id);
    if (rank <= WORD_PREFIX) return { rank, matched };

    // Words in any order, in one name or across the node's names, with typos as the last resort.
    const typo = TYPO + (TITLE_TYPES.includes(entry.node.type) ? TYPO_IN_TITLE : 0);
    for (const name of entry.names) {
      const edits = editsPerWord(name, matches);
      if (!edits.every(Number.isFinite)) continue;
      const total = sum(edits);
      if (total === 0) consider(name.alias ? ALIAS + 2 * ALIAS_STEP : ALL_WORDS, name.raw);
      else consider(typo + total / 10 + (name.alias ? TYPO_IN_ALIAS : 0), name.raw);
    }
    if (rank > ALIAS + 3 * ALIAS_STEP && entry.names.length > 1) {
      const { edits, from } = editsAcross(entry.names, matches);
      if (edits.every(Number.isFinite)) {
        const total = sum(edits);
        consider(total === 0 ? ALIAS + 3 * ALIAS_STEP : typo + total / 10 + TYPO_ACROSS, matchedName(entry, from));
      }
    }
    return rank < Infinity ? { rank, matched } : null;
  };

  const ordered = (a: { entry: Entry; rank: number }, b: { entry: Entry; rank: number }) =>
    a.rank - b.rank ||
    a.entry.typeRank - b.entry.typeRank ||
    a.entry.node.label.length - b.entry.node.label.length ||
    naturalCompare(a.entry.names[0].folded, b.entry.names[0].folded) ||
    byCodeUnit(a.entry.node.id, b.entry.node.id);

  const toHits = (scored: { entry: Entry; matched: string }[], max: number): SearchHit[] => {
    const hits: SearchHit[] = [];
    for (const { entry, matched } of scored) {
      if (hits.length >= max) break;
      const found = diseasesOf(entry.node.id);
      if (found.length) hits.push({ node: entry.node, matched, diseases: [...found] });
    }
    return hits;
  };

  const search = (query: string, limit = DEFAULT_LIMIT, types?: readonly NodeType[]): SearchHit[] => {
    const q = fold(query);
    const max = Math.floor(limit);
    if (!q || !(max > 0)) return [];
    const words = queryWords(q);
    const qs = words.map((w) => w.stem).join(" ");
    // Ids only count when the query has a digit, so a word like "hp" or "mon" does not list
    // every phenotype or disease through its id prefix.
    const withIds = /\p{N}/u.test(q);
    const matches = strictMatches(words);
    const scored: { entry: Entry; rank: number; matched: string }[] = [];
    for (const entry of entries) {
      if (!allowed(entry, types)) continue;
      const result = rankEntry(entry, q, qs, matches, withIds);
      if (result) scored.push({ entry, ...result });
    }
    // Equal-length labels read in order ("CLN1" before "CLN2") before the id settles the rest.
    return toHits(scored.sort(ordered), max);
  };

  const didYouMean = (query: string, limit = DEFAULT_NEAR, types?: readonly NodeType[]): SearchHit[] => {
    const max = Math.floor(limit);
    const words = queryWords(fold(query)).filter((w) => w.raw.length >= 3);
    const specific = words.filter((w) => !GENERIC.has(w.stem));
    const used = specific.length ? specific : words;
    if (!used.length || !(max > 0)) return [];
    const matches = nearMatches(used);
    // Most words found first, then the fewest edits; names clearly worse than the best are left out.
    const scored: { entry: Entry; rank: number; found: number; matched: string }[] = [];
    for (const entry of entries) {
      if (!allowed(entry, types)) continue;
      const { edits, from } = editsAcross(entry.names, matches);
      const hit = edits.filter(Number.isFinite);
      if (hit.length) scored.push({ entry, found: hit.length, rank: sum(hit), matched: matchedName(entry, from) });
    }
    scored.sort((a, b) => b.found - a.found || ordered(a, b));
    const top = scored[0];
    return toHits(top ? scored.filter((s) => s.found === top.found && s.rank <= top.rank + 1) : [], max);
  };

  const suggest = (types: readonly NodeType[], limit = DEFAULT_LIMIT): SearchHit[] => {
    const max = Math.floor(limit);
    if (!types.length || !(max > 0)) return [];
    return entries
      .filter((entry) => types.includes(entry.node.type))
      .map((entry) => ({ entry, found: diseasesOf(entry.node.id) }))
      .filter(({ found }) => found.length > 0)
      .sort(
        (a, b) =>
          b.found.length - a.found.length ||
          a.entry.typeRank - b.entry.typeRank ||
          naturalCompare(a.entry.names[0].folded, b.entry.names[0].folded) ||
          byCodeUnit(a.entry.node.id, b.entry.node.id),
      )
      .slice(0, max)
      .map(({ entry, found }) => ({ node: entry.node, matched: entry.node.label, diseases: [...found] }));
  };

  return {
    byId,
    edgesOf: (id) => [...(edgesByNode.get(id) ?? [])],
    diseases,
    diseasesFor: (id) => [...diseasesOf(id)],
    search,
    didYouMean,
    suggest,
  };
}
