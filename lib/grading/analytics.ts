// Map-level structure from the graded pairs: mechanism clusters (Louvain over strong and
// moderate links), how central each disease is, research bridges between diseases, and 3D
// coordinates (classical MDS of 1 - biology). Everything is deterministic: fixed visit
// orders, fixed tie-breaks and a seeded start vector, so the same graph always lays out the same.
import { byText, round } from "./dimensions.ts";
import type { Bridge, CollaborationDimension, PairGrade, RelevanceCluster } from "./types.ts";

export interface WeightedLink {
  a: string;
  b: string;
  weight: number;
}

// Moves smaller than this (in modularity) do not count, so float noise cannot cause a move.
const MIN_GAIN = 1e-12;

function addTo(map: Map<number, number>, key: number, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

// Louvain community detection (Blondel et al. 2008). Nodes are visited in sorted-id order and a
// node moves only for a strictly better community, ties going to the smaller community id.
// Returns communities as sorted member lists, ordered by their first member.
export function louvain(nodeIds: string[], links: WeightedLink[], resolution = 1): string[][] {
  const ids = [...new Set(nodeIds)].sort(byText);
  const index = new Map(ids.map((id, i) => [id, i]));
  let adjacency: Map<number, number>[] = ids.map(() => new Map());
  let loops: number[] = ids.map(() => 0); // weight inside a node once communities are merged
  for (const link of links) {
    const i = index.get(link.a);
    const j = index.get(link.b);
    if (i === undefined || j === undefined || !(link.weight > 0)) continue;
    if (i === j) loops[i] += link.weight;
    else {
      addTo(adjacency[i], j, link.weight);
      addTo(adjacency[j], i, link.weight);
    }
  }

  let membership = ids.map((_, i) => i); // original node -> node of the current level
  for (;;) {
    const n = adjacency.length;
    const degree = adjacency.map((row, i) => [...row.values()].reduce((s, w) => s + w, 0) + 2 * loops[i]);
    const total = degree.reduce((s, d) => s + d, 0); // 2m
    if (total === 0) break;
    const threshold = (MIN_GAIN * total) / 2; // gains below are in weight units: dQ = gain / m
    const community = adjacency.map((_, i) => i);
    const inCommunity = degree.slice(); // sum of degrees per community

    let moved = false;
    for (let improved = true; improved; ) {
      improved = false;
      for (let i = 0; i < n; i++) {
        const own = community[i];
        const toCommunity = new Map<number, number>();
        for (const [j, w] of adjacency[i]) addTo(toCommunity, community[j], w);
        inCommunity[own] -= degree[i];
        const gain = (c: number) => (toCommunity.get(c) ?? 0) - (resolution * inCommunity[c] * degree[i]) / total;
        let best = own;
        let bestGain = gain(own);
        for (const c of [...toCommunity.keys()].sort((x, y) => x - y)) {
          if (c === own) continue;
          const g = gain(c);
          if (g > bestGain + threshold) {
            best = c;
            bestGain = g;
          }
        }
        inCommunity[best] += degree[i];
        community[i] = best;
        if (best !== own) {
          improved = true;
          moved = true;
        }
      }
    }
    if (!moved) break;

    // Aggregate: one node per community, numbered by first appearance so the visit order of the
    // next level still follows the smallest original id.
    const renumber = new Map<number, number>();
    for (const c of community) if (!renumber.has(c)) renumber.set(c, renumber.size);
    const nextAdjacency: Map<number, number>[] = Array.from({ length: renumber.size }, () => new Map());
    const nextLoops = new Array<number>(renumber.size).fill(0);
    for (let i = 0; i < n; i++) {
      const ci = renumber.get(community[i]) ?? 0;
      nextLoops[ci] += loops[i];
      for (const [j, w] of adjacency[i]) {
        const cj = renumber.get(community[j]) ?? 0;
        if (ci !== cj) addTo(nextAdjacency[ci], cj, w);
        else if (i < j) nextLoops[ci] += w;
      }
    }
    membership = membership.map((node) => renumber.get(community[node]) ?? 0);
    adjacency = nextAdjacency;
    loops = nextLoops;
  }

  const groups = new Map<number, string[]>();
  ids.forEach((id, i) => {
    const list = groups.get(membership[i]);
    if (list) list.push(id);
    else groups.set(membership[i], [id]);
  });
  return [...groups.values()].sort((x, y) => byText(x[0], y[0]));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MDS_SEED = 20261003;
const MAX_ITERATIONS = 10000;
const TOLERANCE = 1e-11;

function dot(x: number[], y: number[]): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * y[i];
  return s;
}

function multiply(matrix: number[][], v: number[]): number[] {
  return matrix.map((row) => dot(row, v));
}

function orthogonalize(v: number[], basis: number[][]): void {
  for (const u of basis) {
    const p = dot(v, u);
    for (let i = 0; i < v.length; i++) v[i] -= p * u[i];
  }
}

// Classical (Torgerson) MDS embeds n points so their distances match a given metric: double-center
// the squared distances into B = -1/2 J D^2 J and take its top eigenpairs, found by power iteration
// with deflation from a seeded start vector. `apply` multiplies a vector orthogonal to the
// all-ones vector by B; `shift` bounds -lambda_min(B), so the shifted operator has no negative
// eigenvalues and the largest ones come first even when the distances are not Euclidean.
// coords = v * sqrt(max(lambda, 0)), scaled so the farthest point sits on the unit sphere, and
// each axis flipped so the first point with a non-zero value on it is positive.
function embed(n: number, apply: (v: number[]) => number[], shift: number, dims: number): number[][] {
  const coords = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  if (n < 2) return coords;
  const random = mulberry32(MDS_SEED);
  const basis: number[][] = [new Array<number>(n).fill(1 / Math.sqrt(n))]; // centred data has no mean component
  for (let k = 0; k < dims; k++) {
    let v = Array.from({ length: n }, () => random() - 0.5);
    orthogonalize(v, basis);
    const start = Math.sqrt(dot(v, v));
    if (start < 1e-12) break; // fewer than dims independent directions
    v = v.map((x) => x / start);
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const w = apply(v).map((x, i) => x + shift * v[i]);
      orthogonalize(w, basis);
      const length = Math.sqrt(dot(w, w));
      if (length < 1e-300) break;
      let change = 0;
      for (let i = 0; i < n; i++) {
        w[i] /= length;
        change = Math.max(change, Math.abs(w[i] - v[i]));
      }
      v = w;
      if (change < TOLERANCE) break;
    }
    const lambda = dot(v, apply(v));
    basis.push(v);
    const factor = Math.sqrt(Math.max(lambda, 0));
    if (factor > 0) for (let i = 0; i < n; i++) coords[i][k] = v[i] * factor;
  }

  const maxNorm = Math.max(...coords.map((p) => Math.sqrt(dot(p, p))));
  if (maxNorm > 0) for (const p of coords) for (let k = 0; k < dims; k++) p[k] /= maxNorm;
  for (let k = 0; k < dims; k++) {
    const first = coords.find((p) => round(p[k]) !== 0);
    if (first && first[k] < 0) for (const p of coords) p[k] = -p[k];
  }
  return coords.map((p) => p.map((x) => (x === 0 ? 0 : x))); // no "-0"
}

// Classical MDS for any metric, from the full n x n distance matrix.
export function classicalMds(n: number, distance: (i: number, j: number) => number, dims = 3): number[][] {
  if (n < 2) return embed(n, (v) => v, 0, dims);
  const squared = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const d = i === j ? 0 : distance(i, j);
      return d * d; // plain multiply: exactly rounded everywhere, unlike pow
    }),
  );
  const rowMean = squared.map((row) => row.reduce((s, x) => s + x, 0) / n);
  const grandMean = rowMean.reduce((s, x) => s + x, 0) / n;
  const centered = squared.map((row, i) => row.map((x, j) => -0.5 * (x - rowMean[i] - rowMean[j] + grandMean)));
  const shift = Math.max(...centered.map((row) => row.reduce((s, x) => s + Math.abs(x), 0)));
  return embed(n, (v) => multiply(centered, v), shift, dims);
}

// The same embedding when most pairs sit at one distance `base` and only `pairs` differ, as in the
// atlas (pairs that share nothing have biology 0, distance 1). With S_ij = d_ij^2 - base^2 on the
// listed pairs, D^2 = base^2 (11' - I) + S, so for v orthogonal to the ones vector
// B v = base^2 v / 2 - (S v - mean(S v)) / 2: each step costs O(n + pairs), not O(n^2).
// |lambda(J S J)| <= max row sum of |S| bounds the shift.
export function sparseMds(n: number, pairs: { i: number; j: number; distance: number }[], base = 1, dims = 3): number[][] {
  const rows: { j: number; s: number }[][] = Array.from({ length: n }, () => []);
  for (const { i, j, distance } of pairs) {
    if (i === j) continue;
    const s = distance * distance - base * base;
    rows[i].push({ j, s });
    rows[j].push({ j: i, s });
  }
  const apply = (v: number[]) => {
    const sv = rows.map((row) => row.reduce((sum, { j, s }) => sum + s * v[j], 0));
    const mean = sv.reduce((sum, x) => sum + x, 0) / n;
    return v.map((x, i) => 0.5 * base * base * x - 0.5 * (sv[i] - mean));
  };
  const spread = Math.max(0, ...rows.map((row) => row.reduce((sum, { s }) => sum + Math.abs(s), 0)));
  return embed(n, apply, Math.max(0, 0.5 * spread - 0.5 * base * base), dims);
}

// ---- atlas structure ---------------------------------------------------------------------------

const BRIDGE_ORDER: readonly CollaborationDimension[] = ["grant", "investigator", "trial", "paper", "patient_org", "asset"];

const BRIDGE_PHRASE: Record<CollaborationDimension, string> = {
  grant: "Same research grant",
  investigator: "Same researcher",
  trial: "Same clinical study",
  paper: "Same paper",
  patient_org: "Same patient group",
  asset: "Same registry or asset",
};

const COLOR_SLOTS = 8;

export interface AnalysisInput {
  diseases: string[]; // sorted ids
  grades: PairGrade[]; // every graded pair
  isUmbrella: (dimension: CollaborationDimension, id: string) => boolean;
}

export interface Analysis {
  clusters: RelevanceCluster[];
  clusterOf: Map<string, string | null>;
  centrality: Map<string, number>;
  bridgeNodes: Set<string>;
  bridges: Bridge[];
  coords: Map<string, [number, number, number]>;
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function isLinked(grade: PairGrade): boolean {
  return grade.tier === "strong" || grade.tier === "moderate";
}

interface Naming {
  id: string;
  label: string;
  mechanisms: string[];
}

// Name a cluster by the biology most of its pairs share: a mechanism, or a gene ("Same gene:
// COL2A1") when the links come from diseases of one gene. Clusters are built from biology links, so
// a biology name says why the group exists; only a group with none falls back to its rarest shared
// symptom, then to a number. When several names are shared by as many pairs, the most specific wins
// (a family-wide process every pair shares never beats the process or gene that sets the group
// apart), and a mechanism wins a tie with a gene because it says what the gene does. Larger
// clusters choose first, and no two clusters take the same name.
function nameClusters(communities: string[][], grades: PairGrade[]): Map<string[], Naming> {
  const ordered = [...communities].sort((x, y) => y.length - x.length || byText(x[0], y[0]));
  const usedNames = new Set<string>();
  const usedSymptoms = new Set<string>();
  const usedIds = new Set<string>();
  const names = new Map<string[], Naming>();
  ordered.forEach((members, position) => {
    const inside = new Set(members);
    const intra = grades.filter((g) => inside.has(g.a) && inside.has(g.b));
    const shared = new Map<string, { label: string; pairs: number; weight: number; gene: boolean }>();
    let rarest: { id: string; label: string; weight: number } | null = null;
    for (const grade of intra) {
      for (const [items, gene] of [
        [grade.dimensions.mechanism.shared, false],
        [grade.dimensions.gene.shared, true],
      ] as const) {
        for (const item of items) {
          const entry = shared.get(item.id) ?? { label: item.label, pairs: 0, weight: item.weight, gene };
          entry.pairs += 1;
          entry.weight = Math.max(entry.weight, item.weight);
          shared.set(item.id, entry);
        }
      }
      for (const item of grade.dimensions.phenotype.shared) {
        if (usedSymptoms.has(item.id)) continue;
        const better =
          !rarest ||
          item.weight > rarest.weight ||
          (item.weight === rarest.weight && (byText(item.label, rarest.label) || byText(item.id, rarest.id)) < 0);
        if (better) rarest = { id: item.id, label: item.label, weight: item.weight };
      }
    }
    const biology = [...shared.entries()]
      .filter(([id]) => !usedNames.has(id))
      .sort(
        (x, y) =>
          y[1].pairs - x[1].pairs || y[1].weight - x[1].weight || Number(x[1].gene) - Number(y[1].gene) || byText(x[0], y[0]),
      )[0];

    let naming: Naming;
    if (biology) {
      const [id, entry] = biology;
      usedNames.add(id);
      naming = entry.gene
        ? { id: `c-${sanitize(id)}`, label: `Same gene: ${entry.label}`, mechanisms: [] }
        : { id: `c-${sanitize(id)}`, label: entry.label, mechanisms: [id] };
    } else if (rarest) {
      usedSymptoms.add(rarest.id);
      naming = { id: `c-group-${position + 1}`, label: `Shared symptoms: ${rarest.label}`, mechanisms: [] };
    } else {
      naming = { id: `c-group-${position + 1}`, label: `Group ${position + 1}`, mechanisms: [] };
    }
    let id = naming.id;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${naming.id}-${suffix}`;
    usedIds.add(id);
    names.set(members, { ...naming, id });
  });
  return names;
}

function bridgeFor(grade: PairGrade, clusterOf: Map<string, string | null>, input: AnalysisInput): Bridge | null {
  const dimensions: CollaborationDimension[] = [];
  const edges = new Set<string>();
  for (const dimension of BRIDGE_ORDER) {
    const items = grade.dimensions[dimension].shared.filter((item) => !input.isUmbrella(dimension, item.id));
    if (!items.length) continue;
    dimensions.push(dimension);
    for (const item of items) for (const edge of item.edges) edges.add(edge);
  }
  if (!dimensions.length) return null;
  const ca = clusterOf.get(grade.a) ?? null;
  const cb = clusterOf.get(grade.b) ?? null;
  const [first, second] = dimensions.map((d) => BRIDGE_PHRASE[d]);
  const reason = second ? `${first} and ${second[0].toLowerCase()}${second.slice(1)}` : first;
  return {
    a: grade.a,
    b: grade.b,
    cross_cluster: ca !== null && cb !== null && ca !== cb,
    reason,
    dimensions,
    edges: [...edges].sort(byText),
  };
}

export function analyze(input: AnalysisInput): Analysis {
  const links = input.grades.filter(isLinked).map((g) => ({ a: g.a, b: g.b, weight: g.biology }));
  const linked = [...new Set(links.flatMap((link) => [link.a, link.b]))];
  const communities = louvain(linked, links);
  const names = nameClusters(communities, input.grades);

  const clusters: RelevanceCluster[] = communities
    .map((members) => {
      const naming = names.get(members) as Naming;
      return { id: naming.id, label: naming.label, size: members.length, members, mechanisms: naming.mechanisms, color_slot: null };
    })
    .sort((x, y) => y.size - x.size || byText(x.id, y.id))
    .map((cluster, i) => ({ ...cluster, color_slot: i < COLOR_SLOTS ? i + 1 : null }));

  const clusterOf = new Map<string, string | null>(input.diseases.map((id) => [id, null]));
  for (const cluster of clusters) for (const member of cluster.members) clusterOf.set(member, cluster.id);

  const strength = new Map<string, number>(input.diseases.map((id) => [id, 0]));
  for (const link of links) {
    strength.set(link.a, (strength.get(link.a) ?? 0) + link.weight);
    strength.set(link.b, (strength.get(link.b) ?? 0) + link.weight);
  }
  const strongest = Math.max(0, ...strength.values());
  const centrality = new Map(input.diseases.map((id) => [id, strongest > 0 ? round((strength.get(id) ?? 0) / strongest) : 0]));

  const bridgeNodes = new Set<string>();
  for (const link of links) {
    const ca = clusterOf.get(link.a) ?? null;
    const cb = clusterOf.get(link.b) ?? null;
    if (ca !== null && cb !== null && ca !== cb) {
      bridgeNodes.add(link.a);
      bridgeNodes.add(link.b);
    }
  }

  const bridges = [...input.grades]
    .sort((x, y) => byText(x.a, y.a) || byText(x.b, y.b))
    .flatMap((grade) => bridgeFor(grade, clusterOf, input) ?? []);

  // Distance 1 - biology. Pairs that were never graded share nothing that can score: biology 0.
  const index = new Map(input.diseases.map((id, i) => [id, i]));
  const distances: { i: number; j: number; distance: number }[] = [];
  for (const grade of [...input.grades].sort((x, y) => byText(x.a, y.a) || byText(x.b, y.b))) {
    const i = index.get(grade.a);
    const j = index.get(grade.b);
    if (i !== undefined && j !== undefined && grade.biology > 0) distances.push({ i, j, distance: 1 - grade.biology });
  }
  const raw = sparseMds(input.diseases.length, distances);
  const coords = new Map(
    input.diseases.map((id, i) => [id, [round(raw[i][0]), round(raw[i][1]), round(raw[i][2])] as [number, number, number]]),
  );
  return { clusters, clusterOf, centrality, bridgeNodes, bridges, coords };
}
