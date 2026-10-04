"use client";

// Renders a section's blocks from the document: cited sentences, caveat notes, linked items, rows of
// related diseases and bullet lists. Nothing here numbers a citation; the document already has.
import { useState } from "react";
import EvidenceBadge from "../EvidenceBadge";
import { formatPercent } from "../format";
import DiseaseRows, { ClinicalBadge, TierBadge } from "../NeighborList";
import { Cites } from "./Cite";
import type { Block, Claim, ItemVM, RowVM } from "./viewModel";
import { ExternalLink } from "./ui";

export function ClaimText({ claim, className = "text-sm text-ink" }: { claim: Claim; className?: string }) {
  return (
    <p className={`text-pretty ${className}`}>
      {claim.text}
      <Cites ns={claim.cites} />
    </p>
  );
}

function More({ total, shown, what, onClick }: { total: number; shown: number; what: string; onClick(): void }) {
  if (total <= shown) return null;
  return (
    <button type="button" onClick={onClick} className="mt-1 text-[0.8125rem] font-medium text-accent-ink hover:underline">
      Show all {total} {what}
    </button>
  );
}

function Items({ block }: { block: Extract<Block, { kind: "items" }> }) {
  const [all, setAll] = useState(false);
  const shown = all ? block.items : block.items.slice(0, block.limit);
  if (!block.items.length && !block.empty) return null;
  return (
    <div>
      {block.heading && (
        <h4 className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">
          <span>
            {block.heading}
            {block.items.length > 0 && block.cites && (
              <span className="tracking-normal normal-case">
                <Cites ns={block.cites} />
              </span>
            )}
          </span>
          {block.items.length > 0 && <EvidenceBadge badge={block.badge ?? null} className="tracking-normal normal-case" />}
        </h4>
      )}
      {!block.heading && block.items.length > 0 && block.cites && (
        <p className="mb-1 text-xs text-ink-2">
          Source
          <Cites ns={block.cites} />
        </p>
      )}
      {block.items.length ? (
        <ul role="list" className="space-y-1.5">
          {shown.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        block.empty && <ClaimText claim={block.empty} className="text-sm text-ink-2" />
      )}
      {!all && <More total={block.items.length} shown={block.limit} what={block.what} onClick={() => setAll(true)} />}
    </div>
  );
}

function ItemRow({ item }: { item: ItemVM }) {
  return (
    <li className="text-sm leading-snug">
      {item.url ? (
        <ExternalLink href={item.url} className="text-ink hover:underline">
          {item.label}
        </ExternalLink>
      ) : (
        <span>{item.label}</span>
      )}
      <Cites ns={item.cites} />
      {(item.note || item.small) && (
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-2">
          {item.note && <span>{item.note}</span>}
          {item.small && <span className="text-[0.6875rem] tabular-nums">{item.small}</span>}
        </span>
      )}
    </li>
  );
}

function Rows({ block, selectedId, onRow }: { block: Extract<Block, { kind: "rows" }>; selectedId: string | null; onRow(row: RowVM, action: "select" | "focus"): void }) {
  const [all, setAll] = useState(false);
  const shown = all ? block.rows : block.rows.slice(0, block.limit);
  return (
    <>
      <DiseaseRows
        rows={shown.map((r) => {
          // A direct link's reason already says how it is linked, so a label would only repeat it.
          const label = r.value >= 1 ? (r.reason ? null : "Direct link") : r.value > 0 ? `${formatPercent(r.value)} relevant` : null;
          return {
            id: r.id,
            short: r.name,
            full: r.name,
            color: r.color,
            meter: r.tier ? r.value : r.clinicalTier ? r.value : undefined,
            badge: r.tier ? (
              <TierBadge tier={r.tier} value={r.value} />
            ) : r.clinicalTier ? (
              <ClinicalBadge tier={r.clinicalTier} value={r.value} />
            ) : label ? (
              <span className="text-xs text-ink-2 tabular-nums">{label}</span>
            ) : null,
            reason:
              r.reason || r.small ? (
                <>
                  {r.reason && <ClaimText claim={r.reason} className="text-xs text-ink-2" />}
                  {r.small && <p className="mt-0.5 font-mono text-[0.6875rem] text-ink-2">{r.small}</p>}
                </>
              ) : null,
          };
        })}
        selectedId={selectedId}
        onSelect={(id) => {
          const row = block.rows.find((r) => r.id === id);
          if (row) onRow(row, block.action);
        }}
        empty={block.empty ? <ClaimText claim={block.empty} className="text-sm text-ink-2" /> : undefined}
      />
      {!all && <More total={block.rows.length} shown={block.limit} what={block.what} onClick={() => setAll(true)} />}
    </>
  );
}

export default function Blocks({ blocks, selectedId, onRow }: { blocks: Block[]; selectedId: string | null; onRow(row: RowVM, action: "select" | "focus"): void }) {
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "claims":
            return (
              <div key={i} className="space-y-2">
                {block.claims.map((c, j) => (
                  <ClaimText key={j} claim={c} />
                ))}
              </div>
            );
          case "note":
            return (
              <p key={i} className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-2 text-pretty">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="mt-px shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>{block.text}</span>
              </p>
            );
          case "items":
            return <Items key={i} block={block} />;
          case "rows":
            return <Rows key={i} block={block} selectedId={selectedId} onRow={onRow} />;
          case "bullets":
            return (
              <ul key={i} role="list" className="space-y-2">
                {block.items.map((c, j) => (
                  <li key={j} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-[0.5rem] size-1.5 shrink-0 rounded-full bg-ink-3" />
                    <ClaimText claim={c} />
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
