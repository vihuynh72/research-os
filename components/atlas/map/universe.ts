// The start screen's "RareVerse universe": every disease as a point of light. Diseases that share
// biology (a colored cluster) gather as a small sunflower inside a soft halo with its name under it;
// the rest are faint stars spread evenly over the free sky. Clusters go where there is most room
// (largest first), stars then fill the gaps as evenly as they can, and nothing goes under the
// search card (`avoid`). Deterministic and recomputed for the size the map is drawn at. Pure.

export type Pt = [number, number];
export type Box = [number, number, number, number]; // left, top, right, bottom

export interface UniverseCluster {
  id: string;
  members: readonly string[]; // most connected first: they sit in the middle
  lines: readonly string[]; // its name, one or two lines
}

export interface UniverseHalo {
  id: string;
  x: number;
  y: number;
  r: number;
  label: Box; // where its name is written, under the halo
}

export interface Universe {
  positions: Map<string, Pt>;
  halos: UniverseHalo[];
}

const PAD = 28; // from the edge of the map
const MARGIN = 18; // around the search card
const SPACING = 17; // between two dots of one cluster
const HALO = 14; // halo beyond its outermost dot
const GAP = 22; // between two halos
const LINE = 14; // a line of a cluster name
const CHAR = 6.3; // width of one character of a cluster name
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// Clearance between two boxes: positive apart, negative when they overlap.
function boxGap(a: Box, b: Box): number {
  const dx = Math.max(a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(a[1] - b[3], b[1] - a[3]);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
}

// Clearance from a point to a box: positive outside, negative inside.
function pointGap(b: Box, x: number, y: number): number {
  return boxGap(b, [x, y, x, y]);
}

export function universeLayout(clusters: readonly UniverseCluster[], stars: readonly string[], width: number, height: number, avoid: Box | null): Universe {
  const positions = new Map<string, Pt>();
  const halos: UniverseHalo[] = [];
  const step = Math.max(8, Math.round(Math.min(width, height) / 70));
  const grid: Pt[] = [];
  for (let y = PAD; y <= height - PAD; y += step) for (let x = PAD; x <= width - PAD; x += step) grid.push([x, y]);
  const card: Box | null = avoid ? [avoid[0] - MARGIN, avoid[1] - MARGIN, avoid[2] + MARGIN, avoid[3] + MARGIN] : null;
  const inside = (b: Box) => Math.min(b[0] - PAD, width - PAD - b[2], b[1] - PAD, height - PAD - b[3]);

  // 1. Clusters, largest first, each where it keeps the most room around it.
  clusters.forEach((c, index) => {
    const spiral = SPACING / 1.8;
    const r = spiral * Math.sqrt(Math.max(c.members.length - 0.5, 0.5)) + HALO;
    const labelW = Math.max(...c.lines.map((l) => l.length)) * CHAR + 8;
    const labelH = c.lines.length * LINE + 4;
    const labelAt = (x: number, y: number): Box => [x - labelW / 2, y + r + 2, x + labelW / 2, y + r + 2 + labelH];
    let best: Pt = [width / 2, height / 2];
    let bestScore = -Infinity;
    for (const [x, y] of grid) {
      const label = labelAt(x, y);
      let score = Math.min(inside([x - r, y - r, x + r, y + r]), inside(label));
      if (card) score = Math.min(score, pointGap(card, x, y) - r, boxGap(card, label));
      for (const h of halos) {
        score = Math.min(score, Math.hypot(h.x - x, h.y - y) - h.r - r - GAP, pointGap(label, h.x, h.y) - h.r, pointGap(h.label, x, y) - r, boxGap(h.label, label) - 6);
        if (score <= bestScore) break;
      }
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    const [x, y] = best;
    halos.push({ id: c.id, x, y, r, label: labelAt(x, y) });
    // A sunflower: even spacing, no grid, the most connected member in the middle.
    const turn = index * 1.3;
    c.members.forEach((id, k) => {
      const d = spiral * Math.sqrt(k + 0.5);
      const a = k * GOLDEN + turn;
      positions.set(id, [round(x + Math.cos(a) * d), round(y + Math.sin(a) * d)]);
    });
  });

  // 2. Stars, each at the free spot farthest from everything placed so far.
  // The map's edge and the card push too, so the first stars do not all land in the corners.
  const room = grid.map(([x, y]) => {
    let gap = Math.min(x, width - x, y, height - y) - 4;
    if (card) gap = Math.min(gap, pointGap(card, x, y));
    for (const h of halos) gap = Math.min(gap, Math.hypot(h.x - x, h.y - y) - h.r - 6, pointGap(h.label, x, y) - 6);
    return gap;
  });
  const usable = grid.map((_, i) => i).filter((i) => room[i] >= 0);
  const pool = usable.length ? usable : grid.map((_, i) => i);
  const nearest = pool.map((i) => Math.max(room[i], 0));
  stars.forEach((id, n) => {
    let pick = 0;
    for (let k = 1; k < pool.length; k++) if (nearest[k] > nearest[pick]) pick = k;
    const [x, y] = grid[pool[pick]];
    // A small fixed nudge off the sampling grid, so no row of stars lines up.
    positions.set(id, [round(x + (((n * 0.618034) % 1) - 0.5) * step * 0.8), round(y + (((n * 0.754878) % 1) - 0.5) * step * 0.8)]);
    for (let k = 0; k < pool.length; k++) {
      const [px, py] = grid[pool[k]];
      nearest[k] = Math.min(nearest[k], Math.hypot(px - x, py - y));
    }
  });
  return { positions, halos };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
