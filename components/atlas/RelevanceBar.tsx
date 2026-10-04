"use client";

// The relevance slider: one threshold picks the related diseases on the map (everything else follows
// the disease that brings it). On wide screens a slim vertical strip floating at the map's right
// edge: the grade file's tiers are bands with their name and cutoff written inside, the value sits
// on the handle. Horizontal under the map on small screens, with the cutoffs as ticks. The
// researcher view adds a small histogram of the related diseases, so moving the bar is never a
// guess.
import { useEffect, useRef, useState } from "react";
import { labelledTicks } from "./barTicks";

export interface RelevanceBarProps {
  value: number; // 0..1
  onChange(value: number): void;
  histogram: number[]; // related diseases per bucket, bucket 0 is the least relevant
  showHistogram?: boolean;
  relatedShown: number;
  relatedTotal: number;
  thresholds: { strong: number; moderate: number; exploratory: number };
  onReset(): void;
  resetLabel?: string; // "Top 5": the filter a search opens at
  resetTitle?: string;
  orientation?: "vertical" | "horizontal";
  defaultValue?: number;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const snap = (x: number) => Math.round(clamp(x) * 100) / 100;

export default function RelevanceBar(props: RelevanceBarProps) {
  const { value, histogram, thresholds, orientation = "vertical" } = props;
  const vertical = orientation === "vertical";
  const trackRef = useRef<HTMLDivElement>(null);
  // Key repeat can outrun re-renders; step from the latest value, not the one this render saw.
  const latest = useRef(value);
  latest.current = value;
  const maxCount = Math.max(1, ...histogram);
  const pctValue = Math.round(value * 100);
  const ticks = [
    { v: thresholds.strong, label: "Strong" },
    { v: thresholds.moderate, label: "Moderate" },
    { v: thresholds.exploratory, label: "Exploratory" },
  ];
  // The bar's length on screen, to keep tick labels apart.
  const [length, setLength] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setLength(vertical ? el.clientHeight : el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [vertical]);
  const labelled = labelledTicks(ticks, length, vertical);

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

  const shownText = props.relatedTotal ? `${props.relatedShown} of ${props.relatedTotal} related ${props.relatedTotal === 1 ? "disease" : "diseases"}` : "No related disease";
  const pointer = {
    onPointerDown: (event: React.PointerEvent) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      props.onChange(fromPointer(event.clientX, event.clientY));
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      props.onChange(fromPointer(event.clientX, event.clientY));
    },
  };
  // The value sits on the handle; the handle is the slider for keyboards and screen readers.
  const thumb = (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Relevance filter"
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pctValue}
      aria-valuetext={`${pctValue} percent, showing ${shownText}`}
      onKeyDown={onKey}
      className="absolute z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-accent bg-surface px-1.5 py-px text-[0.6875rem] leading-4 font-semibold whitespace-nowrap text-accent-ink tabular-nums shadow-[0_1px_4px_rgb(0_0_0/0.14)] outline-none focus-visible:ring-4 focus-visible:ring-accent/30"
      style={vertical ? { left: "50%", ...position(value) } : { top: "50%", ...position(value) }}
    >
      {pctValue}%
    </div>
  );

  const track = (
    <div className="relative h-9 w-full cursor-pointer touch-none" {...pointer}>
      <div ref={vertical ? undefined : trackRef} className="absolute inset-x-4 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line">
        {/* The part of the scale that is on the map. */}
        <div className="absolute rounded-full bg-accent" style={{ top: 0, bottom: 0, right: 0, width: `${(1 - value) * 100}%` }} />
        {ticks.map((t) => (
          <div key={t.label} className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-ink-3" style={position(t.v)} />
        ))}
        {thumb}
      </div>
    </div>
  );

  // The vertical strip: one band per tier, its name and cutoff inside it, the part of the scale on
  // the map tinted, and a line across at the value with the value on it.
  const bands = ticks.map((t, i) => ({ ...t, top: i === 0 ? 1 : ticks[i - 1].v }));
  const strip = (
    <div className="relative min-h-[150px] w-full flex-1 cursor-pointer touch-none" {...pointer}>
      <div ref={vertical ? trackRef : undefined} className="absolute inset-x-0 inset-y-3 rounded-lg bg-surface-2">
        <div className="absolute inset-x-0 top-0 rounded-t-lg bg-accent/12" style={{ height: `${(1 - value) * 100}%` }} />
        {props.showHistogram && (
          <div className="absolute inset-y-0 right-0 w-3" aria-hidden>
            {histogram.map((count, i) => {
              if (!count) return null;
              const lo = i / histogram.length;
              const on = lo + 1 / histogram.length > value + 1e-9;
              return (
                <div
                  key={i}
                  className={`absolute right-0 rounded-l-sm ${on ? "bg-accent/45" : "bg-ink-3/35"}`}
                  style={{ bottom: `${lo * 100}%`, height: `calc(${100 / histogram.length}% - 1px)`, width: `${(count / maxCount) * 100}%`, minWidth: 2 }}
                />
              );
            })}
          </div>
        )}
        {ticks.map((t) => (
          <div key={t.label} className="absolute inset-x-0 h-px bg-ink-3/40" style={position(t.v)} />
        ))}
        {bands.map((b) => (
          <div
            key={b.label}
            aria-hidden
            className="absolute inset-x-0 flex flex-col items-center justify-end pb-1 text-center text-[0.6875rem] leading-tight text-ink-2 transition-opacity"
            // The handle passing over a band's name hides it, so the two never print over each other.
            style={{ top: `${(1 - b.top) * 100}%`, height: `${(b.top - b.v) * 100}%`, opacity: length && value > b.v - 12 / length && value < b.v + 40 / length ? 0 : 1 }}
          >
            <span>{b.label}</span>
            <span className="tabular-nums">{Math.round(b.v * 100)}</span>
          </div>
        ))}
        <div className="absolute inset-x-0 h-0.5 -translate-y-1/2 bg-accent" style={position(value)} />
        {thumb}
      </div>
    </div>
  );

  // Horizontal: the related diseases per bucket; on the map (at or above the bar) in accent, the rest in gray.
  const bars = props.showHistogram && (
    <div className="relative h-5 w-full" aria-hidden>
      <div className="absolute inset-x-4 top-0 bottom-0">
        {histogram.map((count, i) => {
          if (!count) return null;
          const lo = i / histogram.length;
          const on = lo + 1 / histogram.length > value + 1e-9;
          return (
            <div
              key={i}
              className={`absolute rounded-sm ${on ? "bg-accent/70" : "bg-line"}`}
              style={{ left: `${lo * 100}%`, width: `calc(${100 / histogram.length}% - 1px)`, bottom: 0, height: `${(count / maxCount) * 100}%`, minHeight: 2 }}
            />
          );
        })}
      </div>
    </div>
  );

  const labels = (
    <div className="relative h-7 w-full text-[0.6875rem] leading-tight text-ink-2" aria-hidden>
      <div className="absolute inset-x-4 top-0 bottom-0">
        {ticks
          .filter((t) => labelled.has(t.label))
          .map((t) => (
            <div key={t.label} className="absolute top-0 -translate-x-1/2 text-center whitespace-nowrap" style={position(t.v)}>
              {t.label} <span className="tabular-nums">{Math.round(t.v * 100)}</span>
            </div>
          ))}
      </div>
    </div>
  );

  const reset = (props.defaultValue === undefined || value !== props.defaultValue) && (
    <button type="button" onClick={props.onReset} title={props.resetTitle} className="rounded-full px-2.5 py-1 text-[0.75rem] font-medium text-accent-ink hover:bg-surface-2">
      {props.resetLabel ?? "Reset"}
    </button>
  );

  const readout = (
    <p className="text-[0.75rem] leading-snug text-ink-2">
      Showing <strong className="font-semibold text-ink tabular-nums">{props.relatedShown}</strong> of <span className="tabular-nums">{props.relatedTotal}</span> related{" "}
      {props.relatedTotal === 1 ? "disease" : "diseases"}
    </p>
  );

  if (!vertical) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[0.6875rem] font-semibold tracking-wide text-ink-2 uppercase">Relevance</span>
          {readout}
        </div>
        {bars}
        {track}
        {labels}
        {reset && <div className="flex justify-end">{reset}</div>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center gap-1.5 px-1.5 py-2.5">
      <span className="text-[0.6875rem] font-semibold tracking-wide text-ink-2 uppercase">Relevance</span>
      {strip}
      <p className="text-center text-[0.6875rem] leading-tight text-ink-2" title={`Showing ${shownText}`}>
        Showing
        <br />
        <strong className="text-[0.8125rem] font-semibold text-ink tabular-nums">
          {props.relatedShown} of {props.relatedTotal}
        </strong>
      </p>
      {reset && <div className="-mb-1">{reset}</div>}
    </div>
  );
}
