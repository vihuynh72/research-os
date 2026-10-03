"use client";

// The start screen's side panel: the mechanism clusters, how to read the map, and who the view is
// written for. The legend is also shown under the map (a compact strip on wide screens, a fold-out
// on small ones), so the meaning of placement is always one glance away.
import type { ReactNode } from "react";
import { SECTORS, type SectorId } from "@/lib/viz/radialLayout";
import { ICON_PATH } from "@/lib/viz/icons";
import type { NodeType } from "@/lib/graph/types";
import { KIND_STYLE, type Kind } from "./kinds";
import type { ClusterRow, Mode } from "./format";
import { Dot } from "./NeighborList";

interface ClusterProps {
  rows: ClusterRow[];
  activeId?: string | null;
  onPick(row: ClusterRow): void;
}

export function ClusterList({ rows, activeId, onPick }: ClusterProps) {
  return (
    <ul role="list" className="-mx-2 space-y-0.5">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            disabled={!row.lead}
            onClick={() => onPick(row)}
            aria-current={row.id === activeId ? "true" : undefined}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:cursor-default disabled:opacity-60 aria-[current=true]:bg-surface-2 aria-[current=true]:font-medium"
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
  );
}

// ---------- legend glyphs ----------

// Where each kind of thing sits on the map, as a little compass: the same sectors as the layout.
const SECTOR_KIND: Record<SectorId, Kind> = { diseases: "disease", research: "research", community: "community", symptoms: "clinical", biology: "biology" };

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const pad = 6; // a gap between sectors so each reads as its own direction
  const a0 = rad(start + pad / 2);
  const a1 = rad(end - pad / 2);
  const p = (a: number) => `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
  return `M${p(a0)} A${r} ${r} 0 ${end - start - pad > 180 ? 1 : 0} 1 ${p(a1)}`;
}

export function Compass({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 36 36" width={size} height={size} aria-hidden="true" className="shrink-0">
      {SECTORS.map((s) => {
        const kind = SECTOR_KIND[s.id];
        return (
          <path
            key={s.id}
            d={arcPath(18, 18, 14, s.start, s.end)}
            fill="none"
            stroke={kind === "disease" ? "var(--series-1)" : KIND_STYLE[kind].ink}
            strokeWidth={4.5}
            strokeLinecap="butt"
          />
        );
      })}
      <circle cx="18" cy="18" r="4" fill="var(--ink)" />
    </svg>
  );
}

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

type GlyphKind = "distance" | "filter" | "glow" | "dashed" | "faint" | "bubble" | "halo" | "arc";

function Glyph({ kind, width = 28 }: { kind: GlyphKind; width?: number }) {
  return (
    <svg viewBox="0 0 28 20" width={width} height={(width * 20) / 28} aria-hidden="true" className="shrink-0" fill="none">
      {kind === "distance" && (
        <>
          <circle cx="14" cy="10" r="8.5" stroke="var(--line)" strokeWidth="1.2" />
          <circle cx="14" cy="10" r="4.6" stroke="var(--line)" strokeWidth="1.2" />
          <circle cx="14" cy="10" r="2.6" fill="var(--ink)" />
          <circle cx="18.3" cy="8" r="1.8" fill="var(--ink-2)" />
          <circle cx="5.8" cy="13.5" r="1.6" fill="var(--ink-2)" opacity="0.6" />
        </>
      )}
      {kind === "filter" && <circle cx="14" cy="10" r="8" fill="var(--accent)" fillOpacity="0.06" stroke="var(--accent)" strokeWidth="1.4" strokeDasharray="2.5 2.5" />}
      {kind === "glow" && (
        <>
          <line x1="2" y1="10" x2="26" y2="10" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" opacity="0.18" />
          <line x1="2" y1="10" x2="26" y2="10" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
        </>
      )}
      {kind === "dashed" && <line x1="2" y1="10" x2="26" y2="10" stroke="var(--ink-2)" strokeWidth="1.8" strokeDasharray="4 3" />}
      {kind === "faint" && (
        <>
          <line x1="3" y1="10" x2="19" y2="10" stroke="var(--ink-3)" strokeWidth="1.4" opacity="0.4" />
          <circle cx="21" cy="10" r="4.5" fill="var(--kind-clin-fill)" stroke="var(--kind-clin-ink)" strokeWidth="1" opacity="0.35" />
        </>
      )}
      {kind === "bubble" && (
        <>
          <circle cx="14" cy="10" r="8" fill="var(--kind-res-fill)" stroke="var(--kind-res-ink)" strokeOpacity="0.6" strokeWidth="1.1" strokeDasharray="2.4 2" />
          <text x="14" y="13.4" textAnchor="middle" fontSize="9.5" fontWeight="650" fill="var(--kind-res-ink)">
            3
          </text>
        </>
      )}
      {kind === "halo" && (
        <>
          <rect x="2" y="3" width="24" height="14" rx="7" fill="var(--series-1)" opacity="0.14" />
          <circle cx="9" cy="10" r="3.2" fill="var(--series-1)" />
          <circle cx="19" cy="10" r="3.2" fill="var(--series-1)" />
        </>
      )}
      {kind === "arc" && <path d="M3 15 Q14 0 25 15" stroke="var(--ink-2)" strokeWidth="1.4" strokeDasharray="3 3" strokeLinecap="round" />}
    </svg>
  );
}

function Row({ glyph, children }: { glyph: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex w-9 shrink-0 justify-center">{glyph}</span>
      <span className="min-w-0 text-pretty">{children}</span>
    </li>
  );
}

const DIRECTIONS: { kind: Kind; where: string }[] = [
  { kind: "disease", where: "Diseases at the top, colored by cluster" },
  { kind: "research", where: "Research at the upper right" },
  { kind: "community", where: "Groups and registries at the lower right" },
  { kind: "clinical", where: "Symptoms at the bottom" },
  { kind: "biology", where: "Genes and mechanisms on the left" },
];

export function Legend() {
  return (
    <ul role="list" className="space-y-3 text-[0.8125rem] text-ink-2">
      <Row glyph={<Glyph kind="distance" />}>
        <span className="text-ink">Distance = relevance.</span> What you searched sits in the center; the closer something is, the more it matters to it. Rings mark 75%, 45% and
        20%.
      </Row>
      <Row glyph={<Compass size={30} />}>
        <span className="text-ink">Direction = the kind of thing.</span>
        <ul role="list" className="mt-1.5 space-y-1">
          {DIRECTIONS.map((d) => (
            <li key={d.kind} className="flex items-center gap-2">
              <KindSwatch kind={d.kind} />
              <span>{d.where}</span>
            </li>
          ))}
        </ul>
      </Row>
      <Row glyph={<Glyph kind="filter" />}>
        <span className="text-ink">Dashed blue circle = your relevance filter.</span> It moves with the bar beside the map; what is inside it is shown.
      </Row>
      <Row glyph={<Glyph kind="faint" />}>
        <span className="text-ink">Faint = just under your filter.</span> Lower the bar to bring it in.
      </Row>
      <Row glyph={<Glyph kind="glow" />}>
        <span className="text-ink">Thick, glowing line = strong link.</span> Hover a line, or select a node, to see its strength.
      </Row>
      <Row glyph={<Glyph kind="dashed" />}>
        <span className="text-ink">Dashed line = inferred,</span> not stated by a curated source.
      </Row>
      <Row glyph={<Glyph kind="bubble" />}>
        <span className="text-ink">Numbered circle = a folded group</span> (studies, papers, extra symptoms). Click it to open.
      </Row>
      <Row glyph={<Glyph kind="halo" />}>
        <span className="text-ink">Colored halo = same cluster:</span> diseases grouped by the biology they share.
      </Row>
      <Row glyph={<Glyph kind="arc" />}>
        <span className="text-ink">Dashed arc = already working together:</span> a shared grant, researcher or study.
      </Row>
    </ul>
  );
}

// The same legend in one or two lines, under the map on wide screens.
export function LegendStrip() {
  const item = (glyph: ReactNode, text: string) => (
    <li className="flex items-center gap-1.5 whitespace-nowrap">
      {glyph}
      <span>{text}</span>
    </li>
  );
  const short: Record<Kind, string> = { disease: "Diseases", biology: "Genes, mechanisms", clinical: "Symptoms", community: "Groups, registries", research: "Research" };
  return (
    <div role="group" aria-label="How to read the map" className="space-y-1.5 text-xs text-ink-2">
      <ul role="list" className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {item(<Glyph kind="distance" width={24} />, "Closer = more relevant")}
        <li className="flex items-center gap-1.5">
          <Compass size={20} />
          <span className="whitespace-nowrap">Direction = kind:</span>
        </li>
        {(["disease", "biology", "clinical", "community", "research"] as Kind[]).map((k) => (
          <li key={k} className="-ml-1.5 flex items-center gap-1 whitespace-nowrap">
            <KindSwatch kind={k} size={13} />
            {short[k]}
          </li>
        ))}
      </ul>
      <ul role="list" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {item(<Glyph kind="filter" width={22} />, "Your filter")}
        {item(<Glyph kind="faint" width={22} />, "Just under it")}
        {item(<Glyph kind="glow" width={22} />, "Strong link")}
        {item(<Glyph kind="dashed" width={22} />, "Inferred")}
        {item(<Glyph kind="bubble" width={22} />, "Folded group: click to open")}
        {item(<Glyph kind="halo" width={22} />, "Same cluster")}
        {item(<Glyph kind="arc" width={22} />, "Working together")}
      </ul>
    </div>
  );
}

export function PersonaCard({ mode, onMode }: { mode: Mode; onMode(mode: Mode): void }) {
  const parent = mode === "parent";
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <p className="text-sm font-medium">{parent ? "Viewing as Maria · patient leader" : "Researcher view"}</p>
      <p className="mt-0.5 text-xs text-ink-2 text-pretty">
        {parent ? "Plain words and percentages. Every claim keeps its source." : "Adds dimension scores, symptom percentiles, mechanism specificity, confidence and edge ids."}
      </p>
      <button
        type="button"
        onClick={() => onMode(parent ? "researcher" : "parent")}
        className="mt-2 text-[0.8125rem] font-medium text-accent-ink hover:underline"
      >
        {parent ? "Switch to researcher view" : "Switch to parent view"}
      </button>
    </div>
  );
}

interface Props extends ClusterProps {
  diseaseCount: number;
  mode: Mode;
  onMode(mode: Mode): void;
}

export default function ClusterPanel({ rows, activeId, onPick, diseaseCount, mode, onMode }: Props) {
  const clustered = rows.filter((r) => r.id !== "other").reduce((n, r) => n + r.size, 0);
  return (
    <div className="flex min-h-full flex-col gap-7">
      <section aria-labelledby="clusters-heading">
        <h2 id="clusters-heading" className="text-[0.9375rem] font-semibold text-ink">
          Explore by cluster
        </h2>
        <p className="mt-0.5 mb-2 text-xs text-ink-2 text-pretty">
          {clustered > 0
            ? `${clustered} of the ${diseaseCount} diseases fall into groups that share biology. Pick one to map its most connected disease.`
            : `None of the ${diseaseCount} diseases share enough biology to form a group yet.`}
        </p>
        <div className="max-h-[min(22rem,45dvh)] overflow-y-auto overscroll-contain pr-1">
          <ClusterList rows={rows} activeId={activeId} onPick={onPick} />
        </div>
      </section>
      <section aria-labelledby="legend-heading">
        <h2 id="legend-heading" className="mb-3 text-[0.9375rem] font-semibold text-ink">
          How to read the map
        </h2>
        <Legend />
      </section>
      <div className="mt-auto">
        <PersonaCard mode={mode} onMode={onMode} />
      </div>
    </div>
  );
}
