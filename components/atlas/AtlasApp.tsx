"use client";

// The RareVerse screen. It opens on the RareVerse universe: every disease as a point of light, and
// one search card. Whatever the person searches (a disease, gene, symptom, group, study or paper)
// goes in the center of a knowledge graph where distance is relevance and direction is the kind of
// thing. The map card carries its own controls: kind chips on top, the relevance slider docked at
// its right edge, the three-rule legend and the zoom buttons in its lower corners. The panel
// explains whatever is selected, and all of it mirrors the URL (see urlState.ts) so any view can be
// linked to or screenshotted.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AtlasGraph, NodeType } from "@/lib/graph/types";
import type { RelevanceDoc } from "@/lib/grading/types";
import type { SearchAliases, SearchHit } from "@/lib/graph/index";
import type { DataNote } from "@/lib/data/source";
import { applyThreshold, buildNeighborhood, relevanceHistogram, type LinkGroup, type Neighborhood, type ThresholdResult } from "@/lib/graph/neighborhood";
import { sentenceLabel } from "@/lib/graph/labels";
import { TYPE_NAME } from "@/lib/graph/vocab";
import { TYPE_WORD, buildModel, clusterRows, exampleNodes, formatPercent, resolveSelection, type AtlasModel, type ClusterRow, type Mode } from "./format";
import { cleanGraph } from "./names";
import { DEFAULT_RELATED, defaultThreshold, stateQuery, type AtlasState } from "./urlState";
import { useAddressBar } from "./useAddressBar";
import { SEARCH_SCOPES, type ScopeId } from "./searchScopes";
import { kindCounts, onlyKind, toggleKind } from "./kinds";
import KnowledgeGraph from "./KnowledgeGraph";
import RelevanceBar from "./RelevanceBar";
import SearchBox from "./SearchBox";
import ViewToggle, { Segmented, type Display, type SegmentOption } from "./ViewToggle";
import ClusterPanel from "./ClusterPanel";
import DetailPanel from "./DetailPanel";
import MapList from "./MapList";
import { Wordmark } from "./Brand";
import CopyLink from "./CopyLink";
import KindChips from "./map/KindChips";
import MapLegend from "./map/MapLegend";
import type { Box } from "./map/universe";
// 3D view
import dynamic from "next/dynamic";
import type { View } from "./urlState";
import { constellationScene, neighborhoodScene } from "./scene3d";

// 3D view: drawn on a canvas, so it loads in the browser only.
const Graph3D = dynamic(() => import("./Graph3D"), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-ink-2">Loading the 3D view…</p>,
});

interface Props {
  graph: AtlasGraph;
  relevance: RelevanceDoc;
  sample: boolean;
  notes: DataNote[];
  aliases?: SearchAliases | null; // other names for search (public/search-aliases.json), when built
  initial: AtlasState;
}

const PERSONAS: SegmentOption<Mode>[] = [
  { value: "parent", label: "Caregiver" },
  { value: "researcher", label: "Researcher" },
];

// Names short enough to quote whole in the search box's hint.
const HINT_NAME = 24;

const toggled = <T,>(set: ReadonlySet<T>, item: T): Set<T> => {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
};

const NO_LINKS_HIDDEN: ReadonlySet<LinkGroup> = new Set();

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
          No related disease at {formatPercent(threshold)} or above. The closest is <strong>{name ? name.label : closest.id}</strong> at {formatPercent(closest.relevance)}.
        </span>{" "}
        {lower < threshold - 1e-9 && button(`Lower to ${formatPercent(lower)}`, () => onThreshold(lower))}
      </>
    );
  }
  if (focus.type === "Disease" && hood.related.length === 0) {
    const lookAlikes = model.relevance.diseases[focus.id]?.clinical_neighbors?.length ?? 0;
    return (
      <span>
        No disease in RareVerse shares biology with {focus.label} yet. We compared its genes, pathways and gene changes with every other disease here.
        {/* The map places biology only; diseases that merely look alike are listed in the panel. */}
        {lookAlikes > 0 && ` ${lookAlikes} look similar clinically; they are listed beside the map under “Looks similar clinically”.`}
      </span>
    );
  }
  return null;
}

export default function AtlasApp({ graph: sourceGraph, relevance, sample, notes, aliases, initial }: Props) {
  // Decoded once ("&amp;" -> "&"), then used everywhere: model, map, list, panel and search.
  const graph = useMemo(() => cleanGraph(sourceGraph), [sourceGraph]);
  const model = useMemo(() => buildModel(graph, relevance, aliases), [graph, relevance, aliases]);
  const known = useCallback((id: string | null | undefined): id is string => !!id && model.index.byId.has(id), [model]);

  const [focusId, setFocusId] = useState<string | null>(() => (known(initial.focusId) ? initial.focusId : null));
  const [selectedId, setSelectedId] = useState<string | null>(() => (known(initial.focusId) ? initial.selectedId : null));
  const [mode, setMode] = useState<Mode>(initial.mode);
  // null: the filter a new search opens at (defaultThreshold); a number: the one the person set.
  const [chosenThreshold, setThreshold] = useState<number | null>(initial.threshold);
  const [hidden, setHidden] = useState<ReadonlySet<NodeType>>(() => new Set(initial.hidden));
  // Kinds of line the researcher switched off in the Links menu.
  const [hiddenLinks, setHiddenLinks] = useState<ReadonlySet<LinkGroup>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initial.open));
  const [list, setList] = useState(initial.list);
  // 3D view
  const [view, setView] = useState<View>(initial.view);
  // A shared link to something RareVerse does not have opens the start screen and says so.
  // The side panel (tablets and desktops) starts closed on the start screen and opens with the first search or
  // selection; a shared link that centers something opens with it. The icon on the map folds it either way.
  const [panelOpen, setPanelOpen] = useState(() => known(initial.focusId));
  const [staleLink, setStaleLink] = useState(() => !!initial.focusId && !known(initial.focusId));
  const mapRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const hood = useMemo(() => (focusId ? buildNeighborhood(graph, relevance, focusId, { expanded }) : null), [graph, relevance, focusId, expanded]);
  const startThreshold = useMemo(() => defaultThreshold(hood?.related ?? []), [hood]);
  const threshold = chosenThreshold ?? startThreshold;
  // The Links menu is a researcher tool: the caregiver view always shows every line.
  const linksOff = mode === "researcher" ? hiddenLinks : NO_LINKS_HIDDEN;
  const filtered = useMemo(() => (hood ? applyThreshold(hood, threshold, hidden, undefined, linksOff) : null), [hood, threshold, hidden, linksOff]);
  const histogram = useMemo(() => (hood ? relevanceHistogram(hood) : new Array<number>(20).fill(0)), [hood]);
  const kinds = useMemo(() => kindCounts(filtered?.byType ?? {}), [filtered]);
  // A selection the data cannot explain (a stale link, a node folded away) is dropped, so the
  // panel and the address never disagree with the map.
  const selection = useMemo(() => (focusId && hood ? resolveSelection(model, hood, focusId, selectedId) : null), [model, hood, focusId, selectedId]);
  const selected = selection ? selection.id : null;

  // Mirror the state into the address bar. Compared with the address itself, so a link to something
  // unknown, with parts that no longer apply or with an old parameter (view=3d) is rewritten to
  // what is shown.
  const query = stateQuery({
    focusId,
    selectedId: selected,
    view, // 3D view
    mode,
    threshold: chosenThreshold,
    hidden: [...hidden],
    open: [...expanded],
    list,
  });
  useAddressBar(query);

  const focusNode = focusId ? model.index.byId.get(focusId) : undefined;
  useEffect(() => {
    document.title = focusNode ? `${sentenceLabel(focusNode.label)} · RareVerse` : "RareVerse";
  }, [focusNode]);

  const focusOn = useCallback(
    (id: string) => {
      if (!known(id)) return;
      setFocusId(id);
      setSelectedId(null);
      setPanelOpen(true);
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
    setPanelOpen(false);
    setFocusId(null);
    setSelectedId(null);
    setExpanded(new Set());
    setThreshold(null);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setPanelOpen(true);
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
  const didYouMean = useCallback((q: string, types?: readonly NodeType[]) => model.index.didYouMean(q, 3, types), [model]);
  // Any result goes in the center: a gene shows its diseases, a symptom every disease that has it.
  const pick = useCallback((hit: SearchHit) => focusOn(hit.node.id), [focusOn]);

  // From 1024px the start card floats over the top of the map; below that it sits above the map.
  const wide = useMedia("(min-width: 1024px)", true);
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

  // 3D view: Map, 3D or List. The center, the selection and the filters stay as they are.
  const display: Display = list ? "list" : view === "3d" ? "3d" : "map";
  const changeDisplay = useCallback((next: Display) => {
    setList(next === "list");
    if (next !== "list") setView(next === "3d" ? "3d" : "2d");
  }, []);

  const thresholds = model.relevance.meta.thresholds ?? { strong: 0.75, moderate: 0.45, exploratory: 0.2 };
  // The reset brings back the filter a search opens at: the top five related diseases.
  const topFive = (filtered?.relatedTotal ?? 0) >= DEFAULT_RELATED;
  const bar = (orientation: "vertical" | "horizontal") => (
    <RelevanceBar
      value={threshold}
      onChange={setThreshold}
      histogram={histogram}
      showHistogram={mode === "researcher"}
      relatedShown={filtered?.relatedShown ?? 0}
      relatedTotal={filtered?.relatedTotal ?? 0}
      thresholds={thresholds}
      onReset={() => setThreshold(null)}
      resetLabel={topFive ? `Top ${DEFAULT_RELATED}` : "Reset"}
      resetTitle={topFive ? `Show the ${DEFAULT_RELATED} most related diseases` : "Back to the filter this search opened at"}
      defaultValue={startThreshold}
      orientation={orientation}
    />
  );
  const chips = (className: string) => (
    <KindChips
      counts={kinds}
      hidden={hidden}
      onToggle={(kind) => setHidden((prev) => toggleKind(prev, kind))}
      onOnly={(kind) => setHidden(onlyKind(kind))}
      onShowAll={showAllTypes}
      links={
        mode === "researcher"
          ? {
              hidden: hiddenLinks,
              onToggle: (group) => setHiddenLinks((prev) => toggled(prev, group)),
              onShowAll: () => setHiddenLinks(new Set()),
            }
          : undefined
      }
      className={className}
    />
  );

  // The relevance slider on wide screens: a slim strip floating at the map card's right edge.
  const slider = focusId ? (
    <aside aria-label="Relevance filter" className="h-full rounded-xl border border-line bg-surface/92 shadow-sm backdrop-blur-sm">
      {bar("vertical")}
    </aside>
  ) : null;

  const diseaseCount = model.index.diseases.length;
  const banner = sample
    ? `Sample data: ${diseaseCount} ${diseaseCount === 1 ? "rare disease" : "rare diseases"} from the team seed. ${
        model.relevance.meta.method === "agent-judged"
          ? "Grades come from the deterministic engine, checked by the AI review layer, which can only lower a grade."
          : "Grades come from the deterministic engine; the AI review layer is not connected yet."
      }`
    : null;

  // The facts line under the start card, counted from the data: "93 diseases · 52 genes · …".
  const facts = useMemo(() => {
    const count = (type: NodeType) => graph.nodes.filter((n) => n.type === type).length;
    const sources = new Set(graph.edges.map((e) => e.source)).size;
    const parts = (["Disease", "Gene", "Mechanism", "Phenotype"] as NodeType[]).map((t) => `${count(t).toLocaleString("en")} ${TYPE_NAME[t].many}`);
    return [...parts, `${sources} public ${sources === 1 ? "source" : "sources"}`];
  }, [graph]);

  // On wide screens the start card floats over the universe, which keeps clear of it: measure where
  // it sits inside the map. The last place is kept while something is centered, so a disease flies
  // from the dot that was clicked.
  const cardRef = useRef<HTMLDivElement>(null);
  const mapAreaRef = useRef<HTMLDivElement>(null);
  const [avoid, setAvoid] = useState<Box | null>(null);
  // The start card floats over the map, in 3D too: the 3D sky fits below it (Graph3D insetTop).
  const cardOverMap = !focusId && !list && wide;
  useLayoutEffect(() => {
    if (focusId || list) return;
    const card = cardRef.current;
    const area = mapAreaRef.current;
    if (!card || !area) return;
    const measure = () => {
      if (!window.matchMedia("(min-width: 1024px)").matches) return setAvoid(null);
      const c = card.getBoundingClientRect();
      const a = area.getBoundingClientRect();
      const next: Box = [c.left - a.left, c.top - a.top, c.right - a.left, c.bottom - a.top].map(Math.round) as Box;
      setAvoid((prev) => (prev && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(area);
    return () => observer.disconnect();
  }, [focusId, list, wide]);

  const focusName = focusNode ? sentenceLabel(focusNode.label) : "";
  const notice = !list && focusId ? mapNotice({ model, hood, filtered, threshold, hidden, onThreshold: setThreshold, onShowAllTypes: showAllTypes }) : null;
  const map = list ? (
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
  ) : (
    <KnowledgeGraph
      graph={graph}
      relevance={relevance}
      focusId={focusId}
      selectedId={selected}
      threshold={threshold}
      thresholds={thresholds}
      hiddenTypes={hidden}
      hiddenLinks={linksOff}
      expanded={expanded}
      mode={mode}
      onFocus={focusOn}
      onSelect={select}
      onToggleBubble={toggleBubble}
      avoid={cardOverMap ? avoid : null}
      legend={<MapLegend />}
      side={slider}
    />
  );

  // 3D view: the same neighborhood, filters and selection as the map, drawn in 3D; before a search,
  // every disease as a constellation. A click selects (on the start screen it centers the disease);
  // a double-click centers.
  const scene3d = useMemo(() => {
    if (view !== "3d" || list) return null;
    return hood && filtered ? neighborhoodScene(model, hood, filtered, threshold, selected, mode) : constellationScene(model);
  }, [view, list, hood, filtered, model, threshold, selected, mode]);
  const map3d = scene3d && (
    <Graph3D
      nodes={scene3d.nodes}
      links={scene3d.links}
      focusId={focusId ?? ""}
      selectedId={selected}
      layout={focusId ? "disc" : "cloud"}
      rings={scene3d.rings}
      sectors={scene3d.sectors}
      onSelect={(id) => {
        if (!focusId) focusOn(id);
        else if (id.startsWith("bubble:")) toggleBubble(id);
        else select(id);
      }}
      onFocus={(id) => !id.startsWith("bubble:") && focusOn(id)}
      ariaLabel={focusNode ? `3D knowledge graph centered on ${focusName}` : "Every disease in RareVerse, in 3D"}
      caption={
        focusNode
          ? "Drag to rotate, scroll to zoom. Height shows the kind of thing; distance from the center is relevance."
          : "Drag to rotate, scroll to zoom. Diseases that share more biology sit closer together; click one to center it."
      }
      legend={<MapLegend />}
      insetTop={cardOverMap && avoid ? avoid[3] + 12 : 0}
    />
  );

  const startCard = (
    <div
      ref={cardRef}
      className="pointer-events-auto w-full max-w-[36rem] rounded-2xl border border-line bg-surface/92 p-5 text-center shadow-[0_12px_40px_rgb(0_0_0/0.10)] backdrop-blur-md sm:px-7 sm:pt-6 sm:pb-5"
    >
      <p className="text-[0.6875rem] font-semibold tracking-[0.14em] text-accent-ink uppercase">RareVerse</p>
      <h2 className="mt-1.5 text-[1.375rem] leading-tight font-semibold tracking-tight text-balance sm:text-[1.75rem]">Find the rare diseases that share your biology</h2>
      {staleLink && (
        <p role="status" className="mx-auto mt-3 max-w-md rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink text-pretty">
          The item in that link isn’t in RareVerse. Search for it, or start from one of the examples below.
        </p>
      )}
      <p className="mx-auto mt-2 max-w-md text-[0.9375rem] text-ink-2 text-pretty">
        Search a disease, gene or symptom to see which diseases share its biology, and where every link comes from.
      </p>
      <SearchBox
        search={search}
        suggest={suggest}
        didYouMean={didYouMean}
        onPick={pick}
        examples={hintNames}
        examplesByScope={hintsByScope}
        autoFocus
        className="mx-auto mt-4 w-full text-left"
      />
      {examples.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[0.8125rem]">
          <span className="text-ink-2">Try</span>
          {examples.map((ex) => {
            // "GBA1 gene", "Visual impairment symptom", but not "Tay-Sachs disease disease".
            const kind = TYPE_WORD[ex.type].toLowerCase();
            return (
              <button
                key={ex.id}
                type="button"
                onClick={() => focusOn(ex.id)}
                className="inline-flex max-w-full items-baseline gap-1 rounded-full border border-line bg-surface px-3 py-1 text-left text-ink hover:border-ink-3 hover:bg-surface-2"
              >
                <span className="min-w-0">{sentenceLabel(ex.label)}</span>
                {!ex.label.toLowerCase().endsWith(kind) && <span className="shrink-0 text-ink-2">{kind}</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-2 tabular-nums">{facts.join(" · ")}</p>
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
      {/* One row from 1024px: brand | search | Map/List, persona, copy link. Below that the search
          takes a second row, and phones keep Map/List above the map. */}
      <header className="relative z-30 border-b border-line bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 py-2 [grid-template-areas:'brand_controls''search_search'] sm:gap-x-3 sm:px-4 lg:h-14 lg:grid-cols-[minmax(max-content,1fr)_minmax(0,34rem)_minmax(max-content,1fr)] lg:gap-x-6 lg:px-5 lg:py-0 lg:[grid-template-areas:'brand_search_controls']">
          <h1 className="min-w-0 justify-self-start [grid-area:brand]">
            <button type="button" onClick={startOver} title="Start a new search" className="flex h-9 items-center rounded-lg pr-1 text-left">
              <Wordmark tagline />
            </button>
          </h1>
          {focusId && (
            <SearchBox
              search={search}
              suggest={suggest}
              didYouMean={didYouMean}
              onPick={pick}
              examples={hintNames}
              examplesByScope={hintsByScope}
              variant="header"
              className="w-full [grid-area:search]"
            />
          )}
          <div className="flex items-center gap-2 justify-self-end [grid-area:controls] sm:gap-2.5">
            {/* Phones keep the view switch above the map, so the header fits on one line. */}
            <div className="hidden sm:block">
              <ViewToggle value={display} onChange={changeDisplay} />
            </div>
            <Segmented<Mode>
              label="Explanations written for"
              title="Caregiver: plain words. Researcher: adds the scores and ids behind each link."
              options={PERSONAS}
              value={mode}
              onChange={setMode}
            />
            <CopyLink />
          </div>
        </div>
        {(banner || notes.length > 0) && (
          <div className="border-t border-line bg-surface-2 px-4 py-1.5 text-xs text-ink-2 lg:px-5">
            {banner && <p className="text-pretty">{banner}</p>}
            {notes.map((n) => (
              <p key={n.text} className="font-medium text-pretty text-ink">
                {n.text}
              </p>
            ))}
          </div>
        )}
      </header>

      <div
        className={`grid min-h-0 flex-1 grid-cols-1 ${
          panelOpen ? "sm:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_420px] 2xl:grid-cols-[minmax(0,1fr)_440px]" : ""
        }`}
      >
        <main className="relative flex min-w-0 flex-col gap-3 px-3 pt-3 pb-4 sm:min-h-0 sm:overflow-y-auto sm:px-4 lg:gap-0 lg:overflow-hidden lg:bg-surface lg:p-0">
          {/* One search card: above the universe on small screens, floating over it on wide ones. */}
          {!focusId && (
            <div className={`flex justify-center ${cardOverMap ? "lg:pointer-events-none lg:absolute lg:inset-x-0 lg:top-0 lg:z-10 lg:px-6 lg:pt-6" : "lg:px-5 lg:pt-5"}`}>
              <div className="flex w-full justify-center">{startCard}</div>
            </div>
          )}

          {/* Fold or unfold the side panel (tablets and desktops; phones keep it under the map). */}
          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
            aria-controls="atlas-panel"
            aria-label={panelOpen ? "Hide the side panel" : "Show the side panel"}
            title={panelOpen ? "Hide the side panel" : "Show the side panel"}
            className="absolute top-2.5 right-3 z-30 hidden size-9 place-items-center rounded-full border border-line bg-surface text-ink-2 shadow-sm hover:text-ink sm:grid"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
              <path d="M12.5 3.5v13" />
              <path d={panelOpen ? "M6.5 8l2 2-2 2" : "M8.5 8l-2 2 2 2"} />
            </svg>
          </button>

          <div className="flex justify-center sm:hidden">
            <ViewToggle value={display} onChange={changeDisplay} />
          </div>

          {/* The map card's toolbar: one chip per kind (and, for researchers, the Links menu). */}
          {focusId && chips("lg:border-b lg:border-line lg:py-2.5 lg:pr-16 lg:pl-4")}

          <section
            ref={mapRef}
            aria-label={focusNode ? (list ? `Everything linked to ${focusName}, as a list` : `Knowledge graph centered on ${focusName}`) : "Every disease in RareVerse"}
            className={`relative flex w-full scroll-mt-3 overflow-hidden rounded-xl border border-line lg:min-h-0 lg:flex-1 lg:rounded-none lg:border-0 ${
              focusId ? "bg-surface" : "universe-bg"
            } ${list ? "min-h-[420px] lg:min-h-0" : "aspect-square min-h-[340px] sm:aspect-[7/5] sm:min-h-0 lg:aspect-auto"}`}
          >
            <div ref={mapAreaRef} className="relative min-w-0 flex-1">
              {/* 3D view: replaces the map when picked; the slider floats at its right edge, beside it. */}
              {map3d ? (
                <>
                  <div className={`h-full w-full ${slider ? "lg:pr-[5.75rem]" : ""}`}>{map3d}</div>
                  {slider && <div className="absolute top-3 right-3 bottom-12 z-[5] hidden w-[4.75rem] lg:block">{slider}</div>}
                </>
              ) : (
                map
              )}
              {focusId && !list && expanded.size > 0 && (
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
              {/* Wide screens: the notice sits at the top of the map, clear of the legend and zoom corners. */}
              {noticeBox("absolute inset-x-0 top-3 mx-auto hidden w-fit max-w-[80%] sm:block")}
            </div>
          </section>

          {/* Phones: under the map, so it never covers it. */}
          {noticeBox("sm:hidden")}

          {/* Below 1024px the slider lies under the map, with the legend. */}
          {focusId && <div className="rounded-xl border border-line bg-surface p-3 lg:hidden">{bar("horizontal")}</div>}
          {focusId && !list && (
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5 lg:hidden">
              <MapLegend variant="panel" />
            </div>
          )}
        </main>

        <aside
          ref={panelRef}
          id="atlas-panel"
          aria-label={focusId ? "Details" : "About RareVerse"}
          className={`${panelOpen ? "" : "sm:hidden"} panel-scroll scroll-mt-2 rounded-t-2xl border-t border-line bg-surface px-4 pt-2 pb-8 shadow-[0_-10px_30px_rgb(0_0_0/0.06)] sm:rounded-none sm:border-t-0 sm:border-l sm:pt-5 sm:shadow-none lg:px-6`}
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
            <ClusterPanel rows={clusters} edges={graph.edges} onPick={pickCluster} mode={mode} onMode={setMode} />
          )}
        </aside>
      </div>
    </div>
  );
}
