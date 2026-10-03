// Pure scene adapters shared by the 3D view and its regression tests.
import type { Neighborhood, ThresholdResult } from "../../lib/graph/neighborhood.ts";
import { shortLabel } from "../../lib/graph/labels.ts";
import { forceLayout, toUnitSphere } from "../../lib/viz/forceLayout.ts";
import { KIND_OF, KIND_STYLE } from "./kinds.ts";
import type { AtlasModel } from "./format";
import type { Graph3DLink, Graph3DNode } from "./Graph3D";

export interface Scene3D {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
}

function colorFor(model: AtlasModel, id: string): string {
  const cluster = model.relevance.diseases[id]?.cluster;
  const slot = cluster ? model.clusters.get(cluster)?.color_slot : null;
  return slot ? `var(--series-${slot})` : "var(--node-gray)";
}

export function constellationScene(model: AtlasModel): Scene3D {
  return {
    nodes: model.index.diseases.map((node, index) => ({
      id: node.id,
      label: node.label,
      shortLabel: shortLabel(node),
      coords: model.relevance.diseases[node.id]?.coords3d ?? [
        Math.cos(index * 2.399963) * 0.7,
        Math.sin(index * 2.399963) * 0.7,
        model.index.diseases.length > 1 ? index / (model.index.diseases.length - 1) * 2 - 1 : 0,
      ],
      color: colorFor(model, node.id),
      size: model.relevance.diseases[node.id]?.centrality ?? 0,
      emphasis: "context",
    })),
    links: [],
  };
}

export function neighborhoodScene(model: AtlasModel, hood: Neighborhood, filtered: ThresholdResult, selectedId: string | null): Scene3D {
  const positions = toUnitSphere(forceLayout(
    filtered.nodes.map((node) => ({
      id: node.id,
      type: node.type === "Bubble" ? node.bubbleType ?? node.type : node.type,
      role: node.role,
      hop: node.hop,
      relevance: node.relevance,
      radius: node.role === "focus" ? 18 : 8,
      group: node.cluster,
    })),
    filtered.edges,
    { dims: 3 },
  ), hood.focus);
  const visible = new Set(filtered.nodes.map((node) => node.id));
  return {
    nodes: filtered.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      shortLabel: model.index.byId.has(node.id) ? shortLabel(model.index.byId.get(node.id)!) : node.label,
      coords: positions.get(node.id) ?? [0, 0, 0],
      color: node.type === "Disease" ? colorFor(model, node.id) : KIND_STYLE[KIND_OF[node.type === "Bubble" ? node.bubbleType ?? "Phenotype" : node.type]].ink,
      size: node.role === "focus" ? 1 : node.relevance,
      emphasis: node.role === "focus" ? "focus" : "neighbor",
      tierLabel: node.tier,
    })),
    links: [...filtered.edges, ...filtered.faintEdges]
      .filter((edge) => visible.has(edge.a) && visible.has(edge.b))
      .map((edge) => ({
        a: edge.a,
        b: edge.b,
        strength: edge.strength,
        dashed: edge.kind !== "observed",
        emphasis: selectedId && (edge.a === selectedId || edge.b === selectedId) ? "selected" : "normal",
      })),
  };
}

export type { HoodNode } from "../../lib/graph/neighborhood.ts";