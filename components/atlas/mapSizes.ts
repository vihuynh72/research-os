// Node sizes on the map (KnowledgeGraph.tsx): the layout reserves room for each node at the size it
// is drawn. The searched node is a calm white disc; the five most related diseases are the largest
// marks (they grow a little with how connected they are), the other related diseases are small, and
// evidence stays smaller still. When many diseases share the top of the map they are drawn smaller,
// so each still fits on its own ring.
import type { HoodNode, Neighborhood } from "../../lib/graph/neighborhood.ts";
import { DEFAULT_RELATED } from "./urlState.ts";

export const CROWDED_DISEASES = 8;
// The related diseases the map emphasizes: the same five a new search opens with.
export const TOP_RELATED = DEFAULT_RELATED;

export function crowdedDiseases(hood: Pick<Neighborhood, "nodes"> | null): boolean {
  return !!hood && hood.nodes.filter((n) => n.type === "Disease" && n.role !== "focus").length > CROWDED_DISEASES;
}

export function isTopRelated(n: Pick<HoodNode, "role" | "ownerRank">): boolean {
  return n.role === "related" && n.ownerRank >= 1 && n.ownerRank <= TOP_RELATED;
}

export function mapNodeRadius(n: Pick<HoodNode, "role" | "type" | "ownerRank">, centrality: number, crowded = false): number {
  if (n.role === "focus") return 21;
  if (n.type === "Disease") {
    if (n.role === "related" && !isTopRelated(n)) return crowded ? 7 : 8;
    return crowded ? 12 + 3 * centrality : 15 + 5 * centrality;
  }
  if (n.role === "bubble") return 12;
  if (n.role === "symptom") return 9;
  return 10;
}
