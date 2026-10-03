"use client";

// The atlas in 3D, in two layouts. "cloud": before a search, every disease at its MDS position
// (closer = more shared biology). "disc": after a search, the same knowledge graph as the 2D map,
// laid on a tilted disc around what was searched: distance from the center is relevance, direction
// is the kind of thing, and each kind floats at its own height. Kind colors and icons, opacity by
// relevance, faint ghosts, glowing strong lines and dashed inferred lines match the 2D map.
// Plain Canvas 2D with the projection math in lib/viz/project3d.ts, so there is no 3D library to
// ship. AtlasApp loads this through next/dynamic with ssr: false; even so, nothing here touches
// window or document during render.

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { sentenceLabel } from "../../lib/graph/labels.ts";
import {
  PITCH_LIMIT,
  clamp,
  clampPitch,
  depthSort,
  depthT,
  easeInOutCubic,
  faceAngles,
  fitScale,
  hitTest,
  lerp,
  orbitFrame,
  placeLabels,
  project,
  sideAlign,
  wrapAngle,
  type HitTarget,
  type LabelSide,
  type OrbitFrame,
  type Projected,
  type Vec3,
  type View,
} from "../../lib/viz/project3d.ts";

export interface Graph3DNode {
  id: string;
  label: string;
  shortLabel: string;
  coords: [number, number, number];
  color: string; // fill: CSS color or "var(--series-1)"
  size: number; // 0..1
  emphasis: "focus" | "neighbor" | "context";
  tierLabel?: string; // second label line, e.g. "Strong · 85%"
  ink?: string; // ring and icon color for the pale evidence kinds
  icon?: string; // SVG path on a 24 x 24 grid, drawn inside the dot
  count?: number; // a folded group: its size, drawn inside the dot
  alpha?: number; // 0..1 opacity, from relevance
  ghost?: boolean; // just under the filter: faint and unlabelled
  radius?: number; // dot radius in px before perspective; default from size and emphasis
  labelled?: boolean; // name shown without hovering (default: everything but context nodes)
  detail?: string; // tooltip line under the name
  hint?: string; // tooltip line on what a click does
}

export interface Graph3DLink {
  a: string;
  b: string;
  strength: number; // 0..1
  dashed: boolean;
  emphasis: "selected" | "normal";
  color?: string; // default --ink-3
  alpha?: number; // 0..1, default from strength
  width?: number; // px, default from strength
  glow?: number; // px of glow around a strong line
  dash?: number[]; // dash pattern when dashed, default 6 5
}

// Rings in the disc's plane around the center: the relevance tiers and the person's filter.
export interface Graph3DRing {
  r: number; // in scene units, the same as the coords
  kind: "tier" | "filter";
  label?: string;
}

// Where each kind of thing sits on the disc, as a label at the rim.
export interface Graph3DSector {
  label: string;
  angle: number; // radians in the disc's plane, 0 = right, growing toward the viewer
}

export interface Graph3DProps {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
  focusId: string;
  selectedId: string | null;
  onSelect(id: string): void;
  onFocus(id: string): void;
  ariaLabel: string;
  layout?: "cloud" | "disc";
  rings?: Graph3DRing[];
  sectors?: Graph3DSector[];
  caption?: string;
  className?: string;
}

const CAPTION = "3D layout: distance reflects shared biology. Drag to rotate, scroll to zoom.";
const DISC_PITCH = 0.95; // rad: the disc seen from above at an angle, its far side (diseases) on top
const MORPH_MS = 750; // nodes glide to their places when the center changes

// The camera orbits the focus, like the 2D map keeps it in the middle. Distances are in orbit
// spans (the radius around the focus that holds every disease), so framing is the same whatever
// the data: the nearest dots draw about 1.4x, the farthest 0.8x.
const CAMERA_DISTANCE = 3.5;
const FIT_PADDING = 28; // px kept clear around the scene for rings and labels
const ZOOM_MIN = 0.6; // zoom 1 fits every disease from any angle
const ZOOM_MAX = 6;
const AUTO_SPIN = 0.12; // rad/s: under a minute per turn, slow enough to read labels
const SPIN_EASE_S = 0.6; // auto-rotation eases in and out instead of jerking
const ZOOM_EASE_S = 0.08;
const SHIFT_EASE_S = 0.12;
const INERTIA_S = 0.35; // a fling coasts for about a second
const MAX_FLING = 4; // rad/s
const FLING_WINDOW_MS = 80; // a drag that rested longer than this before release does not coast
const FLY_MS = 900; // gliding to a new focus
const KEY_FLY_MS = 160;
const KEY_TURN = 0.15; // rad per arrow press
const KEY_ZOOM = 1.25;
const FACE_MIN_RADIUS = 0.2; // a focus this close to the middle of the cloud has no side to turn toward
const FADE_S = 0.3; // emphasis cross-fade when the focus or selection changes
const TAP_SLOP = { mouse: 4, touch: 8 }; // px a press may wander and still count as a click
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 24;
const CONTEXT_ALPHA = 0.45; // the grayed nodes
const FOG = 0.3; // how far the farthest highlighted nodes blend into the background
const DIM_UNSELECTED = 0.3; // other links while one is selected
const DASH = [6, 5]; // same rhythm as the 2D map's inferred links
const MAX_BACKING_PIXELS = 12e6; // beyond this, extra sharpness is invisible and costs memory
const LINE_MAIN = 15;
const LINE_SUB = 13;
const LABEL_PAD = 3; // px each side of a label box: the 2 px halo plus air between neighbors
const LABEL_SLIDE_S = 0.12;
const TAU = Math.PI * 2;

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// Used only when the page has not defined the token, so the canvas never renders blank.
const TOKEN_FALLBACK: Record<"light" | "dark", Record<string, string>> = {
  light: {
    "--ink": "#1d1d1f",
    "--ink-2": "#6e6e73",
    "--ink-3": "#8e8e93",
    "--line": "#e5e5ea",
    "--accent": "#0071e3",
    "--accent-ink": "#0066cc",
    "--surface": "#ffffff",
    "--node-gray": "#8e8e93",
  },
  dark: {
    "--ink": "#f5f5f7",
    "--ink-2": "#a1a1a6",
    "--ink-3": "#8e8e93",
    "--line": "#38383a",
    "--accent": "#0a84ff",
    "--accent-ink": "#2997ff",
    "--surface": "#1c1c1e",
    "--node-gray": "#8e8e93",
  },
};
const SERIES_FALLBACK: Record<"light" | "dark", string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

type Role = "focus" | "neighbor" | "context";

interface SceneNode {
  id: string;
  label: string;
  short: string;
  tier?: string;
  p: Vec3; // centered, inside the unit sphere
  color: string;
  ink?: string;
  icon?: string;
  count?: number;
  alpha: number;
  ghost: boolean;
  radius?: number;
  labelled: boolean;
  detail?: string;
  hint?: string;
  size: number;
  role: Role;
  selected: boolean;
}

interface SceneLink {
  a: number;
  b: number;
  ids: readonly [string, string];
  strength: number;
  dashed: boolean;
  dash: number[];
  selected: boolean;
  faint: boolean; // touches a grayed node
  color?: string;
  alpha?: number;
  width?: number;
  glow: number;
}

interface Scene {
  nodes: SceneNode[];
  links: SceneLink[]; // selected links last, so they paint on top
  index: Map<string, number>;
  focus: number; // index of the focus node, -1 when it is not among the nodes
  pivot: Vec3; // what the camera orbits: the focus, else the middle of the cloud
  frame: OrbitFrame;
  layout: "cloud" | "disc";
  rings: Graph3DRing[];
  sectors: Graph3DSector[];
  linkKey: string; // which pairs are linked; styling changes alone do not cross-fade
  colors: string[];
  colorKey: string;
}

const EMPTY_SCENE: Scene = {
  nodes: [],
  links: [],
  index: new Map(),
  focus: -1,
  pivot: [0, 0, 0],
  frame: { span: 1, zoom: 1 },
  layout: "cloud",
  rings: [],
  sectors: [],
  linkKey: "",
  colors: [],
  colorKey: "",
};

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function buildScene(
  nodes: readonly Graph3DNode[],
  links: readonly Graph3DLink[],
  focusId: string,
  selectedId: string | null,
  layout: "cloud" | "disc",
  rings: readonly Graph3DRing[],
  sectors: readonly Graph3DSector[],
): Scene {
  const index = new Map<string, number>();
  const unique: Graph3DNode[] = [];
  for (const node of nodes) {
    if (index.has(node.id)) continue;
    index.set(node.id, unique.length);
    unique.push(node);
  }

  // A cloud is centered and scaled to the unit sphere, so any coordinate units frame the same way
  // (relevance coords3d are already centered with max norm 1, which makes this a no-op for them).
  // A disc arrives already scaled around its center over the whole neighborhood, so moving the
  // relevance bar only shows and hides dots; nothing rescales.
  const raw = unique.map((n) => [finite(n.coords?.[0]), finite(n.coords?.[1]), finite(n.coords?.[2])]);
  const disc = layout === "disc";
  const mean = disc ? [0, 0, 0] : [0, 1, 2].map((k) => raw.reduce((sum, p) => sum + p[k], 0) / Math.max(1, raw.length));
  const radius = raw.reduce((max, p) => Math.max(max, Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2])), 0);
  const unit = disc ? 1 : radius > 1e-12 ? 1 / radius : 0;

  let focus = -1;
  const sceneNodes = unique.map((n, i): SceneNode => {
    const role: Role = n.id === focusId || n.emphasis === "focus" ? "focus" : n.emphasis === "neighbor" ? "neighbor" : "context";
    if (n.id === focusId || (focus < 0 && role === "focus")) focus = i;
    return {
      id: n.id,
      label: n.label,
      short: n.shortLabel || n.label,
      tier: n.tierLabel,
      p: [(raw[i][0] - mean[0]) * unit, (raw[i][1] - mean[1]) * unit, (raw[i][2] - mean[2]) * unit],
      color: n.color,
      ink: n.ink,
      icon: n.icon,
      count: n.count,
      alpha: n.alpha === undefined ? 1 : clamp(finite(n.alpha), 0, 1),
      ghost: Boolean(n.ghost),
      radius: n.radius,
      labelled: n.labelled ?? role !== "context",
      detail: n.detail,
      hint: n.hint,
      size: clamp(finite(n.size), 0, 1),
      role,
      selected: n.id === selectedId,
    };
  });

  const sceneLinks: SceneLink[] = [];
  for (const link of links) {
    const a = index.get(link.a);
    const b = index.get(link.b);
    if (a === undefined || b === undefined || a === b) continue;
    const na = sceneNodes[a];
    const nb = sceneNodes[b];
    // The link to the selected neighbor is highlighted even if the caller did not mark it.
    const toSelected =
      selectedId !== null && ((na.id === selectedId && nb.role === "focus") || (nb.id === selectedId && na.role === "focus"));
    sceneLinks.push({
      a,
      b,
      ids: [na.id, nb.id],
      strength: clamp(finite(link.strength), 0, 1),
      dashed: Boolean(link.dashed),
      dash: link.dash ?? DASH,
      selected: link.emphasis === "selected" || toSelected,
      faint: na.role === "context" || nb.role === "context" || na.ghost || nb.ghost,
      color: link.color,
      alpha: link.alpha,
      width: link.width,
      glow: Math.max(0, finite(link.glow)),
    });
  }
  sceneLinks.sort((x, y) => Number(x.selected) - Number(y.selected));

  const colors = [...new Set([...sceneNodes.flatMap((n) => (n.ink ? [n.color, n.ink] : [n.color])), ...sceneLinks.flatMap((l) => (l.color ? [l.color] : []))])].sort();
  const pivot: Vec3 = focus >= 0 ? sceneNodes[focus].p : [0, 0, 0];
  return {
    nodes: sceneNodes,
    links: sceneLinks,
    index,
    focus,
    pivot,
    // The disc is framed whole, rings included, so lowering the bar never pushes dots off screen.
    frame: disc
      ? { span: 1, zoom: 1 }
      : orbitFrame(
          pivot,
          sceneNodes.map((n) => n.p),
          sceneNodes.filter((n) => n.role === "neighbor").map((n) => n.p),
        ),
    layout,
    rings: [...rings],
    sectors: [...sectors],
    linkKey: sceneLinks
      .map((l) => [...l.ids].sort().join(">"))
      .sort()
      .join("|"),
    colors,
    colorKey: colors.join("|"),
  };
}

type Rgba = readonly [number, number, number, number]; // 0..255 channels, alpha 0..1

const GRAY: Rgba = [142, 142, 147, 1];
const VAR_REF = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]*?))?\s*\)$/;
const RGB_FN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/;

interface Palette {
  ink: Rgba;
  ink2: Rgba;
  ink3: Rgba;
  line: Rgba;
  accent: Rgba;
  accentInk: Rgba;
  gray: Rgba;
  halo: Rgba; // whatever is actually behind the canvas
  colors: Map<string, Rgba>;
  family: string;
  fonts: { focus: string; main: string; sub: string; rim: string };
}

function parseRgb(value: string): Rgba | null {
  const m = RGB_FN.exec(value.trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [Number(m[1]), Number(m[2]), Number(m[3]), clamp(alpha, 0, 1)];
}

let pixelContext: CanvasRenderingContext2D | null | undefined;

// Computed colors outside sRGB syntax (oklch(), color(...)) are read back from a 1x1 canvas.
function readPixel(value: string): Rgba | null {
  if (pixelContext === undefined) {
    const scratch = document.createElement("canvas");
    scratch.width = scratch.height = 1;
    pixelContext = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!pixelContext) return null;
  pixelContext.clearRect(0, 0, 1, 1);
  pixelContext.fillStyle = "#000";
  pixelContext.fillStyle = value;
  pixelContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixelContext.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

// Any CSS color (hex, named, hsl, light-dark(), color-mix()...) as sRGB channels: the browser
// computes it on the probe element, which also validates it.
function toRgba(value: string, probe: HTMLElement): Rgba | null {
  const style = probe.style;
  const previous = style.color;
  style.color = "";
  style.color = value;
  const valid = style.color !== "";
  const computed = valid ? getComputedStyle(probe).color : "";
  style.color = previous;
  return valid ? (parseRgb(computed) ?? readPixel(computed)) : null;
}

function fallbackToken(name: string, dark: boolean): string | undefined {
  const series = /^--series-([1-8])$/.exec(name);
  if (series) return SERIES_FALLBACK[dark ? "dark" : "light"][Number(series[1]) - 1];
  return TOKEN_FALLBACK[dark ? "dark" : "light"][name];
}

function backdrop(el: HTMLElement): Rgba | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const c = parseRgb(bg) ?? (bg && bg !== "transparent" ? readPixel(bg) : null);
    if (c && c[3] >= 0.5) return [c[0], c[1], c[2], 1];
  }
  return null;
}

// Resolves "var(--x)" through getComputedStyle on the canvas, so the canvas follows the same
// tokens (and the same light/dark switch) as the rest of the page.
function resolvePalette(canvas: HTMLCanvasElement, colors: readonly string[]): Palette {
  const style = getComputedStyle(canvas);
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolve = (value: string, hops = 0): Rgba | null => {
    const ref = VAR_REF.exec(value.trim());
    if (!ref) return toRgba(value, canvas);
    if (hops > 4) return null;
    const own = style.getPropertyValue(ref[1]).trim();
    const fallback = ref[2]?.trim() || fallbackToken(ref[1], dark);
    return (own ? resolve(own, hops + 1) : null) ?? (fallback ? resolve(fallback, hops + 1) : null);
  };
  const token = (name: string) => resolve(`var(${name})`) ?? GRAY;
  const family = style.fontFamily || FONT_STACK;
  return {
    ink: token("--ink"),
    ink2: token("--ink-2"),
    ink3: token("--ink-3"),
    line: token("--line"),
    accent: token("--accent"),
    accentInk: token("--accent-ink"),
    gray: token("--node-gray"),
    halo: backdrop(canvas) ?? token("--surface"),
    colors: new Map(colors.map((c) => [c, resolve(c) ?? GRAY])),
    family,
    fonts: { focus: `600 13px ${family}`, main: `500 12px ${family}`, sub: `400 11px ${family}`, rim: `500 10.5px ${family}` },
  };
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

function rgba(c: Rgba, alpha = 1): string {
  const a = Math.round(clamp(c[3] * alpha, 0, 1) * 1000) / 1000;
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`;
}

interface Point {
  x: number;
  y: number;
}

interface Drag {
  id: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  t: number;
  moved: boolean;
  vx: number; // px/ms, smoothed, for the fling
  vy: number;
  slop: number;
}

interface Fly {
  start: number;
  ms: number;
  yaw0: number;
  pitch0: number;
  dYaw: number;
  dPitch: number;
}

// Moving the orbit to a new focus: pivot, span and zoom travel together.
interface Glide {
  start: number;
  ms: number;
  pivot0: Vec3;
  pivot1: Vec3;
  span0: number;
  span1: number;
  zoom0: number;
  zoom1: number | null; // null once the wheel takes over the zoom mid-glide
}

interface Anim {
  e: number; // 0 grayed .. 1 highlighted
  f: number; // focus
  s: number; // selected
}

interface Look {
  r: number; // dot radius, CSS px
  outer: number; // including rings: hit target and label clearance
  fill: string;
  band: number; // alpha of the background-colored band that separates overlapping dots
  ring: string | null;
  ringWidth: number;
  edge: string | null; // the thin outline of a pale evidence dot, in its kind's ink
  ink: string | null; // icon and count color
  e: number;
  hover: boolean;
}

// Nodes glide to their new places when the center changes; new ones come out of the center.
interface Morph {
  start: number;
  from: Map<string, Vec3>;
}

interface Frame {
  ids: string[];
  points: Projected[];
  looks: Look[];
  targets: HitTarget[];
}

interface OrbitHooks {
  select(id: string): void;
  focus(id: string): void;
  hover(id: string | null): void;
}

interface OrbitView {
  setScene(scene: Scene): void;
  setKeyTarget(id: string | null): void;
  setListOpen(open: boolean, listWidth: number): void;
  invalidate(): void;
  destroy(): void;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const approach = (value: number, goal: number, step: number) =>
  value < goal ? Math.min(goal, value + step) : Math.max(goal, value - step);
const goalsOf = (n: SceneNode): Anim => ({ e: n.role === "context" ? 0 : 1, f: n.role === "focus" ? 1 : 0, s: n.selected ? 1 : 0 });

// Dot radius before perspective: grayed dots stay small so the colored ones read first.
function dotRadius(size: number, e: number, f: number): number {
  return lerp(lerp(2.5 + 2.5 * size, 5 + 4 * size, e), 9 + 4 * size, f);
}

function createOrbitView(canvas: HTMLCanvasElement, tooltip: HTMLElement, hooks: OrbitHooks): OrbitView | null {
  const context = canvas.getContext("2d");
  if (!context) return null;
  const g = context;

  let scene = EMPTY_SCENE;
  let facedId: string | null = null; // the focus the camera last framed
  let pivot: Vec3 = [0, 0, 0];
  let span = 1;
  let glide: Glide | null = null;
  let yaw = 0;
  let pitch = 0;
  let zoom = 1;
  let zoomGoal = 1;
  let homeZoom = 1; // the focus's default framing, which "0" returns to
  let spin = 0;
  let autoRotate = true; // until the first interaction
  let vYaw = 0;
  let vPitch = 0;
  let fly: Fly | null = null;
  let shift = 0; // px the scene slides right to clear the keyboard list
  let shiftGoal = 0;
  let dim = 0;
  let linkAlpha = 1;
  let fading: { links: SceneLink[]; alpha: number } | null = null;
  let morph: Morph | null = null;
  let shown: Vec3[] = []; // where each node of the scene was last drawn, for the next morph
  const anim = new Map<string, Anim>();
  const labelSides = new Map<string, { side: LabelSide; compact: boolean; dx: number; dy: number }>();
  const textWidths = new Map<string, number>();
  const icons = new Map<string, Path2D>();
  let palette: Palette | null = null;

  let width = 0;
  let height = 0;
  let deviceSize: { w: number; h: number } | null = null;
  let frame: Frame = { ids: [], points: [], looks: [], targets: [] };

  const pointers = new Map<number, Point>();
  let drag: Drag | null = null;
  let pinch: { dist: number; zoom: number } | null = null;
  let pointer: Point | null = null; // mouse or pen resting over the canvas
  let hoverId: string | null = null;
  let keyId: string | null = null;
  let lastTap: { id: string; t: number; x: number; y: number } | null = null;
  let listOpen = false;
  let hasFocus = false;
  let focusRing = false;
  let reduceMotion = false;
  let onScreen = true;
  let raf = 0;
  let lastTime = 0;
  let frameDt = 0; // seconds since the last animated frame; 0 for redraws outside the loop
  let destroyed = false;

  function invalidate() {
    if (!raf && onScreen && !destroyed) raf = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    raf = 0;
    const dt = lastTime ? clamp((now - lastTime) / 1000, 0, 0.05) : 0; // no leaps after a hidden tab
    lastTime = now;
    const busy = step(dt, now);
    frameDt = dt;
    render();
    frameDt = 0;
    if (busy) invalidate();
    else if (!raf) lastTime = 0;
  }

  // Advances every animation by dt seconds; true while anything is still moving.
  function step(dt: number, now: number): boolean {
    let busy = false;
    if (glide) {
      const t = clamp((now - glide.start) / glide.ms, 0, 1);
      const eased = easeInOutCubic(t);
      pivot = lerp3(glide.pivot0, glide.pivot1, eased);
      span = lerp(glide.span0, glide.span1, eased);
      // Zoom moves in log space, so zooming in and out over the glide feel equally fast.
      if (glide.zoom1 !== null) zoom = zoomGoal = Math.exp(lerp(Math.log(glide.zoom0), Math.log(glide.zoom1), eased));
      if (t >= 1) glide = null;
      else busy = true;
    }
    if (fly) {
      const t = clamp((now - fly.start) / fly.ms, 0, 1);
      const eased = easeInOutCubic(t);
      yaw = fly.yaw0 + fly.dYaw * eased;
      pitch = fly.pitch0 + fly.dPitch * eased;
      if (t >= 1) fly = null;
      else busy = true;
    } else if (!drag && (vYaw !== 0 || vPitch !== 0)) {
      yaw += vYaw * dt;
      pitch = clampPitch(pitch + vPitch * dt);
      if (Math.abs(pitch) >= PITCH_LIMIT) vPitch = 0;
      const decay = Math.exp(-dt / INERTIA_S);
      vYaw *= decay;
      vPitch *= decay;
      if (Math.hypot(vYaw, vPitch) < 0.02) vYaw = vPitch = 0;
      else busy = true;
    }

    // Auto-rotation pauses while someone is pointing at, or tabbing through, the scene.
    const paused = pointer !== null || drag !== null || fly !== null || listOpen || hasFocus || vYaw !== 0 || vPitch !== 0;
    const spinGoal = autoRotate && !reduceMotion && !paused ? AUTO_SPIN : 0;
    spin = approach(spin, spinGoal, Math.abs(spinGoal - spin) * (1 - Math.exp(-dt / SPIN_EASE_S)) + 1e-5);
    if (spin !== 0) yaw += spin * dt;
    if (spin !== 0 || spinGoal !== 0) busy = true;

    if (zoom !== zoomGoal) {
      zoom = reduceMotion ? zoomGoal : lerp(zoom, zoomGoal, 1 - Math.exp(-dt / ZOOM_EASE_S));
      if (Math.abs(zoomGoal - zoom) < 1e-4 * zoomGoal) zoom = zoomGoal;
      else busy = true;
    }
    if (shift !== shiftGoal) {
      shift = reduceMotion ? shiftGoal : lerp(shift, shiftGoal, 1 - Math.exp(-dt / SHIFT_EASE_S));
      if (Math.abs(shiftGoal - shift) < 0.5) shift = shiftGoal;
      else busy = true;
    }

    const rate = reduceMotion ? Infinity : dt / FADE_S;
    for (const n of scene.nodes) {
      const goal = goalsOf(n);
      const a = anim.get(n.id) ?? goal;
      a.e = approach(a.e, goal.e, rate);
      a.f = approach(a.f, goal.f, rate);
      a.s = approach(a.s, goal.s, rate);
      anim.set(n.id, a);
      if (a.e !== goal.e || a.f !== goal.f || a.s !== goal.s) busy = true;
    }
    const dimGoal = scene.links.some((l) => l.selected) ? 1 : 0;
    dim = approach(dim, dimGoal, rate);
    linkAlpha = approach(linkAlpha, 1, rate);
    if (fading) {
      fading.alpha = approach(fading.alpha, 0, rate);
      if (fading.alpha === 0) fading = null;
    }
    if (morph && (reduceMotion || now - morph.start >= MORPH_MS)) morph = null;
    return busy || dim !== dimGoal || linkAlpha !== 1 || fading !== null || morph !== null;
  }

  // Where a node is drawn this frame: its place, or on its way there after a change of center.
  function placeOf(n: SceneNode, now: number): Vec3 {
    if (!morph) return n.p;
    const t = easeInOutCubic(clamp((now - morph.start) / MORPH_MS, 0, 1));
    return lerp3(morph.from.get(n.id) ?? [0, 0, 0], n.p, t);
  }

  // Finishes every animation at once (reduced motion was switched on).
  function settle() {
    if (glide) {
      pivot = glide.pivot1;
      span = glide.span1;
      if (glide.zoom1 !== null) zoomGoal = glide.zoom1;
      glide = null;
    }
    if (fly) {
      yaw = fly.yaw0 + fly.dYaw;
      pitch = fly.pitch0 + fly.dPitch;
      fly = null;
    }
    vYaw = vPitch = spin = 0;
    zoom = zoomGoal;
    shift = shiftGoal;
    for (const n of scene.nodes) anim.set(n.id, goalsOf(n));
    linkAlpha = 1;
    fading = null;
    morph = null;
  }

  // Moves the orbit onto the scene's pivot and default framing.
  function glideHome(ms: number) {
    homeZoom = scene.frame.zoom;
    if (reduceMotion || ms <= 0) {
      pivot = scene.pivot;
      span = scene.frame.span;
      zoom = zoomGoal = homeZoom;
      glide = null;
    } else {
      glide = { start: performance.now(), ms, pivot0: pivot, pivot1: scene.pivot, span0: span, span1: scene.frame.span, zoom0: zoom, zoom1: homeZoom };
    }
    invalidate();
  }

  function flyTo(yaw1: number, pitch1: number, ms: number, shortWay: boolean) {
    const dYaw = shortWay ? wrapAngle(yaw1 - yaw) : yaw1 - yaw;
    const dPitch = clampPitch(pitch1) - pitch;
    if (reduceMotion || ms <= 0) {
      yaw += dYaw;
      pitch += dPitch;
      fly = null;
    } else {
      fly = { start: performance.now(), ms, yaw0: yaw, pitch0: pitch, dYaw, dPitch };
    }
    invalidate();
  }

  function faceFocus(ms: number) {
    const f = scene.focus >= 0 ? scene.nodes[scene.focus] : null;
    if (!f || Math.hypot(f.p[0], f.p[1], f.p[2]) <= FACE_MIN_RADIUS) return;
    const goal = faceAngles(f.p);
    vYaw = vPitch = 0;
    flyTo(goal.yaw, goal.pitch, ms, true);
  }

  function sizeBackingStore() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(width * dpr);
    let h = Math.round(height * dpr);
    // Exact device pixels avoid a 1 px blur at fractional ratios (1.25, 1.5). They are ignored when
    // they disagree with devicePixelRatio, as under devtools device emulation, which reports 1x.
    if (deviceSize && Math.abs(deviceSize.w - width * dpr) <= 2 && Math.abs(deviceSize.h - height * dpr) <= 2) {
      w = deviceSize.w;
      h = deviceSize.h;
    }
    const cap = Math.min(1, Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, w * h)));
    w = Math.max(1, Math.floor(w * cap));
    h = Math.max(1, Math.floor(h * cap));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function look(n: SceneNode, p: Projected, t: number, pal: Palette): Look {
    const a = anim.get(n.id) ?? goalsOf(n);
    const e = smooth(a.e);
    const f = smooth(a.f);
    const s = smooth(a.s);
    const hover = n.id === hoverId || n.id === keyId;
    const r = (n.radius !== undefined ? lerp(n.radius, n.radius * 1.12, s) : dotRadius(n.size, e, f)) * p.k;
    const own = pal.colors.get(n.color) ?? pal.gray;
    const color = mix(mix(pal.gray, own, e), pal.halo, FOG * t * e);
    // Relevance sets the opacity, as on the 2D map; dots just under the filter stay faint ghosts.
    let alpha = lerp(CONTEXT_ALPHA * lerp(1.25, 0.75, t), 1, e) * n.alpha;
    if (n.ghost) alpha = Math.min(alpha, 0.3);
    if (hover || n.selected) alpha = Math.max(alpha, 0.9);
    let ring: string | null = null;
    let ringWidth = 0;
    if (s > 0.01) {
      ring = rgba(pal.accent, s);
      ringWidth = 2.5;
    } else if (f > 0.01) {
      ring = rgba(pal.ink, f);
      ringWidth = 2.5;
    } else if (hover) {
      ring = rgba(pal.ink2);
      ringWidth = 1.5;
    }
    const ink = n.ink ? (pal.colors.get(n.ink) ?? pal.ink) : null;
    return {
      r,
      outer: r + (ring ? 2 + ringWidth : 1),
      fill: rgba(color, alpha),
      band: e * alpha,
      ring,
      ringWidth,
      edge: ink ? rgba(ink, alpha * 0.55) : null,
      ink: ink ? rgba(ink, Math.min(1, alpha * 1.1)) : null,
      e,
      hover,
    };
  }

  // Rings in the disc's plane (the relevance tiers and the person's filter) and the kind of thing
  // each direction holds, written at the rim. Drawn first, under everything else.
  function drawDisc(pal: Palette, view: View) {
    if (scene.layout !== "disc") return;
    const at = (x: number, z: number) => project([x - pivot[0], -pivot[1], z - pivot[2]], view);
    const ringPath = (r: number) => {
      g.beginPath();
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * TAU;
        const q = at(Math.cos(a) * r, Math.sin(a) * r);
        if (k === 0) g.moveTo(q.x, q.y);
        else g.lineTo(q.x, q.y);
      }
      g.closePath();
    };
    for (const ring of scene.rings) {
      ringPath(ring.r);
      if (ring.kind === "filter") {
        g.fillStyle = rgba(pal.accent, 0.04);
        g.fill();
        g.setLineDash([4, 6]);
        g.lineWidth = 1.4;
        g.strokeStyle = rgba(pal.accent, 0.95);
      } else {
        g.setLineDash([]);
        g.lineWidth = 1;
        g.strokeStyle = rgba(pal.line);
      }
      g.stroke();
    }
    g.setLineDash([]);
    g.textBaseline = "middle";
    g.lineJoin = "round";
    for (const ring of scene.rings) {
      if (ring.kind !== "filter" || !ring.label) continue;
      const a = (18 * Math.PI) / 180; // the same spot as on the 2D map, just right of the front
      const q = at(Math.cos(a) * ring.r, Math.sin(a) * ring.r);
      drawText(ring.label, `600 11.5px ${pal.family}`, q.x + 6, q.y, "left", pal.accentInk, pal.halo, 1);
    }
    for (const s of scene.sectors) {
      const q = at(Math.cos(s.angle) * 1.08, Math.sin(s.angle) * 1.08);
      const cos = Math.cos(s.angle);
      const text = s.label.toUpperCase();
      const align: CanvasTextAlign = cos > 0.3 ? "left" : cos < -0.3 ? "right" : "center";
      // Kept inside the canvas: a direction label cut off at the edge would name nothing.
      const w = measure(pal.fonts.rim, text);
      const left = align === "left" ? q.x : align === "right" ? q.x - w : q.x - w / 2;
      const dx = clamp(left, 6, Math.max(6, width - 6 - w)) - left;
      // Farther labels fade a little, like the dots behind them.
      const back = depthT(q.depth, view.distance, span);
      drawText(text, pal.fonts.rim, q.x + dx, clamp(q.y, 10, height - 10), align, pal.ink2, pal.halo, lerp(1, 0.6, back));
    }
    g.textBaseline = "top";
  }

  function drawLinks(pal: Palette, points: Projected[], depths: number[]) {
    const drawSet = (links: readonly SceneLink[], generation: number) => {
      for (const l of links) {
        const pa = points[l.a];
        const pb = points[l.b];
        if (!pa || !pb) continue;
        let color = l.color ? (pal.colors.get(l.color) ?? pal.ink3) : pal.ink3;
        let lineWidth = l.width ?? 1 + 2.5 * l.strength;
        let alpha: number;
        let glow = l.glow;
        if (l.selected) {
          color = pal.accent;
          lineWidth = Math.max(3.5, lineWidth + 1.5);
          alpha = 1;
        } else {
          const recede = lerp(1, 0.55, (depths[l.a] + depths[l.b]) / 2);
          alpha = (l.alpha ?? 0.85) * (l.faint ? 0.3 : 1) * recede * lerp(1, DIM_UNSELECTED, dim);
          if (l.faint) glow = 0;
        }
        g.setLineDash(l.dashed ? l.dash : []);
        g.lineCap = l.dashed ? "butt" : "round"; // round caps would close the dash gaps
        g.lineWidth = lineWidth;
        g.strokeStyle = rgba(color, alpha * generation);
        // Strong links glow, the way the 2D map blurs a wider stroke under them.
        if (glow > 0) {
          g.shadowColor = rgba(color, 0.65 * generation);
          g.shadowBlur = 4 + 2.5 * glow;
        }
        g.beginPath();
        g.moveTo(pa.x, pa.y);
        g.lineTo(pb.x, pb.y);
        g.stroke();
        if (glow > 0) {
          g.shadowBlur = 0;
          g.shadowColor = "transparent";
        }
      }
    };
    if (fading) drawSet(fading.links, fading.alpha);
    drawSet(scene.links, linkAlpha);
    g.setLineDash([]);
  }

  function iconPath(d: string): Path2D | null {
    if (typeof Path2D === "undefined") return null;
    let path = icons.get(d);
    if (!path) {
      path = new Path2D(d);
      icons.set(d, path);
    }
    return path;
  }

  function drawNode(n: SceneNode, l: Look, p: Projected, pal: Palette) {
    if (l.band > 0.01) {
      g.beginPath();
      g.arc(p.x, p.y, l.r + 2, 0, TAU);
      g.fillStyle = rgba(pal.halo, l.band);
      g.fill();
    }
    g.beginPath();
    g.arc(p.x, p.y, l.r, 0, TAU);
    g.fillStyle = l.fill;
    g.fill();
    if (l.edge) {
      // A folded group has a dashed outline, as on the 2D map.
      g.setLineDash(n.count !== undefined ? [3, 2.5] : []);
      g.lineWidth = 1.3;
      g.strokeStyle = l.edge;
      g.stroke();
      g.setLineDash([]);
    }
    if (l.ink && n.count !== undefined && l.r >= 5) {
      g.font = `650 ${Math.round(clamp(l.r * 0.8, 9, 14))}px ${pal.family}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = l.ink;
      g.fillText(String(n.count), p.x, p.y + 0.5);
      g.textBaseline = "top";
    } else if (l.ink && n.icon && l.r >= 5) {
      const path = iconPath(n.icon);
      if (path) {
        const scale = (l.r * 1.24) / 24;
        g.save();
        g.translate(p.x - l.r * 0.62, p.y - l.r * 0.62);
        g.scale(scale, scale);
        g.lineWidth = 1.7 / scale;
        g.lineCap = "round";
        g.lineJoin = "round";
        g.strokeStyle = l.ink;
        g.stroke(path);
        g.restore();
      }
    }
    if (l.ring) {
      g.beginPath();
      g.arc(p.x, p.y, l.r + 2 + l.ringWidth / 2, 0, TAU);
      g.lineWidth = l.ringWidth;
      g.strokeStyle = l.ring;
      g.stroke();
    }
  }

  function measure(font: string, text: string): number {
    const key = `${font}\n${text}`;
    let w = textWidths.get(key);
    if (w === undefined) {
      if (textWidths.size > 2000) textWidths.clear();
      g.font = font;
      w = g.measureText(text).width;
      textWidths.set(key, w);
    }
    return w;
  }

  function drawText(text: string, font: string, x: number, y: number, align: CanvasTextAlign, ink: Rgba, halo: Rgba, alpha: number) {
    g.font = font;
    g.textAlign = align;
    g.lineWidth = 4;
    g.strokeStyle = rgba(halo, alpha);
    g.strokeText(text, x, y);
    g.fillStyle = rgba(ink, alpha);
    g.fillText(text, x, y);
  }

  // Names for the focus, its neighbors, the selection and whatever is hovered. Every colored dot
  // keeps a label: several series colors are below 3:1 contrast, so color alone never identifies.
  function drawLabels(pal: Palette, points: Projected[], depths: number[], looks: Look[]) {
    const nodes = scene.nodes;
    const wanted: number[] = [];
    nodes.forEach((n, i) => {
      // A dot zoomed out of view keeps no label: pinned to the edge it would name nothing.
      const { x, y } = points[i];
      const r = looks[i].outer;
      if (x < -r || y < -r || x > width + r || y > height + r) return;
      if ((n.labelled && !n.ghost && looks[i].e > 0.5) || looks[i].hover || n.selected) wanted.push(i);
    });
    const rank = (i: number) => (nodes[i].role === "focus" ? 0 : nodes[i].selected ? 1 : looks[i].hover ? 2 : 3);
    wanted.sort((i, j) => rank(i) - rank(j) || points[i].depth - points[j].depth || i - j);
    const blocks = wanted.map((i) => {
      const n = nodes[i];
      const sub = n.role !== "context" && n.tier ? n.tier : "";
      const font = n.role === "focus" ? pal.fonts.focus : pal.fonts.main;
      const main = measure(font, n.short);
      const text = Math.max(main, sub ? measure(pal.fonts.sub, sub) : 0);
      return {
        i,
        sub,
        font,
        w: Math.ceil(text) + 2 * LABEL_PAD,
        h: LINE_MAIN + (sub ? LINE_SUB : 0),
        // In a crowd the tier word goes first; it stays in the tooltip and the side panel.
        compact: sub ? { w: Math.ceil(main) + 2 * LABEL_PAD, h: LINE_MAIN } : undefined,
      };
    });
    const placed = placeLabels(
      blocks.map((b) => {
        const before = labelSides.get(nodes[b.i].id);
        return {
          x: points[b.i].x,
          y: points[b.i].y,
          r: looks[b.i].outer,
          w: b.w,
          h: b.h,
          compact: b.compact,
          prefer: before?.side,
          preferCompact: before?.compact,
        };
      }),
      width,
      height,
      3,
    );
    // Labels follow their dot exactly, but a move to another side glides: what is smoothed is the
    // offset from the dot, never the position, so a label cannot trail behind during a drag.
    const slide = reduceMotion ? 1 : 1 - Math.exp(-frameDt / LABEL_SLIDE_S);
    const previous = new Map(labelSides);
    let sliding = false;
    labelSides.clear();
    g.textBaseline = "top";
    g.lineJoin = "round";
    g.miterLimit = 2;
    blocks.forEach((b, k) => {
      const box = placed[k];
      const n = nodes[b.i];
      const l = looks[b.i];
      const p = points[b.i];
      const before = previous.get(n.id);
      let dx = box.x - p.x;
      let dy = box.y - p.y;
      if (before && (Math.abs(before.dx - dx) > 0.5 || Math.abs(before.dy - dy) > 0.5)) {
        dx = lerp(before.dx, dx, slide);
        dy = lerp(before.dy, dy, slide);
        sliding = true;
      }
      labelSides.set(n.id, { side: box.side, compact: box.compact, dx, dy });
      const shown = l.hover || n.selected ? 1 : clamp((l.e - 0.5) * 2, 0, 1);
      const alpha = shown * lerp(1, 0.8, depths[b.i]);
      const align = sideAlign(box.side);
      const left = p.x + dx;
      const top = p.y + dy;
      const x = align === "left" ? left + LABEL_PAD : align === "right" ? left + box.w - LABEL_PAD : left + box.w / 2;
      drawText(n.short, b.font, x, top, align, pal.ink, pal.halo, alpha);
      if (b.sub && !box.compact) drawText(b.sub, pal.fonts.sub, x, top + LINE_MAIN, align, pal.ink2, pal.halo, alpha);
    });
    if (sliding) invalidate();
  }

  // Fades in, disappears at once: React empties it as soon as the hover ends, and an empty box
  // fading out would flash.
  function showTooltip(visible: boolean) {
    const opacity = visible ? "1" : "0";
    if (tooltip.style.opacity === opacity) return;
    tooltip.style.transition = visible ? "opacity 120ms ease" : "none";
    tooltip.style.opacity = opacity;
  }

  function placeTooltip() {
    const id = keyId ?? hoverId;
    const i = id === null ? -1 : (scene.index.get(id) ?? -1);
    const p = frame.points[i];
    if (!p || drag?.moved) {
      showTooltip(false);
      return;
    }
    const r = frame.looks[i].outer;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const x = clamp(p.x - tw / 2, 4, Math.max(4, width - tw - 4));
    let y = p.y - r - 8 - th;
    if (y < 4) y = Math.min(p.y + r + 8, height - th - 4); // no room above: show it below
    tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    showTooltip(true);
  }

  function render() {
    if (destroyed || width < 1 || height < 1) return;
    sizeBackingStore();
    palette ??= resolvePalette(canvas, scene.colors);
    const pal = palette;
    g.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    g.clearRect(0, 0, width, height);

    const distance = CAMERA_DISTANCE * span;
    const view: View = {
      yaw,
      pitch,
      distance,
      scale: fitScale(width, height, distance, span, FIT_PADDING) * zoom,
      cx: width / 2 + shift,
      cy: height / 2,
    };
    const nodes = scene.nodes;
    const now = performance.now();
    shown = nodes.map((n) => placeOf(n, now));
    const points = shown.map((p) => project([p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]], view));
    const depths = points.map((p) => depthT(p.depth, distance, span));
    const looks = nodes.map((n, i) => look(n, points[i], depths[i], pal));
    frame = {
      ids: nodes.map((n) => n.id),
      points,
      looks,
      targets: points.map((p, i) => ({ x: p.x, y: p.y, r: looks[i].outer, depth: p.depth, priority: nodes[i].role === "context" || nodes[i].ghost ? 0 : 1 })),
    };

    drawDisc(pal, view);
    drawLinks(pal, points, depths);
    for (const i of depthSort(points.map((p) => p.depth))) drawNode(nodes[i], looks[i], points[i], pal);
    drawLabels(pal, points, depths, looks);

    if (!nodes.length) {
      g.font = pal.fonts.main;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = rgba(pal.ink2);
      g.fillText("No diseases to show.", width / 2, height / 2);
    }
    if (focusRing) {
      g.setLineDash([]);
      g.lineWidth = 2;
      g.strokeStyle = rgba(pal.accent);
      g.beginPath();
      if (typeof g.roundRect === "function") g.roundRect(1, 1, width - 2, height - 2, 11);
      else g.rect(1, 1, width - 2, height - 2);
      g.stroke();
    }
    placeTooltip();
    // The scene can move under a resting pointer (coasting, gliding to a new focus). A tooltip
    // should answer the pointer, not the motion: drop the hover once its dot drifts out of reach,
    // and leave picking a new one to the next pointer move.
    if (hoverId !== null && pointer && !drag) {
      const i = hitTest(frame.targets, pointer.x, pointer.y);
      if (i < 0 || frame.ids[i] !== hoverId) setHover(null);
    }
  }

  function local(e: { clientX: number; clientY: number }): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function setHover(id: string | null) {
    canvas.style.cursor = drag?.moved ? "grabbing" : id ? "pointer" : "grab";
    if (id === hoverId) return;
    hoverId = id;
    if (id === null && keyId === null) showTooltip(false); // before React clears its text
    hooks.hover(id);
    invalidate();
  }

  function updateHover() {
    if (!pointer || drag?.moved) return setHover(null);
    const i = hitTest(frame.targets, pointer.x, pointer.y);
    setHover(i >= 0 ? frame.ids[i] : null);
  }

  function turnRate(): number {
    return clamp(3.6 / Math.max(1, Math.min(width, height)), 0.004, 0.012); // short side ~ 200 degrees
  }

  function spread(): number {
    const [p, q] = [...pointers.values()];
    return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : 0;
  }

  function interrupt() {
    autoRotate = false;
    fly = null;
    vYaw = vPitch = 0;
  }

  // The person zooms: a glide in progress keeps moving the pivot but stops steering the zoom.
  function takeZoom() {
    if (glide) glide.zoom1 = null;
    autoRotate = false;
  }

  function tap(p: Point, time: number) {
    const i = hitTest(frame.targets, p.x, p.y);
    if (i < 0) {
      lastTap = null;
      return;
    }
    const id = frame.ids[i];
    const prev = lastTap;
    if (prev && prev.id === id && time - prev.t < DOUBLE_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) < DOUBLE_TAP_PX) {
      lastTap = null;
      hooks.focus(id);
    } else {
      lastTap = { id, t: time, x: p.x, y: p.y };
      hooks.select(id);
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; the drag still works while it stays over the canvas.
    }
    interrupt();
    if (pointers.size === 1) {
      const slop = e.pointerType === "mouse" ? TAP_SLOP.mouse : TAP_SLOP.touch;
      drag = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, t: e.timeStamp, moved: false, vx: 0, vy: 0, slop };
    } else if (pointers.size === 2) {
      takeZoom();
      pinch = { dist: Math.max(spread(), 1), zoom: zoomGoal };
      if (drag) drag.moved = true; // a pinch is never a tap
    }
    invalidate();
  }

  function onPointerMove(e: PointerEvent) {
    const p = local(e);
    if (e.pointerType !== "touch") pointer = p;
    if (!pointers.has(e.pointerId)) {
      updateHover();
      return;
    }
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      zoom = zoomGoal = clamp((pinch.zoom * spread()) / pinch.dist, ZOOM_MIN, ZOOM_MAX); // locked to the fingers
      invalidate();
      return;
    }
    const d = drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    const dtMs = Math.max(1, e.timeStamp - d.t);
    d.x = p.x;
    d.y = p.y;
    d.t = e.timeStamp;
    if (!d.moved) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) < d.slop) return;
      d.moved = true;
      setHover(null);
    }
    const k = turnRate();
    yaw += dx * k;
    pitch = clampPitch(pitch + dy * k);
    const blend = clamp(dtMs / 40, 0.2, 1); // newer samples count more the longer they span
    d.vx = lerp(d.vx, dx / dtMs, blend);
    d.vy = lerp(d.vy, dy / dtMs, blend);
    invalidate();
  }

  function release(e: PointerEvent, completed: boolean) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    const d = drag;
    if (d && d.id === e.pointerId) {
      drag = null;
      if (!d.moved) {
        if (completed) tap(local(e), e.timeStamp);
      } else if (completed && !reduceMotion && e.timeStamp - d.t < FLING_WINDOW_MS) {
        const k = turnRate() * 1000;
        vYaw = clamp(d.vx * k, -MAX_FLING, MAX_FLING);
        vPitch = clamp(d.vy * k, -MAX_FLING, MAX_FLING);
        if (Math.hypot(vYaw, vPitch) < 0.15) vYaw = vPitch = 0;
      }
    }
    // A finger still down after a pinch keeps turning the scene from where it is, never as a tap.
    if (pointers.size === 1) {
      const [[id, p]] = [...pointers];
      if (drag && drag.id === id) Object.assign(drag, { x: p.x, y: p.y, t: e.timeStamp });
      else drag = { id, x0: p.x, y0: p.y, x: p.x, y: p.y, t: e.timeStamp, moved: true, vx: 0, vy: 0, slop: 0 };
    }
    if (e.pointerType !== "touch") {
      const p = local(e);
      pointer = p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height ? p : null;
    }
    updateHover();
    invalidate();
  }

  const onPointerUp = (e: PointerEvent) => release(e, true);
  const onPointerCancel = (e: PointerEvent) => release(e, false);

  function onPointerLeave(e: PointerEvent) {
    if (e.pointerType === "touch" || drag) return;
    pointer = null;
    setHover(null);
    invalidate();
  }

  function onWheel(e: WheelEvent) {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
    const dy = e.deltaY * unit;
    if (!dy) return;
    // Trackpad pinches arrive as ctrl+wheel with small deltas.
    const next = clamp(zoomGoal * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), ZOOM_MIN, ZOOM_MAX);
    // At a zoom limit a plain scroll goes back to the page instead of being swallowed.
    if (next === zoomGoal && !e.ctrlKey) return;
    e.preventDefault();
    takeZoom();
    zoomGoal = next;
    invalidate();
  }

  function turnBy(dYaw: number, dPitch: number) {
    vYaw = vPitch = 0;
    const yaw1 = (fly ? fly.yaw0 + fly.dYaw : yaw) + dYaw;
    const pitch1 = (fly ? fly.pitch0 + fly.dPitch : pitch) + dPitch;
    flyTo(yaw1, pitch1, KEY_FLY_MS, false);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowLeft":
        turnBy(-KEY_TURN, 0);
        break;
      case "ArrowRight":
        turnBy(KEY_TURN, 0);
        break;
      case "ArrowUp":
        turnBy(0, -KEY_TURN);
        break;
      case "ArrowDown":
        turnBy(0, KEY_TURN);
        break;
      case "+":
      case "=":
        takeZoom();
        zoomGoal = clamp(zoomGoal * KEY_ZOOM, ZOOM_MIN, ZOOM_MAX);
        break;
      case "-":
      case "_":
        takeZoom();
        zoomGoal = clamp(zoomGoal / KEY_ZOOM, ZOOM_MIN, ZOOM_MAX);
        break;
      case "0":
        takeZoom();
        zoomGoal = homeZoom;
        faceFocus(FLY_MS);
        break;
      default:
        return;
    }
    e.preventDefault();
    autoRotate = false;
    focusRing = matchesFocusVisible();
    invalidate();
  }

  function matchesFocusVisible(): boolean {
    try {
      return canvas.matches(":focus-visible");
    } catch {
      return true;
    }
  }

  function onFocusIn() {
    hasFocus = true;
    focusRing = matchesFocusVisible();
    invalidate();
  }

  function onFocusOut() {
    hasFocus = false;
    focusRing = false;
    invalidate();
  }

  const resize = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    const box = entry.contentBoxSize?.[0];
    width = box ? box.inlineSize : entry.contentRect.width;
    height = box ? box.blockSize : entry.contentRect.height;
    const device = entry.devicePixelContentBoxSize?.[0];
    deviceSize = device ? { w: device.inlineSize, h: device.blockSize } : null;
    render(); // now, before the browser paints the stretched old bitmap
  });
  try {
    resize.observe(canvas, { box: "device-pixel-content-box" }); // exact device pixels where supported
  } catch {
    resize.observe(canvas);
  }

  const visibility =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          onScreen = entries[entries.length - 1].isIntersecting;
          if (onScreen) invalidate();
        });
  visibility?.observe(canvas);

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onMotion = () => {
    reduceMotion = motionQuery.matches;
    if (reduceMotion) settle();
    invalidate();
  };
  reduceMotion = motionQuery.matches;
  motionQuery.addEventListener("change", onMotion);

  const restyle = () => {
    palette = null;
    invalidate();
  };
  const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  schemeQuery.addEventListener("change", restyle);
  // Theme switches done with a class or data attribute instead of the media query.
  const themeWatch = new MutationObserver(restyle);
  for (const el of [document.documentElement, document.body]) {
    themeWatch.observe(el, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] });
  }

  // Moving to a screen with another pixel density (Safari does not report device pixels).
  let dprQuery: MediaQueryList | null = null;
  const onDpr = () => {
    watchDpr();
    invalidate();
  };
  function watchDpr() {
    dprQuery?.removeEventListener("change", onDpr);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener("change", onDpr);
  }
  watchDpr();

  document.fonts?.ready.then(() => {
    if (destroyed) return;
    textWidths.clear(); // labels were measured with a fallback font
    restyle();
  });

  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("focus", onFocusIn);
  canvas.addEventListener("blur", onFocusOut);

  return {
    setScene(next) {
      const previous = scene;
      const first = previous === EMPTY_SCENE;
      scene = next;
      const present = new Set(next.nodes.map((n) => n.id));
      for (const n of next.nodes) {
        if (first || reduceMotion || !anim.has(n.id)) anim.set(n.id, goalsOf(n));
      }
      for (const id of [...anim.keys()]) if (!present.has(id)) anim.delete(id);
      for (const id of [...labelSides.keys()]) if (!present.has(id)) labelSides.delete(id);
      if (next.colorKey !== previous.colorKey) palette = null;

      // New links fade in while the old ones fade out, but only when the linked pairs changed.
      if (!first && next.linkKey !== previous.linkKey && !reduceMotion) {
        const carried = previous.links.flatMap((l) => {
          const a = next.index.get(l.ids[0]);
          const b = next.index.get(l.ids[1]);
          return a === undefined || b === undefined ? [] : [{ ...l, a, b, selected: false }];
        });
        fading = carried.length ? { links: carried, alpha: linkAlpha } : null;
        linkAlpha = 0;
      } else if (first) {
        fading = null;
        linkAlpha = 1;
      }

      // A new focus becomes the center of the orbit: the scene glides over to it, zooms to frame
      // its neighbors and turns so the rest of the atlas sits behind it rather than in front.
      const focus = next.focus >= 0 ? next.nodes[next.focus] : null;
      const focusId = focus ? focus.id : null;
      const layoutChanged = first || next.layout !== previous.layout;
      if (first || focusId !== facedId || layoutChanged) {
        // On the disc, every dot glides from where it was (new ones from the center), like the
        // 2D map's entrance; the cloud keeps its positions and the camera moves instead.
        if (next.layout === "disc" && !reduceMotion) {
          const from = new Map<string, Vec3>();
          if (previous.layout === "disc") previous.nodes.forEach((n, i) => from.set(n.id, shown[i] ?? n.p));
          morph = { start: performance.now(), from };
        } else morph = null;
        facedId = focusId;
        glideHome(first ? 0 : FLY_MS);
        if (next.layout === "disc") {
          // Seen from above at an angle, diseases at the far side as on the 2D map. The disc holds
          // still: turning it on its own would scramble which direction holds which kind of thing.
          autoRotate = false;
          spin = 0;
          if (layoutChanged) {
            if (first) {
              yaw = 0;
              pitch = DISC_PITCH;
            } else flyTo(0, DISC_PITCH, FLY_MS, true);
          }
        } else if (focus && Math.hypot(focus.p[0], focus.p[1], focus.p[2]) > FACE_MIN_RADIUS) {
          if (first) ({ yaw, pitch } = faceAngles(focus.p));
          else if (!drag?.moved) faceFocus(FLY_MS);
        } else if (layoutChanged && !first) {
          flyTo(yaw, 0, FLY_MS, true);
        }
      }
      invalidate();
    },
    setKeyTarget(id) {
      keyId = id;
      if (id === null && hoverId === null) showTooltip(false);
      invalidate();
    },
    setListOpen(open, listWidth) {
      listOpen = open;
      // The list covers the left of the canvas: slide the scene into the space beside it, when
      // there is enough, so the dot a row describes stays visible.
      shiftGoal = open && width - listWidth >= 280 ? (listWidth + 8) / 2 : 0;
      if (reduceMotion) shift = shiftGoal;
      invalidate();
    },
    invalidate,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resize.disconnect();
      visibility?.disconnect();
      themeWatch.disconnect();
      motionQuery.removeEventListener("change", onMotion);
      schemeQuery.removeEventListener("change", restyle);
      dprQuery?.removeEventListener("change", onDpr);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("focus", onFocusIn);
      canvas.removeEventListener("blur", onFocusOut);
      tooltip.style.opacity = "0";
    },
  };
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

// The keyboard list shows itself while it holds focus, so sighted keyboard users see where they are.
const LIST_OPEN: CSSProperties = {
  position: "absolute",
  left: 8,
  bottom: 8,
  zIndex: 2,
  width: "min(340px, calc(100% - 16px))",
  maxHeight: "calc(100% - 16px)",
  overflowY: "auto",
  padding: 8,
  borderRadius: 12,
  background: "var(--surface, #fff)",
  color: "var(--ink, #1d1d1f)",
  border: "1px solid var(--line, #e5e5ea)",
  boxShadow: "0 6px 20px rgba(0, 0, 0, 0.14)",
  fontSize: 13,
  lineHeight: "18px",
};

const TOOLTIP: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  zIndex: 3, // above the keyboard list, which it annotates
  maxWidth: 260,
  padding: "6px 10px",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  color: "var(--ink, #1d1d1f)",
  border: "1px solid var(--line, #e5e5ea)",
  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.12)",
  fontSize: 13,
  lineHeight: "18px",
  pointerEvents: "none",
  opacity: 0, // shown and placed by the renderer, outside React, every frame it moves
  willChange: "transform",
};

const MUTED: CSSProperties = { color: "var(--ink-2, #6e6e73)" };

const ROW_BUTTON: CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: "left",
  padding: "4px 8px",
  borderRadius: 8,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

const CENTER_BUTTON: CSSProperties = {
  ...ROW_BUTTON,
  flex: "none",
  color: "var(--accent, #0071e3)",
};

const NO_RINGS: Graph3DRing[] = [];
const NO_SECTORS: Graph3DSector[] = [];

export default function Graph3D({
  nodes,
  links,
  focusId,
  selectedId,
  onSelect,
  onFocus,
  ariaLabel,
  layout = "cloud",
  rings = NO_RINGS,
  sectors = NO_SECTORS,
  caption = CAPTION,
  className,
}: Graph3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<OrbitView | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const hintId = useId();

  const scene = useMemo(
    () => buildScene(nodes, links, focusId, selectedId, layout, rings, sectors),
    [nodes, links, focusId, selectedId, layout, rings, sectors],
  );

  const select = useEffectEvent((id: string) => onSelect(id));
  const focus = useEffectEvent((id: string) => onFocus(id));

  useEffect(() => {
    const canvas = canvasRef.current;
    const tooltip = tooltipRef.current;
    if (!canvas || !tooltip) return;
    const view = createOrbitView(canvas, tooltip, { select, focus, hover: setHoverId });
    viewRef.current = view;
    return () => {
      view?.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.setScene(scene);
  }, [scene]);
  useEffect(() => {
    viewRef.current?.setKeyTarget(keyId);
  }, [keyId]);
  useEffect(() => {
    viewRef.current?.setListOpen(listOpen, listOpen ? (listRef.current?.offsetWidth ?? 0) : 0);
  }, [listOpen]);
  // The tooltip's size follows its text: place it again once React has rendered the new one.
  useEffect(() => {
    viewRef.current?.invalidate();
  }, [hoverId, keyId]);

  // Keyboard twin of the highlighted dots: the focus, then neighbors from the strongest link down.
  const entries = useMemo(() => {
    const strength = new Map<string, number>();
    for (const l of scene.links) {
      const [a, b] = [scene.nodes[l.a], scene.nodes[l.b]];
      if (a.role === "focus") strength.set(b.id, Math.max(strength.get(b.id) ?? 0, l.strength));
      if (b.role === "focus") strength.set(a.id, Math.max(strength.get(a.id) ?? 0, l.strength));
    }
    const rank = (n: SceneNode) => (n.role === "focus" ? 0 : 1);
    return scene.nodes
      .filter((n) => n.role !== "context")
      .sort(
        (x, y) =>
          rank(x) - rank(y) ||
          (strength.get(y.id) ?? 0) - (strength.get(x.id) ?? 0) ||
          (x.label < y.label ? -1 : x.label > y.label ? 1 : 0) ||
          (x.id < y.id ? -1 : 1),
      );
  }, [scene]);

  const tipId = keyId ?? hoverId;
  const tip = tipId === null ? undefined : scene.nodes[scene.index.get(tipId) ?? -1];
  const hint =
    keyId === null && tip
      ? (tip.hint ??
        (tip.role === "neighbor" ? "Click for the evidence" : tip.role === "context" ? "Double-click to center the map here" : null))
      : null;
  const count = scene.nodes.length;
  const what = layout === "disc" ? (count === 1 ? "item" : "items") : count === 1 ? "disease" : "diseases";

  return (
    <div className={`flex h-full min-h-0 w-full flex-col ${className ?? ""}`}>
      <div className="relative min-h-[240px] flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={`${ariaLabel} (${count} ${what})`}
          aria-describedby={hintId}
          className="absolute inset-0 block h-full w-full"
          style={{ touchAction: "none", userSelect: "none", WebkitUserSelect: "none", outline: "none", WebkitTapHighlightColor: "transparent" }}
        />
        <div ref={tooltipRef} aria-hidden="true" style={TOOLTIP}>
          {tip ? (
            <>
              <div style={{ fontWeight: 600 }}>{sentenceLabel(tip.label)}</div>
              {tip.detail ? <div style={MUTED}>{tip.detail}</div> : tip.tier ? <div style={MUTED}>{tip.tier}</div> : null}
              {hint ? <div style={{ ...MUTED, fontSize: 12, marginTop: 2 }}>{hint}</div> : null}
            </>
          ) : null}
        </div>
        {entries.length ? (
          <div
            ref={listRef}
            role="group"
            aria-label={layout === "disc" ? "Items on the map" : "Highlighted diseases"}
            onFocus={() => setListOpen(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setListOpen(false);
            }}
            style={listOpen ? LIST_OPEN : VISUALLY_HIDDEN}
          >
            <p style={{ ...MUTED, margin: "0 8px 6px", fontSize: 12 }}>
              Enter shows the evidence. Center (or Shift+Enter) moves the map there.
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {entries.map((n) => (
                <li key={n.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button
                    type="button"
                    aria-current={n.selected ? "true" : undefined}
                    onClick={() => onSelect(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.shiftKey) {
                        e.preventDefault();
                        onFocus(n.id);
                      }
                    }}
                    onFocus={() => setKeyId(n.id)}
                    onBlur={() => setKeyId(null)}
                    style={{ ...ROW_BUTTON, fontWeight: n.role === "focus" || n.selected ? 600 : 400 }}
                  >
                    {sentenceLabel(n.label)}
                    {n.tier ? <span style={MUTED}> · {n.tier}</span> : null}
                    {n.role === "focus" ? <span style={MUTED}> · in focus</span> : null}
                  </button>
                  {n.role === "focus" || n.count !== undefined ? null : (
                    <button
                      type="button"
                      aria-label={`Center the map on ${sentenceLabel(n.label)}`}
                      onClick={() => onFocus(n.id)}
                      onFocus={() => setKeyId(n.id)}
                      onBlur={() => setKeyId(null)}
                      style={CENTER_BUTTON}
                    >
                      Center
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-4 text-pretty" style={MUTED}>
        {caption}
      </p>
      <p id={hintId} style={VISUALLY_HIDDEN}>
        Arrow keys rotate the view, plus and minus zoom, and 0 resets it. Press Tab to reach the list of{" "}
        {layout === "disc" ? "items on the map" : "highlighted diseases"}.
      </p>
    </div>
  );
}
