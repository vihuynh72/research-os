"use client";

// Badges and rows for related diseases. Every view shows a grade the same way: an icon plus a
// word (and a percentage), never color alone. Biology tiers get bars, clinical resemblance gets
// dots, so the two scores are never read as one.
import type { ReactNode } from "react";
import type { ClinicalTier, Tier } from "@/lib/grading/types";
import { CLINICAL_TIER_WORD, TIER_ORDER } from "@/lib/grading/types";
import { formatPercent, isTier, tierWord } from "./format";

const CLINICAL_LEVEL: Record<ClinicalTier, number> = { very_similar: 3, similar: 2, somewhat: 1, different: 0 };

export function ClinicalIcon({ tier }: { tier: ClinicalTier }) {
  const level = CLINICAL_LEVEL[tier];
  return (
    <svg viewBox="0 0 16 6" width="16" height="6" aria-hidden="true" className="shrink-0">
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={i * 5.5 + 2.5}
          cy="3"
          r="2"
          fill={i < level ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1"
          opacity={i < level ? 1 : 0.45}
        />
      ))}
    </svg>
  );
}

export function ClinicalBadge({ tier, value, className = "" }: { tier: ClinicalTier; value?: number; className?: string }) {
  // A grade file from another engine may use a word this app does not know: name it as written.
  const word = CLINICAL_TIER_WORD[tier] ?? (tier ? `${String(tier).charAt(0).toUpperCase()}${String(tier).slice(1).replace(/_/g, " ")}` : "Not graded");
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-medium whitespace-nowrap text-ink ${className}`}>
      {tier in CLINICAL_LEVEL ? <ClinicalIcon tier={tier} /> : <NeutralIcon />}
      {word}
      {value !== undefined && <span className="font-normal text-ink-2 tabular-nums">· {formatPercent(value)}</span>}
    </span>
  );
}

// For a grade this app does not know: a plain ring, claiming no strength.
function NeutralIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" className="shrink-0">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6" />
    </svg>
  );
}

export function TierIcon({ tier }: { tier: Tier }) {
  if (!isTier(tier)) return <NeutralIcon />;
  const level = TIER_ORDER[tier];
  return (
    <svg viewBox="0 0 14 12" width="14" height="12" aria-hidden="true" className="shrink-0">
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={i * 5 + 0.5}
          y={8 - i * 4 + 0.5}
          width="3"
          height={3 + i * 4}
          rx="1"
          fill={i < level ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1"
          opacity={i < level ? 1 : 0.45}
        />
      ))}
    </svg>
  );
}

export function TierBadge({ tier, value, className = "" }: { tier: Tier; value?: number; className?: string }) {
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-medium whitespace-nowrap text-ink ${className}`}>
      <TierIcon tier={tier} />
      {tierWord(tier)}
      {value !== undefined && <span className="font-normal text-ink-2 tabular-nums">· {formatPercent(value)}</span>}
    </span>
  );
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color, boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--ink) 12%, transparent)" }}
    />
  );
}

export interface DiseaseRow {
  id: string;
  short: string;
  full: string; // the full name, shown under the short one when it differs
  color: string;
  badge: ReactNode; // null when the reason already says it all
  meter?: number; // 0..1, drawn as a small bar beside the badge
  reason?: ReactNode; // one cited sentence; kept outside the button so its citations stay their own links
}

// How far a score reaches on its 0–100% scale; the badge beside it says the number in words.
function Meter({ value }: { value: number }) {
  return (
    <span aria-hidden="true" className="inline-block h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-line">
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, Math.min(100, value * 100))}%` }} />
    </span>
  );
}

// A compact list of related diseases; selecting one opens the pair's evidence.
export default function DiseaseRows({ rows, selectedId, onSelect, empty }: { rows: DiseaseRow[]; selectedId: string | null; onSelect(id: string): void; empty?: ReactNode }) {
  if (!rows.length) return empty ? <div className="text-sm text-ink-2 text-pretty">{empty}</div> : null;
  return (
    <ul role="list" className="-mx-2">
      {rows.map((r) => (
        <li key={r.id} className={`rounded-lg px-2 py-2 hover:bg-surface-2 ${r.id === selectedId ? "bg-surface-2" : ""}`}>
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            aria-current={r.id === selectedId ? "true" : undefined}
            className="group flex w-full items-start gap-3 rounded-md text-left"
          >
            {/* A flex box, so the dot sits centered on the name's first line instead of a taller text line. */}
            <span className="mt-[5px] flex shrink-0">
              <Dot color={r.color} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink text-pretty break-words group-hover:underline">{r.short}</span>
              {r.full !== r.short && <span className="mt-0.5 block text-xs text-ink-2 text-pretty">{r.full}</span>}
              {(r.badge || r.meter !== undefined) && (
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  {r.badge}
                  {r.meter !== undefined && <Meter value={r.meter} />}
                </span>
              )}
            </span>
          </button>
          {r.reason && <div className="mt-1 pl-[22px]">{r.reason}</div>}
        </li>
      ))}
    </ul>
  );
}
