// Types for graph.json. They mirror schema.json (DRAFT 0.1.0); change both together.
// Files under lib/ are also run directly by Node (scripts/*.ts), so they use
// relative imports with a .ts extension and only erasable TypeScript syntax.

export const NODE_TYPES = [
  "Disease",
  "Gene",
  "Variant",
  "Mechanism",
  "Phenotype",
  "PatientOrg",
  "Paper",
  "Trial",
  "Grant",
  "Investigator",
  "Asset",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// observed: stated by a curated source. inferred: derived by our pipeline or a model (drawn dashed).
// contradicted: disputed by a source (shown in its own block, never used to score).
export type EdgeKind = "observed" | "inferred" | "contradicted";

export interface GraphMeta {
  schema_version: "0.1.0";
  generated_at: string;
  slice?: string;
  notes?: string;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  synonyms?: string[];
  description?: string;
  source: string;
  url: string;
  cluster?: string;
  centrality?: number;
  bridge?: boolean;
  attributes?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: string;
  subject: string;
  object: string;
  source: string;
  url: string;
  date: string;
  confidence: number;
  kind: EdgeKind;
  evidence?: string;
  pmid?: string;
}

export interface GraphCluster {
  id: string;
  label: string;
  description?: string;
  size?: number;
}

export interface AtlasGraph {
  meta: GraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters?: GraphCluster[];
}
