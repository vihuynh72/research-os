// What the 3D view draws, built from the same neighborhood, layout, node sizes, line styles and
// label budget as the 2D map, so the two always agree. After a search the knowledge graph lies on
// a disc: each node keeps its 2D place (distance = relevance, direction = kind) and each kind of
// thing gets its own height (SECTOR_DEPTH), so seen from straight above the disc is the 2D map.
// Before a search it is the constellation of every disease at its similarity position (coords3d).
import { type HoodEdge, type HoodNode, type Neighborhood, type ThresholdResult } from "../../lib/graph/neighborhood.ts";
import { SECTORS, radialLayout, ringRadius, sectorOf, type RadialNode, type SectorId } from "../../lib/viz/radialLayout.ts";
import { ICON_PATH } from "../../lib/viz/icons.ts";
import { separate } from "../../lib/viz/project3d.ts";
import { sentenceLabel } from "../../lib/graph/labels.ts";
import { TYPE_NAME } from "../../lib/graph/vocab.ts";
import type { NodeType } from "../../lib/graph/types.ts";
import type { Graph3DLink, Graph3DNode, Graph3DRing, Graph3DSector } from "./Graph3D";
import { KIND_OF, KIND_STYLE } from "./kinds.ts";
import { clusterName, clusterOf, clusterRows, diseaseColor, formatPercent, tierWord, type AtlasModel, type Mode } from "./format.ts";
import { nodeBadge } from "./evidence.ts";
import { mapLines } from "./map/mapName.ts";
import { crowdedDiseases, isTopRelated, mapNodeRadius } from "./mapSizes.ts";
import { labelPlan, topRelatedIds } from "./map/labelBudget.ts";
import { lineStyle } from "./map/lineStyle.ts";

export interface Scene3D {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
  rings: Graph3DRing[];
  sectors: Graph3DSector[];
}

// The 2D map's canvas (components/atlas/KnowledgeGraph.tsx), so both views lay out the same
// neighborhood identically.
const W = 1200;
const H = 840;
// The height each kind of thing floats at above (or below) the diseases' plane, in the 2D map's
// units: tilting the disc then shows the kind twice, by direction and by height.
const SECTOR_DEPTH: Record<SectorId, number> = { diseases: 0, research: -60, community: 45, symptoms: 70, biology: -80 };
const DOT = 0.78; // 3D dots a little smaller than the 2D ones: perspective makes the near ones grow
const CLOUD_GAP = 0.11; // closest two dots of the constellation may sit, in unit-sphere units
const ONE_LINE = 26; // characters of a name per label line, as on the 2D map
const CLOUD_NAMES = 8; // constellation labels: the colored groups, named at their most central disease
const DEFAULT_CUTOFFS = { strong: 0.75, moderate: 0.45, exploratory: 0.2 };

const typeOf = (n: HoodNode): NodeType => (n.type === "Bubble" ? n.bubbleType! : n.type);

// A map name in sentence case, wrapped like the 2D map's (map/mapName.ts), lines joined with "\n".
function mapName(name: string, lines: number, sentence = true): string {
  const wrapped = mapLines(name, ONE_LINE, lines);
  return (sentence ? [sentenceLabel(wrapped[0]), ...wrapped.slice(1)] : wrapped).join("\n");
}

export function neighborhoodScene(
  model: AtlasModel,
  hood: Neighborhood,
  filtered: ThresholdResult,
  threshold: number,
  selectedId: string | null,
  mode: Mode = "parent",
): Scene3D {
  const centrality = (id: string) => model.relevance.diseases[id]?.centrality ?? 0;
  const crowded = crowdedDiseases(hood);
  const radial: RadialNode[] = hood.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    bubbleType: n.bubbleType,
    role: n.role,
    relevance: n.relevance,
    ownerRank: n.ownerRank,
    // The same room as on the 2D map: the five most related keep space around them for their names.
    radius: mapNodeRadius(n, centrality(n.id), crowded) + (isTopRelated(n) ? 16 : 3),
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

  // As on the 2D map: the five most related diseases carry their grade, and only the names in the
  // label budget are printed; every other name shows on hover and selection.
  const top = topRelatedIds(filtered.nodes);
  const named = new Set(labelPlan(filtered.nodes, mode));
  const focusNode = hood.nodes.find((n) => n.role === "focus");
  const focusName = focusNode ? sentenceLabel(focusNode.label) : "";
  const tierText = (n: HoodNode) => (n.tier && n.tier !== "none" ? `${tierWord(n.tier)} · ${formatPercent(n.relevance)}` : formatPercent(n.relevance));

  const ghosts = new Set(filtered.ghosts.map((n) => n.id));
  const nodes: Graph3DNode[] = [...filtered.nodes, ...filtered.ghosts].map((n) => {
    const type = typeOf(n);
    const kind = KIND_STYLE[KIND_OF[type]];
    const isDisease = n.type === "Disease";
    const isFocus = n.role === "focus";
    const isBubble = n.role === "bubble";
    const ghost = ghosts.has(n.id);
    const emphasized = isFocus || n.role === "anchor" || isTopRelated(n);
    const c = centrality(n.id);
    // A bubble's name and reason come from the filter (applyThreshold): what it holds at this filter.
    const count = isBubble ? (filtered.bubbleCount[n.id] ?? n.members?.length ?? 0) : undefined;
    const typeName = sentenceLabel(TYPE_NAME[type].one);
    const badge = isFocus || isBubble ? null : nodeBadge(hood, n.id, model.edgeById);
    const where = n.role === "related" ? `${tierText(n)} related to ${focusName}` : `${formatPercent(n.relevance)} relevant`;
    return {
      id: n.id,
      label: n.label,
      shortLabel: mapName(n.label, isDisease || isFocus ? 4 : 3, !isBubble),
      coords: coordsOf(n),
      // The searched node is a calm white disc ringed in the accent, with its kind's icon.
      color: isFocus ? "var(--surface)" : isDisease ? diseaseColor(model, n.id) : kind.fill,
      ink: isFocus ? "var(--accent)" : isDisease ? undefined : kind.ink,
      icon: isFocus || (!isDisease && !isBubble) ? ICON_PATH[type] : undefined,
      count,
      size: c,
      radius: mapNodeRadius(n, c, crowded) * DOT,
      emphasis: isFocus ? "focus" : "neighbor",
      // Opacity as on the 2D map: the emphasized marks solid, other diseases quieter, ghosts faint.
      alpha: isFocus ? 1 : ghost ? 0.25 : emphasized ? 1 : isDisease ? 0.62 : 0.92,
      ghost,
      labelled: named.has(n.id) || n.id === selectedId,
      strong: emphasized || top.has(n.id),
      tierLabel: top.has(n.id) ? tierText(n) : undefined,
      detail: isFocus
        ? `${typeName} · what you searched`
        : isBubble
          ? n.why
          : `${typeName} · ${where}${badge ? ` · ${badge.label}` : ""}${ghost ? " · under your filter" : ""}`,
      hint: isBubble ? "Click to show them" : isFocus ? "Click for details" : "Click for details · double-click to center here",
    };
  });

  // Line styles are the 2D map's (map/lineStyle.ts): disease-to-disease lines in the accent, their
  // width by tier and a glow when strong; evidence lines thin and neutral; dashed means inferred.
  const cutoffs = model.relevance.meta.thresholds ?? DEFAULT_CUTOFFS;
  const lineOf = (e: HoodEdge, faint: boolean): Graph3DLink => {
    const style = lineStyle(e, cutoffs, faint);
    return {
      a: e.a,
      b: e.b,
      strength: e.strength,
      emphasis: e.id === selectedId ? "selected" : "normal",
      color: style.color,
      width: style.width,
      alpha: style.opacity,
      dashed: !!style.dash,
      dash: style.dash ? style.dash.split(" ").map(Number) : undefined,
      glow: style.glow ? 2 : 0,
    };
  };
  const links = [...filtered.faintEdges.map((e) => lineOf(e, true)), ...filtered.edges.map((e) => lineOf(e, false))];

  // The tier rings at the grade file's cutoffs and the dashed filter ring, as on the 2D map.
  const rings: Graph3DRing[] = [
    ...[cutoffs.strong, cutoffs.moderate, cutoffs.exploratory].filter((t) => t > 0 && t < 1).map((t): Graph3DRing => ({ r: ringRadius(geometry, t) / scale, kind: "tier" })),
    { r: ringRadius(geometry, threshold) / scale, kind: "filter", label: `≥ ${formatPercent(threshold)}` },
  ];
  // Only the directions that hold something are named.
  const used = new Set(filtered.nodes.filter((n) => n.role !== "focus").map((n) => sectorOf(typeOf(n))));
  const sectors: Graph3DSector[] = SECTORS.filter((s) => used.has(s.id)).map((s) => ({ label: s.label, angle: (((s.start + s.end) / 2) * Math.PI) / 180 }));
  return { nodes, links, rings, sectors };
}

export function constellationScene(model: AtlasModel): Scene3D {
  const diseases = model.index.diseases.filter((d) => model.relevance.diseases[d.id]);
  // A calm sky names few things: each colored group, as on the 2D universe ("COL2A1 · 12"), at its
  // most central disease; that disease's own name shows on hover.
  const groups = new Map(
    clusterRows(model)
      .filter((row) => row.lead && row.color !== "var(--node-gray)")
      .slice(0, CLOUD_NAMES)
      .map((row) => [row.lead!, `${row.short} · ${row.size}`]),
  );
  // Diseases that share no biology all sit at the middle of the similarity layout: spread them so
  // every dot can be seen and pointed at, each staying near its place.
  const spread = separate(
    diseases.map((d) => model.relevance.diseases[d.id].coords3d),
    CLOUD_GAP,
    { min: [-1, -1, -1], max: [1, 1, 1] },
  );
  const nodes: Graph3DNode[] = diseases.map((d, i) => {
    const entry = model.relevance.diseases[d.id];
    const cluster = clusterOf(model, d.id);
    const group = groups.get(d.id);
    const lead = group !== undefined;
    return {
      id: d.id,
      label: d.label,
      shortLabel: group ? mapName(group, 2, false) : mapName(d.label, 4),
      coords: [spread[i][0], spread[i][1], spread[i][2]],
      color: diseaseColor(model, d.id),
      size: entry.centrality,
      radius: (lead ? 5 : 3.5) + 3 * entry.centrality,
      emphasis: "neighbor",
      labelled: lead,
      strong: lead,
      detail: cluster ? clusterName(cluster) : "Not in a group yet",
      hint: "Click to center it",
    };
  });
  const links: Graph3DLink[] = model.relevance.pairs
    .filter((p) => p.tier === "strong" || p.tier === "moderate")
    .map((p) => ({ a: p.a, b: p.b, strength: p.relevance, dashed: false, emphasis: "normal", color: "var(--node-gray)", alpha: 0.18 + 0.3 * p.relevance, width: 0.8 + p.relevance }));
  return { nodes, links, rings: [], sectors: [] };
}
