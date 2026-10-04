"use client";

// Small pieces every panel view shares: links that open records, kind icons, buttons and the
// header type scale (eyebrow 12 px caps, title 20 px semibold).
import { useSyncExternalStore, type ReactNode } from "react";
import type { GraphNode, NodeType } from "@/lib/graph/types";
import { ICON_PATH } from "@/lib/viz/icons";
import { diseaseColor, type AtlasModel } from "../format";
import { KIND_OF, KIND_STYLE } from "../kinds";
import { Dot } from "../NeighborList";

export function ExternalLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span aria-hidden="true" className="ml-0.5 text-[0.85em] text-ink-2">
        ↗
      </span>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

// A node's id for the researcher view (MONDO:…, HGNC:…, HP:…), linking to its record.
export function NodeIdLink({ node }: { node: GraphNode }) {
  return (
    <a href={node.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[0.6875rem] break-all text-accent-ink hover:underline">
      {node.id}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export function TypeIcon({ type, className = "size-4" }: { type: NodeType; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATH[type]} />
    </svg>
  );
}

// The node's kind as on the map: a pale disk with its icon, or the cluster color for a disease.
export function KindIcon({ model, node }: { model: AtlasModel; node: GraphNode }) {
  if (node.type === "Disease") return <Dot color={diseaseColor(model, node.id)} size={12} />;
  const style = KIND_STYLE[KIND_OF[node.type]];
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full border" style={{ background: style.fill, borderColor: style.ink, color: style.ink }}>
      <TypeIcon type={node.type} className="size-3.5" />
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium tracking-wide text-ink-2 uppercase">{children}</p>;
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <h2 id="detail-title" className="text-xl leading-snug font-semibold text-balance text-ink">
      {children}
    </h2>
  );
}

export function BackButton({ name, onClick }: { name: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="text-[0.8125rem] font-medium text-accent-ink hover:underline">
      ‹ Back to {name}
    </button>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function PrimaryButton({ onClick, children, disabled, title }: { onClick?(): void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="min-h-9 rounded-full bg-accent px-4 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:brightness-100"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="min-h-9 rounded-full border border-line px-4 text-left text-sm font-medium text-ink hover:bg-surface-2">
      {children}
    </button>
  );
}

// Phones fold every panel section but the first, so the whole panel stays short.
const PHONE = "(max-width: 639px)";

export function usePhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(PHONE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}
