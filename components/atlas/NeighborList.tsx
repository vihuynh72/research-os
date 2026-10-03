"use client";

// Badges and rows for related diseases. Every view shows a grade the same way: an icon plus a
// word (and a percentage), never color alone. Biology tiers get bars, clinical resemblance gets
// dots, so the two scores are never read as one.
import type { ReactNode } from "react";
import type { ClinicalTier, Tier } from "@/lib/grading/types";
import { CLINICAL_TIER_WORD, TIER_ORDER } from "@/lib/grading/types";
import { TIER_WORD, formatPercent } from "./format";

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
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink ${className}`}>
      <ClinicalIcon tier={tier} />
      {CLINICAL_TIER_WORD[tier]}
      {value !== undefined && <span className="font-normal text-ink-2 tabular-nums">· {formatPercent(value)}</span>}
    </span>
  );
}

export function TierIcon({ tier }: { tier: Tier }) {
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
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink ${className}`}>
      <TierIcon tier={tier} />
      {TIER_WORD[tier]}
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
  badge: ReactNode;
  reason: string;
}

// A compact list of related diseases; selecting one opens the pair's evidence.
export default function DiseaseRows({ rows, selectedId, onSelect, empty }: { rows: DiseaseRow[]; selectedId: string | null; onSelect(id: string): void; empty?: string }) {
  if (!rows.length) return empty ? <p className="text-sm text-ink-2 text-pretty">{empty}</p> : null;
  return (
    <ul role="list" className="-mx-2">
      {rows.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            aria-current={r.id === selectedId ? "true" : undefined}
            className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-surface-2 aria-[current=true]:bg-surface-2"
          >
            <span className="mt-1.5">
              <Dot color={r.color} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <span className="min-w-0 truncate text-sm font-medium">{r.short}</span>
                {r.badge}
              </span>
              {r.full !== r.short && <span className="mt-0.5 block truncate text-xs text-ink-2">{r.full}</span>}
              {r.reason && <span className="mt-0.5 block text-xs text-ink-2 text-pretty">{r.reason}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
