"use client";

// The filter toolbar at the top of the map: one chip per kind with shown / total at the current
// filter. Click hides or shows a kind; double-click or Alt/Option-click shows only that kind; "Show
// all" appears once anything is hidden. The researcher view adds a Links menu that hides kinds of
// line (and whatever only those lines held).
import { useEffect, useRef, useState } from "react";
import type { LinkGroup } from "@/lib/graph/neighborhood";
import { LINK_GROUPS } from "@/lib/graph/neighborhood";
import type { NodeType } from "@/lib/graph/types";
import { kindHidden, type KindCount, type MapKindInfo } from "../kinds";
import KindIcon from "./KindIcon";

const LINK_WORD: Record<LinkGroup, string> = {
  biology: "Shared biology (disease to disease)",
  gene: "Disease to gene",
  pathway: "Gene to pathway",
  symptom: "Disease to symptom",
  group: "Patient groups",
  research: "Research",
  bridge: "Working together",
};

interface Props {
  counts: KindCount[];
  hidden: ReadonlySet<NodeType>;
  onToggle(kind: MapKindInfo): void;
  onOnly(kind: MapKindInfo): void;
  onShowAll(): void;
  links?: { hidden: ReadonlySet<LinkGroup>; onToggle(group: LinkGroup): void; onShowAll(): void };
  className?: string;
}

export default function KindChips({ counts, hidden, onToggle, onOnly, onShowAll, links, className = "" }: Props) {
  const anyHidden = counts.some((c) => kindHidden(c.kind, hidden));
  return (
    <div role="toolbar" aria-label="Show on the map" className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {counts.map(({ kind, shown, total }) => {
        const off = kindHidden(kind, hidden);
        return (
          <button
            key={kind.id}
            type="button"
            aria-pressed={!off}
            onClick={(event) => (event.altKey ? onOnly(kind) : onToggle(kind))}
            onDoubleClick={() => onOnly(kind)}
            title={`${off ? "Show" : "Hide"} ${kind.label.toLowerCase()} · double-click or Alt-click to show only ${kind.label.toLowerCase()}`}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border pr-2.5 pl-1.5 text-[0.8125rem] whitespace-nowrap transition-colors max-sm:h-7 max-sm:gap-1 max-sm:pr-2 max-sm:pl-1 max-sm:text-xs ${
              off ? "border-dashed border-line text-ink-2 hover:border-ink-3" : "border-line bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-ink-3"
            }`}
          >
            <KindIcon kind={kind} size={18} off={off} />
            <span className={off ? "line-through decoration-ink-3" : "font-medium"}>{kind.label}</span>
            <span className="text-xs text-ink-2 tabular-nums">
              {shown}/{total}
            </span>
          </button>
        );
      })}
      {anyHidden && (
        <button type="button" onClick={onShowAll} className="inline-flex h-8 items-center rounded-full px-2.5 text-[0.8125rem] font-medium text-accent-ink hover:bg-surface-2">
          Show all
        </button>
      )}
      {links && <LinksMenu {...links} />}
    </div>
  );
}

function LinksMenu({ hidden, onToggle, onShowAll }: NonNullable<Props["links"]>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div
      ref={ref}
      className="relative ml-auto"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[0.8125rem] font-medium text-ink hover:border-ink-3"
      >
        Links
        {hidden.size > 0 && <span className="rounded-full bg-surface-2 px-1.5 text-xs text-ink-2 tabular-nums">{LINK_GROUPS.length - hidden.size}/{LINK_GROUPS.length}</span>}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div role="group" aria-label="Kinds of line on the map" className="absolute top-full right-0 z-30 mt-1.5 w-64 rounded-xl border border-line bg-surface p-2 shadow-[0_8px_30px_rgb(0_0_0/0.12)]">
          <p className="px-2 pt-1 pb-1.5 text-xs text-ink-2">Lines to show. What only a hidden line held leaves the map too.</p>
          {LINK_GROUPS.map((g) => (
            <label key={g} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] text-ink hover:bg-surface-2">
              <input type="checkbox" checked={!hidden.has(g)} onChange={() => onToggle(g)} className="size-3.5" />
              {LINK_WORD[g]}
            </label>
          ))}
          {hidden.size > 0 && (
            <button type="button" onClick={onShowAll} className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[0.8125rem] font-medium text-accent-ink hover:bg-surface-2">
              Show every line
            </button>
          )}
        </div>
      )}
    </div>
  );
}
