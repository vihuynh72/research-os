"use client";

// The numbered Sources list at the bottom of every view: "[n] Source — claim", then how it is known,
// its date and a link to the record. The first eight, then "Show all N".
import EvidenceBadge from "../EvidenceBadge";
import { SOURCES_ID, SOURCES_SHOWN, sourceId, useCitations } from "./CitationContext";
import Section from "./Section";
import { ExternalLink } from "./ui";

export default function Sources() {
  const { records, showAll, setShowAll, flashed, sourcesOpen, setSourcesOpen } = useCitations();
  if (!records.length) return null;
  const shown = showAll ? records : records.slice(0, SOURCES_SHOWN);
  return (
    <Section id={SOURCES_ID} title="Sources" count={String(records.length)} defaultOpen open={sourcesOpen} onOpenChange={setSourcesOpen}>
      <ol role="list" className="space-y-1">
        {shown.map((r) => (
          <li
            key={r.n}
            id={sourceId(r.n)}
            tabIndex={-1}
            className={`-mx-2 scroll-mt-2 rounded-lg px-2 py-1.5 transition-colors duration-700 motion-reduce:transition-none ${flashed === r.n ? "bg-accent/15" : ""}`}
          >
            <p className="text-[0.8125rem] leading-snug text-ink text-pretty">
              <span className="mr-1 font-semibold text-accent-ink tabular-nums">[{r.n}]</span>
              <span className="font-medium">{r.source}</span> — {r.claim}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <EvidenceBadge badge={r.badge} />
              {r.date && r.badge.style !== "searched" && <span className="tabular-nums">{r.date}</span>}
              <ExternalLink href={r.url} className="font-medium text-accent-ink hover:underline">
                Open record
              </ExternalLink>
            </p>
            {r.note && <p className="mt-0.5 text-xs text-ink-2 text-pretty">{r.note}</p>}
          </li>
        ))}
      </ol>
      {!showAll && records.length > SOURCES_SHOWN && (
        <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[0.8125rem] font-medium text-accent-ink hover:underline">
          Show all {records.length} sources
        </button>
      )}
    </Section>
  );
}
