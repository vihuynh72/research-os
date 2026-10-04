// "Where the data comes from", computed from the graph's own links: each source, what it provides,
// how many links it gives and how recent they are. Nothing here is typed in by hand. Pure.
import type { EdgeKind, GraphEdge } from "../../../lib/graph/types.ts";

export interface SourceRow {
  source: string;
  provides: string;
  links: number;
  date: string; // the newest link's date
  kind: EdgeKind | "mixed";
  sample: GraphEdge; // one link, for its evidence badge
}

const PROVIDES: Record<string, string> = {
  causes: "the gene behind each disease",
  has_phenotype: "symptoms",
  in_pathway: "the pathways each gene takes part in",
  variant_of: "recorded gene changes",
  works_on: "patient groups",
  about: "papers",
  funds: "research grants",
  studies: "clinical studies",
  investigates: "researchers",
  registers: "registries",
};

export function dataSources(edges: readonly GraphEdge[]): SourceRow[] {
  const bySource = new Map<string, GraphEdge[]>();
  for (const e of edges) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  return [...bySource]
    .map(([source, list]): SourceRow => {
      const kinds = new Set(list.map((e) => e.kind));
      const types = [...new Set(list.map((e) => e.type))];
      return {
        source,
        provides: types.map((t) => PROVIDES[t] ?? t.replace(/_/g, " ")).join(", "),
        links: list.length,
        date: list.reduce((d, e) => (e.date > d ? e.date : d), ""),
        kind: kinds.size === 1 ? [...kinds][0] : "mixed",
        sample: list[0],
      };
    })
    .sort((a, b) => Number(a.kind !== "observed") - Number(b.kind !== "observed") || b.links - a.links || a.source.localeCompare(b.source));
}
