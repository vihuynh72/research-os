// The one badge for where a link comes from (see evidence.ts): a solid pill with a check when its
// source states it, a dashed pill when it is inferred, an alert when a source disputes it. The
// words always say which, so the outline is never the only signal.
import type { Badge } from "./evidence";

export default function EvidenceBadge({ badge, className = "" }: { badge: Badge | null; className?: string }) {
  if (!badge) return null;
  const outline = badge.style === "inferred" ? "border-dashed border-ink-3" : badge.style === "disputed" ? "border-ink-2" : "border-line";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 text-[0.6875rem] leading-[1.125rem] font-medium whitespace-nowrap text-ink-2 ${outline} ${className}`}>
      {badge.style === "stated" && (
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.3l2.3 2.3 4.7-5" />
        </svg>
      )}
      {badge.style === "disputed" && (
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="6" cy="6" r="4.8" />
          <path d="M6 3.4v3.2M6 8.6v.1" />
        </svg>
      )}
      {badge.label}
    </span>
  );
}
