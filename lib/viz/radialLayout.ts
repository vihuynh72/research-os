// Rings and sectors: on this map placement means something. Distance from the center is relevance to
// what was searched (100% nearest, 0% on the outer ring), and direction is what kind of thing a node
// is: diseases at the top, research at the upper right, groups and registries at the lower right,
// symptoms at the bottom, genes and mechanisms on the left. Inside a sector, a related disease's own
// evidence sits together. Deterministic.
//
// Distance stays honest when a sector is crowded. The relevance filter moves in whole percents, so
// a node stays between the ring of its own whole percent and the ring one percent above it: at
// every filter it is inside the dashed ring when shown and outside it when faint. A crowded node
// slides along that band to a free spot, and only overlaps when the band is full. Direct links
// (100%) can be many, so they get a zone of their own around the center; every other ring starts
// at the edge of that zone.
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
  inner: number; // the innermost row of direct (100%) links
  direct: number; // the ring of 100% relevance: the outer edge of the direct links' zone
  outer: number; // ring of 0% relevance
}

// Most of what matters sits between 70% and 100%, so the scale spends more room there: distance grows
// with (1 - relevance) to a power below 1. Order is preserved, so closer still means more relevant.
const RING_GAMMA = 0.6;

export function ringRadius(geometry: RadialGeometry, relevance: number): number {
  const r = Math.max(0, Math.min(1, relevance));
  const start = geometry.direct ?? geometry.inner;
  return start + Math.pow(1 - r, RING_GAMMA) * (geometry.outer - start);
}

export function geometryFor(width: number, height: number): RadialGeometry {
  const outer = Math.min(width, height) / 2 - 56;
  const inner = Math.max(92, outer * 0.26);
  return { cx: width / 2, cy: height / 2 + 8, inner, direct: inner, outer };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const GAP = 6; // clear space between two nodes
const STEP = (1.5 * Math.PI) / 180; // angle step when sliding along a ring
const RADIAL_STEP = 7; // radius step when moving inward
// The whole percent a relevance is shown at: a node of 0.7099 is shown by a 70% filter, not 71%.
export function percentBand(relevance: number): number {
  return Math.floor(relevance * 100 + 1e-6) / 100;
}
// The zone of direct links grows outward as rows are needed, up to this share of the map's depth.
const DIRECT_ZONE = 0.34;
const EPS = 1e-9;

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

  const at = (angle: number, radius: number) => [g.cx + Math.cos(angle) * radius, g.cy + Math.sin(angle) * radius] as const;
  const clearance = (x: number, y: number, r: number, gap = GAP) => Math.min(...placed.map((p) => Math.hypot(p.x - x, p.y - y) - p.r - r - gap));
  const put = (n: RadialNode, x: number, y: number) => {
    positions.set(n.id, [round2(x), round2(y)]);
    placed.push({ x, y, r: n.radius });
  };

  const sectorFor = (n: RadialNode) => SECTORS.find((s) => s.id === sectorOf(n.type === "Bubble" ? n.bubbleType! : n.type))!;
  const members = (sector: Sector, direct: boolean) =>
    nodes
      .filter((n) => n.id !== focusId && sectorFor(n).id === sector.id && n.relevance >= 1 - EPS === direct)
      .sort((a, b) => b.relevance - a.relevance || a.ownerRank - b.ownerRank || cmp(a.id, b.id));

  // Preferred angle: owners fan out from the sector's middle; diseases group by cluster, and the
  // members of one cluster fan out a little too, so a line from the center to a farther disease
  // never runs straight through a nearer one.
  const clusterOrder = new Map<string, number>();
  const clusterSize = new Map<string, number>();
  for (const d of nodes.filter((n) => n.id !== focusId && sectorFor(n).id === "diseases").sort((a, b) => b.relevance - a.relevance || cmp(a.id, b.id))) {
    const key = d.cluster ?? `~${d.id}`;
    if (!clusterOrder.has(key)) clusterOrder.set(key, clusterOrder.size);
  }
  const fan = (slot: number) => (slot === 0 ? 0 : (slot % 2 === 1 ? 1 : -1) * Math.ceil(slot / 2));
  const preferredAngle = (n: RadialNode, sector: Sector) => {
    const start = (sector.start * Math.PI) / 180;
    const end = (sector.end * Math.PI) / 180;
    const center = (start + end) / 2;
    if (sector.id !== "diseases") return Math.max(start, Math.min(end, center + fan(n.ownerRank) * ((end - start) / 7)));
    const key = n.cluster ?? `~${n.id}`;
    const k = clusterSize.get(key) ?? 0;
    clusterSize.set(key, k + 1);
    const angle = center + fan(clusterOrder.get(key) ?? 0) * ((end - start) / 7) + fan(k) * ((10 * Math.PI) / 180);
    return Math.max(start, Math.min(end, angle));
  };

  // Free spots along one ring of a sector, nearest to the preferred angle first.
  const along = (n: RadialNode, sector: Sector, preferred: number, radius: number, gap = GAP): [number, number] | null => {
    const start = (sector.start * Math.PI) / 180;
    const end = (sector.end * Math.PI) / 180;
    const margin = Math.min((end - start) / 2, (n.radius + GAP / 2) / Math.max(radius, 1));
    const reach = Math.ceil((end - start) / STEP) + 1;
    for (let k = 0; k <= 2 * reach; k++) {
      const angle = preferred + (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * STEP;
      if (angle < start + margin - EPS || angle > end - margin + EPS) continue;
      const [x, y] = at(angle, radius);
      if (clearance(x, y, n.radius, gap) >= 0) return [x, y];
    }
    return null;
  };

  // The least crowded spot between two radii, when nothing fits: it may overlap, but its distance
  // still tells the truth.
  const leastCrowded = (n: RadialNode, sector: Sector, low: number, high: number): [number, number] => {
    const start = (sector.start * Math.PI) / 180;
    const end = (sector.end * Math.PI) / 180;
    let best: [number, number] = [...at((start + end) / 2, high)] as [number, number];
    let bestGap = -Infinity;
    const rows = Math.max(1, Math.ceil((high - low) / RADIAL_STEP));
    for (let i = 0; i <= rows; i++) {
      const radius = high - ((high - low) * i) / rows;
      for (let k = 0; k <= 40; k++) {
        const [x, y] = at(start + ((end - start) * (k + 0.5)) / 41, radius);
        const gap = clearance(x, y, n.radius);
        if (gap > bestGap + EPS) {
          bestGap = gap;
          best = [x, y];
        }
      }
    }
    return best;
  };

  // 1. Direct links: rows from the innermost ring outward, as many as the busiest sector needs.
  const zoneEnd = g.inner + DIRECT_ZONE * (g.outer - g.inner);
  let direct = g.inner;
  for (const sector of SECTORS) {
    for (const n of members(sector, true)) {
      const preferred = preferredAngle(n, sector);
      let spot: [number, number] | null = null;
      for (let radius = g.inner; radius <= zoneEnd + EPS && !spot; radius += RADIAL_STEP) spot = along(n, sector, preferred, radius);
      spot ??= leastCrowded(n, sector, g.inner, zoneEnd);
      put(n, spot[0], spot[1]);
      direct = Math.max(direct, Math.hypot(spot[0] - g.cx, spot[1] - g.cy));
    }
  }
  g.direct = Math.round(direct * 100) / 100;

  // 2. Everything else: inside the band of its own whole percent, never into the zone of direct
  // links. A crowded band first lets nodes touch, then takes the least crowded spot.
  const inBand = (n: RadialNode, sector: Sector, preferred: number, high: number, low: number, gap: number) => {
    const rows = Math.ceil((high - low) / RADIAL_STEP - EPS);
    for (let i = 0; i <= rows; i++) {
      const spot = along(n, sector, preferred, rows ? high - ((high - low) * i) / rows : high, gap);
      if (spot) return spot;
    }
    return null;
  };
  for (const sector of SECTORS) {
    for (const n of members(sector, false)) {
      const preferred = preferredAngle(n, sector);
      const band = percentBand(n.relevance);
      const high = ringRadius(g, band);
      const low = Math.min(high, Math.max(ringRadius(g, Math.min(1, band + 0.01)), g.direct) + 0.25);
      const spot = inBand(n, sector, preferred, high, low, GAP) ?? inBand(n, sector, preferred, high, low, 0) ?? leastCrowded(n, sector, low, high);
      put(n, spot[0], spot[1]);
    }
  }
  return { positions, geometry: g };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// Depth for the 3D view: each sector becomes a layer, so the rings read the same from the front.
export const SECTOR_DEPTH: Record<SectorId, number> = { diseases: 0, research: -60, community: 45, symptoms: 70, biology: -80 };
