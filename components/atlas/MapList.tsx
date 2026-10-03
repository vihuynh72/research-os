"use client";

// The accessible twin of the map: the same items, filtered by the same relevance bar and type
// filters, as lists grouped the way the map places them (by direction, i.e. kind of thing), most
// relevant first. Before a search it lists every disease by cluster, ready to be mapped.
import type { GraphNode, NodeType } from "@/lib/graph/types";
import type { HoodNode, Neighborhood, ThresholdResult } from "@/lib/graph/neighborhood";
import { sectorOf, type SectorId } from "@/lib/viz/radialLayout";
import { shortLabel } from "@/lib/graph/labels";
import { TYPE_NAME } from "@/lib/graph/vocab";
import { KIND_WORD, TYPE_WORD, diseaseColor, formatPercent, nodeName, nodeOf, type AtlasModel, type ClusterRow, type Mode } from "./format";
import { KIND_STYLE, type Kind } from "./kinds";
import { KindSwatch } from "./ClusterPanel";
import { Dot, TierBadge } from "./NeighborList";

interface Props {
  model: AtlasModel;
  hood: Neighborhood | null;
  filtered: ThresholdResult | null;
  threshold: number;
  selectedId: string | null;
  mode: Mode;
  clusters: ClusterRow[];
  onSelect(id: string | null): void;
  onFocus(id: string): void;
  onToggleBubble(id: string): void;
}

const SECTIONS: { id: SectorId; kind: Kind; title: string; where: string }[] = [
  { id: "diseases", kind: "disease", title: "Diseases", where: "top of the map" },
  { id: "biology", kind: "biology", title: "Genes and mechanisms", where: "left" },
  { id: "symptoms", kind: "clinical", title: "Symptoms", where: "bottom" },
  { id: "community", kind: "community", title: "Groups and registries", where: "lower right" },
  { id: "research", kind: "research", title: "Research", where: "upper right" },
];

const typeOf = (n: HoodNode): NodeType => (n.type === "Bubble" ? n.bubbleType! : n.type);

export default function MapList(props: Props) {
  if (!props.hood || !props.filtered) return <AtlasList {...props} />;
  return <HoodList {...props} hood={props.hood} filtered={props.filtered} />;
}

function AtlasList({ model, clusters, onFocus }: Props) {
  return (
    <div className="h-full overflow-y-auto px-4 py-4 lg:px-6">
      <p className="text-sm text-ink-2 text-pretty">
        Every disease in this atlas ({model.index.diseases.length}), grouped by the biology they share. Select one to map it.
      </p>
      {clusters.map((row) => (
        <section key={row.id} aria-labelledby={`list-${row.id}`} className="mt-5">
          <h3 id={`list-${row.id}`} className="flex items-center gap-2 text-sm font-semibold">
            <Dot color={row.color} />
            {row.label}
            <span className="font-normal text-ink-2 tabular-nums">{row.size}</span>
          </h3>
          <ul role="list" className="mt-1.5 grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
            {row.members
              .map((id) => nodeOf(model, id))
              .filter((n): n is GraphNode => !!n)
              .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }))
              .map((node) => (
                <li key={node.id}>
                  <button type="button" onClick={() => onFocus(node.id)} className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2">
                    <span className="font-medium">{shortLabel(node)}</span>
                    {shortLabel(node) !== node.label && <span className="block truncate text-xs text-ink-2">{node.label}</span>}
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HoodList({ model, hood, filtered, threshold, selectedId, mode, onSelect, onFocus, onToggleBubble }: Props & { hood: Neighborhood; filtered: ThresholdResult }) {
  const focus = nodeOf(model, hood.focus);
  if (!focus) return null;
  const center = nodeName(focus, 40);
  const ghosts = new Set(filtered.ghosts.map((n) => n.id));
  const items = [...filtered.nodes, ...filtered.ghosts].filter((n) => n.role !== "focus");
  const hiddenTypes = [...new Set(hood.nodes.filter((n) => n.role !== "focus").map(typeOf))].filter((t) => !filtered.byType[t]?.shown && !items.some((n) => typeOf(n) === t));

  return (
    <div className="h-full overflow-y-auto px-4 py-4 lg:px-6">
      <p className="text-sm text-ink-2 text-pretty">
        <span className="font-medium text-ink">{sentence(center)}</span> is in the center. Below:{" "}
        {filtered.shown} of {filtered.total} linked items at {formatPercent(threshold)} relevance or more, grouped as on the map, most relevant first.
        {filtered.ghosts.length > 0 && " Items just under the filter are marked."}
      </p>
      {hiddenTypes.length > 0 && (
        <p className="mt-1 text-xs text-ink-2">Not listed at this filter: {hiddenTypes.map((t) => TYPE_NAME[t].many).join(", ")}.</p>
      )}
      {SECTIONS.map((section) => {
        const rows = items
          .filter((n) => sectorOf(typeOf(n)) === section.id)
          .sort((a, b) => Number(ghosts.has(a.id)) - Number(ghosts.has(b.id)) || b.relevance - a.relevance || a.label.localeCompare(b.label));
        if (!rows.length) return null;
        return (
          <section key={section.id} aria-labelledby={`list-${section.id}`} className="mt-5">
            <h3 id={`list-${section.id}`} className="flex items-center gap-2 text-sm font-semibold">
              <KindSwatch kind={section.kind} />
              {section.title}
              <span className="font-normal text-ink-2">· {section.where}</span>
            </h3>
            <ul role="list" className="mt-1.5 divide-y divide-line">
              {rows.map((n) => {
                const ghost = ghosts.has(n.id);
                const isBubble = n.role === "bubble";
                const type = typeOf(n);
                return (
                  <li key={n.id} className={`flex items-start gap-3 py-2 ${ghost ? "opacity-70" : ""}`}>
                    <span className="mt-1">
                      {n.type === "Disease" ? <Dot color={diseaseColor(model, n.id)} /> : <TypeDot kind={KIND_STYLE[section.kind]} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        {isBubble ? (
                          <span className="text-sm font-medium">{sentence(n.label)}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onSelect(n.id)}
                            aria-current={n.id === selectedId ? "true" : undefined}
                            className="text-left text-sm font-medium hover:underline aria-[current=true]:text-accent-ink"
                          >
                            {n.type === "Disease" ? shortLabel({ label: n.label, synonyms: model.index.byId.get(n.id)?.synonyms }) : n.label}
                          </button>
                        )}
                        <span className="text-xs text-ink-2">{isBubble ? `${TYPE_NAME[type].many}, folded` : TYPE_WORD[type]}</span>
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                        {n.role === "related" && n.tier ? <TierBadge tier={n.tier} value={n.relevance} /> : <span className="tabular-nums">{formatPercent(n.relevance)} relevant</span>}
                        {n.kind && <span>{KIND_WORD[n.kind]}</span>}
                        {ghost && <span className="font-medium">just under your filter</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-2 text-pretty">{n.why}</p>
                      {mode === "researcher" && !isBubble && <p className="mt-0.5 font-mono text-[0.6875rem] text-ink-2">{n.id}</p>}
                    </div>
                    {isBubble ? (
                      <button type="button" onClick={() => onToggleBubble(n.id)} className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium hover:bg-surface-2">
                        Open
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onFocus(n.id)}
                        aria-label={`Center the map on ${n.label}`}
                        className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium hover:bg-surface-2"
                      >
                        Center
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {!items.length && <p className="mt-5 text-sm text-ink-2">Nothing is linked at this filter. Lower the relevance bar to see more.</p>}
    </div>
  );
}

function TypeDot({ kind }: { kind: { fill: string; ink: string } }) {
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full border" style={{ background: kind.fill, borderColor: kind.ink }} />;
}

function sentence(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}
