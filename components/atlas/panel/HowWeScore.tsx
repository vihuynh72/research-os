"use client";

// "How we score": the scoring rules in plain words. Every number comes from relevance.meta (the
// caps and thresholds the grades were computed with), so the text never drifts from the data.
import { useId, useState } from "react";
import type { RelevanceDoc } from "@/lib/grading/types";
import { formatPercent } from "../format";

export default function HowWeScore({ meta }: { meta: RelevanceDoc["meta"] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const pct = (x: number | undefined) => (typeof x === "number" ? formatPercent(x) : "–");
  const rules = [
    `Shared biology sets the distance on the map: the same gene counts up to ${pct(meta.caps.gene)}, a shared pathway up to ${pct(meta.caps.mechanism)} (weighted by how few diseases here share it), the type of gene change up to ${pct(meta.caps.variant)}.`,
    `Strong starts at ${pct(meta.thresholds.strong)} and needs two independent lines of evidence; moderate starts at ${pct(meta.thresholds.moderate)}, exploratory at ${pct(meta.thresholds.exploratory)}.`,
    "How alike two diseases look (symptoms, onset, inheritance) is shown beside it and never moves the map.",
    "Shared patient groups, papers and grants never move a disease either.",
    meta.method === "deterministic-baseline" ? "Fixed rules, no AI: the same data always gives the same scores." : "Fixed rules first; a review may only lower a grade, never raise it.",
  ];
  return (
    <div onKeyDown={(e) => e.key === "Escape" && open && setOpen(false)}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4M8 11.4v.1" />
        </svg>
        How we score
      </button>
      {open && (
        <div id={id} className="mt-2 rounded-xl border border-line bg-surface p-3 shadow-[0_8px_24px_rgb(0_0_0/0.08)]">
          <ul role="list" className="space-y-1.5 text-xs leading-relaxed text-ink text-pretty">
            {rules.map((r) => (
              <li key={r} className="flex gap-2">
                <span aria-hidden="true" className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-ink-3" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setOpen(false)} className="mt-2 text-xs font-medium text-accent-ink hover:underline">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
