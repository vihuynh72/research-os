// Plain-language names for node types and relations, shared by the map, the panels and docs.
import type { NodeType } from "./types.ts";

export const TYPE_NAME: Record<NodeType, { one: string; many: string }> = {
  Disease: { one: "disease", many: "diseases" },
  Gene: { one: "gene", many: "genes" },
  Variant: { one: "variant", many: "variants" },
  Mechanism: { one: "mechanism", many: "mechanisms" },
  Phenotype: { one: "symptom", many: "symptoms" },
  PatientOrg: { one: "patient group", many: "patient groups" },
  Paper: { one: "paper", many: "papers" },
  Trial: { one: "clinical study", many: "clinical studies" },
  Grant: { one: "research grant", many: "research grants" },
  Investigator: { one: "researcher", many: "researchers" },
  Asset: { one: "registry or asset", many: "registries and assets" },
};

export function countLabel(type: NodeType, n: number): string {
  return `${n} ${n === 1 ? TYPE_NAME[type].one : TYPE_NAME[type].many}`;
}

const RELATION: Record<string, string> = {
  causes: "causes",
  has_phenotype: "has symptom",
  variant_of: "is a variant in",
  disrupts_process: "disrupts",
  has_mechanism: "involves",
  in_pathway: "is in pathway",
  studies: "studies",
  about: "is about",
  mentions: "mentions",
  funds: "funds",
  works_on: "works on",
  registers: "registers",
  investigates: "leads",
  supports: "supports",
  offers: "offers",
  similar_to: "shares biology with",
};

export function relationLabel(type: string): string {
  return RELATION[type] ?? type.replace(/_/g, " ");
}
