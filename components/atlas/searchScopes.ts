// What the search box can be narrowed to. Scopes follow the map's node families, so the chip
// colors match the nodes a result will appear as.
import type { NodeType } from "@/lib/graph/types";
import { ICON_PATH } from "@/lib/viz/icons";
import type { Kind } from "./kinds";

export type ScopeId = "all" | "diseases" | "genes" | "symptoms" | "groups" | "research";

export interface SearchScope {
  id: ScopeId;
  label: string;
  hint: string; // placeholder start, e.g. "Search symptoms"
  types: readonly NodeType[]; // empty = every type
  icon: string; // 24x24 stroke path
  kind: Kind | null;
}

const ALL_ICON = "M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z";

export const SEARCH_SCOPES: readonly SearchScope[] = [
  { id: "all", label: "All", hint: "Search a disease, gene or symptom", types: [], icon: ALL_ICON, kind: null },
  { id: "diseases", label: "Diseases", hint: "Search diseases", types: ["Disease"], icon: ICON_PATH.Disease, kind: "disease" },
  { id: "genes", label: "Genes", hint: "Search genes, gene changes or pathways", types: ["Gene", "Variant", "Mechanism"], icon: ICON_PATH.Gene, kind: "biology" },
  { id: "symptoms", label: "Symptoms", hint: "Search symptoms", types: ["Phenotype"], icon: ICON_PATH.Phenotype, kind: "clinical" },
  { id: "groups", label: "Groups", hint: "Search patient groups or registries", types: ["PatientOrg", "Asset"], icon: ICON_PATH.PatientOrg, kind: "community" },
  { id: "research", label: "Research", hint: "Search studies, papers, grants or researchers", types: ["Trial", "Paper", "Grant", "Investigator"], icon: ICON_PATH.Trial, kind: "research" },
];
