// Where a link comes from, in plain words. The graph's evidence strings were written by the data
// pipeline for developers ("... (pipeline/build_graph.py), not a curated link."); everywhere a link
// is explained, the app says the same thing without file paths. Every link also gets one badge:
// stated by its source, inferred (and how), or disputed. Pure; browser and Node.
import type { GraphEdge } from "../../lib/graph/types.ts";
import type { LinkKind, Neighborhood } from "../../lib/graph/neighborhood.ts";

type Provenance = Pick<GraphEdge, "source" | "kind" | "evidence">;

// "searched" marks a statement of absence: the dataset was searched and had nothing to say.
export type BadgeStyle = "stated" | "inferred" | "disputed" | "searched";

export interface Badge {
  label: string;
  style: BadgeStyle;
}

const SEARCH_MATCH: Badge = { label: "Search match · not reviewed", style: "inferred" };
const NAME_MATCH: Badge = { label: "Name match · not confirmed", style: "inferred" };
const INFERRED: Badge = { label: "Inferred", style: "inferred" };
const PARTLY_INFERRED: Badge = { label: "Partly inferred", style: "inferred" };
const DISPUTED: Badge = { label: "Disputed", style: "disputed" };

const PUBMED = /^PubMed search hit\b/i;
const NIH = /^NIH RePORTER search hit\b/i;
const ORPHANET = /^Orphanet patient-organi[sz]ation directory result\b/i;
const MONARCH_CLUSTER = /^Shared inside an existing Monarch cluster\b/i;

// "“a”", "“a” and “b”", "“a”, “b” and “c”".
function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// The evidence string as one or two plain sentences, or null when it says nothing about this one
// link (the symptom note is a limit of the whole dataset, explained once, not on every symptom).
export function plainEvidence(edge: Pick<GraphEdge, "evidence">): string | null {
  const text = edge.evidence?.trim();
  if (!text || MONARCH_CLUSTER.test(text)) return null;
  const top = (unit: string) => {
    const n = new RegExp(String.raw`first (\d+) ${unit}`, "i").exec(text)?.[1];
    return n ? ` (top ${n} ${unit})` : "";
  };
  if (PUBMED.test(text)) return `Found by a PubMed search for the gene and disease names${top("results")}. Not reviewed by a curator.`;
  if (NIH.test(text)) return `Found by an NIH RePORTER search for the gene and disease names${top("projects")}. Not reviewed by a curator.`;
  if (ORPHANET.test(text)) {
    const clause = /name contains (.+?) from the disease name/i.exec(text)?.[1] ?? "";
    const words = [...clause.matchAll(/["“]([^"”]+)["”]/g)].map((m) => `“${m[1]}”`);
    const why = words.length ? `matched because its name contains ${joinAnd(words)}` : "matched by name";
    return `Listed in Orphanet's patient-group directory; ${why}. Not confirmed by the group.`;
  }
  return withoutPaths(text) || null;
}

// A developer's file path ("pipeline/build_graph.py") has no place in a sentence for families.
const PATH = String.raw`[\w.-]+(?:/[\w.-]+)+\.(?:py|ts|js|mjs|json)\b`;

function withoutPaths(text: string): string {
  return text
    .replace(new RegExp(String.raw`,?\s*kept by ${PATH}`, "g"), "")
    .replace(new RegExp(String.raw`(?:,\s*)?${PATH}`, "g"), "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function inferredBadge(edge: Provenance): Badge {
  const text = edge.evidence ?? "";
  if (PUBMED.test(text) || NIH.test(text) || edge.source === "PubMed" || edge.source === "NIH RePORTER") return SEARCH_MATCH;
  if (ORPHANET.test(text) || edge.source === "Orphanet") return NAME_MATCH;
  return INFERRED;
}

// The badge for a statement of absence ("No patient group on record"), dated by the search.
export function searchedBadge(date: string | null | undefined): Badge {
  return { label: date ? `Searched ${date}` : "Searched", style: "searched" };
}

// The badge for one link.
export function evidenceBadge(edge: Provenance): Badge {
  if (edge.kind === "contradicted") return DISPUTED;
  if (edge.kind === "observed") return { label: `Stated by ${edge.source}`, style: "stated" };
  return inferredBadge(edge);
}

// The badge for a claim that rests on several links: stated when every link is (naming up to three
// sources), their common inferred label when they agree, else "Partly inferred". `kind` is the
// provenance the grades give the claim itself; the badge never claims more than it does. With no
// link and no kind there is nothing to show.
export function evidenceBadgeOf(edges: readonly Provenance[], kind?: LinkKind | null): Badge | null {
  if (kind === "contradicted" || edges.some((e) => e.kind === "contradicted")) return DISPUTED;
  let badge: Badge | null = null;
  const stated = edges.filter((e) => e.kind === "observed").length;
  if (edges.length && stated === edges.length) {
    const sources = [...new Set(edges.map((e) => e.source))];
    badge = { label: `Stated by ${sources.length > 3 ? `${sources.length} sources` : joinAnd(sources)}`, style: "stated" };
  } else if (edges.length && !stated) {
    const labels = [...new Set(edges.map((e) => inferredBadge(e).label))];
    badge = labels.length === 1 ? inferredBadge(edges[0]) : INFERRED;
  } else if (edges.length) {
    badge = PARTLY_INFERRED;
  }
  if ((kind === "inferred" || kind === "mixed") && (!badge || badge.style === "stated")) return kind === "mixed" ? PARTLY_INFERRED : INFERRED;
  return badge;
}

// The records behind a node on the map: for a related disease, the evidence its biology lines rest
// on; for anything else, the links that put it there (the lines drawn to it, not the ones it sends
// on to its own genes or symptoms).
export function nodeEvidence(hood: Pick<Neighborhood, "nodes" | "edges">, nodeId: string, edgeById: ReadonlyMap<string, GraphEdge>): GraphEdge[] {
  const node = hood.nodes.find((n) => n.id === nodeId);
  if (!node || node.role === "focus") return [];
  const lines =
    node.role === "related"
      ? hood.edges.filter((e) => e.role === "similarity" && (e.a === nodeId || e.b === nodeId))
      : hood.edges.filter((e) => e.role !== "bridge" && e.role !== "similarity" && e.b === nodeId);
  const ids = [...new Set(lines.flatMap((e) => e.edgeIds))];
  return ids.flatMap((id) => {
    const edge = edgeById.get(id);
    return edge ? [edge] : [];
  });
}

// The badge for a node on the map, never claiming more than the map's own provenance for it.
export function nodeBadge(hood: Pick<Neighborhood, "nodes" | "edges">, nodeId: string, edgeById: ReadonlyMap<string, GraphEdge>): Badge | null {
  const node = hood.nodes.find((n) => n.id === nodeId);
  if (!node || node.role === "focus") return null;
  return evidenceBadgeOf(nodeEvidence(hood, nodeId, edgeById), node.kind);
}
