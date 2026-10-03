"use client";

// The knowledge-graph map. Before a search it is a faint constellation of every disease in the atlas.
// After a search, what was searched sits in the center and everything else is placed with meaning:
// distance from the center is relevance (rings at the tier cutoffs, plus the filter ring that moves
// with the relevance bar) and direction is the kind of thing (diseases at the top, research upper
// right, groups and registries lower right, symptoms at the bottom, genes and mechanisms on the left).
// Line width, glow and opacity follow relevance; dashed lines are inferred; items just under the
// filter stay as faint ghosts so the user can see there is more.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AtlasGraph, NodeType } from "@/lib/graph/types";
import type { RelevanceDoc } from "@/lib/grading/types";
import { applyThreshold, buildNeighborhood, type HoodEdge, type HoodNode } from "@/lib/graph/neighborhood";
import { SECTORS, radialLayout, ringRadius, type RadialNode } from "@/lib/viz/radialLayout";
import { ICON_PATH } from "@/lib/viz/icons";
import { shortLabel } from "@/lib/graph/labels";
import { TYPE_NAME } from "@/lib/graph/vocab";
import { KIND_OF, KIND_STYLE } from "./kinds";

export interface KnowledgeGraphProps {
  graph: AtlasGraph;
  relevance: RelevanceDoc | null;
  focusId: string | null;
  selectedId: string | null; // a node id or a map edge id
  threshold: number; // 0..1
  hiddenTypes: ReadonlySet<NodeType>;
  expanded: ReadonlySet<string>;
  mode: "parent" | "researcher";
  onFocus(id: string): void;
  onSelect(id: string | null): void;
  onToggleBubble(id: string): void;
  onThreshold(value: number): void;
  reserveTop?: number; // share of the height kept clear above the constellation before a search
  className?: string;
}

const W = 1200;
const H = 840;
const CONSTELLATION_PAD = 70;
// Text keeps a readable size on screen however small the map is drawn: a 12-unit label renders at
// about LABEL_PX pixels, never smaller than designed and never more than MAX_TEXT_SCALE times it.
const LABEL_PX = 10.5;
const MAX_TEXT_SCALE = 2.4;

type Pt = [number, number];
type Box = [number, number, number, number]; // left, top, right, bottom
type Anchor = { x: number; y: number; anchor: "start" | "middle" | "end" };

const overlaps = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

interface Hover {
  kind: "node" | "edge";
  id: string;
  left: number; // px inside the container
  top: number;
}

function nodeRadius(n: HoodNode, centrality: number): number {
  if (n.role === "focus") return 30;
  if (n.type === "Disease") return 17 + 7 * centrality;
  if (n.role === "bubble") return 15;
  if (n.role === "symptom") return 11;
  return 13;
}

function clusterColor(relevance: RelevanceDoc | null, cluster: string | null | undefined): string {
  const slot = relevance?.clusters.find((c) => c.id === cluster)?.color_slot;
  return slot ? `var(--series-${slot})` : "var(--node-gray)";
}

function typeName(n: HoodNode): string {
  if (n.type === "Bubble") return `${TYPE_NAME[n.bubbleType!].many}, folded`;
  return TYPE_NAME[n.type].one;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function truncate(label: string, max = 26): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`;
}

// Disease-to-disease lines carry the story, so they get the weight and the glow; evidence lines stay
// thinner and neutral. Weak lines fade but never below 22% opacity.
function edgeStyle(e: HoodEdge) {
  const r = e.relevance;
  const opacity = 0.22 + 0.78 * r;
  const dash = e.kind === "observed" ? undefined : "6 5";
  switch (e.role) {
    case "similarity":
      return { width: 1 + 5 * r * r, opacity, dash, color: "var(--accent)", glow: r >= 0.75 ? 1.5 + (3 * (r - 0.75)) / 0.25 : 0 };
    case "bridge":
      return { width: 1.4, opacity: 0.85, dash: "3 5", color: "var(--ink-2)", glow: 0 };
    default:
      // Evidence lines stay quiet so the disease-to-disease links lead; hover brings them forward.
      return { width: 0.6 + 1.4 * r * r, opacity: 0.16 + 0.5 * r, dash, color: "var(--ink-3)", glow: 0 };
  }
}

function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function KnowledgeGraph(props: KnowledgeGraphProps) {
  const { graph, relevance, focusId, selectedId, threshold, hiddenTypes, expanded, mode } = props;
  const uid = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // How large the map is drawn, so labels can keep a readable size on screen (ts = text scale).
  const [drawn, setDrawn] = useState(0.7);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setDrawn(Math.min(width / W, height / H));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ts = Math.round(Math.min(MAX_TEXT_SCALE, Math.max(1, LABEL_PX / (12 * drawn))) * 20) / 20;

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const edgeById = useMemo(() => new Map(graph.edges.map((e) => [e.id, e])), [graph]);
  const centralityOf = (id: string) => relevance?.diseases[id]?.centrality ?? 0;
  const focusNode = focusId ? byId.get(focusId) : undefined;

  // Constellation: every disease at its 2D projection of the 3D similarity layout. Before a search it
  // sits below the reserved top band, leaving room for the search card.
  const reserveTop = focusId ? 0 : (props.reserveTop ?? 0);
  const constellation = useMemo(() => {
    const out = new Map<string, Pt>();
    const diseases = graph.nodes.filter((n) => n.type === "Disease");
    const top = H * reserveTop + CONSTELLATION_PAD;
    diseases.forEach((n, i) => {
      const c = relevance?.diseases[n.id]?.coords3d;
      const x = c ? c[0] : Math.cos((i / Math.max(diseases.length, 1)) * 2 * Math.PI) * 0.8;
      const y = c ? c[1] : Math.sin((i / Math.max(diseases.length, 1)) * 2 * Math.PI) * 0.8;
      out.set(n.id, [W / 2 + x * (W / 2 - CONSTELLATION_PAD), top + ((y + 1) / 2) * (H - CONSTELLATION_PAD - top)]);
    });
    return out;
  }, [graph, relevance, reserveTop]);

  // The neighborhood and its layout. Layout uses every node at every relevance, so moving the bar
  // only shows and hides; nothing jumps.
  const hood = useMemo(() => (focusId ? buildNeighborhood(graph, relevance, focusId, { expanded }) : null), [graph, relevance, focusId, expanded]);
  const layout = useMemo(() => {
    if (!hood) return null;
    const nodes: RadialNode[] = hood.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      bubbleType: n.bubbleType,
      role: n.role,
      relevance: n.relevance,
      ownerRank: n.ownerRank,
      radius: nodeRadius(n, relevance?.diseases[n.id]?.centrality ?? 0) + 2,
      cluster: n.cluster ?? null,
    }));
    return radialLayout(nodes, hood.focus, W, H);
  }, [hood, relevance]);
  const positions = layout?.positions ?? new Map<string, Pt>();
  const geometry = layout?.geometry;

  const filtered = useMemo(() => (hood ? applyThreshold(hood, threshold, hiddenTypes) : null), [hood, threshold, hiddenTypes]);
  const level = useMemo(() => {
    const m = new Map<string, "shown" | "ghost">();
    for (const n of filtered?.nodes ?? []) m.set(n.id, "shown");
    for (const n of filtered?.ghosts ?? []) m.set(n.id, "ghost");
    return m;
  }, [filtered]);

  // Entrance: render once at the start points, then let CSS transitions carry nodes outward.
  const [entered, setEntered] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!focusId || reduced) {
      setEntered(focusId);
      return;
    }
    setEntered(null);
    // Two frames let the start positions paint before the move; the timer covers tabs that deliver
    // no frames (background tabs, headless screenshots).
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntered(focusId));
    });
    const fallback = setTimeout(() => setEntered(focusId), 120);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(fallback);
    };
  }, [focusId, reduced]);
  const settled = entered === focusId;

  useEffect(() => setView({ k: 1, x: 0, y: 0 }), [focusId]);
  useEffect(() => setHover(null), [focusId, threshold]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !focusId) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / W, rect.height / H);
      const px = (event.clientX - rect.left - (rect.width - W * scale) / 2) / scale;
      const py = (event.clientY - rect.top - (rect.height - H * scale) / 2) / scale;
      setView((v) => {
        const k = Math.min(3, Math.max(0.5, v.k * Math.exp(-event.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [focusId]);

  const showHover = (kind: Hover["kind"], id: string, target: Element) => {
    const box = containerRef.current?.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    if (!box) return;
    setHover({ kind, id, left: r.left + r.width / 2 - box.left, top: r.top - box.top });
  };

  const hoodNodes = hood?.nodes ?? [];
  const nodeById = new Map(hoodNodes.map((n) => [n.id, n]));
  const center: Pt = geometry ? [geometry.cx, geometry.cy] : [W / 2, H / 2];

  const placeOf = (n: HoodNode): Pt => {
    const target = positions.get(n.id) ?? center;
    if (n.role === "focus") return settled ? target : (constellation.get(n.id) ?? target);
    if (!settled) return n.type === "Disease" ? (constellation.get(n.id) ?? center) : center;
    if (!level.has(n.id) && n.type === "Disease") return constellation.get(n.id) ?? target;
    return target;
  };

  // Hover or selection highlights a node's own lines and shows their strength.
  const activeNode = hover?.kind === "node" ? hover.id : selectedId && nodeById.has(selectedId) ? selectedId : null;
  const touching = useMemo(() => {
    if (!activeNode || !filtered) return null;
    const ids = new Set([activeNode]);
    for (const e of [...filtered.edges, ...filtered.faintEdges]) {
      if (e.a === activeNode) ids.add(e.b);
      if (e.b === activeNode) ids.add(e.a);
    }
    return ids;
  }, [activeNode, filtered]);

  // Labels: radially outward; diseases and the searched node always; others unless they would collide.
  const labelled = useMemo(() => {
    const out = new Set<string>();
    if (!filtered || !geometry) return out;
    const boxes: [number, number, number, number][] = [];
    const order: HoodNode["role"][] = ["focus", "anchor", "related", "attribute", "group", "research", "bubble", "symptom"];
    const nodes = [...filtered.nodes].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.relevance - a.relevance);
    const obstacles = filtered.nodes.flatMap((n): [string, [number, number, number, number]][] => {
      const p = positions.get(n.id);
      if (!p) return [];
      const r = nodeRadius(n, relevance?.diseases[n.id]?.centrality ?? 0);
      return [[n.id, [p[0] - r, p[1] - r, p[0] + r, p[1] + r]]];
    });
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const box = labelBox(n, p);
      const always = n.role === "focus" || n.type === "Disease";
      const hits = (b: [number, number, number, number]) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1];
      if (!always && (boxes.some(hits) || obstacles.some(([id, b]) => id !== n.id && hits(b)))) continue;
      boxes.push(box);
      out.add(n.id);
    }
    return out;
  }, [filtered, positions, geometry, byId, relevance]);

  function labelText(n: HoodNode): string {
    if (n.type === "Disease") return shortLabel({ label: n.label, synonyms: byId.get(n.id)?.synonyms });
    // A bubble shows its count inside, so its label drops the number.
    return truncate(n.role === "bubble" ? n.label.replace(/^\d+ /, "") : n.label);
  }

  // Where a node's label goes: below the searched node, otherwise outward from the center.
  function labelAnchor(n: HoodNode, p: Pt) {
    const r = nodeRadius(n, relevance?.diseases[n.id]?.centrality ?? 0);
    if (n.role === "focus") return { x: 0, y: r + 18, anchor: "middle" as const };
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const anchor = Math.abs(ux) < 0.35 ? ("middle" as const) : ux > 0 ? ("start" as const) : ("end" as const);
    const off = r + 6;
    return { x: ux * off + (anchor === "middle" ? 0 : 0), y: uy * off + (anchor === "middle" ? (uy > 0 ? 10 : -4) : 4), anchor };
  }

  function labelBox(n: HoodNode, p: Pt): [number, number, number, number] {
    const a = labelAnchor(n, p);
    const w = labelText(n).length * 6.6 + (n.type === "Disease" ? 0 : 0);
    const x = p[0] + a.x;
    const y = p[1] + a.y;
    const left = a.anchor === "start" ? x : a.anchor === "end" ? x - w : x - w / 2;
    const h = n.type === "Disease" && n.role !== "focus" ? 30 : 16;
    return [left, y - 12, left + w, y - 12 + h];
  }

  const delayOf = (n: HoodNode, i: number) => (reduced ? 0 : Math.min(n.hop, 4) * 110 + Math.min(i, 40) * 8);
  const transition = (delay: number) =>
    reduced ? undefined : `transform 700ms cubic-bezier(.2,.8,.2,1) ${delay}ms, opacity 420ms ease ${delay}ms`;

  // Cluster hulls behind the diseases on the map.
  const hulls = useMemo(() => {
    if (!filtered || !settled) return [];
    const groups = new Map<string, Pt[]>();
    for (const n of filtered.nodes) {
      if (n.type !== "Disease" || !n.cluster) continue;
      const p = positions.get(n.id);
      if (!p) continue;
      const list = groups.get(n.cluster) ?? [];
      list.push(p);
      groups.set(n.cluster, list);
    }
    return [...groups]
      .filter(([, pts]) => pts.length > 1)
      .map(([id, pts]) => ({
        id,
        label: relevance?.clusters.find((c) => c.id === id)?.label ?? id,
        color: clusterColor(relevance, id),
        hull: convexHull(pts),
        top: Math.min(...pts.map((p) => p[1])),
        left: Math.min(...pts.map((p) => p[0])),
        right: Math.max(...pts.map((p) => p[0])),
      }));
  }, [filtered, positions, relevance, settled]);

  const hoverNode = hover?.kind === "node" ? nodeById.get(hover.id) : undefined;
  const hoverEdge = hover?.kind === "edge" ? [...(filtered?.edges ?? []), ...(filtered?.faintEdges ?? [])].find((e) => e.id === hover.id) : undefined;
  const noneAtThreshold = !!(filtered && hood && hood.related.length > 0 && filtered.relatedShown === 0 && filtered.closestHidden);
  const noRelated = !!(hood && focusId && hood.focusType === "Disease" && hood.related.length === 0);

  const curve = (a: Pt, b: Pt, role: HoodEdge["role"]) => {
    // Lines from the center are straight; others bow outward so they skirt the middle of the map.
    const atCenter = (p: Pt) => Math.hypot(p[0] - center[0], p[1] - center[1]) < 2;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (atCenter(a) || atCenter(b)) return { d: `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`, mid };
    const bow = role === "bridge" ? 0.42 : 0.24;
    const c: Pt = [mid[0] + (mid[0] - center[0]) * bow, mid[1] + (mid[1] - center[1]) * bow];
    const m: Pt = [0.25 * a[0] + 0.5 * c[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * c[1] + 0.25 * b[1]];
    return { d: `M${a[0]} ${a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`, mid: m };
  };

  const edgesToDraw = settled && filtered ? [...filtered.faintEdges.map((e) => ({ e, faint: true })), ...filtered.edges.map((e) => ({ e, faint: false }))] : [];

  return (
    <div ref={containerRef} className={`relative h-full w-full select-none overflow-hidden ${props.className ?? ""}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full touch-none"
        role="group"
        aria-label={
          focusNode
            ? `Knowledge graph for ${focusNode.label}: ${filtered?.shown ?? 0} of ${filtered?.total ?? 0} items shown at ${pct(threshold)} relevance`
            : `Constellation of ${constellation.size} diseases. Search to map one.`
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onSelect(null);
        }}
        onPointerDown={(event) => {
          if (!focusId || (event.target as Element).closest("[data-node],[data-edge]")) return;
          drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const rect = svgRef.current!.getBoundingClientRect();
          const scale = Math.min(rect.width / W, rect.height / H);
          const dx = (event.clientX - d.x) / scale;
          const dy = (event.clientY - d.y) / scale;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) props.onSelect(null);
        }}
      >
        <defs>
          <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* Constellation lines: before a search, faint links between diseases that share biology. */}
        {!focusId && (
          <g aria-hidden>
            {(relevance?.pairs ?? [])
              .filter((p) => p.tier === "strong" || p.tier === "moderate")
              .map((p) => {
                const a = constellation.get(p.a);
                const b = constellation.get(p.b);
                if (!a || !b) return null;
                return <line key={`${p.a}|${p.b}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--node-gray)" strokeWidth={0.8 + p.relevance} opacity={0.12 + 0.18 * p.relevance} />;
              })}
          </g>
        )}

        {/* Constellation dots: every disease not drawn on the map. */}
        <g aria-hidden={focusId ? true : undefined}>
          {[...constellation].map(([id, [x, y]], i) => {
            if (focusId && nodeById.has(id) && (level.has(id) || nodeById.get(id)?.role === "focus")) return null;
            const node = byId.get(id)!;
            const r = 3 + 3 * centralityOf(id);
            return (
              <g key={id} transform={`translate(${x} ${y})`}>
                <circle
                  r={focusId ? r : r + 3}
                  fill={focusId ? "var(--node-gray)" : clusterColor(relevance, relevance?.diseases[id]?.cluster)}
                  className={focusId || reduced ? undefined : "atlas-twinkle"}
                  style={{ opacity: focusId ? 0.16 : 0.75, animationDelay: `${(i % 7) * 0.6}s` }}
                />
                {/* Small atlases get names on the dots; big ones rely on hover. */}
                {!focusId && constellation.size <= 30 && (
                  <text y={r + 20} textAnchor="middle" fontSize={12} fill="var(--ink-2)" className="atlas-label">
                    {shortLabel(node)}
                  </text>
                )}
                {!focusId && (
                  <circle
                    r={16}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`Map ${node.label}`}
                    className="cursor-pointer outline-none"
                    onClick={() => props.onFocus(id)}
                    onKeyDown={(event) => event.key === "Enter" && props.onFocus(id)}
                    onPointerEnter={(event) => showHover("node", id, event.currentTarget)}
                    onPointerLeave={() => setHover(null)}
                  />
                )}
              </g>
            );
          })}
        </g>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* The compass: relevance rings and kind-of-thing sectors. */}
          {geometry && settled && (
            <g aria-hidden className="atlas-fade-in">
              {SECTORS.map((s) => {
                const a = (s.start * Math.PI) / 180;
                return (
                  <line
                    key={s.id}
                    x1={geometry.cx + Math.cos(a) * (geometry.inner - 30)}
                    y1={geometry.cy + Math.sin(a) * (geometry.inner - 30)}
                    x2={geometry.cx + Math.cos(a) * (geometry.outer + 18)}
                    y2={geometry.cy + Math.sin(a) * (geometry.outer + 18)}
                    stroke="var(--line)"
                    strokeWidth={1}
                  />
                );
              })}
              {[0.75, 0.45, 0.2].map((t) => (
                <g key={t}>
                  <circle cx={geometry.cx} cy={geometry.cy} r={ringRadius(geometry, t)} fill="none" stroke="var(--line)" strokeWidth={1} />
                </g>
              ))}
              {SECTORS.map((s) => {
                const a = (((s.start + s.end) / 2) * Math.PI) / 180;
                const r = geometry.outer + 34;
                return (
                  <text
                    key={s.id}
                    x={geometry.cx + Math.cos(a) * r}
                    y={geometry.cy + Math.sin(a) * r + 4}
                    textAnchor={Math.cos(a) > 0.3 ? "start" : Math.cos(a) < -0.3 ? "end" : "middle"}
                    fontSize={11}
                    letterSpacing={0.6}
                    fill="var(--ink-2)"
                    className="atlas-label uppercase"
                  >
                    {s.label.toUpperCase()}
                  </text>
                );
              })}
              {/* The filter ring moves with the relevance bar: inside it is shown, outside it fades. */}
              <circle
                cx={geometry.cx}
                cy={geometry.cy}
                r={ringRadius(geometry, threshold)}
                fill="var(--accent)"
                fillOpacity={0.035}
                stroke="var(--accent)"
                strokeDasharray="4 6"
                strokeWidth={1.4}
                style={{ transition: reduced ? undefined : "r 250ms ease" }}
              />
              <text
                x={geometry.cx + Math.cos((18 * Math.PI) / 180) * ringRadius(geometry, threshold) + 6}
                y={geometry.cy + Math.sin((18 * Math.PI) / 180) * ringRadius(geometry, threshold) + 4}
                fontSize={11.5}
                fontWeight={600}
                fill="var(--accent-ink)"
                className="atlas-label"
              >
                {pct(threshold)} filter
              </text>
            </g>
          )}

          {/* Cluster hulls: same color halo = same mechanism cluster. */}
          {hulls.map((h) => {
            const pad = 40;
            const d = `M${h.hull.map((p) => p.join(" ")).join(" L")}${h.hull.length > 2 ? " Z" : ""}`;
            return (
              <g key={h.id} aria-hidden className="atlas-fade-in">
                <path d={d} fill={h.color} stroke={h.color} strokeWidth={pad * 2} strokeLinejoin="round" strokeLinecap="round" opacity={0.07} />
                <text x={(h.left + h.right) / 2} y={h.top - pad - 8} textAnchor="middle" fontSize={11.5} fill="var(--ink-2)" className="atlas-label">
                  {truncate(h.label, 40)}
                </text>
              </g>
            );
          })}

          {/* Lines: width, opacity and glow follow relevance; dashed = inferred; faint = just under the filter. */}
          {edgesToDraw.map(({ e, faint }) => {
            const a = positions.get(e.a);
            const b = positions.get(e.b);
            if (!a || !b) return null;
            const s = edgeStyle(e);
            const isSelected = selectedId === e.id;
            const active = touching ? touching.has(e.a) && touching.has(e.b) && (e.a === activeNode || e.b === activeNode) : false;
            const dim = touching && !active;
            const { d, mid } = curve(a, b, e.role);
            const showStrength = (active || isSelected || hover?.id === e.id) && e.role !== "bubble";
            const showBridgeLabel = e.role === "bridge" && (active || isSelected || hover?.id === e.id);
            const nodeA = nodeById.get(e.a);
            const nodeB = nodeById.get(e.b);
            const delay = reduced ? 0 : Math.max(nodeA?.hop ?? 0, nodeB?.hop ?? 0) * 110 + 420;
            return (
              <g key={e.id} className="atlas-fade-in" style={{ animationDelay: `${delay}ms`, opacity: faint ? 0.3 : dim ? 0.22 : 1 }}>
                {s.glow > 0 && !faint && (
                  <path d={d} fill="none" stroke="var(--accent)" strokeWidth={s.width + s.glow * 1.6} opacity={0.42} filter={`url(#glow-${uid})`} />
                )}
                <path
                  d={d}
                  fill="none"
                  stroke={isSelected || active ? (e.role === "similarity" ? "var(--accent)" : "var(--ink-2)") : s.color}
                  strokeWidth={isSelected ? s.width + 1.5 : s.width}
                  strokeDasharray={s.dash}
                  strokeLinecap="round"
                  opacity={isSelected ? 1 : s.opacity}
                />
                {showStrength && (
                  <g transform={`translate(${mid[0]} ${mid[1]})`} aria-hidden>
                    <rect x={-17} y={-10} width={34} height={18} rx={9} fill="var(--surface)" stroke="var(--line)" />
                    <text y={3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--ink)">
                      {pct(e.role === "bridge" ? e.relevance : e.strength)}
                    </text>
                  </g>
                )}
                {showBridgeLabel && (
                  <text x={mid[0]} y={mid[1] - 14} textAnchor="middle" fontSize={11.5} fill="var(--ink)" className="atlas-label">
                    {truncate(e.label, 40)}
                  </text>
                )}
                <path
                  d={d}
                  data-edge
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  className="cursor-pointer"
                  onPointerEnter={(event) => showHover("edge", e.id, event.currentTarget)}
                  onPointerLeave={() => setHover(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onSelect(e.id);
                  }}
                />
              </g>
            );
          })}

          {/* Nodes. Every neighborhood node stays mounted so moving the bar animates instead of jumping. */}
          {hoodNodes.map((n, i) => {
            const [x, y] = placeOf(n);
            const lv = level.get(n.id);
            const isFocus = n.role === "focus";
            const isVisible = isFocus || (settled && lv === "shown");
            const isGhost = !isFocus && settled && lv === "ghost";
            const r = nodeRadius(n, centralityOf(n.id));
            const isSelected = selectedId === n.id;
            const type = n.type === "Bubble" ? n.bubbleType! : n.type;
            const kind = KIND_STYLE[KIND_OF[type]];
            const isDisease = n.type === "Disease";
            const fill = isDisease ? clusterColor(relevance, n.cluster) : kind.fill;
            const opacity = isFocus ? 1 : isGhost ? 0.28 : !isVisible ? 0 : touching && !touching.has(n.id) ? 0.3 : 0.6 + 0.4 * n.relevance;
            const showLabel = isVisible && (labelled.has(n.id) || hover?.id === n.id || isSelected);
            const relevanceText = isFocus ? "what you searched" : `${pct(n.relevance)} relevant`;
            const tierWord = n.tier && n.tier !== "none" ? n.tier : "";
            const la = labelAnchor(n, positions.get(n.id) ?? [x, y]);
            const interactive = isVisible || isGhost;
            return (
              <g
                key={n.id}
                data-node
                role="button"
                tabIndex={isVisible ? 0 : -1}
                aria-hidden={!isVisible || undefined}
                aria-label={`${typeName(n)} ${n.label}, ${relevanceText}${n.kind ? `, ${n.kind}` : ""}`}
                aria-pressed={isSelected}
                className="atlas-node cursor-pointer outline-none"
                style={{ transform: `translate(${x}px, ${y}px)`, transition: transition(delayOf(n, i)), opacity, pointerEvents: interactive ? undefined : "none" }}
                onPointerEnter={(event) => showHover("node", n.id, event.currentTarget)}
                onPointerLeave={() => setHover(null)}
                onFocus={(event) => showHover("node", n.id, event.currentTarget)}
                onBlur={() => setHover(null)}
                onClick={(event) => {
                  event.stopPropagation();
                  // A bubble opens in place; its members then show on the map and in the panel.
                  if (n.role === "bubble") props.onToggleBubble(n.id);
                  else props.onSelect(n.id);
                }}
                onDoubleClick={() => n.role !== "bubble" && !isFocus && props.onFocus(n.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  if (event.shiftKey && n.role === "bubble") props.onToggleBubble(n.id);
                  else if (event.shiftKey && !isFocus) props.onFocus(n.id);
                  else if (n.role === "bubble") props.onToggleBubble(n.id);
                  else props.onSelect(n.id);
                }}
              >
                <circle r={r + 6} fill="none" stroke="var(--accent)" strokeWidth={2.5} className={isSelected ? undefined : "atlas-focus-ring"} />
                {n.role === "bubble" ? (
                  <>
                    <circle r={r} fill={kind.fill} stroke={kind.ink} strokeOpacity={0.6} strokeDasharray="3 2.5" strokeWidth={1.3} />
                    <text y={4} textAnchor="middle" fontSize={11.5} fontWeight={650} fill={kind.ink} className="atlas-label-plain">
                      {n.members?.length ?? ""}
                    </text>
                  </>
                ) : isDisease ? (
                  <>
                    <circle r={r} fill={fill} stroke={isFocus ? "var(--ink)" : "var(--surface)"} strokeWidth={isFocus ? 3 : 2} />
                    {isFocus && !reduced && <circle r={r + 10} fill="none" stroke={fill} strokeWidth={2} className="atlas-pulse" />}
                  </>
                ) : (
                  <>
                    <circle r={r} fill={kind.fill} stroke={isFocus ? "var(--ink)" : kind.ink} strokeOpacity={isFocus ? 1 : 0.45} strokeWidth={isFocus ? 3 : 1.3} />
                    <g transform={`translate(${-r * 0.62} ${-r * 0.62}) scale(${(r * 1.24) / 24})`}>
                      <path d={ICON_PATH[type]} fill="none" stroke={kind.ink} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                    </g>
                    {isFocus && !reduced && <circle r={r + 10} fill="none" stroke={kind.ink} strokeOpacity={0.5} strokeWidth={2} className="atlas-pulse" />}
                  </>
                )}
                {showLabel && (
                  <text x={la.x} y={la.y} textAnchor={la.anchor} fontSize={isFocus ? 15 : isDisease ? 13 : 12} fontWeight={isFocus ? 650 : isDisease ? 560 : 450} fill="var(--ink)" className="atlas-label">
                    {labelText(n)}
                    {isDisease && !isFocus && (
                      <tspan x={la.x} dy={15} fontSize={11.5} fontWeight={450} fill="var(--ink-2)">
                        {tierWord ? `${tierWord} · ` : ""}
                        {pct(n.relevance)}
                      </tspan>
                    )}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {focusId && (view.k !== 1 || view.x !== 0 || view.y !== 0) && (
        <button
          type="button"
          onClick={() => setView({ k: 1, x: 0, y: 0 })}
          className="absolute bottom-3 left-3 rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--ink-2)] shadow-sm hover:text-[var(--ink)]"
        >
          Reset view
        </button>
      )}

      {noneAtThreshold && filtered?.closestHidden && (
        <div className="absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[90%] rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--ink)] shadow-sm">
          <span>
            No related disease at {pct(threshold)} or above. The closest is{" "}
            <strong>{shortLabel(byId.get(filtered.closestHidden.id) ?? { label: filtered.closestHidden.id })}</strong> at {pct(filtered.closestHidden.relevance)}.
          </span>{" "}
          <button
            type="button"
            className="ml-2 rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white"
            onClick={() => props.onThreshold(Math.floor(filtered.closestHidden!.relevance * 100) / 100)}
          >
            Lower to {Math.floor(filtered.closestHidden.relevance * 100)}%
          </button>
        </div>
      )}
      {noRelated && focusNode && (
        <div className="absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[90%] rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--ink)] shadow-sm">
          No supported connection to another disease in this atlas yet. We searched genes, mechanisms, symptoms, groups and research linked to{" "}
          {shortLabel(focusNode)}.
        </div>
      )}

      {hover && (hoverNode || hoverEdge || (!focusId && byId.get(hover.id))) && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 w-max max-w-[300px] -translate-x-1/2 -translate-y-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs leading-snug text-[var(--ink)] shadow-md"
          style={{ left: hover.left, top: hover.top - 8 }}
        >
          {hoverNode ? (
            <>
              <div className="font-semibold">{hoverNode.label}</div>
              <div className="text-[var(--ink-2)]">
                {typeName(hoverNode)}
                {hoverNode.role !== "focus" && ` · ${pct(hoverNode.relevance)} relevant`}
                {hoverNode.kind && hoverNode.role !== "focus" && ` · ${hoverNode.kind}`}
                {level.get(hoverNode.id) === "ghost" && " · under your filter"}
              </div>
              <div className="mt-1">{hoverNode.why}</div>
              <div className="mt-1 text-[var(--ink-3)]">
                {hoverNode.role === "bubble" ? "Click to show them" : hoverNode.role === "focus" ? "Click for details" : "Click for the evidence · double-click to center here"}
              </div>
            </>
          ) : hoverEdge ? (
            <>
              <div className="font-semibold">{hoverEdge.label || "linked"}</div>
              <div className="text-[var(--ink-2)]">
                Strength {pct(hoverEdge.strength)} · {pct(hoverEdge.relevance)} relevant to {focusNode ? shortLabel(focusNode) : "your search"} ·{" "}
                {hoverEdge.kind === "observed" ? "stated by a source" : hoverEdge.kind === "mixed" ? "partly inferred" : "inferred"}
              </div>
              <div className="mt-1">
                Source:{" "}
                {[...new Set(hoverEdge.edgeIds.map((id) => edgeById.get(id)?.source).filter(Boolean))].slice(0, 3).join(", ") || "the grading layer"}
              </div>
              {mode === "researcher" && <div className="mt-1 text-[var(--ink-3)]">{hoverEdge.edgeIds.length} graph edges behind this line</div>}
            </>
          ) : (
            <div className="font-semibold">{byId.get(hover.id)?.label}</div>
          )}
        </div>
      )}
    </div>
  );
}
