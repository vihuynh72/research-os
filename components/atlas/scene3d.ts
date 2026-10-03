// What the 3D view draws, built from the same neighborhood, layout and filtering as the 2D map, so
// the two always agree. After a search the knowledge graph lies on a disc: each node keeps its 2D
// place (distance = relevance, direction = kind) and each kind of thing gets its own height
// (SECTOR_DEPTH), so seen from straight above the disc is the 2D map. Before a search it is the
// constellation of every disease at its similarity position (coords3d).
import type { HoodEdge, HoodNode, Neighborhood, ThresholdResult } from "../../lib/graph/neighborhood.ts";
import { SECTORS, SECTOR_DEPTH, radialLayout, ringRadius, sectorOf, type RadialNode } from "../../lib/viz/radialLayout.ts";
import { ICON_PATH } from "../../lib/viz/icons.ts";
import { shortLabel } from "../../lib/graph/labels.ts";
import { TYPE_NAME } from "../../lib/graph/vocab.ts";
import type { NodeType } from "../../lib/graph/types.ts";
import type { Graph3DLink, Graph3DNode, Graph3DRing, Graph3DSector } from "./Graph3D";
import { KIND_OF, KIND_STYLE } from "./kinds.ts";
import { TIER_WORD, clusterOf, diseaseColor, formatPercent, type AtlasModel } from "./format.ts";

export interface Scene3D {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
  rings: Graph3DRing[];
  sectors: Graph3DSector[];
}

// The 2D map's canvas and node sizes (components/atlas/KnowledgeGraph.tsx), so both views lay out
// the same neighborhood identically.
const W = 1200;
const H = 840;
const DOT = 0.78; // 3D dots a little smaller than the 2D ones: perspective makes the near ones grow

export function mapNodeRadius(n: HoodNode, centrality: number): number {
  if (n.role === "focus") return 30;
  if (n.type === "Disease") return 17 + 7 * centrality;
  if (n.role === "bubble") return 15;
  if (n.role === "symptom") return 11;
  return 13;
}

const typeOf = (n: HoodNode): NodeType => (n.type === "Bubble" ? n.bubbleType! : n.type);
const truncate = (label: string, max = 26) => (label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`);

function typeName(n: HoodNode): string {
  return n.type === "Bubble" ? `${TYPE_NAME[n.bubbleType!].many}, folded` : TYPE_NAME[n.type].one;
}

export function neighborhoodScene(model: AtlasModel, hood: Neighborhood, filtered: ThresholdResult, threshold: number, selectedId: string | null): Scene3D {
  const centrality = (id: string) => model.relevance.diseases[id]?.centrality ?? 0;
  const radial: RadialNode[] = hood.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    bubbleType: n.bubbleType,
    role: n.role,
    relevance: n.relevance,
    ownerRank: n.ownerRank,
    radius: mapNodeRadius(n, centrality(n.id)) + 2,
    cluster: n.cluster ?? null,
  }));
  const { positions, geometry } = radialLayout(radial, hood.focus, W, H);
  // One scale for the whole neighborhood (the outer ring plus the room a crowded sector can push a
  // node), so moving the relevance bar only shows and hides dots.
  const scale = geometry.outer + 40;
  const coordsOf = (n: HoodNode): [number, number, number] => {
    const p = positions.get(n.id) ?? [geometry.cx, geometry.cy];
    const height = n.role === "focus" ? 0 : SECTOR_DEPTH[sectorOf(typeOf(n))];
    return [(p[0] - geometry.cx) / scale, height / scale, (p[1] - geometry.cy) / scale];
  };

  const ghosts = new Set(filtered.ghosts.map((n) => n.id));
  const nodes: Graph3DNode[] = [...filtered.nodes, ...filtered.ghosts].map((n) => {
    const type = typeOf(n);
    const kind = KIND_STYLE[KIND_OF[type]];
    const isDisease = n.type === "Disease";
    const isFocus = n.role === "focus";
    const isBubble = n.role === "bubble";
    const ghost = ghosts.has(n.id);
    const c = centrality(n.id);
    const synonyms = model.index.byId.get(n.id)?.synonyms;
    return {
      id: n.id,
      label: n.label,
      shortLabel: isDisease ? shortLabel({ label: n.label, synonyms }) : truncate(isBubble ? n.label.replace(/^\d+ /, "") : n.label),
      coords: coordsOf(n),
      color: isDisease ? diseaseColor(model, n.id) : kind.fill,
      ink: isDisease ? undefined : kind.ink,
      icon: isDisease || isBubble ? undefined : ICON_PATH[type],
      count: isBubble ? (n.members?.length ?? 0) : undefined,
      size: c,
      radius: mapNodeRadius(n, c) * DOT,
      emphasis: isFocus ? "focus" : "neighbor",
      alpha: isFocus ? 1 : ghost ? 0.28 : 0.6 + 0.4 * n.relevance,
      ghost,
      labelled: isFocus || (isDisease && !ghost) || n.id === selectedId,
      tierLabel: isDisease && !isFocus ? `${n.tier && n.tier !== "none" ? `${TIER_WORD[n.tier]} · ` : ""}${formatPercent(n.relevance)}` : undefined,
      detail: isFocus
        ? `${typeName(n)} · what you searched`
        : `${typeName(n)} · ${formatPercent(n.relevance)} relevant${n.kind ? ` · ${n.kind}` : ""}${ghost ? " · under your filter" : ""}`,
      hint: isBubble ? "Click to show them" : isFocus ? undefined : "Click for the evidence · double-click to center here",
    };
  });

  // Line styles follow the 2D map: disease-to-disease lines carry the story (accent, width and
  // glow by relevance), evidence lines stay thin and neutral, existing collaboration is a dashed arc.
  const lineOf = (e: HoodEdge, faint: boolean): Graph3DLink => {
    const r = e.relevance;
    const base = { a: e.a, b: e.b, strength: e.strength, emphasis: e.id === selectedId ? ("selected" as const) : ("normal" as const) };
    const dim = faint ? 0.3 : 1;
    switch (e.role) {
      case "similarity":
        return { ...base, color: "var(--accent)", width: 1 + 5 * r * r, alpha: (0.22 + 0.78 * r) * dim, dashed: e.kind !== "observed", glow: !faint && r >= 0.75 ? 1.5 + (3 * (r - 0.75)) / 0.25 : 0 };
      case "bridge":
        return { ...base, color: "var(--ink-2)", width: 1.4, alpha: 0.85 * dim, dashed: true, dash: [3, 5] };
      default:
        return { ...base, color: "var(--ink-3)", width: 0.6 + 1.4 * r * r, alpha: (0.16 + 0.5 * r) * dim, dashed: e.kind !== "observed" };
    }
  };
  const links = [...filtered.faintEdges.map((e) => lineOf(e, true)), ...filtered.edges.map((e) => lineOf(e, false))];

  const rings: Graph3DRing[] = [
    ...[0.75, 0.45, 0.2].map((t): Graph3DRing => ({ r: ringRadius(geometry, t) / scale, kind: "tier" })),
    { r: ringRadius(geometry, threshold) / scale, kind: "filter", label: `${formatPercent(threshold)} filter` },
  ];
  const sectors: Graph3DSector[] = SECTORS.map((s) => ({ label: s.label, angle: (((s.start + s.end) / 2) * Math.PI) / 180 }));
  return { nodes, links, rings, sectors };
}

export function constellationScene(model: AtlasModel): Scene3D {
  const diseases = model.index.diseases.filter((d) => model.relevance.diseases[d.id]);
  // Small atlases get names on the dots; big ones rely on hover, as on the 2D constellation.
  const named = diseases.length <= 30;
  const nodes: Graph3DNode[] = diseases.map((d) => {
    const entry = model.relevance.diseases[d.id];
    const cluster = clusterOf(model, d.id);
    return {
      id: d.id,
      label: d.label,
      shortLabel: shortLabel(d),
      coords: entry.coords3d,
      color: diseaseColor(model, d.id),
      size: entry.centrality,
      emphasis: "neighbor",
      labelled: named,
      detail: cluster ? cluster.label : "Not in a cluster",
      hint: "Click to map it",
    };
  });
  const links: Graph3DLink[] = model.relevance.pairs
    .filter((p) => p.tier === "strong" || p.tier === "moderate")
    .map((p) => ({ a: p.a, b: p.b, strength: p.relevance, dashed: false, emphasis: "normal", color: "var(--node-gray)", alpha: 0.18 + 0.3 * p.relevance, width: 0.8 + p.relevance }));
  return { nodes, links, rings: [], sectors: [] };
}
