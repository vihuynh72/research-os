"use client";

// The 2D map: the searched disease in the center, its closest diseases on three rings.
// Distance encodes shared biology only (the grading layer's biology score), the ring is the
// tier, color is the mechanism cluster, dot size is centrality, dashed means inferred.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GraphNode } from "@/lib/graph/types";
import type { PairGrade, Tier } from "@/lib/grading/types";
import { sentenceLabel, shortLabel } from "@/lib/graph/labels";
import { TIER_WORD, diseaseColor, formatScore, nodeOf, pairOf, type AtlasModel, type Mode } from "./format";
import { ClinicalBadge, TierBadge } from "./NeighborList";

const C = 500; // center of the 1000 x 1000 map space
const PAD = 60; // map units kept free outside the outer ring, mostly for labels
const FOCUS_R = 34;
const BANDS: Record<Exclude<Tier, "none">, { inner: number; outer: number }> = {
  strong: { inner: 120, outer: 230 },
  moderate: { inner: 230, outer: 340 },
  exploratory: { inner: 340, outer: 440 },
};
const RING_ORDER = ["strong", "moderate", "exploratory"] as const;
const MAX_LABEL_PX = 190; // widest a neighbor label may get before it wraps or truncates
const LABEL_CHARS = 44; // names without a compact synonym get two lines before truncating

// Coordinates are rounded so the server's and the browser's trig agree to the character and
// hydration sees identical markup (Node and Chrome can differ in the last bits of Math.sin).
const r2 = (v: number) => Math.round(v * 100) / 100;

type Side = "right" | "left" | "below" | "above";

interface Placed {
  id: string;
  node: GraphNode;
  pair: PairGrade;
  tier: Tier;
  relevance: number;
  angle: number; // radians, clockwise from 3 o'clock (SVG y points down)
  x: number;
  y: number;
  r: number; // dot radius
  color: string;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Label {
  anchor: "start" | "middle" | "end";
  x: number; // relative to the node center
  y: number; // first baseline, relative to the node center
  lines: string[];
  sub: string;
  subY: number;
  box: Box; // absolute map units, for collision checks and the click target
}

// Width estimate for the system font, in em. Deterministic, so server and client agree and
// no text has to be measured in the DOM.
function charEm(ch: string): number {
  if (ch === " ") return 0.28;
  if ("ilj.,:;'|!()[]".includes(ch)) return 0.3;
  if ("mwMW".includes(ch)) return 0.84;
  if (/[A-Z0-9]/.test(ch)) return 0.66;
  return 0.55;
}

// Map labels are semibold, which runs about 6% wider than regular text.
function textWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size * 1.06;
}

function truncate(text: string, max: number, size: number): string {
  if (textWidth(text, size) <= max) return text;
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`, size) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

// Up to two lines: break at a space when the label is too wide, then truncate what is left.
function fitLines(text: string, max: number, size: number): string[] {
  if (textWidth(text, size) <= max) return [text];
  const words = text.split(" ");
  let first = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = first ? `${first} ${words[i]}` : words[i];
    if (textWidth(next, size) > max) break;
    first = next;
  }
  if (!first || i >= words.length) return [truncate(text, max, size)];
  return [first, truncate(words.slice(i).join(" "), max, size)];
}

// Overlap area with a margin around the first box, so labels keep clear of each other
// instead of merely not touching.
function overlap(a: Box, b: Box, margin = 0): number {
  const w = Math.min(a.x1 + margin, b.x1) - Math.max(a.x0 - margin, b.x0);
  const h = Math.min(a.y1 + margin * 0.5, b.y1) - Math.max(a.y0 - margin * 0.5, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

function outside(a: Box, area: Box): number {
  const inW = Math.max(0, Math.min(a.x1, area.x1) - Math.max(a.x0, area.x0));
  const inH = Math.max(0, Math.min(a.y1, area.y1) - Math.max(a.y0, area.y0));
  return (a.x1 - a.x0) * (a.y1 - a.y0) - inW * inH;
}

// Distance from the center inside the tier's band: more shared biology sits closer. Dots keep
// a small inset from the band's edges, so a capped pair (biology above its tier) never sits on
// the ring line, where it would read as the next tier.
export function radiusFor(tier: Tier, biology: number, thresholds: { strong: number; moderate: number; exploratory: number }): number {
  const band = BANDS[tier === "none" ? "exploratory" : tier];
  const min = tier === "strong" ? thresholds.strong : tier === "moderate" ? thresholds.moderate : thresholds.exploratory;
  const max = tier === "strong" ? 1 : tier === "moderate" ? thresholds.strong : thresholds.moderate;
  const t = Math.min(1, Math.max(0, (biology - min) / (max - min || 1)));
  return band.outer - (0.08 + 0.84 * t) * (band.outer - band.inner);
}

interface Props {
  model: AtlasModel;
  focusId: string;
  selectedId: string | null;
  mode: Mode;
  onSelect(id: string | null): void;
  onFocus(id: string): void;
}

export default function RadialMap({ model, focusId, selectedId, mode, onSelect, onFocus }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tip, setTip] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w && h) setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The view box always matches the container's shape, so the circle stays centered and
  // labels can use the spare width on wide screens.
  const W = size?.w ?? 720;
  const H = size?.h ?? 720;
  const base = 1000 + 2 * PAD;
  const vbW = W >= H ? (base * W) / H : base;
  const vbH = W >= H ? base : (base * H) / W;
  const vb = { x: C - vbW / 2, y: C - vbH / 2, w: vbW, h: vbH };
  const s = W / vbW; // screen px per map unit
  const labelPx = s < 0.42 ? 11.5 : 13;
  const font = labelPx / s;
  const subFont = (labelPx - 1.5) / s;
  const halo = 3.5 / s;
  const lineH = font * 1.15;

  const focus = nodeOf(model, focusId);
  const entry = model.relevance.diseases[focusId];
  const thresholds = model.relevance.meta.thresholds;

  const placed = useMemo<Placed[]>(() => {
    const list = (entry?.neighbors ?? []).flatMap((n) => {
      const node = nodeOf(model, n.id);
      const pair = pairOf(model, focusId, n.id);
      return node && pair ? [{ n, node, pair, cluster: model.relevance.diseases[n.id]?.cluster ?? null }] : [];
    });
    // Same cluster sits together; inside a cluster the closest comes first. Code-unit order, not
    // localeCompare, so the server and every browser place the dots identically.
    const byCode = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    list.sort(
      (a, b) =>
        (a.cluster === null ? 1 : 0) - (b.cluster === null ? 1 : 0) ||
        byCode(a.cluster ?? "", b.cluster ?? "") ||
        b.n.relevance - a.n.relevance ||
        byCode(a.n.id, b.n.id),
    );
    // Evenly spaced from -60 degrees clockwise, kept inside a 300 degree arc so the ring
    // names at 12 o'clock stay clear.
    const count = list.length;
    const step = count <= 1 ? 0 : Math.min(360 / count, 300 / (count - 1));
    return list.map(({ n, node, pair }, i) => {
      const angle = ((-60 + i * step) * Math.PI) / 180;
      const dist = radiusFor(n.tier, n.relevance, thresholds);
      return {
        id: n.id,
        node,
        pair,
        tier: n.tier,
        relevance: n.relevance,
        angle,
        x: r2(C + dist * Math.cos(angle)),
        y: r2(C + dist * Math.sin(angle)),
        r: 12 + 12 * (model.relevance.diseases[n.id]?.centrality ?? 0),
        color: diseaseColor(model, n.id),
      };
    });
  }, [entry, focusId, model, thresholds]);

  const focusFont = font * 1.1;
  const focusLineH = focusFont * 1.15;
  const focusLines = focus ? fitLines(shortLabel(focus, LABEL_CHARS), 240 / s, focusFont) : [];
  const focusLabelTop = C + FOCUS_R + 11 / s;
  const ringLabelY = (tier: (typeof RING_ORDER)[number]) => C - BANDS[tier].outer + subFont * 1.2;

  // Greedy label placement, most related first: each label tries the side facing away from
  // the center, then above or below, and keeps the spot that covers the fewest dots, labels
  // and ring names and stays inside the map.
  const labels = new Map<string, Label>();
  {
    const area: Box = { x0: vb.x + 6 / s, y0: vb.y + 4 / s, x1: vb.x + vb.w - 6 / s, y1: vb.y + vb.h - 4 / s };
    const dots = placed.map((p) => ({ id: p.id, box: { x0: p.x - p.r, y0: p.y - p.r, x1: p.x + p.r, y1: p.y + p.r } }));
    const obstacles: Box[] = RING_ORDER.map((tier) => {
      const w = textWidth(TIER_WORD[tier], subFont);
      const y = ringLabelY(tier);
      return { x0: C - w / 2, y0: y - subFont, x1: C + w / 2, y1: y + subFont * 0.3 };
    });
    const clear = 10 / s; // breathing room around the center, which belongs to the focus
    obstacles.push({ x0: C - FOCUS_R - clear, y0: C - FOCUS_R - clear, x1: C + FOCUS_R + clear, y1: C + FOCUS_R + clear });
    if (focusLines.length) {
      const w = Math.max(...focusLines.map((l) => textWidth(l, focusFont)));
      obstacles.push({ x0: C - w / 2 - clear, y0: focusLabelTop, x1: C + w / 2 + clear, y1: focusLabelTop + focusLines.length * focusLineH + clear });
    }
    const gap = 6 / s;
    const maxW = MAX_LABEL_PX / s;
    const order = [...placed].sort(
      (a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0) || b.relevance - a.relevance || (a.id < b.id ? -1 : 1),
    );
    for (const p of order) {
      const text = shortLabel(p.node, LABEL_CHARS);
      const sub = mode === "researcher" ? `${TIER_WORD[p.tier]} · ${formatScore(p.relevance)}` : TIER_WORD[p.tier];
      const cos = Math.cos(p.angle);
      const sin = Math.sin(p.angle);
      // shift slides the block along the node: vertically for side labels, sideways for
      // labels above or below, so a label can step around its neighbor's.
      const build = (side: Side, shift: number): Label => {
        let avail = maxW;
        if (side === "right") avail = Math.min(maxW, area.x1 - (p.x + p.r + gap));
        if (side === "left") avail = Math.min(maxW, p.x - p.r - gap - area.x0);
        const lines = fitLines(text, Math.max(avail, font * 2.5), font);
        const width = Math.max(...lines.map((l) => textWidth(l, font)), textWidth(sub, subFont));
        const blockH = lines.length * lineH + subFont * 1.3;
        let anchor: Label["anchor"] = "middle";
        let x = 0;
        let top: number;
        if (side === "right" || side === "left") {
          anchor = side === "right" ? "start" : "end";
          x = side === "right" ? p.r + gap : -(p.r + gap);
          top = -blockH / 2 + sin * blockH * 0.25 + shift * blockH;
        } else {
          // Centered labels also slide sideways to stay inside the map instead of being cut off.
          const half = width / 2;
          x = Math.min(Math.max(p.x + shift * width, area.x0 + half), area.x1 - half) - p.x;
          top = side === "below" ? p.r + gap * 0.6 : -(p.r + gap * 0.6) - blockH;
        }
        const x0 = anchor === "start" ? p.x + x : anchor === "end" ? p.x + x - width : p.x + x - width / 2;
        return {
          anchor,
          x: r2(x),
          y: r2(top + font * 0.92),
          lines,
          sub,
          subY: r2(top + lines.length * lineH + subFont * 1.02),
          box: { x0: r2(x0), y0: r2(p.y + top), x1: r2(x0 + width), y1: r2(p.y + top + blockH) },
        };
      };
      const outward: Side = cos >= 0 ? "right" : "left";
      const inward: Side = cos >= 0 ? "left" : "right";
      const vertical: Side = sin >= 0 ? "below" : "above";
      const otherVertical: Side = sin >= 0 ? "above" : "below";
      const sides: Side[] = Math.abs(cos) >= 0.38 ? [outward, vertical, otherVertical, inward] : [vertical, outward, inward, otherVertical];
      let best: Label | null = null;
      let bestCost = Infinity;
      for (let rank = 0; rank < sides.length; rank++) {
        for (const shift of [0, 0.4, -0.4]) {
          const label = build(sides[rank], shift);
          let cost = (rank + Math.abs(shift) * 1.5) * font * font * 0.5 + outside(label.box, area) * 40;
          for (const o of obstacles) cost += overlap(label.box, o, 6 / s) * 4;
          for (const d of dots) if (d.id !== p.id) cost += overlap(label.box, d.box, 4 / s) * 4;
          // A spot with room for the whole name wins over a cramped one.
          if (label.lines.join(" ") !== text) cost += font * font * 2;
          if (cost < bestCost) {
            bestCost = cost;
            best = label;
          }
        }
      }
      if (best) {
        labels.set(p.id, best);
        obstacles.push(best.box);
      }
    }
  }

  // A hover tooltip must close on Escape even when the keyboard focus is elsewhere (WCAG 1.4.13).
  useEffect(() => {
    if (!tip) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTip(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tip]);

  const showTip = (id: string) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setTip(id);
  };
  const hideTipSoon = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTip(null), 120);
  };
  const onKey = (event: KeyboardEvent, id: string | null) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey && id) onFocus(id);
      else onSelect(id);
    } else if (event.key === " ") {
      event.preventDefault(); // act on key up, like a native button
    }
  };
  const onKeyUp = (event: KeyboardEvent, id: string | null) => {
    if (event.key === " ") onSelect(id);
  };

  if (!focus || !entry) return null;
  const focusShort = shortLabel(focus);
  const tipItem = tip ? placed.find((p) => p.id === tip) : undefined;

  // Visual dots render in id order so a refocus never reorders the DOM: the same element
  // glides from the ring to the center (a CSS transform transition) instead of being recreated.
  const dots = [
    { id: focusId, x: C, y: C, r: FOCUS_R, color: diseaseColor(model, focusId), focus: true },
    ...placed.map((p) => ({ id: p.id, x: p.x, y: p.y, r: p.r, color: p.color, focus: false })),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (tip) setTip(null);
        else if (selectedId) onSelect(null);
      }}
    >
      <svg
        className="map-svg absolute inset-0 h-full w-full"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        role="group"
        aria-label={`Map of the diseases closest to ${focusShort}: ${placed.length} shown`}
      >
        <g aria-hidden="true">
          {RING_ORDER.map((tier) => (
            <circle
              key={tier}
              cx={C}
              cy={C}
              r={BANDS[tier].outer}
              fill="none"
              stroke="var(--line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {placed.map((p) => {
            const selected = p.id === selectedId;
            return (
              <line
                key={`${focusId}>${p.id}`}
                className="map-link map-enter"
                x1={C}
                y1={C}
                x2={p.x}
                y2={p.y}
                stroke={selected ? "var(--accent)" : "var(--ink-3)"}
                strokeWidth={selected ? 3.5 : 1.5 + 2 * p.relevance}
                strokeDasharray={p.pair.support === "observed" ? undefined : "6 5"}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                opacity={selectedId && !selected ? 0.25 : 1}
              />
            );
          })}
          {RING_ORDER.map((tier) => (
            <text
              key={tier}
              className="map-label map-label-muted"
              x={C}
              y={ringLabelY(tier)}
              textAnchor="middle"
              fontSize={subFont}
              strokeWidth={halo}
            >
              {TIER_WORD[tier]}
            </text>
          ))}

          {dots.map((d) => {
            const selected = d.id === selectedId;
            const hovered = d.id === tip;
            return (
              <g key={d.id} className="map-move map-enter" style={{ transform: `translate(${d.x}px, ${d.y}px)` }}>
                <circle
                  r={d.r}
                  fill={d.color}
                  stroke={d.focus ? "var(--ink)" : selected ? "var(--accent)" : hovered ? "var(--ink)" : "var(--surface)"}
                  strokeWidth={d.focus || selected ? 3 : 2}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}

          <text
            className="map-label"
            x={C}
            y={focusLabelTop + focusFont * 0.92}
            textAnchor="middle"
            fontSize={focusFont}
            fontWeight={700}
            strokeWidth={halo}
          >
            {focusLines.map((line, i) => (
              <tspan key={i} x={C} dy={i === 0 ? 0 : focusLineH}>
                {line}
              </tspan>
            ))}
          </text>
          {!placed.length && (
            <text
              className="map-label map-label-muted"
              x={C}
              y={focusLabelTop + focusLines.length * focusLineH + font * 1.6}
              textAnchor="middle"
              fontSize={font}
              strokeWidth={halo}
            >
              No supported connection in this atlas yet.
            </text>
          )}
          {placed.map((p) => {
            const label = labels.get(p.id);
            if (!label) return null;
            return (
              <g key={`${focusId}:${p.id}`} className="map-enter" transform={`translate(${p.x} ${p.y})`}>
                <text
                  className="map-label"
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  fontSize={font}
                  fontWeight={p.id === selectedId ? 700 : 600}
                  strokeWidth={halo}
                >
                  {label.lines.map((line, i) => (
                    <tspan key={i} x={label.x} dy={i === 0 ? 0 : lineH}>
                      {line}
                    </tspan>
                  ))}
                </text>
                <text
                  className="map-label map-label-muted"
                  x={label.x}
                  y={label.subY}
                  textAnchor={label.anchor}
                  fontSize={subFont}
                  strokeWidth={halo}
                >
                  {label.sub}
                </text>
              </g>
            );
          })}
        </g>

        {/* Interactive layer in reading order: the center first, then clockwise. */}
        <g
          className="map-hit"
          role="button"
          tabIndex={0}
          aria-label={`${focus.label}, center of the map${selectedId ? ", activate to clear the selection" : ""}`}
          onClick={() => onSelect(null)}
          onKeyDown={(event) => onKey(event, null)}
          onKeyUp={(event) => onKeyUp(event, null)}
        >
          <circle cx={C} cy={C} r={FOCUS_R + 4 / s} fill="transparent" />
          <circle
            className="map-focus-ring"
            cx={C}
            cy={C}
            r={FOCUS_R + 8 / s}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </g>
        {placed.map((p) => {
          const selected = p.id === selectedId;
          const label = labels.get(p.id);
          return (
            <g
              key={p.id}
              className="map-hit"
              role="button"
              tabIndex={0}
              aria-label={`${p.node.label}, ${TIER_WORD[p.tier].toLowerCase()} link`}
              aria-pressed={selected}
              onClick={() => onSelect(p.id)}
              onDoubleClick={() => onFocus(p.id)}
              onKeyDown={(event) => onKey(event, p.id)}
              onKeyUp={(event) => onKeyUp(event, p.id)}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") showTip(p.id);
              }}
              onPointerLeave={hideTipSoon}
              onFocus={() => showTip(p.id)}
              onBlur={hideTipSoon}
            >
              <circle cx={p.x} cy={p.y} r={Math.max(p.r + 4 / s, 22 / s)} fill="transparent" />
              {label && (
                <rect
                  x={label.box.x0}
                  y={label.box.y0}
                  width={label.box.x1 - label.box.x0}
                  height={label.box.y1 - label.box.y0}
                  fill="transparent"
                />
              )}
              <circle
                className="map-focus-ring"
                cx={p.x}
                cy={p.y}
                r={p.r + 7 / s}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>

      {tipItem && (
        <div
          role="tooltip"
          className="map-tooltip rounded-xl border border-line bg-surface p-3 text-sm shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
          style={tipStyle((tipItem.x - vb.x) * s, (tipItem.y - vb.y) * s, tipItem.r * s, W)}
          onPointerEnter={() => showTip(tipItem.id)}
          onPointerLeave={hideTipSoon}
        >
          <p className="font-semibold text-ink">{sentenceLabel(tipItem.node.label)}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <TierBadge tier={tipItem.tier} />
            {tipItem.pair.clinical_tier && <ClinicalBadge tier={tipItem.pair.clinical_tier} />}
          </div>
          <p className="mt-1.5 text-ink-2 text-pretty">{tipItem.pair.tier_reason}</p>
          <p className="mt-1.5 text-xs font-medium text-accent-ink">Click for the evidence</p>
        </div>
      )}
    </div>
  );
}

// Above the dot when there is room, below it otherwise; kept inside the map horizontally.
function tipStyle(left: number, top: number, radiusPx: number, width: number) {
  const tipW = Math.min(288, width - 16);
  const x = Math.min(Math.max(left - tipW / 2, 8), width - tipW - 8);
  return top > 170
    ? { left: x, top: top - radiusPx - 10, width: tipW, transform: "translateY(-100%)" }
    : { left: x, top: top + radiusPx + 10, width: tipW };
}
