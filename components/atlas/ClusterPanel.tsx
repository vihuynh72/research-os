"use client";

// The start screen's side panel: the disease groups (pick one to map its most connected disease),
// how to read the map in three rules, where the data comes from, and who the view is written for.
import type { GraphEdge, NodeType } from "@/lib/graph/types";
import { ICON_PATH } from "@/lib/viz/icons";
import { KIND_STYLE, type Kind } from "./kinds";
import type { ClusterRow, Mode } from "./format";
import { evidenceBadge } from "./evidence";
import EvidenceBadge from "./EvidenceBadge";
import { Dot } from "./NeighborList";
import MapLegend from "./map/MapLegend";
import { dataSources } from "./map/sources";

// One kind of thing as it appears on the map: a pale disk with its icon (diseases: a solid dot).
export function KindSwatch({ kind, size = 16 }: { kind: Kind; size?: number }) {
  if (kind === "disease") {
    return (
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className="shrink-0">
        <circle cx="8" cy="8" r="6.5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="1.5" />
      </svg>
    );
  }
  const icon: Record<Exclude<Kind, "disease">, NodeType> = { biology: "Gene", clinical: "Phenotype", community: "PatientOrg", research: "Paper" };
  const style = KIND_STYLE[kind];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="11" fill={style.fill} stroke={style.ink} strokeOpacity={0.5} strokeWidth="1.2" />
      <g transform="translate(5.2 5.2) scale(0.567)">
        <path d={ICON_PATH[icon[kind]]} fill="none" stroke={style.ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

function PersonaCard({ mode, onMode }: { mode: Mode; onMode(mode: Mode): void }) {
  const parent = mode === "parent";
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <p className="text-sm font-medium">{parent ? "Viewing as Maria · patient leader" : "Researcher view"}</p>
      <p className="mt-0.5 text-xs text-ink-2 text-pretty">
        {parent ? "Plain words and percentages. Every claim keeps its source." : "Adds the score of each line of evidence, symptom percentiles, pathway specificity and record ids."}
      </p>
      <button type="button" onClick={() => onMode(parent ? "researcher" : "parent")} className="mt-2 text-[0.8125rem] font-medium text-accent-ink hover:underline">
        {parent ? "Switch to researcher view" : "Switch to caregiver view"}
      </button>
    </div>
  );
}

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-[0.8125rem] font-semibold text-ink">
      {children}
    </h2>
  );
}

interface Props {
  rows: ClusterRow[];
  edges: readonly GraphEdge[];
  onPick(row: ClusterRow): void;
  mode: Mode;
  onMode(mode: Mode): void;
}

export default function ClusterPanel({ rows, edges, onPick, mode, onMode }: Props) {
  const sources = dataSources(edges);
  return (
    <div className="flex min-h-full flex-col gap-7">
      <section aria-labelledby="groups-heading">
        <SectionTitle id="groups-heading">Disease groups</SectionTitle>
        <p className="mt-1 mb-2 text-xs text-ink-2 text-pretty">
          Grouped by a shared gene or pathway. Diseases of one gene can still work differently; open a pair to see what is known.
        </p>
        <ul role="list" className="-mx-2">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                disabled={!row.lead}
                onClick={() => onPick(row)}
                title={row.lead ? `Map the most connected disease of this group` : undefined}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:cursor-default disabled:opacity-60"
              >
                <span className="mt-[0.3rem]">
                  <Dot color={row.color} />
                </span>
                <span className="min-w-0 flex-1 text-pretty">{row.label}</span>
                <span className="text-ink-2 tabular-nums">{row.size}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="legend-heading" className="space-y-3">
        <SectionTitle id="legend-heading">How to read the map</SectionTitle>
        <MapLegend variant="panel" />
      </section>

      <section aria-labelledby="sources-heading">
        <SectionTitle id="sources-heading">Where the data comes from</SectionTitle>
        <p className="mt-1 mb-2.5 text-xs text-ink-2 text-pretty">
          {sources.length} public sources. Curated databases state their links; searches and name matches are marked as such.
        </p>
        <ul role="list" className="space-y-2.5">
          {sources.map((s) => (
            <li key={s.source} className="text-[0.8125rem] leading-snug">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-ink">{s.source}</span>
                <span className="shrink-0 text-xs text-ink-2 tabular-nums">
                  {s.links.toLocaleString("en")} {s.links === 1 ? "link" : "links"}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                <span className="text-pretty">
                  {s.provides.charAt(0).toUpperCase() + s.provides.slice(1)} · <time dateTime={s.date}>{s.date}</time>
                </span>
                {s.kind !== "observed" && <EvidenceBadge badge={evidenceBadge(s.sample)} />}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-auto">
        <PersonaCard mode={mode} onMode={onMode} />
      </div>
    </div>
  );
}
