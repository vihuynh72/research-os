"use client";

// A related disease selected: the pair as a proposal skeleton. The verdict (biology, and clinical
// resemblance kept apart), then what they share, what differs, what needs an expert, who already
// connects them, the next step and the sources.
import { useMemo } from "react";
import type { GraphNode } from "@/lib/graph/types";
import type { PairGrade } from "@/lib/grading/types";
import { ContactFinderButton } from "../contact/ContactFinder";
import EvidenceBadge from "../EvidenceBadge";
import { STATUS_WORD, nodeOf } from "../format";
import { ClinicalBadge, TierBadge } from "../NeighborList";
import { ClaimText } from "./Blocks";
import DocShell from "./DocShell";
import NextStepCard from "./NextStepCard";
import type { PanelProps } from "./types";
import { Actions, BackButton, Eyebrow, PrimaryButton, SecondaryButton, Title } from "./ui";
import { buildPairDoc, type PairDoc } from "./viewModel";

function ScoreTable({ doc }: { doc: PairDoc }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <h3 className="text-xs font-semibold tracking-wide text-ink-2 uppercase">Score table</h3>
      <dl className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line tabular-nums">
        {doc.totals.map((t) => (
          <div key={t.label} className="flex flex-col justify-between bg-surface px-2 py-1.5">
            <dt className="text-[0.6875rem] text-ink-2">{t.label}</dt>
            <dd className="text-sm font-semibold text-ink">{t.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs tabular-nums">
          <thead className="text-ink-2">
            <tr>
              <th scope="col" className="py-1 pr-2 font-medium">Line</th>
              <th scope="col" className="py-1 pr-2 font-medium">Status</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Score</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Cap</th>
              <th scope="col" className="py-1 font-medium">Counts toward</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {doc.scores.map((r) => (
              <tr key={r.line}>
                <th scope="row" className="py-1 pr-2 font-medium text-ink">{r.line}</th>
                <td className="py-1 pr-2 text-ink-2">{r.status}</td>
                <td className="py-1 pr-2 text-right text-ink">{r.score}</td>
                <td className="py-1 pr-2 text-right text-ink-2">{r.cap}</td>
                <td className="py-1 text-ink-2">{r.countsToward}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-2">Lines of evidence: {doc.lines.length ? doc.lines.join(", ") : "none"}</p>
      <div className="mt-2 space-y-1 text-xs text-ink-2">
        <p className="font-semibold text-ink">Engine note</p>
        {doc.engineNote.map((t) => (
          <p key={t} className="text-pretty">{t}</p>
        ))}
      </div>
    </div>
  );
}

export default function PairView(props: PanelProps & { pair: PairGrade; other: GraphNode; anchorId: string }) {
  const { model, focusId, mode, onSelect, onFocus, pair, other, anchorId } = props;
  const doc = useMemo(() => buildPairDoc(model, focusId, anchorId, other, pair, mode), [model, focusId, anchorId, other, pair, mode]);
  const focus = nodeOf(model, focusId);
  if (!doc || !focus) return null;
  return (
    <DocShell
      model={model}
      doc={doc}
      selectedId={null}
      onRow={(row) => onFocus(row.id)}
      header={
        <>
          <BackButton name={focus.label} onClick={() => onSelect(null)} />
          <div className="pt-2">
            <Eyebrow>Two related diseases</Eyebrow>
          </div>
          <Title>{doc.title}</Title>
          {doc.through && <p className="text-xs text-ink-2 text-pretty">{doc.through}</p>}
        </>
      }
      top={
        <>
          <dl className="divide-y divide-line rounded-xl border border-line">
            <div className="px-3 py-3">
              <dt className="text-xs font-medium text-ink-2">Shared biology · sets the distance on the map</dt>
              <dd className="mt-2 space-y-2">
                <span className="flex flex-wrap items-center gap-2">
                  <TierBadge tier={doc.biology.tier} value={doc.biology.value} />
                  <EvidenceBadge badge={doc.biology.badge} className="h-6 px-2.5" />
                </span>
                <ClaimText claim={doc.biology.why} />
              </dd>
            </div>
            {doc.clinical && (
              <div className="px-3 py-3">
                <dt className="text-xs font-medium text-ink-2">How alike they look · symptoms, never used for distance</dt>
                <dd className="mt-2 space-y-2">
                  {doc.clinical.compared ? (
                    <ClinicalBadge tier={doc.clinical.tier} value={doc.clinical.value} />
                  ) : (
                    // With no symptoms to compare, a "looks different" word would claim more than the data holds.
                    <span className="inline-flex h-6 items-center rounded-full border border-dashed border-ink-3 px-2.5 text-xs font-medium text-ink-2">{STATUS_WORD.unknown}</span>
                  )}
                  <ClaimText claim={doc.clinical.why} />
                </dd>
              </div>
            )}
          </dl>
          {mode === "researcher" && <ScoreTable doc={doc} />}
        </>
      }
      after={
        <>
          <NextStepCard steps={doc.steps} forWhat={`${doc.anchor.label} and ${other.label}`} />
          <Actions>
            <PrimaryButton disabled title="Coming next">
              Draft a collaboration brief
            </PrimaryButton>
            <ContactFinderButton diseaseIds={[anchorId, other.id]} />
            <SecondaryButton onClick={() => onFocus(other.id)}>Center the map on {other.label}</SecondaryButton>
          </Actions>
          <p className="text-xs text-ink-2 text-pretty">
            Shared work is a starting point for a conversation, not medical advice. A scientist has to check whether the two diseases work the same way.
          </p>
        </>
      }
    />
  );
}
