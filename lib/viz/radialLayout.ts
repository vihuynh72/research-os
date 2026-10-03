// Rings and sectors: on this map placement means something. Distance from the center is relevance to
// what was searched (100% on the inner ring, 0% on the outer one), and direction is what kind of thing
// a node is: diseases at the top, research at the upper right, groups and registries at the lower
// right, symptoms at the bottom, genes and mechanisms on the left. Inside a sector, a related disease's
// own evidence sits together. Deterministic: overlaps are resolved by sliding a node along its ring
// inside its sector, and a node is pushed outward only when its sector is full there.
import type { NodeType } from "../graph/types.ts";

export type SectorId = "diseases" | "research" | "community" | "symptoms" | "biology";

export interface Sector {
  id: SectorId;
  label: string;
  start: number; // degrees, 0 = right, growing clockwise (SVG y points down)
  end: number;
}

export const SECTORS: readonly Sector[] = [
  { id: "diseases", label: "Diseases", start: -150, end: -30 },
  { id: "research", label: "Research", start: -30, end: 18 },
  { id: "community", label: "Groups and registries", start: 18, end: 66 },
  { id: "symptoms", label: "Symptoms", start: 66, end: 150 },
  { id: "biology", label: "Genes and mechanisms", start: 150, end: 210 },
];

export function sectorOf(type: NodeType): SectorId {
  switch (type) {
    case "Disease":
      return "diseases";
    case "Trial":
    case "Paper":
    case "Grant":
    case "Investigator":
      return "research";
    case "PatientOrg":
    case "Asset":
      return "community";
    case "Phenotype":
      return "symptoms";
    default:
      return "biology";
  }
}

export interface RadialNode {
  id: string;
  type: NodeType | "Bubble";
  bubbleType?: NodeType;
  role: string;
  relevance: number;
  ownerRank: number;
  radius: number; // drawn size, for collisions
  cluster?: string | null;
}

export interface RadialGeometry {
  cx: number;
  cy: number;
  inner: number; // ring of 100% relevance
  outer: number; // ring of 0% relevance
}

// Most of what matters sits between 70% and 100%, so the scale spends more room there: distance grows
// with (1 - relevance) to a power below 1. Order is preserved, so closer still means more relevant.
const RING_GAMMA = 0.6;

export function ringRadius(geometry: RadialGeometry, relevance: number): number {
  const r = Math.max(0, Math.min(1, relevance));
  return geometry.inner + Math.pow(1 - r, RING_GAMMA) * (geometry.outer - geometry.inner);
}

export function geometryFor(width: number, height: number): RadialGeometry {
  const outer = Math.min(width, height) / 2 - 56;
  return { cx: width / 2, cy: height / 2 + 8, inner: Math.max(92, outer * 0.26), outer };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const GAP = 8;
const STEP = (2.5 * Math.PI) / 180;

export function radialLayout(
  nodes: readonly RadialNode[],
  focusId: string,
  width: number,
  height: number,
): { positions: Map<string, [number, number]>; geometry: RadialGeometry } {
  const g = geometryFor(width, height);
  const positions = new Map<string, [number, number]>();
  const placed: { x: number; y: number; r: number }[] = [];
  const focus = nodes.find((n) => n.id === focusId);
  positions.set(focusId, [g.cx, g.cy]);
  placed.push({ x: g.cx, y: g.cy, r: focus?.radius ?? 30 });

  const fits = (x: number, y: number, r: number) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + GAP);

  // Diseases: clusters get neighbouring sub-arcs, best cluster in the middle of the top.
  const clusterOrder = new Map<string, number>();
  const diseases = nodes
    .filter((n) => n.id !== focusId && sectorOf(n.type === "Bubble" ? n.bubbleType! : n.type) === "diseases")
    .sort((a, b) => b.relevance - a.relevance || cmp(a.id, b.id));
  for (const d of diseases) {
    const key = d.cluster ?? "~";
    if (!clusterOrder.has(key)) clusterOrder.set(key, clusterOrder.size);
  }

  for (const sector of SECTORS) {
    const members = nodes
      .filter((n) => n.id !== focusId && sectorOf(n.type === "Bubble" ? n.bubbleType! : n.type) === sector.id)
      .sort((a, b) => b.relevance - a.relevance || a.ownerRank - b.ownerRank || cmp(a.id, b.id));
    const start = (sector.start * Math.PI) / 180;
    const end = (sector.end * Math.PI) / 180;
    const span = end - start;
    const center = (start + end) / 2;
    for (const n of members) {
      // Preferred angle: owners (and, for diseases, clusters) fan out from the sector's middle.
      const slot = sector.id === "diseases" ? (clusterOrder.get(n.cluster ?? "~") ?? 0) : n.ownerRank;
      const fan = slot === 0 ? 0 : (slot % 2 === 1 ? 1 : -1) * Math.ceil(slot / 2);
      const preferred = Math.max(start, Math.min(end, center + fan * (span / 7)));
      let radius = ringRadius(g, n.relevance);
      let done = false;
      // A full sector pushes a node outward a little, never far past the outer ring.
      for (let attempt = 0; attempt < 30 && !done && radius <= g.outer + 36; attempt++) {
        const margin = Math.min(span / 2, (n.radius + GAP) / Math.max(radius, 1));
        for (let k = 0; k < 400; k++) {
          const offset = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * STEP;
          const angle = preferred + offset;
          if (angle < start + margin || angle > end - margin) {
            if (Math.abs(offset) > span) break;
            continue;
          }
          const x = g.cx + Math.cos(angle) * radius;
          const y = g.cy + Math.sin(angle) * radius;
          if (fits(x, y, n.radius)) {
            positions.set(n.id, [round2(x), round2(y)]);
            placed.push({ x, y, r: n.radius });
            done = true;
            break;
          }
        }
        if (!done) radius += (n.radius + GAP) / 2; // sector full at this ring: step outward
      }
      if (!done) {
        // Out of room: settle on the ring at the free-est angle rather than leave the canvas.
        const r = Math.min(radius, g.outer + 36);
        let bestAngle = preferred;
        let bestGap = -Infinity;
        for (let k = 0; k <= 40; k++) {
          const angle = start + (span * k) / 40;
          const x = g.cx + Math.cos(angle) * r;
          const y = g.cy + Math.sin(angle) * r;
          const gap = Math.min(...placed.map((p) => Math.hypot(p.x - x, p.y - y) - p.r));
          if (gap > bestGap) {
            bestGap = gap;
            bestAngle = angle;
          }
        }
        const x = g.cx + Math.cos(bestAngle) * r;
        const y = g.cy + Math.sin(bestAngle) * r;
        positions.set(n.id, [round2(x), round2(y)]);
        placed.push({ x, y, r: n.radius });
      }
    }
  }
  return { positions, geometry: g };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// Depth for the 3D view: each sector becomes a layer, so the rings read the same from the front.
export const SECTOR_DEPTH: Record<SectorId, number> = { diseases: 0, research: -60, community: 45, symptoms: 70, biology: -80 };
