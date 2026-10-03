// Node kinds for color: diseases are the big, saturated nodes (their cluster color); everything else
// is a pale tint with a darker icon by family, so the map reads as "diseases first, evidence second".
// Four families, not eleven types: color stays readable and every node also carries its type icon.
import type { NodeType } from "@/lib/graph/types";

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
  biology: { fill: "var(--kind-bio-fill)", ink: "var(--kind-bio-ink)", label: "Genes and mechanisms" },
  clinical: { fill: "var(--kind-clin-fill)", ink: "var(--kind-clin-ink)", label: "Symptoms" },
  community: { fill: "var(--kind-comm-fill)", ink: "var(--kind-comm-ink)", label: "Groups and registries" },
  research: { fill: "var(--kind-res-fill)", ink: "var(--kind-res-ink)", label: "Research" },
};

export const KIND_ORDER: Kind[] = ["disease", "biology", "clinical", "community", "research"];
