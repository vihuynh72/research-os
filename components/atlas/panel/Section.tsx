"use client";

// A collapsible panel section: a 13 px title with a count, folded or open. The document decides
// which start open (the first two with content); phones fold all but the first.
import { useState, type ReactNode } from "react";
import { usePhone } from "./ui";

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" className={`shrink-0 text-ink-2 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}>
      <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Section({
  id,
  title,
  count,
  hint,
  defaultOpen,
  first = false,
  open: controlled,
  onOpenChange,
  children,
}: {
  id: string;
  title: string;
  count?: string;
  hint?: string;
  defaultOpen: boolean;
  first?: boolean;
  open?: boolean | null; // controlled from outside (Sources); null keeps the default
  onOpenChange?(open: boolean): void;
  children: ReactNode;
}) {
  const phone = usePhone();
  const [own, setOwn] = useState<boolean | null>(null);
  const chosen = controlled !== undefined && controlled !== null ? controlled : own;
  const open = chosen ?? (defaultOpen && (!phone || first));
  const toggle = () => {
    setOwn(!open);
    onOpenChange?.(!open);
  };
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-2 border-t border-line">
      <h3 id={`${id}-title`} className="text-[0.8125rem] font-semibold text-ink">
        <button type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle} className="flex min-h-11 w-full items-center gap-2 py-2 text-left hover:text-accent-ink">
          <Chevron open={open} />
          <span className="min-w-0 flex-1 text-pretty">{title}</span>
          {count !== undefined && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2 tabular-nums">{count}</span>}
        </button>
      </h3>
      <div id={`${id}-body`} hidden={!open} className="pb-4">
        {hint && <p className="mb-2 text-xs text-ink-2 text-pretty">{hint}</p>}
        {children}
      </div>
    </section>
  );
}
