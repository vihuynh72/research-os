"use client";

// A disease in the center: what it is, its closest diseases and why, its biology and symptoms, the
// people and research around it, what we don't know, the next step and every source.
import { Fragment, useMemo } from "react";
import { ContactFinderButton } from "../contact/ContactFinder";
import { nodeOf } from "../format";
import { Dot } from "../NeighborList";
import { Cites } from "./Cite";
import DocShell from "./DocShell";
import NextStepCard from "./NextStepCard";
import type { PanelProps } from "./types";
import { Eyebrow, ExternalLink, NodeIdLink, Title } from "./ui";
import { buildDiseaseDoc } from "./viewModel";

export default function DiseaseView({ model, focusId, mode, selection, onSelect }: PanelProps) {
  const doc = useMemo(() => buildDiseaseDoc(model, focusId, mode), [model, focusId, mode]);
  const node = nodeOf(model, focusId);
  if (!doc || !node) return null;
  return (
    <DocShell
      model={model}
      doc={doc}
      selectedId={selection?.id ?? null}
      onRow={(row) => onSelect(row.id)}
      header={
        <>
          <Eyebrow>Disease</Eyebrow>
          <Title>{doc.title}</Title>
          {doc.group && (
            <p>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink">
                <Dot color={doc.group.color} size={8} />
                {doc.group.label}
              </span>
            </p>
          )}
          <p className="text-[0.8125rem] text-ink-2 tabular-nums text-pretty">
            {doc.facts.map((f, i) => (
              <Fragment key={f.text}>
                {i > 0 && " · "}
                {f.text}
                <Cites ns={f.cites} />
              </Fragment>
            ))}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {doc.links.map((l) => (
              <ExternalLink key={l.url} href={l.url} className="font-medium text-accent-ink hover:underline">
                {l.label}
              </ExternalLink>
            ))}
            {mode === "researcher" && <NodeIdLink node={node} />}
          </p>
        </>
      }
      after={
        <NextStepCard steps={doc.steps} forWhat={node.label}>
          <ContactFinderButton diseaseIds={[focusId]} />
        </NextStepCard>
      }
    />
  );
}
