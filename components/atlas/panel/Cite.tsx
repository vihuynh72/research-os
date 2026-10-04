"use client";

// A citation chip, "[3]": its accessible name says which source it is; hovering or focusing it shows
// a small card with the record (source, the claim, how it is known, its date, a link), and clicking
// it scrolls to the numbered entry in Sources and flashes it.
import { useId, useRef, useState } from "react";
import EvidenceBadge from "../EvidenceBadge";
import { sourceId, useCitations } from "./CitationContext";
import { ExternalLink } from "./ui";

const CARD = 272; // px

export function Cite({ n }: { n: number }) {
  const { records, reveal } = useCitations();
  const record = records[n - 1];
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ left: 0, width: CARD, above: false });
  const wrap = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const cardId = useId();
  if (!record) return null;

  // Keep the card inside the panel: shift it left near the right edge, flip it up near the bottom.
  const show = () => {
    window.clearTimeout(timer.current);
    const el = wrap.current;
    if (el) {
      const at = el.getBoundingClientRect();
      const host = el.closest("aside")?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth };
      const width = Math.min(CARD, host.right - host.left - 16);
      let left = 0;
      if (at.left + width > host.right - 8) left = host.right - 8 - width - at.left;
      if (at.left + left < host.left + 8) left = host.left + 8 - at.left;
      setPlace({ left, width, above: at.bottom + 200 > window.innerHeight && at.top > 220 });
    }
    setOpen(true);
  };
  const hide = (delay = 140) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), delay);
  };

  return (
    <span
      ref={wrap}
      className="relative inline-block"
      onMouseEnter={show}
      onMouseLeave={() => hide()}
      onFocus={show}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) hide(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <a
        href={`#${sourceId(n)}`}
        onClick={(e) => {
          e.preventDefault();
          setOpen(false);
          reveal(n);
        }}
        aria-label={`Source ${n}: ${record.source}`}
        aria-describedby={open ? cardId : undefined}
        className="ml-0.5 rounded-sm px-px text-[0.6875rem] font-semibold whitespace-nowrap text-accent-ink tabular-nums hover:underline"
      >
        [{n}]
      </a>
      {open && (
        <span
          id={cardId}
          className={`absolute z-40 block ${place.above ? "bottom-full pb-1.5" : "top-full pt-1.5"}`}
          style={{ left: place.left, width: place.width }}
        >
          <span className="block rounded-xl border border-line bg-surface p-3 text-left font-normal shadow-[0_10px_30px_rgb(0_0_0/0.14)]">
            <span className="block text-xs font-semibold text-ink">
              [{n}] {record.source}
            </span>
            <span className="mt-1 block text-[0.8125rem] leading-snug text-ink text-pretty">{record.claim}</span>
            <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <EvidenceBadge badge={record.badge} />
              {record.date && <span className="tabular-nums">{record.date}</span>}
              <ExternalLink href={record.url} className="font-medium text-accent-ink hover:underline">
                Open record
              </ExternalLink>
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

export function Cites({ ns }: { ns: readonly number[] }) {
  if (!ns.length) return null;
  return (
    <span className="whitespace-nowrap">
      {ns.map((n) => (
        <Cite key={n} n={n} />
      ))}
    </span>
  );
}
