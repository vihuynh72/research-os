// Turns the atlas model into the nodes and links Graph3D draws.
// The opening view is a cloud of diseases. A search puts the focus at the
// center and places each kind of neighbor on its own side.

import type { NodeType } from "@/lib/graph/types";
import type { HoodNode, Neighborhood, ThresholdResult } from "@/lib/graph/neighborhood";
import type { Graph3DLink, Graph3DNode } from "./Graph3D";
import { KIND_OF, KIND_STYLE } from "./kinds";
import { diseaseColor, nodeName, type AtlasModel } from "./format";

export interface Scene3D {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
}

const SIDES: Partial<Record<NodeType, [number, number, number]>> = {
  Gene: [1, 0.35, 0],
  Variant: [0.7, 0.7, 0.2],
  Mechanism: [0.2, 1, 0],
  Phenotype: [-1, 0.2, 0],
  PatientOrg: [-0.3, -0.8, 0.4],
  Asset: [-0.7, -0.5, 0.2],
  Trial: [0.2, -1, 0],
  Paper: [0.8, -0.4, 0.3],
  Grant: [0.4, -0.7, -0.3],
  Investigator: [-0.2, -0.2, 1],
};

function place(index: number, total: number, side: [number, number, number], relevance: number): [number, number, number] {
  const turn = (index / Math.max(1, total)) * Math.PI * 2;
  const radius = 0.35 + (1 - Math.min(1, Math.max(0, relevance))) * 0.65;
  return [
    side[0] * radius + Math.cos(turn) * 0.12,
    side[1] * radius + Math.sin(turn) * 0.12,
    side[2] * radius,
  ];
}

export function constellationScene(model: AtlasModel): Scene3D {
  const diseases = model.index.diseases;
  const nodes = diseases.map((disease, index): Graph3DNode => {
    const turn = (index / Math.max(1, diseases.length)) * Math.PI * 2;
    const lift = ((index % 5) - 2) * 0.18;
    return {
      id: disease.id,
      label: disease.label,
      shortLabel: nodeName(disease, 28),
      coords: [Math.cos(turn), lift, Math.sin(turn)],
      color: diseaseColor(model, disease.id),
      size: 0.55,
      emphasis: "context",
    };
  });
  return { nodes, links: [] };
}

export function neighborhoodScene(
  model: AtlasModel,
  hood: Neighborhood,
  filtered: ThresholdResult,
  selectedId: string | null,
): Scene3D {
  const visible = new Map(filtered.nodes.map((node) => [node.id, node]));
  const counts = new Map<string, number>();
  for (const node of filtered.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  const seen = new Map<string, number>();
  const nodes = filtered.nodes.map((node): Graph3DNode => {
    const order = seen.get(node.type) ?? 0;
    seen.set(node.type, order + 1);
    const type = node.type === "Bubble" ? node.bubbleType ?? "Phenotype" : node.type;
    const side = node.id === hood.focus ? [0, 0, 0] as [number, number, number] : SIDES[type] ?? [0, 1, 0];
    const graphNode = model.index.byId.get(node.id);
    return {
      id: node.id,
      label: node.label,
      shortLabel: graphNode ? nodeName(graphNode, 28) : node.label,
      coords: node.id === hood.focus ? [0, 0, 0] : place(order, counts.get(node.type) ?? 1, side, node.relevance),
      color: node.type === "Disease" ? diseaseColor(model, node.id) : KIND_STYLE[KIND_OF[type]].ink,
      size: node.id === hood.focus ? 1 : 0.35 + node.relevance * 0.45,
      emphasis: node.id === hood.focus ? "focus" : "neighbor",
      tierLabel: node.tier,
    };
  });
  const links = [...filtered.edges, ...filtered.faintEdges]
    .filter((link) => visible.has(link.a) && visible.has(link.b))
    .map((link): Graph3DLink => ({
      a: link.a,
      b: link.b,
      strength: link.strength,
      dashed: link.kind !== "observed",
      emphasis: selectedId && (link.a === selectedId || link.b === selectedId) ? "selected" : "normal",
    }));
  return { nodes, links };
}

export type { HoodNode };
