"use client";

// The atlas screen. It opens blank: a faint constellation of every disease and one search box.
// Whatever the person searches (a disease, gene, symptom, group, study or paper) goes in the
// center of a knowledge graph where distance is relevance and direction is the kind of thing.
// The relevance bar filters the map, the panel explains whatever is selected, and all of it
// mirrors the URL (see urlState.ts) so any view can be linked to or screenshotted.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AtlasGraph, NodeType } from "@/lib/graph/types";
import type { RelevanceDoc } from "@/lib/grading/types";
import type { SearchHit } from "@/lib/graph/index";
import type { DataNote } from "@/lib/data/source";
import { applyThreshold, buildNeighborhood, relevanceHistogram, type Neighborhood, type ThresholdResult } from "@/lib/graph/neighborhood";
import { TYPE_NAME } from "@/lib/graph/vocab";
import { TYPE_WORD, buildModel, clusterRows, exampleNodes, formatPercent, nodeName, resolveSelection, type AtlasModel, type ClusterRow, type Mode, type View } from "./format";
import { defaultThreshold, stateQuery, type AtlasState } from "./urlState";
import { constellationScene, neighborhoodScene } from "./scene3d";
import { SEARCH_SCOPES, type ScopeId } from "./searchScopes";
import KnowledgeGraph from "./KnowledgeGraph";
import RelevanceBar from "./RelevanceBar";
import SearchBox from "./SearchBox";
import ViewToggle, { Segmented, type Display, type SegmentOption } from "./ViewToggle";
import ClusterPanel, { LegendStrip, Legend } from "./ClusterPanel";
import DetailPanel from "./DetailPanel";
import MapList from "./MapList";

const Graph3D = dynamic(() => import("./Graph3D"), {
  ssr: false,
  loading: () => <MapMessage>Loading the 3D view…</MapMessage>,
});

interface Props {
  graph: AtlasGraph;
  relevance: RelevanceDoc;
  sample: boolean;
  notes: DataNote[];
  initial: AtlasState;
}

// Every type the map can show, in the order the type filters list them.
const TYPE_ORDER: NodeType[] = ["Disease", "Gene", "Variant", "Mechanism", "Phenotype", "PatientOrg", "Asset", "Trial", "Paper", "Grant", "Investigator"];

const PERSONAS: SegmentOption<Mode>[] = [
  { value: "parent", label: "Caregiver" },
  { value: "researcher", label: "Researcher" },
];

// Names short enough to quote whole in the search box's hint.
const HINT_NAME = 24;

function MapMessage({ children }: { children: ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-2">{children}</div>;
}

const toggled = <T,>(set: ReadonlySet<T>, item: T): Set<T> => {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
};

const isPhone = () => window.matchMedia("(max-width: 639px)").matches;
const scrollBehavior = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// A media query as state. The server and the first client render use `serverValue`, so hydration
// matches; the real value follows right after.
function useMedia(query: string, serverValue: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

// What the map cannot show at this filter, said under it with the one button that fixes it: the
// type filter hides the diseases, no related disease reaches the bar, or none shares biology at all.
function mapNotice({
  model,
  hood,
  filtered,
  threshold,
  hidden,
  onThreshold,
  onShowAllTypes,
}: {
  model: AtlasModel;
  hood: Neighborhood | null;
  filtered: ThresholdResult | null;
  threshold: number;
  hidden: ReadonlySet<NodeType>;
  onThreshold(value: number): void;
  onShowAllTypes(): void;
}): ReactNode {
  if (!hood || !filtered) return null;
  const focus = model.index.byId.get(hood.focus);
  if (!focus) return null;
  const button = (label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} className="mt-2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white sm:mt-0 sm:ml-2">
      {label}
    </button>
  );
  if (hidden.has("Disease") && (hood.related.length > 0 || hood.anchors.some((id) => id !== hood.focus))) {
    return (
      <>
        <span>Diseases are hidden by your type filter{focus.type === "Disease" ? ", so only the one you searched is on the map" : ""}.</span>{" "}
        {button("Show all types", onShowAllTypes)}
      </>
    );
  }
  const closest = filtered.closestHidden;
  if (hood.related.length > 0 && filtered.relatedShown === 0 && closest && closest.relevance < threshold - 1e-9) {
    const name = model.index.byId.get(closest.id);
    const lower = Math.floor(closest.relevance * 100 + 1e-6) / 100;
    return (
      <>
        <span>
          No related disease at {formatPercent(threshold)} or above. The closest is <strong>{name ? nodeName(name, 80) : closest.id}</strong> at {formatPercent(closest.relevance)}.
        </span>{" "}
        {lower < threshold - 1e-9 && button(`Lower to ${formatPercent(lower)}`, () => onThreshold(lower))}
      </>
    );
  }
  if (focus.type === "Disease" && hood.related.length === 0) {
    const lookAlikes = model.relevance.diseases[focus.id]?.clinical_neighbors?.length ?? 0;
    return (
      <span>
        No disease in this atlas shares biology with {nodeName(focus, 80)} yet. We compared its genes, mechanisms and gene changes with every other disease here.
        {/* The map places biology only; diseases that merely look alike are listed in the panel. */}
        {lookAlikes > 0 && ` ${lookAlikes} look similar clinically; they are listed beside the map under “Looks similar clinically”.`}
      </span>
    );
  }
  return null;
}

export default function AtlasApp({ graph, relevance, sample, notes, initial }: Props) {
  const model = useMemo(() => buildModel(graph, relevance), [graph, relevance]);
  const known = useCallback((id: string | null | undefined): id is string => !!id && model.index.byId.has(id), [model]);

  const [focusId, setFocusId] = useState<string | null>(() => (known(initial.focusId) ? initial.focusId : null));
  const [selectedId, setSelectedId] = useState<string | null>(() => (known(initial.focusId) ? initial.selectedId : null));
  const [view, setView] = useState<View>(initial.view);
  const [mode, setMode] = useState<Mode>(initial.mode);
  // null: the filter a new search opens at (defaultThreshold); a number: the one the person set.
  const [chosenThreshold, setThreshold] = useState<number | null>(initial.threshold);
  const [hidden, setHidden] = useState<ReadonlySet<NodeType>>(() => new Set(initial.hidden));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initial.open));
  const [list, setList] = useState(initial.list);
  // A shared link to something this atlas does not have opens the start screen and says so.
  const [staleLink, setStaleLink] = useState(() => !!initial.focusId && !known(initial.focusId));
  const mapRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const hood = useMemo(() => (focusId ? buildNeighborhood(graph, relevance, focusId, { expanded }) : null), [graph, relevance, focusId, expanded]);
  const moderate = relevance.meta.thresholds?.moderate;
  const startThreshold = useMemo(() => defaultThreshold(hood?.related ?? [], moderate), [hood, moderate]);
  const threshold = chosenThreshold ?? startThreshold;
  const filtered = useMemo(() => (hood ? applyThreshold(hood, threshold, hidden) : null), [hood, threshold, hidden]);
  const histogram = useMemo(() => (hood ? relevanceHistogram(hood) : new Array<number>(20).fill(0)), [hood]);
  const types = useMemo(
    () => TYPE_ORDER.filter((t) => filtered?.byType[t]).map((t) => ({ type: t, shown: filtered!.byType[t]!.shown, total: filtered!.byType[t]!.total })),
    [filtered],
  );
  // A selection the data cannot explain (a stale link, a node folded away) is dropped, so the
  // panel and the address never disagree with the map.
  const selection = useMemo(() => (focusId && hood ? resolveSelection(model, hood, focusId, selectedId) : null), [model, hood, focusId, selectedId]);
  const selected = selection ? selection.id : null;

  // Mirror the state into the address bar. Compared with the link the page was opened with, so a
  // link to something unknown, or with parts that no longer apply, is rewritten to what is shown.
  const query = stateQuery({
    focusId,
    selectedId: selected,
    view,
    mode,
    threshold: chosenThreshold,
    hidden: [...hidden],
    open: [...expanded],
    list,
  });
  const written = useRef(stateQuery(initial));
  useEffect(() => {
    if (query === written.current) return;
    written.current = query;
    window.history.replaceState(null, "", `${window.location.pathname}${query}`);
  }, [query]);

  const focusNode = focusId ? model.index.byId.get(focusId) : undefined;
  useEffect(() => {
    document.title = focusNode ? `${nodeName(focusNode, 32)} · CVI Atlas` : "CVI Atlas";
  }, [focusNode]);

  const focusOn = useCallback(
    (id: string) => {
      if (!known(id)) return;
      setFocusId(id);
      setSelectedId(null);
      setExpanded(new Set());
      // Each new center opens at its own default filter, so its related diseases are in view.
      setThreshold(null);
      setStaleLink(false);
      // On phones the map sits above the evidence: bring it back into view after a re-center.
      if (mapRef.current && isPhone() && mapRef.current.getBoundingClientRect().top < 0) {
        mapRef.current.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      }
    },
    [known],
  );

  const startOver = useCallback(() => {
    setFocusId(null);
    setSelectedId(null);
    setExpanded(new Set());
    setThreshold(null);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    // On phones the evidence sits below the map: bring it into view after a tap.
    if (id && panelRef.current && isPhone()) panelRef.current.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }, []);

  const toggleBubble = useCallback((id: string) => setExpanded((prev) => toggled(prev, id)), []);
  const showAllTypes = useCallback(() => setHidden(new Set()), []);

  // Wide screens scroll the evidence panel on its own: start each new subject at its top.
  useEffect(() => {
    if (panelRef.current && !isPhone()) panelRef.current.scrollTop = 0;
  }, [focusId, selected]);

  const search = useCallback((q: string, types?: readonly NodeType[]) => model.index.search(q, undefined, types), [model]);
  const suggest = useCallback((types: readonly NodeType[]) => model.index.suggest(types, 8), [model]);
  // Any result goes in the center: a gene shows its diseases, a symptom every disease that has it.
  const pick = useCallback((hit: SearchHit) => focusOn(hit.node.id), [focusOn]);

  // From 1024px the start card floats over the top of the map; below that it sits above the map.
  const wide = useMedia("(min-width: 1024px)", true);
  // The search box's kind chips fit beside the header controls only on wide screens; narrower
  // headers keep one line (the start card always has them).
  const roomy = useMedia("(min-width: 1280px)", true);
  const examples = useMemo(() => exampleNodes(model), [model]);
  // The hint quotes whole names only: a short disease name (the example, else the best connected
  // disease with a short name), then a gene.
  const hintNames = useMemo(() => {
    const central = [...model.index.diseases].sort((a, b) => (model.relevance.diseases[b.id]?.centrality ?? 0) - (model.relevance.diseases[a.id]?.centrality ?? 0));
    const short = (candidates: { label: string }[]) => candidates.map((n) => n.label).find((label) => label.length <= HINT_NAME);
    return [
      short([...examples.filter((n) => n.type === "Disease"), ...central]),
      short([...examples.filter((n) => n.type === "Gene"), ...model.index.suggest(["Gene"], 12).map((h) => h.node)]),
    ].filter((name): name is string => !!name);
  }, [examples, model]);
  const hintsByScope = useMemo(() => {
    const out: Partial<Record<ScopeId, string[]>> = {};
    for (const scope of SEARCH_SCOPES) {
      if (!scope.types.length) continue;
      out[scope.id] = model.index
        .suggest(scope.types, 12)
        .map((h) => h.node.label)
        .filter((label) => label.length <= HINT_NAME)
        .slice(0, 2);
    }
    return out;
  }, [model]);
  const clusters = useMemo(() => clusterRows(model), [model]);
  const pickCluster = useCallback((row: ClusterRow) => row.lead && focusOn(row.lead), [focusOn]);

  const display: Display = list ? "list" : view;
  const changeDisplay = useCallback((next: Display) => {
    if (next === "list") setList(true);
    else {
      setView(next);
      setList(false);
    }
  }, []);

  const thresholds = model.relevance.meta.thresholds ?? { strong: 0.75, moderate: 0.45, exploratory: 0.2 };
  const bar = (orientation: "vertical" | "horizontal") => (
    <RelevanceBar
      value={threshold}
      onChange={setThreshold}
      histogram={histogram}
      shown={filtered?.shown ?? 0}
      total={filtered?.total ?? 0}
      relatedShown={filtered?.relatedShown ?? 0}
      relatedTotal={filtered?.relatedTotal ?? 0}
      thresholds={thresholds}
      types={types}
      hiddenTypes={hidden}
      onToggleType={(t) => setHidden((prev) => toggled(prev, t))}
      onOnlyType={(t) => setHidden(new Set(TYPE_ORDER.filter((x) => x !== t)))}
      onShowAllTypes={showAllTypes}
      onReset={() => {
        setThreshold(null);
        setHidden(new Set());
      }}
      defaultValue={startThreshold}
      orientation={orientation}
      disabled={!focusId}
    />
  );

  const scene3d = useMemo(() => {
    if (view !== "3d" || list) return null;
    if (!hood || !filtered || !focusId) return constellationScene(model);
    return neighborhoodScene(model, hood, filtered, threshold, selected);
  }, [view, list, hood, filtered, focusId, model, selected, threshold]);

  const diseaseCount = model.index.diseases.length;
  const banner = sample
    ? `Sample data: ${diseaseCount} ${diseaseCount === 1 ? "rare disease" : "rare diseases"} from the team seed. ${
        model.relevance.meta.method === "agent-judged"
          ? "Grades come from the deterministic engine, checked by the AI review layer, which can only lower a grade."
          : "Grades come from the deterministic engine; the AI review layer is not connected yet."
      }`
    : null;

  const focusName = focusNode ? nodeName(focusNode, 40) : "";
  const notice = !list && focusId ? mapNotice({ model, hood, filtered, threshold, hidden, onThreshold: setThreshold, onShowAllTypes: showAllTypes }) : null;
  let map: ReactNode;
  if (list) {
    map = (
      <MapList
        model={model}
        hood={hood}
        filtered={filtered}
        threshold={threshold}
        selectedId={selected}
        mode={mode}
        clusters={clusters}
        onSelect={select}
        onFocus={focusOn}
        onToggleBubble={toggleBubble}
      />
    );
  } else if (view === "3d" && scene3d) {
    map = (
      <Graph3D
        nodes={scene3d.nodes}
        links={scene3d.links}
        focusId={focusId ?? ""}
        selectedId={selected}
        layout={focusId ? "disc" : "cloud"}
        rings={scene3d.rings}
        sectors={scene3d.sectors}
        onSelect={(id) => {
          const node = hood?.nodes.find((n) => n.id === id);
          if (!focusId) focusOn(id);
          else if (node?.role === "bubble") toggleBubble(id);
          else select(id === focusId ? null : id);
        }}
        onFocus={(id) => !id.startsWith("bubble:") && focusOn(id)}
        ariaLabel={focusNode ? `3D knowledge graph centered on ${focusName}` : `3D constellation of the ${diseaseCount} diseases in this atlas`}
        caption={
          focusNode
            ? "3D: the same map as 2D, tilted. Distance from the center is relevance; each kind of thing has its own direction and height. Drag to rotate, scroll to zoom."
            : "3D: diseases that share more biology sit closer together. Drag to rotate, scroll to zoom, click a disease to map it."
        }
        className="h-full w-full px-3 pt-1 pb-2.5"
      />
    );
  } else {
    map = (
      <KnowledgeGraph
        graph={graph}
        relevance={relevance}
        focusId={focusId}
        selectedId={selected}
        threshold={threshold}
        thresholds={thresholds}
        hiddenTypes={hidden}
        expanded={expanded}
        mode={mode}
        onFocus={focusOn}
        onSelect={select}
        onToggleBubble={toggleBubble}
        reserveTop={wide ? 0.42 : 0}
      />
    );
  }
  const cardOverMap = !focusId && !list && view === "2d";

  const startCard = (
    <div className="w-full max-w-xl rounded-2xl border border-line bg-surface/90 p-5 text-center shadow-[0_8px_30px_rgb(0_0_0/0.08)] backdrop-blur sm:p-6">
      <h2 className="text-[1.375rem] leading-tight font-semibold tracking-tight text-balance sm:text-[1.625rem]">Find the diseases that share your biology</h2>
      {staleLink && (
        <p role="status" className="mx-auto mt-3 max-w-md rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink text-pretty">
          The item in that link isn’t in this atlas. Search for it, or start from one of the examples below.
        </p>
      )}
      <p className="mt-2 text-sm text-ink-2 text-pretty">
        Each dot is one of the {diseaseCount} diseases in this atlas. Search a disease, a gene or a symptom: it goes in the center, the closer something sits the more it
        matters to it, and its direction tells you what kind of thing it is.
      </p>
      <SearchBox
        search={search}
        suggest={suggest}
        onPick={pick}
        examples={hintNames}
        examplesByScope={hintsByScope}
        autoFocus
        className="mx-auto mt-4 w-full max-w-md text-left"
      />
      {examples.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[0.8125rem]">
          <span className="text-ink-2">Try</span>
          {examples.map((ex) => (
            <button
              key={ex.id}
              type="button"
              onClick={() => focusOn(ex.id)}
              title={ex.label}
              className="inline-flex max-w-full items-baseline gap-1 rounded-full border border-line bg-surface px-3 py-1 text-ink hover:border-ink-3 hover:bg-surface-2"
            >
              <span className="truncate">{nodeName(ex, 44)}</span>
              <span className="shrink-0 text-ink-2">{TYPE_WORD[ex.type].toLowerCase()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const noticeBox = (className: string) =>
    notice && (
      <div role="status" className={`rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink text-pretty shadow-sm ${className}`}>
        {notice}
      </div>
    );

  return (
    <div className="flex min-h-dvh flex-col sm:h-dvh sm:min-h-0">
      <header className="border-b border-line bg-surface">
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2.5 px-4 py-2.5 [grid-template-areas:'brand_controls''search_search'] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-x-5 sm:[grid-template-areas:'brand_search_controls'] lg:px-5">
          <button type="button" onClick={startOver} className="flex items-baseline gap-2 justify-self-start rounded-md text-left [grid-area:brand]" title="Start a new search">
            <h1 className="text-[1.0625rem] font-semibold tracking-tight whitespace-nowrap">CVI Atlas</h1>
            <span className="hidden text-sm whitespace-nowrap text-ink-2 md:inline">Knowledge graph</span>
          </button>
          {focusId ? (
            <SearchBox
              search={search}
              suggest={suggest}
              onPick={pick}
              examples={hintNames}
              examplesByScope={hintsByScope}
              scopes={roomy ? undefined : false}
              className="w-full max-w-xl justify-self-center [grid-area:search]"
            />
          ) : (
            <div className="hidden sm:block sm:[grid-area:search]" />
          )}
          <div className="flex items-center gap-2 justify-self-end [grid-area:controls] sm:gap-3">
            {/* Phones keep the view switch above the map, so the header fits on one line. */}
            <div className="hidden sm:block">
              <ViewToggle value={display} onChange={changeDisplay} />
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-sm whitespace-nowrap text-ink-2 xl:inline">Viewing as:</span>
              <Segmented<Mode> label="Viewing as" options={PERSONAS} value={mode} onChange={setMode} />
            </div>
          </div>
        </div>
        {(banner || notes.length > 0) && (
          <div className="border-t border-line bg-surface-2 px-4 py-1.5 text-xs text-ink-2 lg:px-5">
            {banner && <p className="text-pretty">{banner}</p>}
            {notes.map((n) => (
              <p key={n.detail} className="text-pretty">
                <span className="font-medium text-ink">{n.text}</span>
                {mode === "researcher" && <span className="ml-1.5 font-mono text-[0.6875rem]">{n.detail}</span>}
              </p>
            ))}
          </div>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,1fr)_200px_340px] xl:grid-cols-[minmax(0,1fr)_200px_380px]">
        <main className="relative flex min-w-0 flex-col gap-3 px-3 pt-3 pb-4 sm:min-h-0 sm:overflow-y-auto sm:px-4 lg:overflow-hidden lg:bg-surface lg:p-0">
          {/* One search card: above the constellation on small screens, floating over it on wide ones. */}
          {!focusId && (
            <div className={`flex justify-center ${cardOverMap ? "lg:pointer-events-none lg:absolute lg:inset-x-0 lg:top-0 lg:z-10 lg:p-6" : "lg:px-5 lg:pt-5"}`}>
              <div className="pointer-events-auto flex w-full justify-center">{startCard}</div>
            </div>
          )}

          <div className="flex justify-center sm:hidden">
            <ViewToggle value={display} onChange={changeDisplay} />
          </div>

          <section
            ref={mapRef}
            aria-label={focusNode ? (list ? `Everything linked to ${focusName}, as a list` : `Knowledge graph centered on ${focusName}`) : "Every disease in the atlas"}
            className={`relative w-full scroll-mt-3 overflow-hidden rounded-xl border border-line bg-surface lg:min-h-0 lg:flex-1 lg:rounded-none lg:border-0 ${
              list ? "min-h-[420px] lg:min-h-0" : "aspect-[7/5] lg:aspect-auto"
            }`}
          >
            {map}
            {focusId && !list && view === "2d" && expanded.size > 0 && (
              <div className="absolute top-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1.5">
                {[...expanded].map((id) => {
                  const type = id.split(":").pop() as NodeType;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleBubble(id)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-2 shadow-sm hover:text-ink"
                      aria-label={`Fold the ${TYPE_NAME[type]?.many ?? "items"} back into a group`}
                    >
                      Fold {TYPE_NAME[type]?.many ?? "group"}
                      <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                        <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  );
                })}
              </div>
            )}
            {/* Wide screens: the notice sits at the foot of the map. */}
            {noticeBox("absolute inset-x-0 bottom-4 mx-auto hidden w-fit max-w-[90%] sm:block")}
          </section>

          {/* Phones: under the map, so it never covers it. */}
          {noticeBox("sm:hidden")}

          {focusId && !list && view === "2d" && (
            <div className="hidden px-5 pb-3 lg:block">
              <LegendStrip />
            </div>
          )}

          {/* Below 1024px the relevance bar lies under the map. */}
          {focusId && (
            <div className="rounded-xl border border-line bg-surface p-3 lg:hidden">
              {bar("horizontal")}
            </div>
          )}

          {focusId && (
            <details className="rounded-xl border border-line bg-surface px-3 py-2 lg:hidden">
              <summary className="cursor-pointer text-[0.8125rem] font-medium">How to read the map</summary>
              <div className="mt-3 mb-1">
                <Legend thresholds={thresholds} />
              </div>
            </details>
          )}
        </main>

        <aside aria-label="Relevance filter" className="hidden min-h-0 overflow-y-auto border-l border-line bg-surface px-3 py-4 lg:block">
          {bar("vertical")}
        </aside>

        <aside
          ref={panelRef}
          aria-label={focusId ? "Details" : "About this atlas"}
          className="panel-scroll scroll-mt-2 rounded-t-2xl border-t border-line bg-surface px-4 pt-2 pb-8 shadow-[0_-10px_30px_rgb(0_0_0/0.06)] sm:rounded-none sm:border-t-0 sm:border-l sm:pt-5 sm:shadow-none lg:px-5"
        >
          <div className="sheet-grabber mx-auto mb-4 sm:hidden" aria-hidden="true" />
          {focusId && hood && filtered ? (
            <DetailPanel
              model={model}
              hood={hood}
              filtered={filtered}
              focusId={focusId}
              selection={selection}
              threshold={threshold}
              mode={mode}
              onSelect={select}
              onFocus={focusOn}
              onThreshold={setThreshold}
            />
          ) : (
            <ClusterPanel rows={clusters} diseaseCount={diseaseCount} onPick={pickCluster} mode={mode} onMode={setMode} thresholds={thresholds} />
          )}
        </aside>
      </div>
    </div>
  );
}
