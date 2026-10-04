"use client";

// One search for everything: a WAI-ARIA combobox over diseases, genes, symptoms, groups and
// research. Its dropdown opens on one compact row of chips that narrow it to one kind ("only
// symptoms"), on the start card and in the header alike, so neither grows a second row. Picking a
// result puts it in the center of the map. The search forgives typos, plurals and other names
// (lib/graph/index.ts); when it still finds nothing, the box offers close names and other ways in,
// never a bare "nothing matches".
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { SearchHit } from "@/lib/graph/index";
import type { GraphNode, NodeType } from "@/lib/graph/types";
import { countLabel } from "@/lib/graph/vocab";
import { ICON_PATH } from "@/lib/viz/icons";
import { TYPE_WORD } from "./format";
import { KIND_STYLE } from "./kinds";
import { SEARCH_SCOPES, type ScopeId, type SearchScope } from "./searchScopes";

const NEAR_LIMIT = 3;
const CHIP_FADE = 28; // px of fade at a side of the chip row that hides chips

// Other ways in when nothing matches, offered only when the data has them.
const TRY: readonly { kind: string; name: string; types: readonly NodeType[] }[] = [
  { kind: "a gene", name: "GBA1", types: ["Gene"] },
  { kind: "a symptom", name: "Seizure", types: ["Phenotype"] },
];

// Longest first: the box shows the longest hint that fits, so a phone never shows a hint cut
// off mid-word. The examples come from the data, so the hint never names something RareVerse
// does not have. The server renders the first one.
function placeholdersFor(scope: SearchScope, examples: string[], header: boolean): string[] {
  // Something is already in the center: the header box searches for the next thing, no examples.
  if (header && scope.id === "all") return ["Search another disease, gene or symptom", "Search another", "Search"];
  return [
    examples.length >= 2 ? `${scope.hint}, e.g. “${examples[0]}” or “${examples[1]}”` : "",
    examples.length >= 1 ? `${scope.hint}, e.g. “${examples[0]}”` : "",
    scope.hint,
    scope.id === "all" ? "Search RareVerse" : `Search ${scope.label.toLowerCase()}`,
  ].filter(Boolean);
}

// Pressing a control in the dropdown keeps focus in the box, so the dropdown stays open.
const keepFocus = (event: PointerEvent) => event.preventDefault();

// "NIH RePORTER record 8593531": the source's own number for an item, from its id.
const recordName = (node: GraphNode) => `${node.source} record ${node.id.slice(node.id.indexOf(":") + 1)}`;

interface Props {
  // types narrows the search; a caller that ignores it still works, the box filters what comes back.
  search(query: string, types?: readonly NodeType[]): SearchHit[];
  // Close names for a query that finds nothing ("gaushur" -> Gaucher disease). Optional: without it
  // the box still offers other ways in.
  didYouMean?(query: string, types?: readonly NodeType[]): SearchHit[];
  suggest?(types: readonly NodeType[]): SearchHit[]; // what to list for a chosen kind before typing
  onPick(hit: SearchHit): void;
  examples?: string[]; // names to suggest in the "All" placeholder, from the data
  examplesByScope?: Partial<Record<ScopeId, string[]>>;
  variant?: "card" | "header";
  autoFocus?: boolean; // on devices with a mouse or trackpad only, so phones do not pop the keyboard
  className?: string;
}

export default function SearchBox({ search, didYouMean, suggest, onPick, examples = [], examplesByScope = {}, variant = "card", autoFocus = false, className = "" }: Props) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  // The focus the page gives the box on load opens nothing; a click, a key or typing does.
  const quietFocus = useRef(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  const [scopeId, setScopeId] = useState<ScopeId>("all");
  const header = variant === "header";
  const scope = SEARCH_SCOPES.find((s) => s.id === scopeId) ?? SEARCH_SCOPES[0];
  const scopeExamples = scope.id === "all" ? examples : (examplesByScope[scope.id] ?? []);
  // A string key, so a new examples array with the same names does not refit the placeholder.
  const exampleKey = scopeExamples.join("\n");
  const placeholders = useMemo(() => placeholdersFor(scope, exampleKey ? exampleKey.split("\n") : [], header), [scope, exampleKey, header]);
  const [placeholder, setPlaceholder] = useState(placeholders[0]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!input || !context) return;
    const fit = () => {
      const style = getComputedStyle(input);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      // A little slack: the canvas can measure the system font a few pixels narrower than the page draws it.
      const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16;
      setPlaceholder(placeholders.find((text) => context.measureText(text).width <= room) ?? placeholders[placeholders.length - 1]);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(input);
    return () => observer.disconnect();
  }, [placeholders]);

  useEffect(() => {
    if (!autoFocus || !window.matchMedia("(pointer: fine)").matches) return;
    quietFocus.current = true;
    inputRef.current?.focus({ preventScroll: true });
    quietFocus.current = false;
  }, [autoFocus]);

  const trimmed = query.trim();
  const types = scope.types;
  const hits = useMemo(() => {
    if (trimmed) {
      const found = search(trimmed, types.length ? types : undefined);
      return types.length ? found.filter((hit) => types.includes(hit.node.type)) : found;
    }
    // A chosen kind with nothing typed yet lists what ties RareVerse together.
    return types.length && suggest ? suggest(types) : [];
  }, [trimmed, search, suggest, types]);
  const noMatch = !!trimmed && !hits.length;
  // Nothing found: close names instead, of the chosen kind when there is one.
  const near = useMemo(() => {
    if (!noMatch || !didYouMean) return [];
    const found = didYouMean(trimmed, types.length ? types : undefined);
    return (types.length ? found.filter((hit) => types.includes(hit.node.type)) : found).slice(0, NEAR_LIMIT);
  }, [noMatch, didYouMean, trimmed, types]);
  // A gene and a symptom to try instead, checked against the data before they are offered.
  const tries = useMemo(() => {
    if (!noMatch || scope.id !== "all") return [];
    return TRY.flatMap((t) => {
      const hit = search(t.name, t.types).find((h) => h.node.label.toLowerCase() === t.name.toLowerCase());
      return hit ? [{ ...t, hit }] : [];
    });
  }, [noMatch, scope.id, search]);
  const options = hits.length ? hits : near;
  const browsing = !trimmed && hits.length > 0;
  const expanded = open && options.length > 0;

  // A phone scrolls the chip row. The sides that hide chips fade, so the row reads as scrollable
  // rather than cut, and the chosen kind always stays fully in view.
  const chipRow = useRef<HTMLDivElement>(null);
  const [hiddenChips, setHiddenChips] = useState({ start: false, end: false });
  const measureChips = useCallback(() => {
    const row = chipRow.current;
    if (!row) return;
    const start = row.scrollLeft > 1;
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setHiddenChips((was) => (was.start === start && was.end === end ? was : { start, end }));
  }, []);
  useLayoutEffect(() => {
    const row = chipRow.current;
    const chip = row?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!open || !row || !chip) return;
    // Clear of the fades too; the browser stops the scroll at either end of the row.
    const box = row.getBoundingClientRect();
    const own = chip.getBoundingClientRect();
    if (own.left < box.left + CHIP_FADE) row.scrollLeft -= box.left + CHIP_FADE - own.left;
    else if (own.right > box.right - CHIP_FADE) row.scrollLeft += own.right - (box.right - CHIP_FADE);
    measureChips();
    const observer = new ResizeObserver(measureChips);
    observer.observe(row);
    return () => observer.disconnect();
  }, [open, scopeId, measureChips]);
  const chipFades = [hiddenChips.start ? `transparent, #000 ${CHIP_FADE}px` : "#000", hiddenChips.end ? `#000 calc(100% - ${CHIP_FADE}px), transparent` : "#000"];
  const chipMask = hiddenChips.start || hiddenChips.end ? `linear-gradient(to right, ${chipFades.join(", ")})` : undefined;

  // Announce what the box offers once typing pauses, not on every keystroke.
  useEffect(() => {
    if (!open || !trimmed) return;
    const where = scope.id === "all" ? "" : ` in ${scope.label.toLowerCase()}`;
    const instead = tries.length ? ` Try ${tries.map((t) => `${t.kind}, ${t.name}`).join(", or ")}.` : "";
    const message = hits.length
      ? `${hits.length} ${hits.length === 1 ? "suggestion" : "suggestions"}`
      : near.length
        ? `No exact match${where}. ${near.length} close ${near.length === 1 ? "name" : "names"}.`
        : `No exact match${where}.${instead}`;
    const timer = setTimeout(() => setAnnouncement(message), 450);
    return () => clearTimeout(timer);
  }, [hits.length, near.length, open, trimmed, scope, tries]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const pick = (hit: SearchHit) => {
    onPick(hit);
    setQuery("");
    close();
    inputRef.current?.blur();
  };

  const choose = (next: ScopeId) => {
    setScopeId(next);
    setActive(-1);
    setOpen(true);
    inputRef.current?.focus({ preventScroll: true });
  };

  // The box stays open while focus moves between the input and its dropdown; leaving both closes it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        if (options.length) setActive((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setOpen(true);
        if (options.length) setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
        break;
      case "Enter":
        // A close name is only a guess, so Enter takes one only once it is highlighted.
        if (open && hits.length) {
          event.preventDefault();
          pick(hits[active >= 0 ? active : 0]);
        } else if (open && near.length && active >= 0) {
          event.preventDefault();
          pick(near[active]);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close();
        } else if (query) {
          event.preventDefault();
          setQuery("");
        }
        break;
    }
  };

  // Arrow keys move between chips, as in any radio group; Escape goes back to the box, closed.
  const onChipKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      inputRef.current?.focus({ preventScroll: true });
      close();
      return;
    }
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + SEARCH_SCOPES.length) % SEARCH_SCOPES.length;
    setScopeId(SEARCH_SCOPES[next].id);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  // Text-only pills in one row. A dropdown too narrow for all six (a phone) scrolls the row sideways
  // instead of spending a second row before the results. Phones get 40px taps. The row's padding
  // leaves room for the focus ring, which the scrolling row would otherwise clip.
  const chips = (
    <div
      ref={chipRow}
      id={`${id}-scope`}
      role="radiogroup"
      aria-label="Search in"
      onScroll={measureChips}
      style={chipMask ? { maskImage: chipMask, WebkitMaskImage: chipMask } : undefined}
      className="flex gap-1 overflow-x-auto p-1 pb-1.5 [scrollbar-width:none]"
    >
      {SEARCH_SCOPES.map((s, i) => {
        const on = s.id === scope.id;
        const style = s.kind ? KIND_STYLE[s.kind] : null;
        const fill = s.kind === "disease" ? "var(--series-1)" : (style?.fill ?? "var(--accent)");
        const ink = s.kind === "disease" || !style ? "#fff" : style.ink;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={s.hint}
            onPointerDown={keepFocus}
            onClick={() => choose(s.id)}
            onKeyDown={(event) => onChipKey(event, i)}
            className={`h-10 shrink-0 rounded-full border px-2.5 text-xs font-medium transition-colors sm:h-7 ${on ? "border-transparent" : "border-line bg-surface text-ink-2 hover:border-ink-3 hover:text-ink"}`}
            style={on ? { background: fill, color: ink } : undefined}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );

  const row = (hit: SearchHit, i: number) => {
    // Another name led here (an alias, a synonym, an id): say which, so the hit makes sense.
    const other = hit.matched !== hit.node.label ? hit.matched : null;
    // Two results with one title (a grant funded again under the same name) get their record
    // number, so they do not look like a repeated row.
    const twin = options.some((o) => o !== hit && o.node.label === hit.node.label);
    return (
      <li
        key={hit.node.id}
        id={`${id}-opt-${i}`}
        role="option"
        aria-selected={i === active}
        onPointerDown={keepFocus}
        onClick={() => pick(hit)}
        onPointerMove={() => setActive(i)}
        className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 aria-selected:bg-surface-2"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0 text-ink-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d={ICON_PATH[hit.node.type]} />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-sm break-words text-ink text-pretty">{hit.node.label}</span>
          {other && <span className="block text-xs break-words text-ink-2">matched: {other}</span>}
          {twin && <span className="block text-xs text-ink-2 tabular-nums">{recordName(hit.node)}</span>}
        </span>
        <span className="shrink-0 text-right text-xs text-ink-2">
          {TYPE_WORD[hit.node.type]}
          {hit.node.type !== "Disease" && <span className="block">→ {countLabel("Disease", hit.diseases.length)}</span>}
        </span>
      </li>
    );
  };

  const where = scope.id === "all" ? "" : ` in ${scope.label.toLowerCase()}`;
  const link = "rounded font-medium text-accent-ink underline-offset-2 hover:underline";

  return (
    <div className={`relative ${className}`} onBlur={onBlur}>
      <label htmlFor={inputId} className="visually-hidden">
        Search RareVerse
      </label>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`pointer-events-none absolute left-3 size-4 -translate-y-1/2 text-ink-2 ${header ? "top-[1.125rem]" : "top-5"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-describedby={`${id}-scope`}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          if (!quietFocus.current) setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`w-full rounded-full border border-line bg-surface-2 pr-4 pl-9 text-ellipsis text-ink placeholder:text-ink-2 focus:bg-surface focus-visible:outline-2 focus-visible:outline-accent ${header ? "h-9 text-sm" : "h-10 text-[0.9375rem]"}`}
      />

      <div
        hidden={!open}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) event.preventDefault();
        }}
        className="absolute inset-x-0 top-full z-30 mt-2 rounded-xl border border-line bg-surface p-1.5 text-left shadow-[0_12px_32px_rgb(0_0_0/0.16)]"
      >
        {chips}
        {noMatch && (
          <p className="border-t border-line px-2.5 pt-2.5 pb-1 text-sm break-words text-ink text-pretty">
            No exact match for “{trimmed}”{where}.{near.length > 0 && " Did you mean:"}
          </p>
        )}
        <ul
          id={listId}
          role="listbox"
          aria-label={browsing ? `${scope.label} in RareVerse` : near.length ? "Close names" : "Suggestions"}
          hidden={!expanded}
          className={`max-h-[min(24rem,60dvh)] overflow-y-auto ${noMatch ? "" : "border-t border-line pt-1"}`}
        >
          {browsing && (
            <li role="presentation" className="px-2.5 pt-1.5 pb-1 text-[11px] tracking-wide text-ink-2 uppercase">
              {scope.label} linked to the most diseases
            </li>
          )}
          {options.map(row)}
        </ul>
        {noMatch && (
          <p className={`px-2.5 pt-1.5 pb-1.5 text-[13px] text-ink-2 text-pretty ${near.length ? "mt-1 border-t border-line pt-2" : ""}`}>
            {scope.id !== "all" ? (
              <button type="button" className={link} onPointerDown={keepFocus} onClick={() => choose("all")}>
                Search everything instead
              </button>
            ) : tries.length ? (
              <>
                Try{" "}
                {tries.map((t, i) => (
                  <Fragment key={t.name}>
                    {i > 0 && " or "}
                    {t.kind} (
                    <button type="button" className={link} onPointerDown={keepFocus} onClick={() => pick(t.hit)}>
                      {t.name}
                    </button>
                    )
                  </Fragment>
                ))}
                .
              </>
            ) : (
              "Try another spelling, or a gene or symptom name."
            )}
          </p>
        )}
      </div>
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>
    </div>
  );
}
