"use client";

// A gene, symptom, pathway, group, paper or grant: what it is (cited), the diseases it is linked
// to, its biology for a gene, and every source. Used in the center (CenterView) and when selected.
import { useMemo } from "react";
import type { GraphNode } from "@/lib/graph/types";
import type { HoodNode } from "@/lib/graph/neighborhood";
import { ContactFinderButton } from "../contact/ContactFinder";
import { formatScore, nodeOf } from "../format";
import { ClaimText } from "./Blocks";
import DocShell from "./DocShell";
import type { PanelProps } from "./types";
import { Actions, BackButton, Eyebrow, KindIcon, NodeIdLink, PrimaryButton, SecondaryButton, Title } from "./ui";
import { buildNodeDoc } from "./viewModel";

export default function NodeView(props: PanelProps & { node: GraphNode; hoodNode?: HoodNode }) {
  const { model, hood, focusId, node, hoodNode, threshold, mode, selection, onSelect, onFocus } = props;
  const doc = useMemo(() => buildNodeDoc(model, hood, focusId, node, hoodNode, threshold, mode), [model, hood, focusId, node, hoodNode, threshold, mode]);
  const focus = nodeOf(model, focusId);
  const info = model.relevance.node_info?.[node.id];
  const small = [
    info?.specificity !== undefined ? `specificity ${formatScore(info.specificity)}` : "",
    info?.ic !== undefined ? `IC ${formatScore(info.ic)}` : "",
    typeof info?.diseases === "number" ? `reaches ${info.diseases} diseases` : "",
  ].filter(Boolean);
  return (
    <DocShell
      model={model}
      doc={doc}
      selectedId={selection?.id ?? null}
      onRow={(row, action) => (action === "focus" ? onFocus(row.id) : onSelect(row.id))}
      header={
        <>
          {!doc.center && focus && <BackButton name={focus.label} onClick={() => onSelect(null)} />}
          <div className={`flex items-center gap-2 ${doc.center ? "" : "pt-2"}`}>
            <KindIcon model={model} node={node} />
            <Eyebrow>{doc.eyebrow}</Eyebrow>
          </div>
          <Title>{doc.title}</Title>
          {doc.relevance && <ClaimText claim={doc.relevance} className="text-[0.8125rem] font-medium text-ink" />}
          <div className="space-y-1.5 pt-1">
            {doc.intro.map((c, i) => (
              <ClaimText key={i} claim={c} />
            ))}
          </div>
          {mode === "researcher" && (
            <p className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-ink-2 tabular-nums">
              <NodeIdLink node={node} />
              {small.map((s) => (
                <span key={s}>· {s}</span>
              ))}
            </p>
          )}
        </>
      }
      after={
        (!doc.center || doc.contactIds) && (
          <Actions>
            {!doc.center && <PrimaryButton onClick={() => onFocus(node.id)}>Center the map here</PrimaryButton>}
            {doc.contactIds && <ContactFinderButton diseaseIds={doc.contactIds} label="Contact the authors" />}
            {!doc.center && <SecondaryButton onClick={() => onSelect(null)}>Clear selection</SecondaryButton>}
          </Actions>
        )
      }
    />
  );
}
