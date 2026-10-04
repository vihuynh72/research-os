"use client";

// A line selected on the map: what it says, how strong it is, the records it rests on (a folded
// line lists the items it stands for) and every source.
import { useMemo } from "react";
import type { HoodEdge } from "@/lib/graph/neighborhood";
import { formatPercent, nodeOf } from "../format";
import DocShell from "./DocShell";
import type { PanelProps } from "./types";
import { Actions, BackButton, Eyebrow, PrimaryButton, SecondaryButton, Title } from "./ui";
import { buildEdgeDoc } from "./viewModel";

export default function EdgeView(props: PanelProps & { edge: HoodEdge }) {
  const { model, hood, focusId, edge, threshold, mode, onSelect, onFocus } = props;
  const doc = useMemo(() => buildEdgeDoc(model, hood, focusId, edge, threshold, mode), [model, hood, focusId, edge, threshold, mode]);
  const focus = nodeOf(model, focusId);
  return (
    <DocShell
      model={model}
      doc={doc}
      selectedId={null}
      onRow={(row) => onFocus(row.id)}
      header={
        <>
          {focus && <BackButton name={focus.label} onClick={() => onSelect(null)} />}
          <div className="pt-2">
            <Eyebrow>{doc.eyebrow}</Eyebrow>
          </div>
          <Title>{doc.title}</Title>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
            <div className="bg-surface px-3 py-2">
              <dt className="text-xs text-ink-2">Strength</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatPercent(doc.strength)}</dd>
            </div>
            <div className="bg-surface px-3 py-2">
              <dt className="text-xs text-ink-2">Relevance to {focus?.label ?? focusId}</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatPercent(doc.relevance)}</dd>
            </div>
          </dl>
          <p className="text-xs text-ink-2 text-pretty">{doc.strengthMeans}</p>
        </>
      }
      after={
        (doc.pairWith || doc.centerable.length > 0) && (
          <Actions>
            {doc.pairWith && <PrimaryButton onClick={() => onSelect(doc.pairWith!.id)}>Why they&apos;re connected</PrimaryButton>}
            {doc.centerable.map((n) => (
              <SecondaryButton key={n.id} onClick={() => onFocus(n.id)}>
                Center on {n.label}
              </SecondaryButton>
            ))}
          </Actions>
        )
      }
    />
  );
}
