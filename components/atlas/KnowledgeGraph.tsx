"use client";

// The knowledge-graph map. Before a search it is the RareVerse universe: every disease as a point of
// light, the ones that share biology gathered in colored groups. After a search, what was searched
// sits in the center as a calm white disc and everything else is placed with meaning: distance from
// the center is relevance (faint rings at the tier cutoffs, plus the dashed filter ring that moves
// with the relevance bar) and direction is the kind of thing (diseases at the top, research upper
// right, groups lower right, symptoms at the bottom, genes and pathways on the left). The five most
// related diseases are the largest marks and carry their grade; line width follows the tier;
// dashed lines are inferred. Only a few names are printed (labelBudget.ts) and never over each
// other; every other name shows on hover and selection.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AtlasGraph, GraphEdge, NodeType } from "@/lib/graph/types";
import type { RelevanceDoc } from "@/lib/grading/types";
import { applyThreshold, bubbleLabel, buildNeighborhood, type HoodEdge, type HoodNode, type LinkGroup, type LinkKind } from "@/lib/graph/neighborhood";
import { sentenceLabel } from "@/lib/graph/labels";
import { SECTORS, radialLayout, ringRadius, sectorOf, type RadialNode } from "@/lib/viz/radialLayout";
import { ICON_PATH } from "@/lib/viz/icons";
import { countLabel, relationLabel } from "@/lib/graph/vocab";
import { KIND_OF, KIND_STYLE } from "./kinds";
import { TYPE_WORD, clusterName, clusterShortName, engineText, evidenceName, formatPercent, tierWord } from "./format";
import { evidenceBadgeOf, nodeEvidence } from "./evidence";
import EvidenceBadge from "./EvidenceBadge";
import { compactSynonym, wrapName } from "./names";
import { mapLines } from "./map/mapName";
import { crowdedDiseases, isTopRelated, mapNodeRadius } from "./mapSizes";
import { labelPlan, topRelatedIds } from "./map/labelBudget";
import { lineStyle, lineTier, type Thresholds } from "./map/lineStyle";
import { universeLayout, type Box } from "./map/universe";

export interface KnowledgeGraphProps {
  graph: AtlasGraph;
  relevance: RelevanceDoc | null;
  focusId: string | null;
  selectedId: string | null; // a node id or a map edge id
  threshold: number; // 0..1
  thresholds: Thresholds; // the tier rings and line widths
  hiddenTypes: ReadonlySet<NodeType>;
  hiddenLinks: ReadonlySet<LinkGroup>;
  expanded: ReadonlySet<string>;
  mode: "parent" | "researcher";
  onFocus(id: string): void;
  onSelect(id: string | null): void;
  onToggleBubble(id: string): void;
  avoid?: Box | null; // px inside the map that the start screen keeps clear: the search card
  legend?: ReactNode; // drawn in the map's bottom-left corner once something is centered
  side?: ReactNode; // floats at the map's right edge on wide screens (the relevance slider)
  className?: string;
}

const W = 1200;
const H = 840;
// Text keeps a readable size on screen however small the map is drawn: a 12-unit label renders at
// LABEL_PX pixels or more, so the smallest text (the 11.5-unit grade line) never goes under 11 px.
const LABEL_PX = 11.5;
// A name up to this many characters fits on one line of the map; longer ones wrap. A disease's
// name is never cut: it wraps over as many lines as it needs.
const ONE_LINE = 26;
// A label may cover this share of its own area with dots (it is drawn above them, with a halo),
// but never any of another label. First it looks for a place at least CLEAR_PX from every other
// dot, so it can only be read as its own dot's name.
const DOT_OVERLAP = 0.08;
const CLEAR_PX = 8;
// Phones name only the center and the three most related; every other name shows on tap.
const PHONE_LABELS = 4;
// When no place beside its dot is clear, a name may stand this much farther out (map units),
// joined to its dot by a hairline.
const LEAD_STEPS = [0, 20, 40];

type Pt = [number, number];
type Anchor = { x: number; y: number; anchor: "start" | "middle" | "end"; lead?: boolean }; // first baseline, from the node; lead: set apart, joined by a hairline
interface LabelSpec {
  lines: string[];
  tier: string; // a top related disease's grade line, or ""
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
  kind: "node" | "edge" | "star";
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

const typeOfNode = (n: HoodNode): NodeType => (n.type === "Bubble" ? n.bubbleType! : n.type);
const pct = formatPercent;

// Map names in sentence case, like the panel ("Congenital stromal corneal dystrophy").
const capitalized = (lines: string[]): string[] => (lines.length ? [sentenceLabel(lines[0]), ...lines.slice(1)] : lines);

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

// The shortest lines that join a cluster's dots: a constellation, not a web.
function spanningLines(points: Pt[]): [Pt, Pt][] {
  if (points.length < 2) return [];
  const inTree = [0];
  const lines: [Pt, Pt][] = [];
  while (inTree.length < points.length) {
    let best: [number, number] = [-1, -1];
    let bestD = Infinity;
    for (const i of inTree) {
      for (let j = 0; j < points.length; j++) {
        if (inTree.includes(j)) continue;
        const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
        if (d < bestD) {
          bestD = d;
          best = [i, j];
        }
      }
    }
    inTree.push(best[1]);
    lines.push([points[best[0]], points[best[1]]]);
  }
  return lines;
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

// A group's name in the universe: "COL2A1 · 12", wrapped whole when long.
function groupName(c: RelevanceDoc["clusters"][number]): string[] {
  return wrapName(`${clusterShortName(c)} · ${c.size}`, 26, 3);
}

// A box inside the container, in px, from an element's place on screen.
function boxIn(el: HTMLElement | null, container: HTMLElement | null): Box | null {
  if (!el || !container) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const c = container.getBoundingClientRect();
  return [r.left - c.left, r.top - c.top, r.right - c.left, r.bottom - c.top];
}

export default function KnowledgeGraph(props: KnowledgeGraphProps) {
  const { graph, relevance, focusId, selectedId, threshold, thresholds, hiddenTypes, hiddenLinks, expanded, mode } = props;
  const uid = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // How large the map is drawn, so labels keep a readable size on screen (ts = text scale), and the
  // corners the legend and the zoom buttons take, so no label goes under them.
  const [box, setBox] = useState({ width: 600, height: 420, measured: false });
  const [corners, setCorners] = useState<Box[]>([]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setBox({ width, height, measured: true });
      const taken = [boxIn(legendRef.current, el), boxIn(zoomRef.current, el), boxIn(sideRef.current, el)].filter((b): b is Box => !!b);
      setCorners((prev) => (JSON.stringify(prev) === JSON.stringify(taken) ? prev : taken));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (legendRef.current) observer.observe(legendRef.current);
    if (sideRef.current) observer.observe(sideRef.current);
    return () => observer.disconnect();
  }, [focusId]);
  const drawn = Math.min(box.width / W, box.height / H);
  const ts = Math.ceil(Math.max(1, LABEL_PX / (12 * drawn)) * 20) / 20;
  const phone = box.measured && box.width < 640;

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
  const focusName = focusNode ? sentenceLabel(focusNode.label) : "";

  // ---------- the universe (start screen) ----------

  // Laid out in screen pixels, for the size the map is drawn at, around the search card. Kept while
  // something is centered, so a disease flies from the dot that was clicked.
  const avoidKey = props.avoid ? props.avoid.map(Math.round).join(",") : "";
  const universe = useMemo(() => {
    const avoid = avoidKey ? (avoidKey.split(",").map(Number) as Box) : null;
    const diseases = graph.nodes.filter((n) => n.type === "Disease");
    const colored = (relevance?.clusters ?? []).filter((c) => c.color_slot !== null).sort((a, b) => b.size - a.size || (a.color_slot ?? 0) - (b.color_slot ?? 0));
    const inCluster = new Set(colored.flatMap((c) => c.members));
    const clusters = colored.map((c) => ({
      id: c.id,
      members: c.members.filter((id) => byId.has(id)).sort((a, b) => centralityOf(b) - centralityOf(a) || (a < b ? -1 : 1)),
      lines: groupName(c),
    }));
    const stars = diseases.filter((n) => !inCluster.has(n.id)).map((n) => n.id).sort();
    return { ...universeLayout(clusters, stars, box.width, box.height, avoid), clusters: colored };
    // centralityOf reads relevance, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, relevance, byId, box.width, box.height, avoidKey]);
  const clusterOfDisease = useMemo(() => {
    const out = new Map<string, NonNullable<RelevanceDoc["clusters"]>[number]>();
    for (const c of relevance?.clusters ?? []) for (const m of c.members) out.set(m, c);
    return out;
  }, [relevance]);

  // Where a point of the universe (px) lands in the centered map's coordinates.
  const fromScreen = (p: Pt): Pt => {
    const scale = drawn || 1;
    return [(p[0] - (box.width - W * scale) / 2) / scale, (p[1] - (box.height - H * scale) / 2) / scale];
  };

  // ---------- the centered map ----------

  // The neighborhood and its layout. Layout uses every node at every relevance, so moving the bar
  // only shows and hides; nothing jumps.
  const hood = useMemo(() => (focusId ? buildNeighborhood(graph, relevance, focusId, { expanded }) : null), [graph, relevance, focusId, expanded]);
  const crowded = crowdedDiseases(hood);
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
      // The five most related keep room around them for their names.
      radius: mapNodeRadius(n, relevance?.diseases[n.id]?.centrality ?? 0, crowdedDiseases(hood)) + (isTopRelated(n) ? 16 : 3),
      cluster: n.cluster ?? null,
    }));
    return radialLayout(nodes, hood.focus, W, H);
  }, [hood, relevance]);
  const positions = layout?.positions ?? new Map<string, Pt>();
  const geometry = layout?.geometry;

  const filtered = useMemo(() => (hood ? applyThreshold(hood, threshold, hiddenTypes, undefined, hiddenLinks) : null), [hood, threshold, hiddenTypes, hiddenLinks]);
  const level = useMemo(() => {
    const m = new Map<string, "shown" | "ghost">();
    for (const n of filtered?.nodes ?? []) m.set(n.id, "shown");
    for (const n of filtered?.ghosts ?? []) m.set(n.id, "ghost");
    return m;
  }, [filtered]);
  const top = useMemo(() => topRelatedIds(filtered?.nodes ?? []), [filtered]);

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
  // The zoom buttons zoom about the middle of the map.
  const zoomBy = (factor: number) =>
    setView((v) => {
      const k = Math.min(3, Math.max(0.5, v.k * factor));
      const [px, py] = [W / 2, H / 2];
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });

  const hoodNodes = hood?.nodes ?? [];
  const nodeById = new Map(hoodNodes.map((n) => [n.id, n]));
  const center: Pt = geometry ? [geometry.cx, geometry.cy] : [W / 2, H / 2];

  // Where a point of the centered map is on screen, inside the container: for tooltips.
  const toScreen = (p: Pt): Pt => {
    const scale = drawn || 1;
    return [(box.width - W * scale) / 2 + (p[0] * view.k + view.x) * scale, (box.height - H * scale) / 2 + (p[1] * view.k + view.y) * scale];
  };
  const showHover = (kind: Hover["kind"], id: string, target: Element, below: boolean) => {
    const c = containerRef.current?.getBoundingClientRect();
    if (!c) return;
    const r = target.getBoundingClientRect();
    setHover({ kind, id, left: r.left + r.width / 2 - c.left, top: r.top - c.top, bottom: r.bottom - c.top, below });
  };
  const showNodeHover = (id: string, target: Element) => {
    const p = positions.get(id);
    // Nodes below the center open their tooltip below, away from their own lines.
    showHover("node", id, target, !!p && p[1] > center[1] + 4);
  };
  const showEdgeHover = (id: string, clientX: number, clientY: number) => {
    const c = containerRef.current?.getBoundingClientRect();
    if (!c) return;
    const y = clientY - c.top;
    setHover({ kind: "edge", id, left: clientX - c.left, top: y - 14, bottom: y + 14, below: y > toScreen(center)[1] });
  };

  const placeOf = (n: HoodNode): Pt => {
    const target = positions.get(n.id) ?? center;
    const start = universe.positions.get(n.id);
    const from = start ? fromScreen(start) : null;
    if (n.role === "focus") return settled ? target : (from ?? target);
    if (!settled) return n.type === "Disease" ? (from ?? center) : center;
    if (!level.has(n.id) && n.type === "Disease") return from ?? target;
    return target;
  };

  // Hover or selection brings a node's own lines forward.
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

  // The full name: a disease's compact synonym or label; a bubble's count at this filter.
  function fullName(n: HoodNode): string {
    if (n.role === "bubble") return bubbleLabel(n.bubbleType!, filtered?.bubbleCount[n.id] ?? n.members?.length ?? 0);
    const node = byId.get(n.id);
    return (node && compactSynonym(node)) ?? n.label;
  }

  // The grade line under a top related disease: "Moderate · 63%".
  function tierText(n: HoodNode): string {
    if (n.role !== "related") return "";
    return n.tier && n.tier !== "none" ? `${tierWord(n.tier)} · ${pct(n.relevance)}` : pct(n.relevance);
  }

  // The ways a node's name can be written, best first. A disease's name is never cut: it wraps
  // (wide lines, then narrow ones). Other names may shorten, keeping the end that tells siblings
  // apart ("…type 1A").
  function labelForms(n: HoodNode): LabelSpec[] {
    const isFocus = n.role === "focus";
    const strong = isFocus || n.role === "anchor" || top.has(n.id);
    const size = isFocus ? 15 : strong ? 13 : 12;
    const weight = isFocus ? 650 : strong ? 600 : 450;
    const name = fullName(n);
    const spec = (lines: string[], tier: string): LabelSpec => ({ lines: n.role === "bubble" ? lines : capitalized(lines), tier, size, weight });
    const tier = top.has(n.id) ? tierText(n) : "";
    const shapes =
      n.type === "Disease" || isFocus
        ? [...new Set([mapLines(name, isFocus ? 28 : ONE_LINE, 4), mapLines(name, 18, 5)].map((l) => l.join("\n")))].map((l) => l.split("\n"))
        : [mapLines(name, ONE_LINE, 3)];
    return tier ? [...shapes.map((l) => spec(l, tier)), ...shapes.map((l) => spec(l, ""))] : shapes.map((l) => spec(l, ""));
  }

  const lineHeight = (spec: LabelSpec) => spec.size * 1.2 * ts;
  const tierHeight = 15 * ts;
  // The text's extent around its first baseline, as the browser measures it (font ascent and
  // descent), so two labels that do not touch here do not touch on screen.
  const below = (spec: LabelSpec) => (spec.lines.length - 1) * lineHeight(spec) + (spec.tier ? tierHeight : 0) + 0.26 * (spec.tier ? 11.5 : spec.size) * ts;
  const ascent = (spec: LabelSpec) => spec.size * 0.96 * ts;

  // Where a label can go, best first: below the searched node; otherwise outward from the center,
  // then to the right, left, above or below its dot.
  function labelAnchors(n: HoodNode, p: Pt, spec: LabelSpec, extra = 0): Anchor[] {
    const r = radiusOf(n);
    const off = r + 6 + extra;
    const under: Anchor = { x: 0, y: off + ascent(spec), anchor: "middle" };
    if (n.role === "focus") {
      // Under the center, else slid to one side under it, else above it.
      const y = off + 10 + ascent(spec);
      return [{ x: 0, y, anchor: "middle" }, { x: r, y, anchor: "end" }, { x: -r, y, anchor: "start" }, under, { x: 0, y: -off - 10 - below(spec), anchor: "middle" }];
    }
    const middle = -(ascent(spec) + below(spec)) / 2 + ascent(spec); // a baseline that centers the block on the dot
    const over: Anchor = { x: 0, y: -off - below(spec), anchor: "middle" };
    const right: Anchor = { x: off, y: middle, anchor: "start" };
    const left: Anchor = { x: -off, y: middle, anchor: "end" };
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const radial: Anchor = Math.abs(ux) < 0.35 ? (uy > 0 ? under : over) : { x: ux * off, y: uy * off + middle, anchor: ux > 0 ? "start" : "end" };
    const diagonal = (sx: number, sy: number): Anchor => ({ x: sx * off * 0.8, y: sy > 0 ? off * 0.8 + ascent(spec) : -off * 0.8 - below(spec), anchor: sx > 0 ? "start" : "end" });
    const all = [radial, ...[right, left, over, under, diagonal(1, -1), diagonal(-1, -1), diagonal(1, 1), diagonal(-1, 1)].filter((a) => a !== radial)];
    return extra ? all.map((a) => ({ ...a, lead: true })) : all;
  }

  function labelBox(p: Pt, spec: LabelSpec, a: Anchor, air = true): Box {
    const w = Math.max(...spec.lines.map((l) => textWidth(l, spec.size, spec.weight)), spec.tier ? textWidth(spec.tier, 11.5, 450) : 0) * ts;
    const x = p[0] + a.x;
    const y = p[1] + a.y;
    const left = a.anchor === "start" ? x : a.anchor === "end" ? x - w : x - w / 2;
    // Air around the text, so two names side by side never read as one.
    const [ax, ay] = air ? [7 * ts, 2 * ts] : [0, 0];
    return [left - ax, y - ascent(spec) - ay, left + w + ax, y + below(spec) + ay];
  }

  // The corners the legend and zoom buttons take, in map coordinates.
  const cornerBoxes = useMemo(
    () =>
      corners.map((b): Box => {
        const [x0, y0] = fromScreen([b[0] - 6, b[1] - 6]);
        const [x1, y1] = fromScreen([b[2] + 6, b[3] + 6]);
        return [x0, y0, x1, y1];
      }),
    // fromScreen reads the box size, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [corners, box.width, box.height],
  );

  // The sectors that have something in them, named at the rim in small muted caps.
  const sectorNames = useMemo(() => {
    if (!geometry || !filtered) return [];
    const used = new Set(filtered.nodes.filter((n) => n.role !== "focus").map((n) => sectorOf(typeOfNode(n))));
    const place = (s: (typeof SECTORS)[number], a: number) => {
      const size = 10.5 * ts;
      const text = s.label.toUpperCase();
      const anchor: Anchor["anchor"] = Math.cos(a) > 0.3 ? "start" : Math.cos(a) < -0.3 ? "end" : "middle";
      const x = geometry.cx + Math.cos(a) * (geometry.outer + 30);
      const width = text.length * size * 0.72;
      // Too wide for the room beside the rings: two lines ("GENES &" / "PATHWAYS").
      const split = text.includes(" ") && (anchor === "end" ? x - width < 6 : anchor === "start" ? x + width > W - 6 : false);
      const lines = split ? [text.slice(0, text.lastIndexOf(" ")), text.slice(text.lastIndexOf(" ") + 1)] : [text];
      const lift = Math.sin(a) < -0.3 ? (lines.length - 1) * size * 1.2 : Math.sin(a) > 0.3 ? 0 : ((lines.length - 1) * size * 1.2) / 2;
      const y = geometry.cy + Math.sin(a) * (geometry.outer + 30) + 4 - lift;
      const w = Math.max(...lines.map((l) => l.length)) * size * 0.72;
      const left = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
      return { id: s.id, x, y, anchor, lines, size, box: [left, y - size, left + w, y + 3 + (lines.length - 1) * size * 1.2] as Box };
    };
    return SECTORS.filter((s) => used.has(s.id)).map((s) => {
      const mid = (s.start + s.end) / 2;
      // The middle of its sector, else the nearest angle inside the sector that is clear of the corners.
      const tries = [0, 6, -6, 12, -12, 18, -18, 24, -24].map((d) => mid + d).filter((d) => d > s.start && d < s.end);
      const spots = tries.map((d) => place(s, (d * Math.PI) / 180));
      return spots.find((spot) => !cornerBoxes.some((c) => overlaps(spot.box, c))) ?? spots[0];
    });
  }, [geometry, filtered, ts, cornerBoxes]);

  const filterLabelAt = (g: NonNullable<typeof geometry>): Pt => {
    const r = ringRadius(g, threshold);
    return [g.cx + Math.cos((18 * Math.PI) / 180) * r + 6, g.cy + Math.sin((18 * Math.PI) / 180) * r + 4];
  };
  const filterText = `≥ ${pct(threshold)}`;


  // Labels: the planned names (labelBudget.ts), most important first, each in the first of its
  // forms and places that covers no other label, stays inside the map and sits clearly nearer its
  // own dot than any other; one that fits nowhere is left to hover and selection. The searched node
  // is always named.
  const labels = useMemo(() => {
    const placed = new Map<string, PlacedLabel>();
    const taken: Box[] = [];
    const obstacles: [string, Box][] = [];
    if (!filtered || !geometry) return { placed, taken, obstacles };
    // Every dot drawn, faint ones under the filter too: a name near one could be read as its.
    const dots = [...filtered.nodes, ...filtered.ghosts].flatMap((n) => (positions.get(n.id) ? [{ id: n.id, p: positions.get(n.id)!, r: radiusOf(n) }] : []));
    // The gap between a dot's edge and a text box (0 when it touches or is covered).
    const gap = (b: Box, [cx, cy]: Pt, r: number) => Math.max(0, Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cy, 0, cy - b[3])) - r);
    const nearestOther = (id: string, text: Box) => dots.reduce((min, d) => (d.id === id ? min : Math.min(min, gap(text, d.p, d.r))), Infinity);
    const clear = CLEAR_PX / (drawn || 1);
    taken.push(...sectorNames.map((s) => s.box), ...cornerBoxes);
    {
      const [x, y] = filterLabelAt(geometry);
      taken.push([x, y - 11.5 * ts, x + textWidth(filterText, 11.5, 600) * ts + 4, y + 3 * ts]);
    }
    for (const n of filtered.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const r = radiusOf(n);
      obstacles.push([n.id, [p[0] - r, p[1] - r, p[0] + r, p[1] + r]]);
    }
    const inside = (b: Box) => b[0] >= 4 && b[1] >= 4 && b[2] <= W - 4 && b[3] <= H - 4;
    const free = (n: HoodNode, b: Box, dots = DOT_OVERLAP) => {
      if (!inside(b) || taken.some((t) => overlaps(b, t))) return false;
      const onDots = obstacles.reduce((sum, [id, o]) => sum + (id === n.id ? 0 : overlapArea(b, o)), 0);
      return onDots <= dots * area(b);
    };
    for (const id of labelPlan(filtered.nodes, mode).slice(0, phone ? PHONE_LABELS : undefined)) {
      const n = nodeById.get(id);
      const p = n && positions.get(id);
      if (!n || !p) continue;
      const forms = labelForms(n);
      // Each form beside its dot, then set farther out with a hairline (the center stays put).
      const steps = n.role === "focus" ? [0] : LEAD_STEPS;
      const candidates = forms.flatMap((spec) =>
        steps.flatMap((extra) => labelAnchors(n, p, spec, extra).map((at) => ({ spec, at, b: labelBox(p, spec, at), text: labelBox(p, spec, at, false) }))),
      );
      // How near its own dot a name reads: a name set apart is tied to it by its hairline.
      const own = (c: { at: Anchor; text: Box }) => (c.at.lead ? clear : gap(c.text, p, radiusOf(n)));
      // First a place well clear of every other dot (twice as clear when set apart); then one beside
      // its dot and nearer it than any other; the center and the five most related then take the
      // least ambiguous free place.
      let chosen: PlacedLabel | null =
        candidates.find((c) => free(n, c.b, 0) && nearestOther(id, c.text) >= (c.at.lead ? 2 : 1) * clear) ??
        candidates.find((c) => !c.at.lead && free(n, c.b) && nearestOther(id, c.text) > own(c) + 2) ??
        null;
      if (!chosen && (n.role === "focus" || top.has(id))) {
        let best = -Infinity;
        for (const c of candidates) {
          if (!free(n, c.b, 0.25)) continue;
          const margin = nearestOther(id, c.text) - own(c);
          if (margin > best) {
            best = margin;
            chosen = c;
          }
        }
      }
      // The searched node is always named, in its least crowded place.
      if (!chosen && n.role === "focus") {
        let least = Infinity;
        for (const spec of forms) {
          for (const at of labelAnchors(n, p, spec)) {
            const b = labelBox(p, spec, at);
            const onDots = obstacles.reduce((sum, [other, o]) => sum + (other === id ? 0 : overlapArea(b, o)), 0);
            const cost = taken.reduce((sum, t) => sum + overlapArea(b, t), 0) + onDots + (inside(b) ? 0 : area(b));
            if (cost < least) {
              least = cost;
              chosen = { spec, at };
            }
          }
        }
      }
      if (!chosen) continue;
      placed.set(id, { spec: chosen.spec, at: chosen.at });
      taken.push(labelBox(p, chosen.spec, chosen.at));
    }
    return { placed, taken, obstacles };
    // The helpers read the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, positions, geometry, byId, relevance, ts, drawn, phone, threshold, crowded, measureText, sectorNames, cornerBoxes, top, mode]);

  // A label shown because its node is pointed at or selected, where no place was planned.
  const looseLabel = (n: HoodNode): PlacedLabel | null => {
    const p = positions.get(n.id);
    if (!p) return null;
    const spec = labelForms(n)[0];
    return { spec, at: labelAnchors(n, p, spec)[0] };
  };

  const delayOf = (n: HoodNode, i: number) => (reduced ? 0 : Math.min(n.hop, 4) * 110 + Math.min(i, 40) * 8);
  const transition = (delay: number) => (reduced ? undefined : `transform 700ms cubic-bezier(.2,.8,.2,1) ${delay}ms, opacity 420ms ease ${delay}ms`);

  // Very soft cluster halos behind the related diseases.
  const hulls = useMemo(() => {
    if (!filtered || !settled) return [];
    const groups = new Map<string, Pt[]>();
    for (const n of filtered.nodes) {
      if (n.type !== "Disease" || n.role === "focus" || !n.cluster || clusterColor(relevance, n.cluster) === "var(--node-gray)") continue;
      const p = positions.get(n.id);
      if (!p) continue;
      groups.set(n.cluster, [...(groups.get(n.cluster) ?? []), p]);
    }
    return [...groups].filter(([, pts]) => pts.length > 1).map(([id, pts]) => ({ id, color: clusterColor(relevance, id), hull: convexHull(pts) }));
  }, [filtered, positions, relevance, settled]);

  // A shown bubble's name and reason come from the filter: what it holds now (applyThreshold).
  const shownById = useMemo(() => new Map((filtered?.nodes ?? []).map((n) => [n.id, n])), [filtered]);
  const hoverNode = hover?.kind === "node" ? (shownById.get(hover.id) ?? nodeById.get(hover.id)) : undefined;
  const hoverEdge = hover?.kind === "edge" ? [...(filtered?.edges ?? []), ...(filtered?.faintEdges ?? [])].find((e) => e.id === hover.id) : undefined;
  const hoverStar = hover?.kind === "star" ? byId.get(hover.id) : undefined;

  // Shown nodes a line from the center could run through.
  const blockers = useMemo(
    () => (filtered?.nodes ?? []).flatMap((n) => (n.role === "focus" || !positions.get(n.id) ? [] : [{ id: n.id, p: positions.get(n.id)!, r: radiusOf(n) }])),
    // radiusOf reads `crowded`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, positions, crowded],
  );

  // A line's path. Lines from the center are straight, unless one would run through another node:
  // then it bows around it. Other lines bow gently outward.
  const curve = (e: HoodEdge, a: Pt, b: Pt): string => {
    const atCenter = (p: Pt) => Math.hypot(p[0] - center[0], p[1] - center[1]) < 2;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (atCenter(a) || atCenter(b)) {
      const [from, to] = atCenter(a) ? [a, b] : [b, a];
      const block = blockers
        .filter((x) => x.id !== e.a && x.id !== e.b)
        .map((x) => ({ ...x, ...toSegment(x.p, from, to) }))
        .filter((x) => x.d < x.r + 5 && x.t > 0.05 && x.t < 0.95)
        .sort((x, y) => x.t - y.t)[0];
      if (!block) return `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const len = Math.hypot(dx, dy) || 1;
      const side = (block.p[0] - from[0]) * -dy + (block.p[1] - from[1]) * dx > 0 ? -1 : 1;
      const bow = (block.r + 18) * 2;
      const c: Pt = [mid[0] + (-dy / len) * bow * side, mid[1] + (dx / len) * bow * side];
      return `M${from[0]} ${from[1]} Q${c[0]} ${c[1]} ${to[0]} ${to[1]}`;
    }
    const bow = e.role === "bridge" ? 0.42 : 0.24;
    const c: Pt = [mid[0] + (mid[0] - center[0]) * bow, mid[1] + (mid[1] - center[1]) * bow];
    return `M${a[0]} ${a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`;
  };

  // The pointed-at line is drawn last, so its own hit area is on top of its neighbors'.
  const edgesToDraw =
    settled && filtered
      ? [...filtered.faintEdges.map((e) => ({ e, faint: true })), ...filtered.edges.map((e) => ({ e, faint: false }))].sort(
          (x, y) => Number(hover?.kind === "edge" && x.e.id === hover.id) - Number(hover?.kind === "edge" && y.e.id === hover.id),
        )
      : [];
  // A node chosen in the panel or on the map lights its link to the center; its evidence lines
  // (symptoms, groups, research) cross the whole map, so they stay quiet until it is pointed at.
  const quietEvidence = !!activeNode && activeNode === selectedId && activeNode !== focusId && hover?.kind !== "node";

  // Tooltips name things in full; only the labels drawn on the map are shortened.
  const nameOf = (id: string) => {
    const n = nodeById.get(id);
    return n?.role === "bubble" ? fullName(n) : sentenceLabel(n?.label ?? byId.get(id)?.label ?? id);
  };
  const recordsOf = (e: HoodEdge) => e.edgeIds.flatMap((id) => edgeById.get(id) ?? []);
  // A line in words, in the record's own direction: "GBA1 gene causes Gaucher disease type I".
  const recordSentence = (edge: GraphEdge) => {
    const word = (id: string) => {
      const n = byId.get(id);
      return n ? evidenceName(n) : id;
    };
    // Onset and inheritance are stored as phenotypes, but they are not symptoms.
    const aspect = relevance?.node_info?.[edge.object]?.aspect;
    const relation = edge.type === "has_phenotype" && (aspect === "I" || aspect === "C") ? "has" : relationLabel(edge.type);
    return `${sentenceLabel(word(edge.subject))} ${relation} ${word(edge.object)}`;
  };
  const edgeTitle = (e: HoodEdge) => {
    if (e.role === "similarity") return `${nameOf(e.a)} and ${nameOf(e.b)} share biology`;
    if (e.role === "bridge") return `${nameOf(e.a)} and ${nameOf(e.b)}: ${e.label}`;
    if (e.role === "bubble") {
      const bubble = nodeById.get(e.b);
      const type = bubble?.bubbleType;
      return type ? `${countLabel(type, e.edgeIds.length)} linked to ${nameOf(e.a)}` : nameOf(e.b);
    }
    const record = recordsOf(e)[0];
    return record ? recordSentence(record) : `${nameOf(e.a)} ${e.label || "is linked to"} ${nameOf(e.b)}`;
  };

  // What a node is, for screen readers: its name, kind, grade and where it comes from.
  const nodeText = (n: HoodNode): string => {
    const kind = n.role === "bubble" ? "folded group" : TYPE_WORD[typeOfNode(n)].toLowerCase();
    const where = n.role === "focus" ? "in the center" : n.role === "related" ? `${tierText(n)} related to ${focusName}` : n.role === "anchor" ? `linked to ${focusName}` : "";
    const badge = n.role === "focus" || !hood ? null : evidenceBadgeOf(nodeEvidence(hood, n.id, edgeById), n.kind);
    return [nameOf(n.id), kind, where, badge?.label].filter(Boolean).join(", ");
  };

  const ringValues = [thresholds.strong, thresholds.moderate, thresholds.exploratory].filter((t) => t > 0 && t < 1);

  return (
    <div ref={containerRef} className={`relative h-full w-full select-none overflow-hidden ${props.className ?? ""}`}>
      {/* The universe: every disease before a search. Once something is centered it fades away:
          its places mean nothing on the radial map. */}
      <svg
        viewBox={`0 0 ${Math.round(box.width)} ${Math.round(box.height)}`}
        className="absolute inset-0 h-full w-full"
        role="group"
        aria-label={`Every disease in RareVerse: ${universe.positions.size} diseases, ${universe.halos.length} groups that share biology. Search, or pick a dot, to map one.`}
        aria-hidden={focusId ? true : undefined}
        style={{ opacity: focusId || !box.measured ? 0 : 1, transition: reduced ? undefined : "opacity 500ms ease", pointerEvents: focusId ? "none" : undefined }}
      >
        <defs>
          {universe.clusters.map((c) => (
            <radialGradient key={c.id} id={`halo-${uid}-${c.color_slot}`}>
              <stop offset="0%" stopColor={`var(--series-${c.color_slot})`} stopOpacity={0.26} />
              <stop offset="55%" stopColor={`var(--series-${c.color_slot})`} stopOpacity={0.1} />
              <stop offset="100%" stopColor={`var(--series-${c.color_slot})`} stopOpacity={0} />
            </radialGradient>
          ))}
        </defs>
        {universe.halos.map((h) => {
          const c = universe.clusters.find((x) => x.id === h.id)!;
          const pts = c.members.flatMap((m): Pt[] => {
            const p = universe.positions.get(m);
            return p ? [p] : [];
          });
          const lines = groupName(c);
          return (
            <g key={h.id} aria-hidden>
              <circle cx={h.x} cy={h.y} r={h.r + 10} fill={`url(#halo-${uid}-${c.color_slot})`} />
              {spanningLines(pts).map(([a, b], i) => (
                <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={`var(--series-${c.color_slot})`} strokeWidth={1} opacity={0.38} />
              ))}
              {box.width >= 480 && (
                <text x={h.x} y={h.label[1] + 11} textAnchor="middle" fontSize={11} fontWeight={550} fill="var(--ink-2)" className="atlas-label universe-label">
                  {lines.map((line, i) => (
                    <tspan key={i} x={h.x} dy={i === 0 ? 0 : 14}>
                      {line}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          );
        })}
        {[...universe.positions].map(([id, [x, y]], i) => {
          const node = byId.get(id);
          if (!node) return null;
          const cluster = clusterOfDisease.get(id);
          const colored = !!cluster?.color_slot;
          const r = colored ? 3.2 + 2.4 * centralityOf(id) : 2.1;
          return (
            <g key={id} transform={`translate(${x} ${y})`}>
              <circle
                r={r}
                fill={colored ? `var(--series-${cluster!.color_slot})` : "var(--star)"}
                className={reduced || colored ? undefined : "atlas-twinkle"}
                style={{ opacity: colored ? 1 : undefined, animationDelay: `${(i % 9) * 0.55}s` }}
              />
              <circle
                r={10}
                fill="transparent"
                tabIndex={focusId ? -1 : 0}
                role="button"
                aria-label={`Map ${sentenceLabel(node.label)}${cluster ? `, ${clusterName(cluster).toLowerCase()}` : ""}`}
                className="universe-dot cursor-pointer"
                onClick={() => props.onFocus(id)}
                onKeyDown={(event) => event.key === "Enter" && props.onFocus(id)}
                onPointerEnter={(event) => showHover("star", id, event.currentTarget, y > box.height / 2)}
                onPointerLeave={() => setHover(null)}
                onFocus={(event) => showHover("star", id, event.currentTarget, y > box.height / 2)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>

      {focusId && (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="absolute inset-0 h-full w-full touch-none"
          role="group"
          aria-label={`Knowledge graph for ${focusName}: ${filtered?.relatedShown ?? 0} of ${filtered?.relatedTotal ?? 0} related diseases shown at ${pct(threshold)} relevance or more`}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onSelect(null);
          }}
          onPointerDown={(event) => {
            if ((event.target as Element).closest("[data-node],[data-edge]")) return;
            drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
            (event.currentTarget as Element).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d) return;
            const scale = drawn || 1;
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
            <radialGradient id={`focus-${uid}`}>
              <stop offset="40%" stopColor="var(--accent)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </radialGradient>
          </defs>

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {/* Quiet geometry: faint tier rings, the dashed filter ring, the names of the sectors in use. */}
            {geometry && settled && (
              <g aria-hidden className="atlas-fade-in">
                {ringValues.map((t) => (
                  <circle key={t} cx={geometry.cx} cy={geometry.cy} r={ringRadius(geometry, t)} fill="none" stroke="var(--line)" strokeWidth={1} />
                ))}
                {sectorNames.map((s) => (
                  <text key={s.id} x={s.x} y={s.y} textAnchor={s.anchor} fontSize={s.size} fontWeight={500} letterSpacing={1.2} fill="var(--ink-2)" className="atlas-label" data-sector={s.id}>
                    {s.lines.map((line, i) => (
                      <tspan key={line} x={s.x} dy={i === 0 ? 0 : s.size * 1.2}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                ))}
                {/* The filter ring moves with the relevance bar: the related diseases inside it are shown. */}
                <circle
                  cx={geometry.cx}
                  cy={geometry.cy}
                  r={ringRadius(geometry, threshold)}
                  fill="var(--accent)"
                  fillOpacity={0.025}
                  stroke="var(--accent)"
                  strokeOpacity={0.75}
                  strokeDasharray="4 6"
                  strokeWidth={1.3}
                  style={{ transition: reduced ? undefined : "r 250ms ease" }}
                />
                <text x={filterLabelAt(geometry)[0]} y={filterLabelAt(geometry)[1]} fontSize={11.5 * ts} fontWeight={600} fill="var(--accent-ink)" className="atlas-label" data-ring="filter">
                  {filterText}
                </text>
              </g>
            )}

            {/* The fade-in ends at opacity 1, so the halo's own opacity sits on its path inside it. */}
            {hulls.map((h) => (
              <g key={h.id} aria-hidden className="atlas-fade-in">
                <path
                  d={`M${h.hull.map((p) => p.join(" ")).join(" L")}${h.hull.length > 2 ? " Z" : ""}`}
                  fill={h.color}
                  stroke={h.color}
                  strokeWidth={64}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.06}
                />
              </g>
            ))}

            {/* Lines: width by tier, dashed = inferred, faint = to a disease just under the filter. */}
            {edgesToDraw.map(({ e, faint }) => {
              const a = positions.get(e.a);
              const b = positions.get(e.b);
              if (!a || !b) return null;
              const s = lineStyle(e, thresholds, faint);
              const isSelected = selectedId === e.id;
              const own = e.a === activeNode || e.b === activeNode;
              const quiet = quietEvidence && own && e.role !== "similarity";
              const active = !!touching && touching.has(e.a) && touching.has(e.b) && own && !quiet;
              // The lines from the center lead; every other line stays in the background until its
              // node is pointed at or selected.
              const background = e.a !== focusId && e.b !== focusId;
              const dim = !quiet && ((!!touching && !active) || (background && !active && !isSelected));
              const d = curve(e, a, b);
              const nodeA = nodeById.get(e.a);
              const nodeB = nodeById.get(e.b);
              const delay = reduced ? 0 : Math.max(nodeA?.hop ?? 0, nodeB?.hop ?? 0) * 110 + 420;
              const width = s.width + (isSelected ? 1.5 : active && e.role !== "similarity" ? 0.6 : 0);
              // The opacity sits on an outer group: the fade-in animation ends at opacity 1 and, with
              // fill-mode both, would override an opacity set on its own element.
              return (
                <g key={e.id} style={{ opacity: quiet ? 0.3 : dim ? (touching ? 0.12 : e.role === "similarity" ? 0.4 : 0.28) : 1 }}>
                  <g className="atlas-fade-in" style={{ animationDelay: `${delay}ms` }}>
                    {s.glow && <path d={d} fill="none" stroke="var(--accent)" strokeWidth={s.width + 5} opacity={0.35} filter={`url(#glow-${uid})`} />}
                    <path
                      d={d}
                      fill="none"
                      stroke={isSelected || active ? (e.role === "similarity" ? "var(--accent)" : "var(--ink-2)") : s.color}
                      strokeWidth={width}
                      strokeDasharray={s.dash}
                      strokeLinecap="round"
                      opacity={isSelected || active ? 1 : s.opacity}
                      data-tier={e.role === "similarity" ? (faint ? "under" : lineTier(e.strength, thresholds, e.tier)) : undefined}
                    />
                    <path
                      d={d}
                      data-edge={e.id}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={e.role === "similarity" ? 12 : 8}
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
              const type = typeOfNode(n);
              const kind = KIND_STYLE[KIND_OF[type]];
              const isDisease = n.type === "Disease";
              const emphasized = isFocus || n.role === "anchor" || isTopRelated(n);
              const opacity = isFocus ? 1 : isGhost ? 0.25 : !isVisible ? 0 : touching && !touching.has(n.id) ? 0.3 : emphasized ? 1 : isDisease ? 0.62 : 0.92;
              const interactive = isVisible || isGhost;
              const labeled = labels.placed.has(n.id);
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  role="button"
                  tabIndex={isVisible ? 0 : -1}
                  aria-hidden={!isVisible || undefined}
                  aria-label={nodeText(n)}
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
                    if (event.shiftKey && !isFocus && n.role !== "bubble") props.onFocus(n.id);
                    else if (n.role === "bubble") props.onToggleBubble(n.id);
                    else props.onSelect(n.id);
                  }}
                >
                  <circle r={r + (isFocus ? 7 : 5)} fill="none" stroke="var(--accent)" strokeWidth={2.5} className={isSelected && !isFocus ? undefined : "atlas-focus-ring"} />
                  {isFocus ? (
                    <>
                      <circle r={r + 22} fill={`url(#focus-${uid})`} />
                      <circle r={r} fill="var(--surface)" stroke="var(--accent)" strokeWidth={3} />
                      <g transform={`translate(${-r * 0.5} ${-r * 0.5}) scale(${r / 24})`}>
                        <path d={ICON_PATH[type]} fill="none" stroke="var(--accent)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                      </g>
                    </>
                  ) : n.role === "bubble" ? (
                    <>
                      <circle r={r} fill={kind.fill} stroke={kind.ink} strokeOpacity={0.6} strokeDasharray="3 2.5" strokeWidth={1.3} />
                      {labeled ? (
                        <g transform={`translate(${-r * 0.5} ${-r * 0.5}) scale(${r / 24})`}>
                          <path d={ICON_PATH[type]} fill="none" stroke={kind.ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                        </g>
                      ) : (
                        <text y={4} textAnchor="middle" fontSize={11} fontWeight={650} fill={kind.ink} className="tabular-nums">
                          {filtered?.bubbleCount[n.id] ?? n.members?.length ?? ""}
                        </text>
                      )}
                    </>
                  ) : isDisease ? (
                    <circle r={r} fill={clusterColor(relevance, n.cluster)} stroke="var(--surface)" strokeWidth={emphasized ? 2.5 : 1.5} />
                  ) : (
                    <>
                      <circle r={r} fill={kind.fill} stroke={kind.ink} strokeOpacity={0.45} strokeWidth={1.2} />
                      <g transform={`translate(${-r * 0.62} ${-r * 0.62}) scale(${(r * 1.24) / 24})`}>
                        <path d={ICON_PATH[type]} fill="none" stroke={kind.ink} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                      </g>
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
                    {at.lead && <LeadLine box={labelBox([0, 0], spec, at, false)} r={radiusOf(n)} />}
                    <text
                      x={at.x}
                      y={at.y}
                      textAnchor={at.anchor}
                      fontSize={spec.size * ts}
                      fontWeight={spec.weight}
                      fill={isFocus || spec.weight >= 600 || pointedAt ? "var(--ink)" : "var(--ink-2)"}
                      className="atlas-label"
                      data-label={labels.placed.has(n.id) ? "name" : "hover"}
                    >
                      {spec.lines.map((line, k) => (
                        <tspan key={k} x={at.x} dy={k === 0 ? 0 : lineHeight(spec)}>
                          {line}
                        </tspan>
                      ))}
                      {spec.tier && (
                        <tspan x={at.x} dy={tierHeight} fontSize={11.5 * ts} fontWeight={500} fill="var(--ink-2)">
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
      )}

      {focusId && props.legend && (
        <div ref={legendRef} className="absolute bottom-3 left-3 hidden lg:block">
          {props.legend}
        </div>
      )}

      {focusId && props.side && (
        <div ref={sideRef} className="absolute top-3 right-3 bottom-[7.75rem] z-[5] hidden w-[4.75rem] lg:block">
          {props.side}
        </div>
      )}

      {focusId && (
        <div ref={zoomRef} className="absolute right-3 bottom-3 hidden flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm sm:flex" role="group" aria-label="Zoom">
          <ZoomButton label="Zoom in" onClick={() => zoomBy(1.3)}>
            <path d="M8 3.5v9M3.5 8h9" />
          </ZoomButton>
          <ZoomButton label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
            <path d="M3.5 8h9" />
          </ZoomButton>
          <ZoomButton label="Reset the view" onClick={() => setView({ k: 1, x: 0, y: 0 })} disabled={view.k === 1 && view.x === 0 && view.y === 0}>
            <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.8v2.7h2.7" />
          </ZoomButton>
        </div>
      )}

      {hover && (hoverNode || hoverEdge || hoverStar) && (
        <Tooltip hover={hover} width={box.width} height={box.height}>
          {hoverNode ? (
            <>
              <div className="font-semibold">{nameOf(hoverNode.id)}</div>
              <div className="text-ink-2">
                {hoverNode.role === "bubble" ? "Folded group" : TYPE_WORD[typeOfNode(hoverNode)]}
                {hoverNode.role === "related" && ` · ${tierText(hoverNode)} related to ${focusName}`}
                {hoverNode.role === "anchor" && ` · linked to ${focusName}`}
                {level.get(hoverNode.id) === "ghost" && " · under your filter"}
              </div>
              {hood && hoverNode.role !== "focus" && <TooltipBadge records={nodeEvidence(hood, hoverNode.id, edgeById)} kind={hoverNode.kind} />}
              {(hoverNode.role !== "related" || mode === "researcher") && hoverNode.role !== "focus" && <div className="mt-1 text-pretty">{engineText(hoverNode.why)}</div>}
              <div className="mt-1 text-ink-2">
                {hoverNode.role === "bubble" ? "Click to show them" : hoverNode.role === "focus" ? "What you searched · click for details" : "Click for details · double-click to center here"}
              </div>
            </>
          ) : hoverEdge ? (
            <>
              <div className="font-semibold text-pretty">{edgeTitle(hoverEdge)}</div>
              <div className="text-ink-2">
                {hoverEdge.role === "similarity"
                  ? `${hoverEdge.tier && hoverEdge.tier !== "none" ? `${tierWord(hoverEdge.tier)} · ` : ""}${pct(hoverEdge.strength)} shared biology`
                  : evidenceStrength(recordsOf(hoverEdge), hoverEdge.kind)}
              </div>
              <TooltipBadge records={recordsOf(hoverEdge)} kind={hoverEdge.kind} />
              {mode === "researcher" && (
                <div className="mt-1 text-ink-2">
                  {hoverEdge.edgeIds.length} {hoverEdge.edgeIds.length === 1 ? "record" : "records"} behind this line
                </div>
              )}
            </>
          ) : hoverStar ? (
            <>
              <div className="font-semibold">{sentenceLabel(hoverStar.label)}</div>
              <div className="text-ink-2">{clusterOfDisease.get(hoverStar.id) ? clusterName(clusterOfDisease.get(hoverStar.id)) : "Not in a group yet"}</div>
              <div className="mt-1 text-ink-2">Click to map it</div>
            </>
          ) : null}
        </Tooltip>
      )}
    </div>
  );
}

// The hairline from a dot to its name when the name stands apart: from the dot's edge to the
// nearest point of the text.
function LeadLine({ box, r }: { box: Box; r: number }) {
  const nx = Math.min(Math.max(0, box[0]), box[2]);
  const ny = Math.min(Math.max(0, box[1]), box[3]);
  const len = Math.hypot(nx, ny);
  if (len < r + 6) return null;
  const [dx, dy] = [nx / len, ny / len];
  return <line x1={dx * (r + 2)} y1={dy * (r + 2)} x2={nx - dx * 3} y2={ny - dy * 3} stroke="var(--ink-3)" strokeWidth={1} strokeLinecap="round" />;
}

function ZoomButton({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center text-ink-2 transition-colors not-last:border-b not-last:border-line hover:bg-surface-2 hover:text-ink disabled:text-ink-3 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

// How strong an evidence line is, in words: a link a curated source states, or an inferred one
// (the badge under it says how it was found).
function evidenceStrength(records: GraphEdge[], kind: LinkKind | null): string {
  const style = evidenceBadgeOf(records, kind)?.style;
  return style === "stated" ? "Stated link" : style === "disputed" ? "Disputed link" : style ? "Inferred link" : "Link on record";
}

// Where a hovered node or line comes from: its evidence badge, and the sources by name when the
// badge does not say them ("Search match · not reviewed  PubMed").
function TooltipBadge({ records, kind }: { records: GraphEdge[]; kind: LinkKind | null }) {
  const badge = evidenceBadgeOf(records, kind);
  if (!badge) return null;
  const sources = [...new Set(records.map((e) => e.source))].join(", ");
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <EvidenceBadge badge={badge} />
      {badge.style !== "stated" && sources && <span className="text-ink-2">{sources}</span>}
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
      className={`pointer-events-none absolute z-10 w-max -translate-x-1/2 rounded-xl border border-line bg-surface px-3 py-2 text-xs leading-snug text-ink shadow-md ${below ? "" : "-translate-y-full"}`}
      style={{ left, top: below ? hover.bottom + 8 : hover.top - 8, maxWidth: half * 2 }}
    >
      {children}
    </div>
  );
}
