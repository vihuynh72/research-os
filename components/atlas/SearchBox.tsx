"use client";

// One search for everything: a WAI-ARIA combobox over diseases, genes, symptoms, groups and
// research. Picking a result puts it in the center of the map.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SearchHit } from "@/lib/graph/index";
import { countLabel } from "@/lib/graph/vocab";
import { ICON_PATH } from "@/lib/viz/icons";
import { TYPE_WORD } from "./format";

// Longest first: the box shows the longest hint that fits, so a phone never shows a hint cut
// off mid-word. The examples come from the data, so the hint never names something the atlas
// does not have. The server renders the first one.
function placeholdersFor(examples: string[]): string[] {
  return [
    examples.length >= 2 ? `Search a disease, gene or symptom, e.g. "${examples[0]}" or "${examples[1]}"` : "",
    examples.length >= 1 ? `Search a disease, gene or symptom, e.g. "${examples[0]}"` : "",
    "Search a disease, gene or symptom",
    "Search the atlas",
  ].filter(Boolean);
}

interface Props {
  search(query: string): SearchHit[];
  onPick(hit: SearchHit): void;
  examples?: string[]; // names to suggest in the placeholder, e.g. ["CLN3", "MFSD8"]
  autoFocus?: boolean; // on devices with a mouse or trackpad only, so phones do not pop the keyboard
  className?: string;
}

export default function SearchBox({ search, onPick, examples = [], autoFocus = false, className = "" }: Props) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  const exampleKey = examples.join("\n");
  const placeholders = useMemo(() => placeholdersFor(exampleKey ? exampleKey.split("\n") : []), [exampleKey]);
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
  const hits = useMemo(() => (trimmed ? search(trimmed) : []), [trimmed, search]);
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
        if (open && trimmed) {
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

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={inputId} className="visually-hidden">
        Search the atlas
      </label>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-2"
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
      <ul
        id={listId}
        role="listbox"
        aria-label="Suggestions"
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(24rem,60dvh)] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[0_12px_32px_rgb(0_0_0/0.16)]"
      >
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
          Nothing in this atlas matches “{trimmed}”. Try a disease name, a gene{examples[1] ? ` such as ${examples[1]}` : ""}, or a symptom.
        </div>
      )}
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>
    </div>
  );
}
