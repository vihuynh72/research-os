// Node kinds for color: diseases are the big, saturated nodes (their cluster color); everything else
// is a pale tint with a darker icon by family, so the map reads as "diseases first, evidence second".
// Four families, not eleven types: color stays readable and every node also carries its type icon.
import { NODE_TYPES, type NodeType } from "../../lib/graph/types.ts";

export type Kind = "disease" | "biology" | "clinical" | "community" | "research";

export const KIND_OF: Record<NodeType, Kind> = {
  Disease: "disease",
  Gene: "biology",
  Variant: "biology",
  Mechanism: "biology",
  Phenotype: "clinical",
  PatientOrg: "community",
  Asset: "community",
  Trial: "research",
  Paper: "research",
  Grant: "research",
  Investigator: "research",
};

export const KIND_STYLE: Record<Kind, { fill: string; ink: string; label: string }> = {
  disease: { fill: "var(--node-gray)", ink: "var(--ink)", label: "Diseases" },
  biology: { fill: "var(--kind-bio-fill)", ink: "var(--kind-bio-ink)", label: "Genes and pathways" },
  clinical: { fill: "var(--kind-clin-fill)", ink: "var(--kind-clin-ink)", label: "Symptoms" },
  community: { fill: "var(--kind-comm-fill)", ink: "var(--kind-comm-ink)", label: "Groups and registries" },
  research: { fill: "var(--kind-res-fill)", ink: "var(--kind-res-ink)", label: "Research" },
};

// The six kinds a person filters the map by (the chips above the map, and the legend's swatches):
// genes and pathways share a color but not an icon, so they get a chip each.
export type MapKind = "disease" | "gene" | "pathway" | "symptom" | "group" | "research";

export interface MapKindInfo {
  id: MapKind;
  label: string;
  types: readonly NodeType[];
  style: Kind;
  icon: NodeType;
}

export const MAP_KINDS: readonly MapKindInfo[] = [
  { id: "disease", label: "Diseases", types: ["Disease"], style: "disease", icon: "Disease" },
  { id: "gene", label: "Genes", types: ["Gene", "Variant"], style: "biology", icon: "Gene" },
  { id: "pathway", label: "Pathways", types: ["Mechanism"], style: "biology", icon: "Mechanism" },
  { id: "symptom", label: "Symptoms", types: ["Phenotype"], style: "clinical", icon: "Phenotype" },
  { id: "group", label: "Groups", types: ["PatientOrg", "Asset"], style: "community", icon: "PatientOrg" },
  { id: "research", label: "Research", types: ["Paper", "Grant", "Trial", "Investigator"], style: "research", icon: "Paper" },
];

export interface KindCount {
  kind: MapKindInfo;
  shown: number;
  total: number;
}

// Shown / total per kind at the current filter, for the kinds this map has at all.
export function kindCounts(byType: Partial<Record<NodeType, { shown: number; total: number }>>): KindCount[] {
  return MAP_KINDS.flatMap((kind) => {
    const rows = kind.types.flatMap((t) => byType[t] ?? []);
    const total = rows.reduce((n, r) => n + r.total, 0);
    return total ? [{ kind, shown: rows.reduce((n, r) => n + r.shown, 0), total }] : [];
  });
}

// A kind is off when every one of its types is hidden (the address keeps type names: hide=Gene,Variant).
export function kindHidden(kind: MapKindInfo, hidden: ReadonlySet<NodeType>): boolean {
  return kind.types.every((t) => hidden.has(t));
}

export function toggleKind(hidden: ReadonlySet<NodeType>, kind: MapKindInfo): Set<NodeType> {
  const next = new Set(hidden);
  const off = kindHidden(kind, hidden);
  for (const t of kind.types) {
    if (off) next.delete(t);
    else next.add(t);
  }
  return next;
}

// Only this kind (what was searched always stays).
export function onlyKind(kind: MapKindInfo): Set<NodeType> {
  return new Set(NODE_TYPES.filter((t) => !kind.types.includes(t)));
}
