"use client";

// The knowledge-graph map. Before a search it is a faint constellation of every disease in the atlas.
// After a search, what was searched sits in the center and everything else is placed with meaning:
// distance from the center is relevance (rings at the tier cutoffs, plus the filter ring that moves
// with the relevance bar) and direction is the kind of thing (diseases at the top, research upper
// right, groups and registries lower right, symptoms at the bottom, genes and mechanisms on the left).
// Line width, glow and opacity follow relevance; dashed lines are inferred; items just under the
// filter stay as faint ghosts so the user can see there is more. Labels never print over each
// other: a name that fits nowhere is left to hover and selection.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AtlasGraph, NodeType } from "@/lib/graph/types";
import type { RelevanceDoc } from "@/lib/grading/types";
import { applyThreshold, buildNeighborhood, type HoodEdge, type HoodNode } from "@/lib/graph/neighborhood";
import { SECTORS, radialLayout, ringRadius, type RadialNode } from "@/lib/viz/radialLayout";
import { separate } from "@/lib/viz/project3d";
import { ICON_PATH } from "@/lib/viz/icons";
import { TYPE_NAME } from "@/lib/graph/vocab";
import { KIND_OF, KIND_STYLE } from "./kinds";
import { formatPercent, isTier, tierWord } from "./format";
import { compactSynonym, displayName, distinctNames, fitName, wrapName } from "./names";
import { crowdedDiseases, mapNodeRadius } from "./mapSizes";

export interface KnowledgeGraphProps {
  graph: AtlasGraph;
  relevance: RelevanceDoc | null;
  focusId: string | null;
  selectedId: string | null; // a node id or a map edge id
  threshold: number; // 0..1
  thresholds: { strong: number; moderate: number; exploratory: number }; // the tier rings
  hiddenTypes: ReadonlySet<NodeType>;
  expanded: ReadonlySet<string>;
  mode: "parent" | "researcher";
  onFocus(id: string): void;
  onSelect(id: string | null): void;
  onToggleBubble(id: string): void;
  reserveTop?: number; // share of the height kept clear above the constellation before a search
  className?: string;
}

const W = 1200;
const H = 840;
const CONSTELLATION_PAD = 70;
const CONSTELLATION_GAP = 34; // closest two constellation dots may sit: their hover targets never overlap
// Text keeps a readable size on screen however small the map is drawn: a 12-unit label renders at
// about LABEL_PX pixels, never smaller than designed and never more than MAX_TEXT_SCALE times it.
const LABEL_PX = 10.5;
const MAX_TEXT_SCALE = 2.4;
// A name up to this many characters fits on one line of the map; longer ones wrap over two lines,
// or, where two lines do not fit, shorten in the middle and keep their distinguishing end.
const ONE_LINE = 26;
const TWO_LINES = 26;
// A label may cover this share of its own area with dots (it is drawn above them, with a halo),
// but never any of another label.
const DOT_OVERLAP = 0.08;

type Pt = [number, number];
type Box = [number, number, number, number]; // left, top, right, bottom
type Anchor = { x: number; y: number; anchor: "start" | "middle" | "end" }; // first baseline, from the node
interface LabelSpec {
  lines: string[];
  tier: string; // the related disease's grade line, or ""
  size: number;
  weight: number;
}
interface PlacedLabel {
  spec: LabelSpec;
  at: Anchor;
}

const overlaps = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

interface Hover {
  kind: "node" | "edge";
  id: string;
  left: number; // px inside the container
  top: number; // px inside the container: the target's top edge
  bottom: number; // and its bottom edge
  below: boolean; // open below the target (it sits in the lower half of the map), room permitting
}

function clusterColor(relevance: RelevanceDoc | null, cluster: string | null | undefined): string {
  const slot = relevance?.clusters.find((c) => c.id === cluster)?.color_slot;
  return slot ? `var(--series-${slot})` : "var(--node-gray)";
}

function typeName(n: HoodNode): string {
  if (n.type === "Bubble") return `${TYPE_NAME[n.bubbleType!].many}, folded`;
  return TYPE_NAME[n.type].one;
}

const pct = formatPercent;

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

// Distance from p to the segment a-b, and how far along it (0..1) the closest point lies.
function toSegment(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
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
  const { graph, relevance, focusId, selectedId, threshold, thresholds, hiddenTypes, expanded, mode } = props;
  const uid = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // How large the map is drawn, so labels can keep a readable size on screen (ts = text scale).
  const [drawn, setDrawn] = useState(0.7);
  const [boxWidth, setBoxWidth] = useState(600);
  const [boxHeight, setBoxHeight] = useState(420);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setDrawn(Math.min(width / W, height / H));
      if (width > 0) setBoxWidth(width);
      if (height > 0) setBoxHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ts = Math.round(Math.min(MAX_TEXT_SCALE, Math.max(1, LABEL_PX / (12 * drawn))) * 20) / 20;

  // Label widths: estimated on the server and in the first render (so hydration matches), then
  // measured with the page's own font, so labels are placed by their real size.
  const [measureText, setMeasureText] = useState<((text: string, size: number, weight: number) => number) | null>(null);
  useEffect(() => {
    const context = document.createElement("canvas").getContext("2d");
    const el = containerRef.current;
    if (!context || !el) return;
    const family = getComputedStyle(el).fontFamily;
    const cache = new Map<string, number>();
    setMeasureText(() => (text: string, size: number, weight: number) => {
      const key = `${weight}|${text}`;
      let unit = cache.get(key);
      if (unit === undefined) {
        context.font = `${weight} 100px ${family}`;
        unit = context.measureText(text).width / 100;
        cache.set(key, unit);
      }
      return unit * size;
    });
  }, []);
  const textWidth = (text: string, size: number, weight: number) => (measureText ? measureText(text, size, weight) : text.length * size * (weight >= 560 ? 0.6 : 0.56));

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const edgeById = useMemo(() => new Map(graph.edges.map((e) => [e.id, e])), [graph]);
  const centralityOf = (id: string) => relevance?.diseases[id]?.centrality ?? 0;
  const focusNode = focusId ? byId.get(focusId) : undefined;
  // One short name per disease of the atlas, never two alike ("oculocutaneous… type 1A").
  const diseaseNames = useMemo(() => distinctNames(graph.nodes.filter((n) => n.type === "Disease"), ONE_LINE), [graph]);

  // Constellation: every disease at its 2D projection of the 3D similarity layout. Before a search it
  // sits below the reserved top band, leaving room for the search card.
  const reserveTop = focusId ? 0 : (props.reserveTop ?? 0);
  const constellation = useMemo(() => {
    const out = new Map<string, Pt>();
    const diseases = graph.nodes.filter((n) => n.type === "Disease");
    const top = H * reserveTop + CONSTELLATION_PAD;
    const raw = diseases.map((n, i): Pt => {
      const c = relevance?.diseases[n.id]?.coords3d;
      const x = c ? c[0] : Math.cos((i / Math.max(diseases.length, 1)) * 2 * Math.PI) * 0.8;
      const y = c ? c[1] : Math.sin((i / Math.max(diseases.length, 1)) * 2 * Math.PI) * 0.8;
      return [W / 2 + x * (W / 2 - CONSTELLATION_PAD), top + ((y + 1) / 2) * (H - CONSTELLATION_PAD - top)];
    });
    // Diseases that share no biology all sit at the middle of the similarity layout: spread them
    // so every dot can be seen and pointed at, each staying near its place. A small atlas writes
    // names under its dots, so its dots keep a name's width apart.
    const gap = diseases.length <= 30 ? Math.max(CONSTELLATION_GAP, 46 * ts) : CONSTELLATION_GAP;
    const spread = separate(raw, gap, { min: [CONSTELLATION_PAD, top], max: [W - CONSTELLATION_PAD, H - CONSTELLATION_PAD] });
    diseases.forEach((n, i) => out.set(n.id, [Math.round(spread[i][0] * 100) / 100, Math.round(spread[i][1] * 100) / 100]));
    return out;
  }, [graph, relevance, reserveTop, ts]);

  // The neighborhood and its layout. Layout uses every node at every relevance, so moving the bar
  // only shows and hides; nothing jumps.
  const hood = useMemo(() => (focusId ? buildNeighborhood(graph, relevance, focusId, { expanded }) : null), [graph, relevance, focusId, expanded]);
  const crowded = crowdedDiseases(hood);
  // Short names for everything else on the map, never two alike ("Developmental… Ductal Cells").
  const nodeNames = useMemo(
    () => distinctNames((hood?.nodes ?? []).filter((n) => n.type !== "Disease").map((n) => ({ id: n.id, label: n.role === "bubble" ? n.label.replace(/^\d+ /, "") : n.label })), ONE_LINE),
    [hood],
  );
  const radiusOf = (n: HoodNode) => mapNodeRadius(n, centralityOf(n.id), crowded);
  const layout = useMemo(() => {
    if (!hood) return null;
    const nodes: RadialNode[] = hood.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      bubbleType: n.bubbleType,
      role: n.role,
      relevance: n.relevance,
      ownerRank: n.ownerRank,
      radius: mapNodeRadius(n, relevance?.diseases[n.id]?.centrality ?? 0, crowdedDiseases(hood)) + 2,
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

  const hoodNodes = hood?.nodes ?? [];
  const nodeById = new Map(hoodNodes.map((n) => [n.id, n]));
  const center: Pt = geometry ? [geometry.cx, geometry.cy] : [W / 2, H / 2];

  // Where a point of the map is on screen, inside the container: for tooltips.
  const toScreen = (p: Pt): Pt | null => {
    const svg = svgRef.current;
    const box = containerRef.current?.getBoundingClientRect();
    if (!svg || !box) return null;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const ox = rect.left - box.left + (rect.width - W * scale) / 2;
    const oy = rect.top - box.top + (rect.height - H * scale) / 2;
    return [ox + (p[0] * view.k + view.x) * scale, oy + (p[1] * view.k + view.y) * scale];
  };
  const showNodeHover = (id: string, target: Element) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const r = target.getBoundingClientRect();
    const p = positions.get(id);
    // Nodes below the center open their tooltip below, away from their own line and its pill.
    const below = !!focusId && !!p && p[1] > center[1] + 4;
    setHover({ kind: "node", id, left: r.left + r.width / 2 - box.left, top: r.top - box.top, bottom: r.bottom - box.top, below });
  };
  const showEdgeHover = (id: string, clientX: number, clientY: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    const c = toScreen(center);
    if (!box || !c) return;
    const y = clientY - box.top;
    setHover({ kind: "edge", id, left: clientX - box.left, top: y - 14, bottom: y + 14, below: y > c[1] });
  };

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

  // ---------- names on the map ----------

  // The full name: a disease's compact synonym or label; a folded group's label without its count
  // (the count is in the bubble).
  function fullName(n: HoodNode): string {
    if (n.role === "bubble") return n.label.replace(/^\d+ /, "");
    const node = byId.get(n.id);
    return (node && compactSynonym(node)) ?? n.label;
  }

  // The grade line under a related disease's name: its tier and relevance.
  function tierText(n: HoodNode): string {
    if (n.type !== "Disease" || n.role === "focus" || n.role === "anchor") return "";
    const word = n.tier && n.tier !== "none" ? `${tierWord(n.tier).toLowerCase()} · ` : "";
    return `${word}${pct(n.relevance)}`;
  }

  // The ways a node's name can be written. Compact: one line (the whole name, or a short form that
  // keeps what tells it apart), with the grade line under a related disease, then without it.
  // Full: wrapped whole over two lines. Every label first gets a compact form, then grows into a
  // full one where there is room.
  function labelForms(n: HoodNode): { compact: LabelSpec[]; full: LabelSpec[] } {
    const isDisease = n.type === "Disease";
    const size = n.role === "focus" ? 15 : isDisease ? 13 : 12;
    const weight = n.role === "focus" ? 650 : isDisease ? 560 : 450;
    const name = fullName(n);
    if (n.role === "focus") return { compact: [{ lines: wrapName(name, 28, 3), tier: "", size, weight }], full: [] };
    const tier = tierText(n);
    const short = name.length <= ONE_LINE ? name : isDisease ? (diseaseNames.get(n.id) ?? fitName(name, ONE_LINE)) : (nodeNames.get(n.id) ?? fitName(name, ONE_LINE));
    const spec = (lines: string[], withTier: string): LabelSpec => ({ lines, tier: withTier, size, weight });
    const compact = tier ? [spec([short], tier), spec([short], "")] : [spec([short], "")];
    if (name.length <= ONE_LINE) return { compact, full: [] };
    const two = wrapName(name, TWO_LINES, 2);
    return { compact, full: tier ? [spec(two, tier), spec(two, "")] : [spec(two, "")] };
  }
  const labelSpecs = (n: HoodNode): LabelSpec[] => {
    const { compact, full } = labelForms(n);
    return [...full, ...compact];
  };

  const lineHeight = (spec: LabelSpec) => spec.size * 1.2 * ts;
  const tierHeight = 15 * ts;
  // The text's extent around its first baseline, as the browser measures it (font ascent and
  // descent), so two labels that do not touch here do not touch on screen.
  const below = (spec: LabelSpec) => (spec.lines.length - 1) * lineHeight(spec) + (spec.tier ? tierHeight : 0) + 0.26 * (spec.tier ? 11.5 : spec.size) * ts;
  const ascent = (spec: LabelSpec) => spec.size * 0.96 * ts;

  // Where a label can go, best first: below the searched node; otherwise outward from the center,
  // then to the right, left, above or below its dot.
  function labelAnchors(n: HoodNode, p: Pt, spec: LabelSpec): Anchor[] {
    const r = radiusOf(n);
    if (n.role === "focus") return [{ x: 0, y: r + 6 + ascent(spec), anchor: "middle" }];
    const off = r + 6;
    const middle = -(ascent(spec) + below(spec)) / 2 + ascent(spec); // a baseline that centers the block on the dot
    const under: Anchor = { x: 0, y: off + ascent(spec), anchor: "middle" };
    const over: Anchor = { x: 0, y: -off - below(spec), anchor: "middle" };
    const right: Anchor = { x: off, y: middle, anchor: "start" };
    const left: Anchor = { x: -off, y: middle, anchor: "end" };
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const radial: Anchor = Math.abs(ux) < 0.35 ? (uy > 0 ? under : over) : { x: ux * off, y: uy * off + middle, anchor: ux > 0 ? "start" : "end" };
    return [radial, ...[right, left, over, under].filter((a) => a !== radial)];
  }

  function labelBox(p: Pt, spec: LabelSpec, a: Anchor): Box {
    const w = Math.max(...spec.lines.map((l) => textWidth(l, spec.size, spec.weight)), spec.tier ? textWidth(spec.tier, 11.5, 450) : 0) * ts;
    const x = p[0] + a.x;
    const y = p[1] + a.y;
    const left = a.anchor === "start" ? x : a.anchor === "end" ? x - w : x - w / 2;
    // A little air around the text, so two labels never touch.
    return [left - 3 * ts, y - ascent(spec) - 1.5 * ts, left + w + 3 * ts, y + below(spec) + 1.5 * ts];
  }

  // A direction's name at the rim of the map. Two-word names ("Genes and mechanisms") break after
  // "and" so they stay inside the map when it is drawn small.
  function sectorLabel(s: (typeof SECTORS)[number], g: NonNullable<typeof geometry>) {
    const a = (((s.start + s.end) / 2) * Math.PI) / 180;
    const size = 11 * ts;
    const words = s.label.toUpperCase().split(" AND ");
    const lines = words.length === 2 ? [`${words[0]} AND`, words[1]] : [s.label.toUpperCase()];
    const anchor: Anchor["anchor"] = Math.cos(a) > 0.3 ? "start" : Math.cos(a) < -0.3 ? "end" : "middle";
    // Names above the map grow upward, names below grow downward, so neither runs into the rings.
    const lift = Math.sin(a) < -0.3 ? (lines.length - 1) * size * 1.2 : Math.sin(a) > 0.3 ? 0 : ((lines.length - 1) * size * 1.2) / 2;
    return { x: g.cx + Math.cos(a) * (g.outer + 34), y: g.cy + Math.sin(a) * (g.outer + 34) + 4 - lift, anchor, lines, size };
  }

  const filterLabelAt = (g: NonNullable<typeof geometry>): Pt => {
    const r = ringRadius(g, threshold);
    return [g.cx + Math.cos((18 * Math.PI) / 180) * r + 6, g.cy + Math.sin((18 * Math.PI) / 180) * r + 4];
  };

  // Labels: the searched node always; diseases, then everything else, where they fit. Each takes
  // the first of its forms and places that covers no other label and stays inside the map; a label
  // that fits nowhere is left to hover and selection.
  const labels = useMemo(() => {
    const placed = new Map<string, PlacedLabel>();
    const boxes: Box[] = [];
    const obstacles: [string, Box][] = [];
    if (!filtered || !geometry) return { placed, boxes, obstacles };
    // The direction names at the rim and the filter's own label are placed first.
    for (const s of SECTORS) {
      const { x, y, anchor, lines, size } = sectorLabel(s, geometry);
      const w = Math.max(...lines.map((l) => l.length)) * size * 0.68;
      const left = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
      boxes.push([left, y - size, left + w, y + 3 + (lines.length - 1) * size * 1.2]);
    }
    {
      const [x, y] = filterLabelAt(geometry);
      boxes.push([x, y - 11.5 * ts, x + `${pct(threshold)} filter`.length * 11.5 * 0.56 * ts, y + 3 * ts]);
    }
    for (const n of filtered.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const r = radiusOf(n);
      obstacles.push([n.id, [p[0] - r, p[1] - r, p[0] + r, p[1] + r]]);
    }
    const order: HoodNode["role"][] = ["focus", "anchor", "related", "attribute", "group", "bubble", "research", "symptom"];
    const nodes = [...filtered.nodes].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.relevance - a.relevance);
    const inside = (b: Box) => b[0] >= 4 && b[1] >= 4 && b[2] <= W - 4 && b[3] <= H - 4;
    const ownBox = new Map<string, Box>();
    // The first form and place that covers no other label, few dots, and stays inside the map.
    const firstFit = (n: HoodNode, p: Pt, specs: LabelSpec[], skip?: string): PlacedLabel | null => {
      for (const spec of specs) {
        for (const at of labelAnchors(n, p, spec)) {
          const box = labelBox(p, spec, at);
          if (!inside(box)) continue;
          if ([...ownBox].some(([id, b]) => id !== skip && overlaps(box, b)) || boxes.some((b) => overlaps(box, b))) continue;
          const onDots = obstacles.reduce((sum, [id, b]) => sum + (id === n.id ? 0 : overlapArea(box, b)), 0);
          if (onDots <= DOT_OVERLAP * area(box)) return { spec, at };
        }
      }
      return null;
    };
    // Pass 1: every label in its compact form, so as many things as possible are named.
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const { compact } = labelForms(n);
      let chosen = firstFit(n, p, compact);
      // The searched node is always named, in its least crowded place.
      if (!chosen && n.role === "focus") {
        let least = Infinity;
        for (const spec of compact) {
          for (const at of labelAnchors(n, p, spec)) {
            const box = labelBox(p, spec, at);
            const cost = [...ownBox.values(), ...boxes].reduce((sum, b) => sum + overlapArea(box, b), 0) + (inside(box) ? 0 : area(box));
            if (cost < least) {
              least = cost;
              chosen = { spec, at };
            }
          }
        }
      }
      if (!chosen) continue;
      placed.set(n.id, chosen);
      ownBox.set(n.id, labelBox(p, chosen.spec, chosen.at));
    }
    // Pass 2: where there is room, a shortened name grows back to its whole name over two lines.
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p || !placed.has(n.id)) continue;
      const { full } = labelForms(n);
      if (!full.length) continue;
      const current = placed.get(n.id)!;
      const grown = firstFit(n, p, full.filter((spec) => !!spec.tier === !!current.spec.tier), n.id);
      if (!grown) continue;
      placed.set(n.id, grown);
      ownBox.set(n.id, labelBox(p, grown.spec, grown.at));
    }
    // Pass 3: a label that grew may have moved away from a place another one wanted.
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p || placed.has(n.id)) continue;
      const chosen = firstFit(n, p, labelForms(n).compact);
      if (!chosen) continue;
      placed.set(n.id, chosen);
      ownBox.set(n.id, labelBox(p, chosen.spec, chosen.at));
    }
    boxes.push(...ownBox.values());
    return { placed, boxes, obstacles };
  }, [filtered, positions, geometry, byId, relevance, ts, threshold, diseaseNames, nodeNames, crowded, measureText]);

  // A label shown because its node is pointed at or selected, where no place was free.
  const looseLabel = (n: HoodNode): PlacedLabel | null => {
    const p = positions.get(n.id);
    if (!p) return null;
    const spec = labelSpecs(n)[0];
    return { spec, at: labelAnchors(n, p, spec)[0] };
  };

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
    // A cluster's name goes above its halo, else below it, and is left out where it would cover a
    // label or a dot: the halo color and the legend still say what it is.
    const taken: Box[] = [...labels.boxes, ...labels.obstacles.map(([, b]) => b)];
    const pad = 40;
    return [...groups]
      .filter(([, pts]) => pts.length > 1)
      .map(([id, pts]) => {
        const label = fitName(relevance?.clusters.find((c) => c.id === id)?.label ?? id, 40);
        const top = Math.min(...pts.map((p) => p[1]));
        const bottom = Math.max(...pts.map((p) => p[1]));
        const mid = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
        const w = label.length * 11.5 * 0.54 * ts;
        let labelY: number | null = null;
        for (const y of [top - pad - 8, bottom + pad + 14 * ts]) {
          const box: Box = [mid - w / 2, y - 11 * ts, mid + w / 2, y + 3 * ts];
          if (box[1] > 4 && box[3] < H - 4 && !taken.some((b) => overlaps(box, b))) {
            labelY = y;
            taken.push(box);
            break;
          }
        }
        return { id, label, color: clusterColor(relevance, id), hull: convexHull(pts), labelX: mid, labelY };
      });
  }, [filtered, positions, relevance, settled, labels, ts]);

  const hoverNode = hover?.kind === "node" ? nodeById.get(hover.id) : undefined;
  const hoverEdge = hover?.kind === "edge" ? [...(filtered?.edges ?? []), ...(filtered?.faintEdges ?? [])].find((e) => e.id === hover.id) : undefined;

  // Shown nodes a line from the center could run through.
  const blockers = useMemo(
    () => (filtered?.nodes ?? []).flatMap((n) => (n.role === "focus" || !positions.get(n.id) ? [] : [{ id: n.id, p: positions.get(n.id)!, r: radiusOf(n) }])),
    [filtered, positions, crowded],
  );

  // A line's path, the point its strength pill prefers, and any point along it (for a pill that
  // has to move to stay clear of labels and dots).
  const curve = (e: HoodEdge, a: Pt, b: Pt): { d: string; mid: Pt; at(t: number): Pt } => {
    const atCenter = (p: Pt) => Math.hypot(p[0] - center[0], p[1] - center[1]) < 2;
    const quad = (from: Pt, c: Pt, to: Pt) => (u: number): Pt => [
      (1 - u) * (1 - u) * from[0] + 2 * (1 - u) * u * c[0] + u * u * to[0],
      (1 - u) * (1 - u) * from[1] + 2 * (1 - u) * u * c[1] + u * u * to[1],
    ];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (atCenter(a) || atCenter(b)) {
      // Lines from the center are straight, unless one would run through another node: then it
      // bows around it, and its strength pill sits past that node.
      const [from, to] = atCenter(a) ? [a, b] : [b, a];
      const block = blockers
        .filter((x) => x.id !== e.a && x.id !== e.b)
        .map((x) => ({ ...x, ...toSegment(x.p, from, to) }))
        .filter((x) => x.d < x.r + 5 && x.t > 0.05 && x.t < 0.95)
        .sort((x, y) => x.t - y.t)[0];
      if (!block) {
        const line = (u: number): Pt => [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
        return { d: `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`, mid, at: line };
      }
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const len = Math.hypot(dx, dy) || 1;
      // Bow to the side away from the blocking node.
      const side = (block.p[0] - from[0]) * -dy + (block.p[1] - from[1]) * dx > 0 ? -1 : 1;
      const bow = (block.r + 18) * 2;
      const c: Pt = [mid[0] + (-dy / len) * bow * side, mid[1] + (dx / len) * bow * side];
      const t = Math.min(0.85, Math.max(0.6, block.t + (block.r + 24) / len));
      const q = quad(from, c, to);
      return { d: `M${from[0]} ${from[1]} Q${c[0]} ${c[1]} ${to[0]} ${to[1]}`, mid: q(t), at: q };
    }
    const bow = e.role === "bridge" ? 0.42 : 0.24;
    const c: Pt = [mid[0] + (mid[0] - center[0]) * bow, mid[1] + (mid[1] - center[1]) * bow];
    const q = quad(a, c, b);
    return { d: `M${a[0]} ${a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`, mid: q(0.5), at: q };
  };

  const edgesToDraw = settled && filtered ? [...filtered.faintEdges.map((e) => ({ e, faint: true })), ...filtered.edges.map((e) => ({ e, faint: false }))] : [];
  const pillText = (e: HoodEdge) => pct(e.role === "bridge" ? e.relevance : e.strength);
  const pillWidth = (e: HoodEdge) => pillText(e).length * 6.6 + 12;

  // Strength pills on the lines of the hovered or selected node, and on a hovered or selected line,
  // the pointed-at line first and then the strongest. A pill never covers a dot, a label or another
  // pill; one that would is left out (hovering its line still shows it).
  const pills = new Map<string, Pt>();
  {
    const isActive = (e: HoodEdge) => !!touching && touching.has(e.a) && touching.has(e.b) && (e.a === activeNode || e.b === activeNode);
    const pointed = (e: HoodEdge) => e.id === hover?.id || e.id === selectedId;
    const placed: Box[] = [];
    for (const { e } of edgesToDraw
      .filter(({ e }) => e.role !== "bubble" && (pointed(e) || isActive(e)))
      .sort((x, y) => Number(pointed(y.e)) - Number(pointed(x.e)) || y.e.relevance - x.e.relevance)) {
      const a = positions.get(e.a);
      const b = positions.get(e.b);
      if (!a || !b) continue;
      const path = curve(e, a, b);
      const half = (pillWidth(e) / 2) * ts;
      const boxAt = (p: Pt): Box => [p[0] - half, p[1] - 10 * ts, p[0] + half, p[1] + 8 * ts];
      const blocked = (box: Box) =>
        placed.some((p) => overlaps(box, p)) || labels.obstacles.some(([, o]) => overlaps(box, o)) || labels.boxes.some((l) => overlaps(box, l));
      // The middle of the line first, then points along it, until one is clear.
      const spot = [path.mid, ...[0.4, 0.6, 0.3, 0.7, 0.22, 0.78].map((t) => path.at(t))].find((p) => !blocked(boxAt(p)));
      if (!spot) continue;
      placed.push(boxAt(spot));
      pills.set(e.id, spot);
    }
  }

  const nameOf = (id: string) => {
    const n = nodeById.get(id);
    if (!n) return id;
    if (n.role === "bubble") return n.label;
    return displayName({ label: n.label, synonyms: byId.get(id)?.synonyms }, 34);
  };
  // What a hovered line says: the relation in words, between the two things it joins.
  const edgeTitle = (e: HoodEdge) => {
    if (e.role === "similarity") return `${nameOf(e.a)} and ${nameOf(e.b)} share biology`;
    if (e.role === "bridge") return `${nameOf(e.a)} and ${nameOf(e.b)}: ${e.label}`;
    if (e.role === "bubble") return `${nameOf(e.a)} → ${nameOf(e.b)}`;
    return `${nameOf(e.a)} ${e.label || "is linked to"} ${nameOf(e.b)}`;
  };

  const ringValues = [thresholds.strong, thresholds.moderate, thresholds.exploratory].filter((t) => t > 0 && t < 1);

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

        {/* Constellation dots: every disease. Once something is centered they fade away: their
            places mean nothing on the radial map. */}
        <g aria-hidden={focusId ? true : undefined} style={{ pointerEvents: focusId ? "none" : undefined }}>
          {[...constellation].map(([id, [x, y]], i) => {
            if (focusId && nodeById.has(id) && (level.has(id) || nodeById.get(id)?.role === "focus")) return null;
            const node = byId.get(id)!;
            const r = 3 + 3 * centralityOf(id);
            return (
              <g key={id} transform={`translate(${x} ${y})`} style={{ opacity: focusId && settled ? 0 : 1, transition: reduced ? undefined : "opacity 600ms ease" }}>
                <circle
                  r={focusId ? r : r + 3}
                  fill={focusId ? "var(--node-gray)" : clusterColor(relevance, relevance?.diseases[id]?.cluster)}
                  className={focusId || reduced ? undefined : "atlas-twinkle"}
                  style={{ opacity: focusId ? 0.16 : 0.75, animationDelay: `${(i % 7) * 0.6}s` }}
                />
                {/* Small atlases get names on the dots; big ones rely on hover. */}
                {!focusId && constellation.size <= 30 && (
                  <text y={r + 8 + 12 * ts} textAnchor="middle" fontSize={12 * ts} fill="var(--ink-2)" className="atlas-label">
                    {diseaseNames.get(id) ?? node.label}
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
                    onPointerEnter={(event) => showNodeHover(id, event.currentTarget)}
                    onPointerLeave={() => setHover(null)}
                  />
                )}
              </g>
            );
          })}
        </g>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* The compass: relevance rings at the grade cutoffs and kind-of-thing sectors. */}
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
              {ringValues.map((t) => (
                <circle key={t} cx={geometry.cx} cy={geometry.cy} r={ringRadius(geometry, t)} fill="none" stroke="var(--line)" strokeWidth={1} />
              ))}
              {SECTORS.map((s) => {
                const label = sectorLabel(s, geometry);
                return (
                  <text
                    key={s.id}
                    x={label.x}
                    y={label.y}
                    textAnchor={label.anchor}
                    fontSize={label.size}
                    letterSpacing={0.6}
                    fill="var(--ink-2)"
                    className="atlas-label uppercase"
                  >
                    {label.lines.map((line, i) => (
                      <tspan key={line} x={label.x} dy={i === 0 ? 0 : label.size * 1.2}>
                        {line}
                      </tspan>
                    ))}
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
              <text x={filterLabelAt(geometry)[0]} y={filterLabelAt(geometry)[1]} fontSize={11.5 * ts} fontWeight={600} fill="var(--accent-ink)" className="atlas-label">
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
                {h.labelY !== null && (
                  <text x={h.labelX} y={h.labelY} textAnchor="middle" fontSize={11.5 * ts} fill="var(--ink-2)" className="atlas-label">
                    {h.label}
                  </text>
                )}
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
            const { d, mid } = curve(e, a, b);
            const pill = pills.get(e.id);
            const showBridgeLabel = e.role === "bridge" && (isSelected || hover?.id === e.id);
            const nodeA = nodeById.get(e.a);
            const nodeB = nodeById.get(e.b);
            const delay = reduced ? 0 : Math.max(nodeA?.hop ?? 0, nodeB?.hop ?? 0) * 110 + 420;
            const width = pillWidth(e);
            // The opacity sits on an outer group: the fade-in animation ends at opacity 1 and, with
            // fill-mode both, would override an opacity set on its own element.
            return (
              <g key={e.id} style={{ opacity: faint ? 0.3 : dim ? 0.22 : 1 }}>
                <g className="atlas-fade-in" style={{ animationDelay: `${delay}ms` }}>
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
                  {pill && (
                    <g transform={`translate(${pill[0]} ${pill[1]}) scale(${ts})`} aria-hidden>
                      <rect x={-width / 2} y={-10} width={width} height={18} rx={9} fill="var(--surface)" stroke="var(--line)" />
                      <text y={3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="var(--ink)">
                        {pillText(e)}
                      </text>
                    </g>
                  )}
                  {showBridgeLabel && (
                    <text x={mid[0]} y={mid[1] - 14 * ts} textAnchor="middle" fontSize={11.5 * ts} fill="var(--ink)" className="atlas-label">
                      {fitName(e.label, 40)}
                    </text>
                  )}
                  <path
                    d={d}
                    data-edge
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="cursor-pointer"
                    onPointerEnter={(event) => showEdgeHover(e.id, event.clientX, event.clientY)}
                    onPointerMove={(event) => showEdgeHover(e.id, event.clientX, event.clientY)}
                    onPointerLeave={() => setHover(null)}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onSelect(e.id);
                    }}
                  />
                </g>
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
            const r = radiusOf(n);
            const isSelected = selectedId === n.id;
            const type = n.type === "Bubble" ? n.bubbleType! : n.type;
            const kind = KIND_STYLE[KIND_OF[type]];
            const isDisease = n.type === "Disease";
            const fill = isDisease ? clusterColor(relevance, n.cluster) : kind.fill;
            const opacity = isFocus ? 1 : isGhost ? 0.28 : !isVisible ? 0 : touching && !touching.has(n.id) ? 0.3 : 0.6 + 0.4 * n.relevance;
            const relevanceText = isFocus ? "what you searched" : `${pct(n.relevance)} relevant`;
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
                onPointerEnter={(event) => showNodeHover(n.id, event.currentTarget)}
                onPointerLeave={() => setHover(null)}
                onFocus={(event) => showNodeHover(n.id, event.currentTarget)}
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
              </g>
            );
          })}

          {/* Names, above every dot and line, so nothing covers them. */}
          <g aria-hidden className="pointer-events-none">
            {hoodNodes.map((n, i) => {
              const isFocus = n.role === "focus";
              const isVisible = isFocus || (settled && level.get(n.id) === "shown");
              if (!isVisible) return null;
              const pointedAt = hover?.id === n.id || selectedId === n.id;
              const label = labels.placed.get(n.id) ?? (pointedAt ? looseLabel(n) : null);
              if (!label) return null;
              const [x, y] = placeOf(n);
              const { spec, at } = label;
              const dimmed = touching && !touching.has(n.id);
              return (
                <g key={n.id} style={{ transform: `translate(${x}px, ${y}px)`, transition: transition(delayOf(n, i)), opacity: dimmed ? 0.35 : 1 }}>
                  <text x={at.x} y={at.y} textAnchor={at.anchor} fontSize={spec.size * ts} fontWeight={spec.weight} fill="var(--ink)" className="atlas-label">
                    {spec.lines.map((line, k) => (
                      <tspan key={k} x={at.x} dy={k === 0 ? 0 : lineHeight(spec)}>
                        {line}
                      </tspan>
                    ))}
                    {spec.tier && (
                      <tspan x={at.x} dy={tierHeight} fontSize={11.5 * ts} fontWeight={450} fill="var(--ink-2)">
                        {spec.tier}
                      </tspan>
                    )}
                  </text>
                </g>
              );
            })}
          </g>
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

      {hover && (hoverNode || hoverEdge || (!focusId && byId.get(hover.id))) && (
        <Tooltip hover={hover} width={boxWidth} height={boxHeight}>
          {hoverNode ? (
            <>
              <div className="font-semibold">{hoverNode.label}</div>
              <div className="text-[var(--ink-2)]">
                {typeName(hoverNode)}
                {hoverNode.role !== "focus" && ` · ${pct(hoverNode.relevance)} relevant`}
                {hoverNode.kind && hoverNode.role !== "focus" && ` · ${hoverNode.kind}`}
                {hoverNode.tier && hoverNode.role === "related" && !isTier(hoverNode.tier) && ` · ${tierWord(hoverNode.tier).toLowerCase()}`}
                {level.get(hoverNode.id) === "ghost" && " · under your filter"}
              </div>
              <div className="mt-1">{hoverNode.why}</div>
              <div className="mt-1 text-[var(--ink-3)]">
                {hoverNode.role === "bubble" ? "Click to show them" : hoverNode.role === "focus" ? "Click for details" : "Click for the evidence · double-click to center here"}
              </div>
            </>
          ) : hoverEdge ? (
            <>
              <div className="font-semibold">{edgeTitle(hoverEdge)}</div>
              <div className="text-[var(--ink-2)]">
                Strength {pct(hoverEdge.strength)} · {pct(hoverEdge.relevance)} relevant to {focusNode ? displayName(focusNode, 34) : "your search"} ·{" "}
                {hoverEdge.kind === "observed"
                  ? hoverEdge.role === "similarity"
                    ? "main evidence stated by a source"
                    : "stated by a source"
                  : hoverEdge.kind === "mixed"
                    ? "partly inferred"
                    : "inferred"}
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
        </Tooltip>
      )}
    </div>
  );
}

// A tooltip that opens away from the center of the map (so it never hides the line it describes)
// and stays inside the map: it flips when there is no room on that side.
const TOOLTIP_ROOM = 150; // px a tooltip may need
function Tooltip({ hover, width, height, children }: { hover: Hover; width: number; height: number; children: ReactNode }) {
  const half = Math.min(150, (width - 16) / 2);
  const left = Math.min(Math.max(hover.left, 8 + half), width - 8 - half);
  const roomBelow = height - hover.bottom - 8;
  const roomAbove = hover.top - 8;
  const below = hover.below ? roomBelow >= TOOLTIP_ROOM || roomBelow > roomAbove : roomAbove < TOOLTIP_ROOM && roomBelow > roomAbove;
  return (
    <div
      role="tooltip"
      className={`pointer-events-none absolute z-10 w-max -translate-x-1/2 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs leading-snug text-[var(--ink)] shadow-md ${below ? "" : "-translate-y-full"}`}
      style={{ left, top: below ? hover.bottom + 8 : hover.top - 8, maxWidth: half * 2 }}
    >
      {children}
    </div>
  );
}
