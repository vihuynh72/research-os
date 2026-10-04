"use client";

// One line under the title: how many sources back this view, of which kinds, and from where.
// Clicking it jumps to the Sources list.
import type { Summary } from "./viewModel";
import { useCitations } from "./CitationContext";

export default function EvidenceSummary({ summary }: { summary: Summary }) {
  const { jump, records } = useCitations();
  if (!records.length) return null;
  return (
    <button type="button" onClick={jump} className="group flex items-start gap-1.5 text-left text-xs text-ink-2 hover:text-ink">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="mt-px shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.8l5 1.9v3.9c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6V3.7z" />
        <path d="M5.6 8.1l1.7 1.7 3.2-3.4" />
      </svg>
      <span className="text-pretty group-hover:underline">
        {summary.text}
        {summary.sources.length > 0 && <span> · {summary.sources.join(", ")}</span>}
      </span>
    </button>
  );
}
