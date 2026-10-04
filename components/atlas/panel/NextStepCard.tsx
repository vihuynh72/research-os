"use client";

// The emphasized next step: one concrete thing to do, built only from sourced items, with its
// records cited. When nothing supports a step it says so in a dashed card.
import type { ReactNode } from "react";
import type { NodeType } from "@/lib/graph/types";
import { Cites } from "./Cite";
import type { StepVM } from "./viewModel";
import { TypeIcon } from "./ui";

const STEP_ICON: Record<StepVM["kind"], NodeType> = {
  contact: "Investigator",
  registry: "Asset",
  group: "PatientOrg",
  study: "Trial",
  paper: "Paper",
  gap: "Disease",
};

export default function NextStepCard({ steps, forWhat, children }: { steps: StepVM[]; forWhat: string; children?: ReactNode }) {
  if (!steps.length && !children) return null;
  const gap = steps.every((s) => s.kind === "gap");
  return (
    <section aria-labelledby="next-step-title" className={`rounded-xl border p-4 ${gap ? "border-dashed border-ink-3" : "border-accent/35 bg-accent/5"}`}>
      <h3 id="next-step-title" className="text-xs font-semibold tracking-wide text-ink-2 uppercase">
        Next step for {forWhat}
      </h3>
      <ol role="list" className="mt-2 space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-0.5 text-accent-ink">
              <TypeIcon type={STEP_ICON[s.kind]} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink text-pretty">
                {s.text}
                <Cites ns={s.cites} />
              </p>
              <p className="mt-1 text-xs text-ink-2 text-pretty">
                {s.because}
                <Cites ns={s.becauseCites} />
              </p>
              {s.caveat && <p className="mt-1 text-xs text-ink-2 text-pretty">{s.caveat}</p>}
            </div>
          </li>
        ))}
      </ol>
      {children && <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>}
    </section>
  );
}
