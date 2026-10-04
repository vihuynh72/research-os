"use client";

// The numbered records of one panel document, and how a citation chip reaches its entry: opening
// the Sources section (and its full list when needed), scrolling the entry into view, flashing it
// and moving focus there so keyboard users land on it too.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SourceRecord } from "./citations";

export const SOURCES_SHOWN = 8;
export const SOURCES_ID = "panel-sources";
export const sourceId = (n: number) => `panel-source-${n}`;

interface CitationApi {
  records: SourceRecord[];
  reveal(n: number): void; // scroll to one entry and flash it
  jump(): void; // scroll to the Sources section
  flashed: number | null;
  sourcesOpen: boolean | null; // null: the section's own default
  setSourcesOpen(open: boolean): void;
  showAll: boolean;
  setShowAll(all: boolean): void;
}

const Citations = createContext<CitationApi | null>(null);

export function useCitations(): CitationApi {
  const api = useContext(Citations);
  if (!api) throw new Error("useCitations outside CitationProvider");
  return api;
}

function scrollToId(id: string, focus: boolean) {
  // Twice a frame: once for React to open the section, once for the layout to settle.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: focus ? "center" : "start", behavior: reduce ? "auto" : "smooth" });
      if (focus) el.focus({ preventScroll: true });
    }),
  );
}

export function CitationProvider({ records, children }: { records: SourceRecord[]; children: ReactNode }) {
  const [sourcesOpen, setSourcesOpen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [flashed, setFlashed] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const reveal = useCallback((n: number) => {
    setSourcesOpen(true);
    if (n > SOURCES_SHOWN) setShowAll(true);
    setFlashed(n);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlashed(null), 1800);
    scrollToId(sourceId(n), true);
  }, []);
  const jump = useCallback(() => {
    setSourcesOpen(true);
    scrollToId(SOURCES_ID, false);
  }, []);

  const api = useMemo(() => ({ records, reveal, jump, flashed, sourcesOpen, setSourcesOpen, showAll, setShowAll }), [records, reveal, jump, flashed, sourcesOpen, showAll]);
  return <Citations.Provider value={api}>{children}</Citations.Provider>;
}
