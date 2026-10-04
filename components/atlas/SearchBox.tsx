"use client";

// One search for everything: a WAI-ARIA combobox over diseases, genes, symptoms, groups and
// research, with icon chips to narrow it to one kind ("only symptoms"). Picking a result puts it
// in the center of the map.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SearchHit } from "@/lib/graph/index";
import type { NodeType } from "@/lib/graph/types";
import { countLabel } from "@/lib/graph/vocab";
import { ICON_PATH } from "@/lib/viz/icons";
import { TYPE_WORD } from "./format";
import { KIND_STYLE } from "./kinds";
import { SEARCH_SCOPES, type ScopeId, type SearchScope } from "./searchScopes";

// Longest first: the box shows the longest hint that fits, so a phone never shows a hint cut
// off mid-word. The examples come from the data, so the hint never names something the atlas
// does not have. The server renders the first one.
function placeholdersFor(scope: SearchScope, examples: string[]): string[] {
  return [
    examples.length >= 2 ? `${scope.hint}, e.g. "${examples[0]}" or "${examples[1]}"` : "",
    examples.length >= 1 ? `${scope.hint}, e.g. "${examples[0]}"` : "",
    scope.hint,
    scope.id === "all" ? "Search the atlas" : `Search ${scope.label.toLowerCase()}`,
  ].filter(Boolean);
}

interface Props {
  // types narrows the search; a caller that ignores it still works, the box filters what comes back.
  search(query: string, types?: readonly NodeType[]): SearchHit[];
  suggest?(types: readonly NodeType[]): SearchHit[]; // what to list for a chosen kind before typing
  onPick(hit: SearchHit): void;
  examples?: string[]; // names to suggest in the "All" placeholder, from the data
  examplesByScope?: Partial<Record<ScopeId, string[]>>;
  scopes?: readonly SearchScope[] | false; // false hides the chips
  autoFocus?: boolean; // on devices with a mouse or trackpad only, so phones do not pop the keyboard
  className?: string;
}

export default function SearchBox({
  search,
  suggest,
  onPick,
  examples = [],
  examplesByScope = {},
  scopes = SEARCH_SCOPES,
  autoFocus = false,
  className = "",
}: Props) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  const [scopeId, setScopeId] = useState<ScopeId>("all");
  const scopeList = scopes === false ? [] : scopes;
  const scope = scopeList.find((s) => s.id === scopeId) ?? SEARCH_SCOPES[0];
  const scopeExamples = scope.id === "all" ? examples : (examplesByScope[scope.id] ?? []);
  // A string key, so a new examples array with the same names does not refit the placeholder.
  const exampleKey = scopeExamples.join("\n");
  const placeholders = useMemo(() => placeholdersFor(scope, exampleKey ? exampleKey.split("\n") : []), [scope, exampleKey]);
  const [placeholder, setPlaceholder] = useState(placeholders[0]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!input || !context) return;
    const fit = () => {
      const style = getComputedStyle(input);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 4;
      setPlaceholder(placeholders.find((text) => context.measureText(text).width <= room) ?? placeholders[placeholders.length - 1]);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(input);
    return () => observer.disconnect();
  }, [placeholders]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const trimmed = query.trim();
  const types = scope.types;
  const hits = useMemo(() => {
    if (trimmed) {
      const found = search(trimmed, types.length ? types : undefined);
      return types.length ? found.filter((hit) => types.includes(hit.node.type)) : found;
    }
    // A chosen kind with nothing typed yet lists what ties the atlas together.
    return types.length && suggest ? suggest(types) : [];
  }, [trimmed, search, suggest, types]);
  const browsing = !trimmed && hits.length > 0;
  const expanded = open && hits.length > 0;

  // Announce the result count once typing pauses, not on every keystroke.
  useEffect(() => {
    if (!open || !trimmed) return;
    const timer = setTimeout(() => {
      setAnnouncement(hits.length ? `${hits.length} ${hits.length === 1 ? "suggestion" : "suggestions"}` : "No matches");
    }, 450);
    return () => clearTimeout(timer);
  }, [hits.length, open, trimmed]);

  const pick = (hit: SearchHit) => {
    onPick(hit);
    setQuery("");
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
  };

  const choose = (next: ScopeId) => {
    setScopeId(next);
    setActive(-1);
    setOpen(true);
    inputRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        if (hits.length) setActive((i) => (i + 1) % hits.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setOpen(true);
        if (hits.length) setActive((i) => (i <= 0 ? hits.length - 1 : i - 1));
        break;
      case "Enter":
        if (open && hits.length) {
          event.preventDefault();
          pick(hits[active >= 0 ? active : 0]);
        }
        break;
      case "Escape":
        if (open && (trimmed || browsing)) {
          event.preventDefault();
          setOpen(false);
          setActive(-1);
        } else if (query) {
          event.preventDefault();
          setQuery("");
        }
        break;
    }
  };

  // Arrow keys move between chips, as in any radio group.
  const onChipKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = scopeList[(index + step + scopeList.length) % scopeList.length];
    setScopeId(next.id);
    (event.currentTarget.parentElement?.children[(index + step + scopeList.length) % scopeList.length] as HTMLElement | undefined)?.focus();
  };

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={inputId} className="visually-hidden">
        Search the atlas
      </label>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-5 left-3 size-4 -translate-y-1/2 text-ink-2"
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
        aria-describedby={scopeList.length ? `${id}-scope` : undefined}
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
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-10 w-full rounded-full border border-line bg-surface-2 pr-4 pl-9 text-[0.9375rem] text-ellipsis text-ink placeholder:text-ink-2 focus:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
      />

      {scopeList.length > 0 && (
        <div
          id={`${id}-scope`}
          role="radiogroup"
          aria-label="Search in"
          className="mt-2 flex flex-wrap gap-1.5"
        >
          {scopeList.map((s, i) => {
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
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(s.id)}
                onKeyDown={(event) => onChipKey(event, i)}
                className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${on ? "border-transparent font-medium" : "border-line bg-surface text-ink-2 hover:border-ink-3 hover:text-ink"}`}
                style={on ? { background: fill, color: ink } : undefined}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={s.icon} />
                </svg>
                {s.label}
              </button>
            );
          })}
        </div>
      )}

      <ul
        id={listId}
        role="listbox"
        aria-label={browsing ? `${scope.label} in this atlas` : "Suggestions"}
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(24rem,60dvh)] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[0_12px_32px_rgb(0_0_0/0.16)]"
      >
        {browsing && (
          <li role="presentation" className="px-2.5 pt-1.5 pb-1 text-[11px] uppercase tracking-wide text-ink-2">
            {scope.label} linked to the most diseases
          </li>
        )}
        {hits.map((hit, i) => {
          const isDisease = hit.node.type === "Disease";
          const synonym = hit.matched !== hit.node.label ? hit.matched : null;
          return (
            <li
              key={hit.node.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick(hit)}
              onPointerMove={() => setActive(i)}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 aria-selected:bg-surface-2"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-5 shrink-0 text-ink-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={ICON_PATH[hit.node.type]} />
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{hit.node.label}</span>
                {synonym && <span className="block truncate text-xs text-ink-2">matches “{synonym}”</span>}
              </span>
              <span className="shrink-0 text-right text-xs text-ink-2">
                {TYPE_WORD[hit.node.type]}
                {!isDisease && <span className="block">→ {countLabel("Disease", hit.diseases.length)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {open && trimmed && !hits.length && (
        <div className="absolute inset-x-0 top-full z-30 mt-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink-2 shadow-[0_12px_32px_rgb(0_0_0/0.16)]">
          {scope.id === "all" ? (
            <>
              Nothing in this atlas matches “{trimmed}”. Try a disease name, a gene{examples[1] ? ` such as ${examples[1]}` : ""}, or a symptom.
            </>
          ) : (
            <>
              No {scope.label.toLowerCase()} match “{trimmed}”.{" "}
              <button type="button" className="text-accent-ink underline" onPointerDown={(event) => event.preventDefault()} onClick={() => choose("all")}>
                Search everything
              </button>
            </>
          )}
        </div>
      )}
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>
    </div>
  );
}
