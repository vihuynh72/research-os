// Deterministic force layout for the map: the same neighborhood always lands in the same place,
// so a screenshot, the demo and a teammate's laptop show one picture. It starts from a radial
// arrangement that already encodes relevance (related diseases sit closer the more biology they
// share, the focus's own evidence sits in sectors by type), then relaxes it with springs,
// repulsion and collision. Works in 2D or 3D; units are abstract, the renderer scales to fit.

export interface LayoutNode {
  id: string;
  role: string; // HoodRole
  type: string; // node type, or "Bubble"
  hop: number;
  relevance: number;
  radius: number; // drawn radius, used for collision
  group?: string | null; // cluster id for related diseases; keeps a cluster's members side by side
}

export interface LayoutEdge {
  a: string;
  b: string;
  relevance: number;
  role: string; // HoodEdgeRole
}

export type Point = [number, number, number];

export interface LayoutOptions {
  dims?: 2 | 3;
  iterations?: number;
}

// Preferred angle (radians, 0 = right, clockwise on screen) for the focus's own evidence by type.
const SECTOR: Record<string, number> = {
  Gene: Math.PI, // left
  Variant: Math.PI * 0.92,
  Mechanism: -Math.PI / 2, // top
  Phenotype: Math.PI / 2, // bottom
  PatientOrg: -Math.PI / 8, // upper right
  Asset: Math.PI / 12,
  Trial: Math.PI * 0.3,
  Paper: Math.PI * 0.36,
  Grant: Math.PI * 0.24,
  Investigator: Math.PI * 0.18,
};

const RELATED_BASE = 190; // distance of a related disease with relevance 1
const RELATED_SPAN = 320; // extra distance per unit of missing relevance
const OWN_RADIUS = [0, 120, 185]; // by hop

export function relatedDistance(relevance: number): number {
  return RELATED_BASE + RELATED_SPAN * (1 - Math.max(0, Math.min(1, relevance)));
}

// FNV-1a: a stable pseudo-random number in [0, 1) from an id, for deterministic jitter.
export function hash01(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sectorOf(node: LayoutNode): number {
  return SECTOR[node.type] ?? SECTOR.Trial;
}

function restLength(edge: LayoutEdge, a: LayoutNode, b: LayoutNode): number | null {
  switch (edge.role) {
    case "similarity":
      return relatedDistance(edge.relevance);
    case "shared":
      return 150;
    case "bubble":
      return 72;
    case "evidence":
      return a.role === "focus" || b.role === "focus" ? OWN_RADIUS[1] : 82;
    default:
      return null; // bridges are drawn, not pulled
  }
}

export function forceLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: LayoutOptions = {}): Map<string, Point> {
  const dims = opts.dims ?? 2;
  const iterations = opts.iterations ?? 320;
  const list = [...nodes].sort((x, y) => cmp(x.id, y.id));
  const index = new Map(list.map((n, i) => [n.id, i]));
  const n = list.length;
  const pos: Point[] = list.map(() => [0, 0, 0]);
  const vel: Point[] = list.map(() => [0, 0, 0]);

  // Initial placement.
  const related = list
    .filter((x) => x.role === "related")
    .sort((x, y) => cmp(x.group ?? "~", y.group ?? "~") || y.relevance - x.relevance || cmp(x.id, y.id));
  related.forEach((node, i) => {
    const angle = -Math.PI / 2 + Math.PI / 5 + ((i + 0.5) * 2 * Math.PI) / related.length;
    const r = relatedDistance(node.relevance);
    pos[index.get(node.id)!] = [Math.cos(angle) * r, Math.sin(angle) * r, 0];
  });
  const bySector = new Map<number, LayoutNode[]>();
  for (const node of list) {
    if (node.role === "focus" || node.role === "related") continue;
    const s = sectorOf(node);
    const group = bySector.get(s);
    if (group) group.push(node);
    else bySector.set(s, [node]);
  }
  for (const [sector, group] of bySector) {
    group.sort((x, y) => x.hop - y.hop || y.relevance - x.relevance || cmp(x.id, y.id));
    const spread = Math.min(Math.PI / 1.6, 0.32 * group.length);
    group.forEach((node, i) => {
      const t = group.length === 1 ? 0 : i / (group.length - 1) - 0.5;
      const angle = sector + t * spread;
      const r = OWN_RADIUS[Math.min(node.hop, 2)] + 18 * (i % 2);
      pos[index.get(node.id)!] = [Math.cos(angle) * r, Math.sin(angle) * r, 0];
    });
  }
  if (dims === 3) {
    list.forEach((node, i) => {
      if (node.role !== "focus") pos[i][2] = (hash01(node.id) - 0.5) * 160;
    });
  }

  const links = edges
    .map((e) => ({ e, i: index.get(e.a), j: index.get(e.b) }))
    .filter((l): l is { e: LayoutEdge; i: number; j: number } => l.i !== undefined && l.j !== undefined && l.i !== l.j)
    .sort((x, y) => cmp(x.e.a, y.e.a) || cmp(x.e.b, y.e.b));
  const focusIndex = list.findIndex((x) => x.role === "focus");

  let alpha = 1;
  for (let step = 0; step < iterations; step++) {
    const force: Point[] = list.map(() => [0, 0, 0]);
    // Repulsion keeps nodes apart; scaled by size so big nodes claim more room.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d: Point = [pos[j][0] - pos[i][0], pos[j][1] - pos[i][1], pos[j][2] - pos[i][2]];
        const d2 = Math.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2], 49);
        const k = (2200 * (1 + (list[i].radius + list[j].radius) / 40) * alpha) / d2;
        const len = Math.sqrt(d2);
        for (let c = 0; c < 3; c++) {
          const f = (k * d[c]) / len;
          force[i][c] -= f;
          force[j][c] += f;
        }
      }
    }
    // Springs along links, stiffer for more relevant links.
    for (const { e, i, j } of links) {
      const rest = restLength(e, list[i], list[j]);
      if (rest === null) continue;
      const d: Point = [pos[j][0] - pos[i][0], pos[j][1] - pos[i][1], pos[j][2] - pos[i][2]];
      const len = Math.max(Math.hypot(d[0], d[1], d[2]), 1e-6);
      const k = (0.05 + 0.07 * e.relevance) * (len - rest) * alpha;
      for (let c = 0; c < 3; c++) {
        const f = (k * d[c]) / len;
        force[i][c] += f;
        force[j][c] -= f;
      }
    }
    // Radial pull keeps the meaning of distance: related diseases at their relevance distance,
    // the focus's own evidence on its inner rings.
    for (let i = 0; i < n; i++) {
      const node = list[i];
      if (node.role === "focus") continue;
      const target = node.role === "related" ? relatedDistance(node.relevance) : OWN_RADIUS[Math.min(node.hop, 2)];
      const strength = node.role === "related" ? 0.12 : 0.03;
      const len = Math.max(Math.hypot(pos[i][0], pos[i][1], pos[i][2]), 1e-6);
      const k = (strength * (target - len) * alpha) / len;
      for (let c = 0; c < 3; c++) force[i][c] += k * pos[i][c];
    }
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        vel[i][c] = Math.max(-30, Math.min(30, (vel[i][c] + force[i][c]) * 0.55));
        pos[i][c] += vel[i][c];
      }
      if (dims === 2) pos[i][2] = 0;
    }
    // Collision: resolve overlaps directly so labels and icons never sit on top of each other.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const min = list[i].radius + list[j].radius + 10;
        const d: Point = [pos[j][0] - pos[i][0], pos[j][1] - pos[i][1], pos[j][2] - pos[i][2]];
        let len = Math.hypot(d[0], d[1], d[2]);
        if (len >= min) continue;
        if (len < 1e-6) {
          const angle = hash01(list[i].id + list[j].id) * 2 * Math.PI;
          d[0] = Math.cos(angle);
          d[1] = Math.sin(angle);
          d[2] = 0;
          len = 1;
        }
        const push = (min - len) / 2;
        for (let c = 0; c < 3; c++) {
          const delta = (push * d[c]) / len;
          if (i !== focusIndex) pos[i][c] -= delta;
          if (j !== focusIndex) pos[j][c] += delta;
        }
      }
    }
    if (focusIndex >= 0) pos[focusIndex] = [0, 0, 0];
    alpha *= 0.986;
  }

  const out = new Map<string, Point>();
  list.forEach((node, i) => {
    out.set(node.id, [round2(pos[i][0]), round2(pos[i][1]), round2(pos[i][2])]);
  });
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100 || 0;
}

// Uniformly scales positions into a box, keeping the focus at the box center when given.
export function fitToBox(
  positions: ReadonlyMap<string, Point>,
  width: number,
  height: number,
  padding: number,
  center?: string,
): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (!positions.size) return out;
  const origin = center && positions.get(center) ? positions.get(center)! : null;
  let extentX = 0;
  let extentY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of positions.values()) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (origin) {
      extentX = Math.max(extentX, Math.abs(x - origin[0]));
      extentY = Math.max(extentY, Math.abs(y - origin[1]));
    }
  }
  const cx = origin ? origin[0] : (minX + maxX) / 2;
  const cy = origin ? origin[1] : (minY + maxY) / 2;
  const halfW = origin ? extentX : (maxX - minX) / 2;
  const halfH = origin ? extentY : (maxY - minY) / 2;
  const scale = Math.min((width / 2 - padding) / Math.max(halfW, 1), (height / 2 - padding) / Math.max(halfH, 1), 1.6);
  for (const [id, [x, y]] of positions) {
    out.set(id, [width / 2 + (x - cx) * scale, height / 2 + (y - cy) * scale]);
  }
  return out;
}

// Scales 3D positions into the unit sphere around the focus, for the canvas 3D view.
export function toUnitSphere(positions: ReadonlyMap<string, Point>, center?: string): Map<string, Point> {
  const origin: Point = center && positions.get(center) ? positions.get(center)! : [0, 0, 0];
  let max = 0;
  for (const p of positions.values()) max = Math.max(max, Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]));
  const out = new Map<string, Point>();
  for (const [id, p] of positions) {
    out.set(id, max > 0 ? [(p[0] - origin[0]) / max, (p[1] - origin[1]) / max, (p[2] - origin[2]) / max] : [0, 0, 0]);
  }
  return out;
}
