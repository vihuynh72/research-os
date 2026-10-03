"use client";

// The relevance bar beside the map: one threshold filters every node by its relevance to the
// searched disease. The mini histogram shows what lowering the bar would reveal, so the user is
// never guessing. Vertical beside the map; horizontal under it on phones.
import { useRef } from "react";
import type { NodeType } from "@/lib/graph/types";
import { ICON_PATH } from "@/lib/viz/icons";
import { TYPE_NAME } from "@/lib/graph/vocab";
import { KIND_OF, KIND_STYLE } from "./kinds";

export interface RelevanceBarProps {
  value: number; // 0..1
  onChange(value: number): void;
  histogram: number[]; // counts per bucket, bucket 0 is the least relevant
  shown: number;
  total: number;
  relatedShown: number;
  relatedTotal: number;
  thresholds: { strong: number; moderate: number; exploratory: number };
  types: { type: NodeType; shown: number; total: number }[];
  hiddenTypes: ReadonlySet<NodeType>;
  onToggleType(type: NodeType): void;
  onOnlyType(type: NodeType): void; // show this type alone (plus what was searched)
  onShowAllTypes(): void;
  onReset(): void;
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
  defaultValue?: number;
}

// Short names keep the type toggles on one line in a narrow column.
const SHORT: Record<NodeType, string> = {
  Disease: "Diseases",
  Gene: "Genes",
  Variant: "Variants",
  Mechanism: "Mechanisms",
  Phenotype: "Symptoms",
  PatientOrg: "Groups",
  Asset: "Registries",
  Trial: "Studies",
  Paper: "Papers",
  Grant: "Grants",
  Investigator: "Researchers",
};

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const snap = (x: number) => Math.round(clamp(x) * 100) / 100;

export default function RelevanceBar(props: RelevanceBarProps) {
  const { value, histogram, thresholds, orientation = "vertical", disabled } = props;
  const vertical = orientation === "vertical";
  const trackRef = useRef<HTMLDivElement>(null);
  // Key repeat can outrun re-renders; step from the latest value, not the one this render saw.
  const latest = useRef(value);
  latest.current = value;
  const maxCount = Math.max(1, ...histogram);
  const pctValue = Math.round(value * 100);
  const ticks = [
    { v: 1, label: "Direct" },
    { v: thresholds.strong, label: "Strong" },
    { v: thresholds.moderate, label: "Moderate" },
    { v: thresholds.exploratory, label: "Exploratory" },
  ];

  const fromPointer = (clientX: number, clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return value;
    return snap(vertical ? 1 - (clientY - rect.top) / rect.height : (clientX - rect.left) / rect.width);
  };
  const position = (v: number) => (vertical ? { top: `${(1 - v) * 100}%` } : { left: `${v * 100}%` });

  const onKey = (event: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01, PageUp: 0.1, PageDown: -0.1 };
    let next: number;
    if (event.key in step) next = snap(latest.current + step[event.key]);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    else return;
    event.preventDefault();
    latest.current = next;
    props.onChange(next);
  };

  const track = (
    <div
      className={`relative ${vertical ? "mx-auto h-full w-10" : "h-10 w-full"} ${disabled ? "opacity-40" : "cursor-pointer"} touch-none`}
      onPointerDown={(event) => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        props.onChange(fromPointer(event.clientX, event.clientY));
      }}
      onPointerMove={(event) => {
        if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        props.onChange(fromPointer(event.clientX, event.clientY));
      }}
    >
      <div ref={trackRef} className={`absolute ${vertical ? "inset-y-2 left-1/2 w-1.5 -translate-x-1/2" : "inset-x-2 top-1/2 h-1.5 -translate-y-1/2"} rounded-full bg-[var(--line)]`}>
        {/* The part of the scale that is on the map. */}
        <div
          className="absolute rounded-full bg-[var(--accent)]"
          style={vertical ? { left: 0, right: 0, top: 0, height: `${(1 - value) * 100}%` } : { top: 0, bottom: 0, right: 0, width: `${(1 - value) * 100}%` }}
        />
        {ticks.map((t) => (
          <div
            key={t.label}
            className={`absolute ${vertical ? "left-1/2 h-px w-4 -translate-x-1/2" : "top-1/2 h-4 w-px -translate-y-1/2"} bg-[var(--ink-3)]`}
            style={position(t.v)}
          />
        ))}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Relevance threshold"
          aria-orientation={orientation}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pctValue}
          aria-valuetext={`${pctValue} percent, showing ${props.shown} of ${props.total} items`}
          aria-disabled={disabled || undefined}
          onKeyDown={onKey}
          className={`absolute h-5 w-5 rounded-full border-2 border-[var(--accent)] bg-[var(--surface)] shadow-sm outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)]/30 ${vertical ? "left-1/2 -translate-x-1/2 -translate-y-1/2" : "top-1/2 -translate-x-1/2 -translate-y-1/2"}`}
          style={position(value)}
        />
      </div>
    </div>
  );

  // Histogram: one bar per bucket; on the map (at or above the bar) in accent, the rest in gray.
  const bars = (
    <div className={`relative ${vertical ? "h-full w-12" : "h-8 w-full"}`} aria-hidden>
      <div className={`absolute ${vertical ? "inset-y-2 left-0 right-0" : "inset-x-2 top-0 bottom-0"}`}>
        {histogram.map((count, i) => {
          const lo = i / histogram.length;
          const size = `${(count / maxCount) * 100}%`;
          const on = lo + 1 / histogram.length > value + 1e-9;
          const slot = `${100 / histogram.length}%`;
          return (
            <div
              key={i}
              className="absolute"
              style={
                vertical
                  ? { bottom: `${lo * 100}%`, height: slot, left: 0, width: "100%", padding: "1px 0" }
                  : { left: `${lo * 100}%`, width: slot, bottom: 0, height: "100%", padding: "0 1px" }
              }
            >
              {count > 0 && (
                <div
                  className={`rounded-sm ${on ? "bg-[var(--accent)]" : "bg-[var(--line)]"}`}
                  style={vertical ? { width: size, height: "100%", minWidth: 2 } : { height: size, width: "100%", minHeight: 2, marginTop: "auto", position: "absolute", bottom: 0, left: 0 }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const labels = (
    <div className={`relative ${vertical ? "h-full w-20" : "h-4 w-full"} text-[10.5px] leading-none text-[var(--ink-2)]`} aria-hidden>
      <div className={`absolute ${vertical ? "inset-y-2 right-0 left-0" : "inset-x-2 top-0 bottom-0"}`}>
        {ticks.map((t) => (
          <div
            key={t.label}
            className={`absolute whitespace-nowrap ${vertical ? "right-0 -translate-y-1/2 text-right" : "-translate-x-1/2"}`}
            style={position(t.v)}
          >
            {t.label} {Math.round(t.v * 100)}
          </div>
        ))}
      </div>
    </div>
  );

  const readout = (
    <div className="text-[12px] leading-snug text-[var(--ink-2)]">
      {disabled ? (
        <span>Search to map a disease.</span>
      ) : (
        <>
          <div>
            Showing <strong className="text-[var(--ink)]">{props.shown}</strong> of {props.total}
          </div>
          <div>
            {props.relatedShown} of {props.relatedTotal} related {props.relatedTotal === 1 ? "disease" : "diseases"}
          </div>
          <div className="mt-1 text-[11px] text-[var(--ink-3)]">The dashed circle on the map moves with this bar.</div>
        </>
      )}
    </div>
  );

  // Type filters: click a row to hide or show that type, "only" to see it alone, "All" to bring
  // everything back. Swatches match the node colors on the map.
  const allShown = props.hiddenTypes.size === 0;
  const typeToggles = props.types.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-[var(--ink-2)]">
        <span>Show</span>
        <button
          type="button"
          onClick={props.onShowAllTypes}
          disabled={allShown}
          className="rounded-full px-2 py-0.5 normal-case tracking-normal text-[var(--accent-ink)] hover:bg-[var(--surface-2)] disabled:text-[var(--ink-3)] disabled:hover:bg-transparent"
        >
          All
        </button>
      </div>
      <div className={vertical ? "grid grid-cols-1 gap-1" : "flex flex-wrap gap-1.5"}>
        {props.types.map(({ type, shown, total }) => {
          const hidden = props.hiddenTypes.has(type);
          const kind = KIND_STYLE[KIND_OF[type]];
          return (
            <div key={type} className="group flex items-stretch gap-1">
              <button
                type="button"
                aria-pressed={!hidden}
                onClick={() => props.onToggleType(type)}
                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-[11.5px] transition-colors ${hidden ? "border-[var(--line)] text-[var(--ink-3)]" : "border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--ink-3)]"}`}
                title={`${hidden ? "Show" : "Hide"} ${TYPE_NAME[type].many}`}
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                  style={{ background: hidden ? "transparent" : type === "Disease" ? "var(--series-1)" : kind.fill, border: `1px solid ${hidden ? "var(--line)" : type === "Disease" ? "transparent" : kind.ink}` }}
                  aria-hidden
                >
                  <svg viewBox="0 0 24 24" className="h-2.5 w-2.5">
                    <path d={ICON_PATH[type]} fill="none" stroke={hidden ? "var(--ink-3)" : type === "Disease" ? "#fff" : kind.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className={`truncate ${hidden ? "line-through" : ""}`}>{SHORT[type]}</span>
                <span className="ml-auto pl-1 tabular-nums text-[var(--ink-3)]">
                  {shown}/{total}
                </span>
              </button>
              <button
                type="button"
                onClick={() => props.onOnlyType(type)}
                className="rounded-lg px-1.5 text-[10.5px] text-[var(--ink-2)] opacity-0 transition-opacity hover:bg-[var(--surface-2)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                aria-label={`Show only ${TYPE_NAME[type].many}`}
              >
                only
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const header = (
    <div className={vertical ? "text-center" : "flex items-baseline gap-2"}>
      <div className="text-[28px] font-semibold leading-none tracking-tight text-[var(--ink)]">{disabled ? "–" : `${pctValue}%`}</div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--ink-2)]">relevance</div>
    </div>
  );

  const reset = !disabled && (props.defaultValue === undefined || value !== props.defaultValue || props.hiddenTypes.size > 0) && (
    <button type="button" onClick={props.onReset} className="text-[12px] text-[var(--accent)] hover:underline">
      Reset
    </button>
  );

  if (!vertical) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          {header}
          {readout}
        </div>
        <div className="flex flex-col">
          {bars}
          {track}
          {labels}
        </div>
        <div className="flex items-center justify-between gap-2">
          {typeToggles}
          {reset}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {header}
      <div className="flex min-h-[220px] flex-1 items-stretch">
        {labels}
        {track}
        {bars}
      </div>
      {readout}
      <div className="min-h-0 overflow-y-auto">{typeToggles}</div>
      {reset}
    </div>
  );
}
