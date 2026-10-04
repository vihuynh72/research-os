// Node sizes on the map, shared by the 2D map (KnowledgeGraph.tsx) and the 3D view (scene3d.ts), so
// both lay out a neighborhood the same way. Diseases grow with how connected they are; when many
// diseases share the top of the map they are drawn smaller, so each still fits on its own ring.
import type { HoodNode, Neighborhood } from "../../lib/graph/neighborhood.ts";

export const CROWDED_DISEASES = 8;

export function crowdedDiseases(hood: Pick<Neighborhood, "nodes"> | null): boolean {
  return !!hood && hood.nodes.filter((n) => n.type === "Disease" && n.role !== "focus").length > CROWDED_DISEASES;
}

export function mapNodeRadius(n: Pick<HoodNode, "role" | "type">, centrality: number, crowded = false): number {
  if (n.role === "focus") return 30;
  if (n.type === "Disease") return crowded ? 12 + 4 * centrality : 17 + 7 * centrality;
  if (n.role === "bubble") return 15;
  if (n.role === "symptom") return 11;
  return 13;
}
