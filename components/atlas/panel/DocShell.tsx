"use client";

// The frame every panel view shares: header, the evidence summary and "How we score", the
// collapsible sections, the next step, actions and the numbered Sources, all reading one document.
import type { ReactNode } from "react";
import type { AtlasModel } from "../format";
import { CitationProvider } from "./CitationContext";
import Blocks from "./Blocks";
import EvidenceSummary from "./EvidenceSummary";
import HowWeScore from "./HowWeScore";
import Section from "./Section";
import Sources from "./Sources";
import type { SourceRecord } from "./citations";
import type { RowVM, SectionVM, Summary } from "./viewModel";

export interface DocLike {
  sections: SectionVM[];
  sources: SourceRecord[];
  summary: Summary;
}

export default function DocShell({
  model,
  doc,
  header,
  top,
  after,
  selectedId,
  onRow,
}: {
  model: AtlasModel;
  doc: DocLike;
  header: ReactNode;
  top?: ReactNode; // between the header and the sections (a verdict, a score table)
  after?: ReactNode; // the next step and actions, before Sources
  selectedId: string | null;
  onRow(row: RowVM, action: "select" | "focus"): void;
}) {
  return (
    <CitationProvider records={doc.sources}>
      <article aria-labelledby="detail-title" className="space-y-4">
        <header className="space-y-2">
          {header}
          <div className="flex flex-col gap-1.5 pt-1">
            <EvidenceSummary summary={doc.summary} />
            <HowWeScore meta={model.relevance.meta} />
          </div>
        </header>
        {top}
        <div>
          {doc.sections.map((s, i) => (
            <Section key={s.id} id={`section-${s.id}`} title={s.title} count={s.count} hint={s.hint} defaultOpen={s.open} first={i === 0}>
              <Blocks blocks={s.blocks} selectedId={selectedId} onRow={onRow} />
            </Section>
          ))}
        </div>
        {after}
        <div className="border-b border-line">
          <Sources />
        </div>
      </article>
    </CitationProvider>
  );
}
