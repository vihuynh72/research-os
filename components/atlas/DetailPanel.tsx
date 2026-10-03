"use client";

// Right column: the evidence. With nothing selected it describes the focus disease; with a
// neighbor selected it explains the pair. Every claim links to its source and says whether it
// is observed (stated by a curated source) or inferred (derived by the pipeline).
import { useState, type ReactNode } from "react";
import type { GraphEdge, GraphNode, NodeType } from "@/lib/graph/types";
import type { Dimension, DimensionResult, DimensionStatus, PairGrade, SharedItem } from "@/lib/grading/types";
import { DIMENSIONS, DIMENSION_LABEL } from "@/lib/grading/types";
import { VARIANT_EFFECT_LABEL } from "@/lib/grading/variants";
import { sentenceLabel, shortLabel } from "@/lib/graph/labels";
import { TYPE_NAME, countLabel } from "@/lib/graph/vocab";
import { ICON_PATH } from "@/lib/viz/icons";
import {
  FLAG_TEXT,
  KIND_WORD,
  STATUS_WORD,
  TYPE_WORD,
  clusterOf,
  clusterColor,
  coverageOf,
  diseaseColor,
  diseaseProfile,
  edgeSentence,
  evidenceName,
  evidencePath,
  formatPercent,
  formatScore,
  isRecruiting,
  neighborRows,
  nodeOf,
  pairOf,
  sharedEdges,
  trialStatus,
  umbrellaIds,
  variantRows,
  type AtlasModel,
  type Kind,
  type LinkedItem,
  type Mode,
} from "./format";
import NeighborList, { ClinicalBadge, Dot, TierBadge } from "./NeighborList";

interface Props {
  model: AtlasModel;
  focusId: string;
  selectedId: string | null;
  mode: Mode;
  onSelect(id: string | null): void;
  onFocus(id: string): void;
}

export default function DetailPanel(props: Props) {
  const { model, focusId, selectedId } = props;
  const pair = selectedId ? pairOf(model, focusId, selectedId) : undefined;
  const other = selectedId ? nodeOf(model, selectedId) : undefined;
  // Keyed so expanded lists start folded again for every new disease or pair.
  if (pair && other) return <PairView key={`${focusId}|${other.id}`} {...props} pair={pair} other={other} />;
  return <FocusView key={focusId} {...props} />;
}

// ---------- small shared pieces ----------

function ExternalLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
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

// Citations can be whole paper titles. Show "Zhang et al. 2025" when the label starts that way,
// otherwise one line cut to fit; the full label stays in the title.
function SourceName({ source }: { source: string }) {
  const cite = /^[^,]{3,40}\b(?:19|20)\d{2}(?=,)/.exec(source)?.[0] ?? source;
  return (
    <span title={source} className="inline-block max-w-[15rem] truncate align-bottom">
      {cite}
    </span>
  );
}

function SourceLink({ href, source }: { href: string; source: string }) {
  return (
    <ExternalLink href={href} className="hover:underline">
      <SourceName source={source} />
    </ExternalLink>
  );
}

export function KindTag({ kind }: { kind: Kind }) {
  const solid = kind === "observed";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-ink-3 px-1.5 text-[0.6875rem] leading-4 whitespace-nowrap text-ink-2 ${solid ? "" : "border-dashed"}`}
    >
      <svg viewBox="0 0 12 4" width="12" height="4" aria-hidden="true">
        <line x1="0" y1="2" x2="12" y2="2" stroke="currentColor" strokeWidth="1.6" strokeDasharray={solid ? undefined : "3 2"} />
      </svg>
      {KIND_WORD[kind]}
    </span>
  );
}

function TypeIcon({ type, className = "size-4" }: { type: NodeType; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATH[type]} />
    </svg>
  );
}

// Status is shape plus a hidden word, never color alone.
function StatusIcon({ status }: { status: DimensionStatus }) {
  return (
    <span className="mt-0.5 shrink-0 text-ink">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
        {status === "match" && (
          <>
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {status === "partial" && (
          <>
            <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 1.6a6.4 6.4 0 0 1 0 12.8z" fill="currentColor" />
          </>
        )}
        {status === "none" && (
          <>
            <circle cx="8" cy="8" r="6.4" stroke="var(--ink-3)" strokeWidth="1.3" />
            <path d="M5 8h6" stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
        {status === "unknown" && (
          <>
            <circle cx="8" cy="8" r="6.4" stroke="var(--ink-3)" strokeWidth="1.3" strokeDasharray="2.4 2" />
            <path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1v.3M8 11.3v.1" stroke="var(--ink-2)" strokeWidth="1.4" strokeLinecap="round" />
          </>
        )}
      </svg>
      <span className="visually-hidden">{STATUS_WORD[status]}: </span>
    </span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4">
      <h3 className="text-[0.9375rem] font-semibold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-ink-2 text-pretty">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function MoreButton({ shown, total, onClick, what }: { shown: number; total: number; onClick(): void; what: string }) {
  if (total <= shown) return null;
  return (
    <button type="button" onClick={onClick} className="mt-1 text-[0.8125rem] font-medium text-accent-ink hover:underline">
      Show all {total} {what}
    </button>
  );
}

function shortName(node: GraphNode): string {
  return node.type === "Disease" ? shortLabel(node) : shortLabel(node, 48);
}

// The edge that ties an item to the rest of the path: the one touching the item itself.
function itemEdge(item: LinkedItem): GraphEdge | undefined {
  return item.edges.find((e) => e.subject === item.node.id || e.object === item.node.id) ?? item.edges[0];
}

function EdgeIds({ edges }: { edges: GraphEdge[] }) {
  return (
    <p className="mt-0.5 font-mono text-[0.6875rem] break-all text-ink-2">
      {edges.map((e) => `${e.id} (confidence ${e.confidence})`).join(", ")}
    </p>
  );
}

function itemMeta(node: GraphNode): string[] {
  const a = node.attributes ?? {};
  const out: string[] = [];
  if (node.type === "PatientOrg" || node.type === "Asset") {
    if (typeof a.kind === "string" && node.type === "Asset") out.push(a.kind.charAt(0).toUpperCase() + a.kind.slice(1));
    if (typeof a.country === "string") out.push(a.country);
  }
  if (node.type === "Grant") {
    const parts = [a.agency, a.fiscal_year].filter((x) => typeof x === "string" || typeof x === "number");
    if (parts.length) out.push(parts.join(" "));
  }
  if (node.type === "Paper") {
    const parts = [a.journal, a.year].filter((x) => typeof x === "string" || typeof x === "number");
    if (parts.length) out.push(parts.join(", "));
  }
  return out;
}

function ItemRow({
  item,
  mode,
  extra,
  ownSource,
  ownLink,
  ownVia,
}: {
  item: LinkedItem;
  mode: Mode;
  extra?: ReactNode;
  ownSource: boolean; // the row names its source, provenance and caveat itself
  ownLink: boolean; // the list names the source; the row only links its own record
  ownVia: boolean;
}) {
  const edge = itemEdge(item);
  const website = typeof item.node.attributes?.website === "string" ? item.node.attributes.website : null;
  const meta = itemMeta(item.node);
  const via = ownVia ? item.via : undefined;
  const linkOnly = !ownSource && ownLink && edge && edge.url !== item.node.url;
  const details = extra || meta.length > 0 || ownSource || linkOnly || via || website;
  return (
    <li className="py-1">
      <ExternalLink href={item.node.url} className="text-sm text-ink hover:underline">
        {item.node.label}
      </ExternalLink>
      {details && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
          {extra}
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
          {ownSource && edge && (
            // The item link already opens the record when the edge cites the same page.
            edge.url === item.node.url ? (
              <SourceName source={edge.source} />
            ) : (
              <SourceLink href={edge.url} source={edge.source} />
            )
          )}
          {linkOnly && (
            <SourceLink href={edge.url} source={edge.source} />
          )}
          {ownSource && <KindTag kind={item.kind} />}
          {via && (
            <span>
              via {TYPE_WORD[via.type].toLowerCase()} {shortName(via)}
            </span>
          )}
          {website && (
            <ExternalLink href={website} className="hover:underline">
              Website
            </ExternalLink>
          )}
        </div>
      )}
      {/* A row with its own source also carries its own caveat or quote. */}
      {ownSource && edge?.evidence && <p className="mt-0.5 text-xs text-ink-2 text-pretty">{edge.evidence}</p>}
      {mode === "researcher" && <EdgeIds edges={item.edges} />}
    </li>
  );
}

interface SourceLine {
  source: string;
  url: string | null; // the one page every item cites; null when items cite their own pages
  rowLinks: boolean; // items cite different pages that are not their own link: link each row
  kind: Kind;
  evidence?: string;
  via?: GraphNode;
}

// One source line for a whole list when every item rests on the same kind of record (same
// source, provenance and caveat), instead of repeating "HPO (via Monarch) · observed" on every
// row. The route ("through mechanism X") joins the line only when every item shares it. Lists
// that mix sources keep a source on each row.
function commonSource(items: LinkedItem[]): SourceLine | null {
  const edges = items.map(itemEdge);
  const first = edges[0];
  if (!first || edges.some((e) => !e)) return null;
  const alike = items.every((item, i) => {
    const e = edges[i]!;
    return e.source === first.source && item.kind === items[0].kind && (e.evidence ?? "") === (first.evidence ?? "");
  });
  if (!alike) return null;
  const sameVia = items.every((item) => item.via?.id === items[0].via?.id);
  const line = { source: first.source, kind: items[0].kind, evidence: first.evidence, via: sameVia ? items[0].via : undefined };
  if (items.every((item, i) => edges[i]!.url === item.node.url)) return { ...line, url: null, rowLinks: false };
  if (edges.every((e) => e!.url === first.url)) return { ...line, url: first.url, rowLinks: false };
  // Same kind of record, different pages: each row keeps its own link, the line says the rest.
  return { ...line, url: null, rowLinks: true };
}

function SourceFooter({ line }: { line: SourceLine }) {
  return (
    <div className="mt-1 text-xs text-ink-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          Source:{" "}
          {line.url ? (
            <SourceLink href={line.url} source={line.source} />
          ) : (
            <SourceName source={line.source} />
          )}
        </span>
        <KindTag kind={line.kind} />
        {line.via && (
          <span>
            through {TYPE_WORD[line.via.type].toLowerCase()} {shortName(line.via)}
          </span>
        )}
      </p>
      {line.evidence && <p className="mt-0.5 text-pretty">{line.evidence}</p>}
    </div>
  );
}

function ItemList({ items, mode, limit, what, extra }: { items: LinkedItem[]; mode: Mode; limit: number; what: string; extra?: (item: LinkedItem) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  const line = commonSource(items);
  return (
    <>
      <ul role="list">
        {shown.map((item) => (
          <ItemRow key={item.node.id} item={item} mode={mode} extra={extra?.(item)} ownSource={!line} ownLink={!!line?.rowLinks} ownVia={!line?.via} />
        ))}
      </ul>
      <MoreButton shown={limit} total={all ? 0 : items.length} onClick={() => setAll(true)} what={what} />
      {line && <SourceFooter line={line} />}
    </>
  );
}

function Fact({ type, items, empty, children }: { type: NodeType; items: number; empty: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2">
      <span className="mt-0.5 text-ink-2">
        <TypeIcon type={type} />
      </span>
      <div className="min-w-0 flex-1">{items ? children : <p className="text-sm text-ink-2">{empty}</p>}</div>
    </div>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-[0.8125rem] font-medium text-ink">{children}</h4>;
}

// ---------- focus disease ----------

function FocusView({ model, focusId, selectedId, mode, onSelect }: Props) {
  const focus = nodeOf(model, focusId);
  const entry = model.relevance.diseases[focusId];
  if (!focus || !entry) return null;
  const profile = diseaseProfile(model, focusId);
  const cluster = clusterOf(model, focusId);
  const rows = neighborRows(model, focusId);
  const short = shortLabel(focus);
  const synonyms = (focus.synonyms ?? []).filter((s) => s !== focus.label).slice(0, 3);
  const recruiting = profile.trials.filter((t) => isRecruiting(t.node)).length;
  const info = model.relevance.node_info ?? {};
  const researcher = mode === "researcher";
  // Clinical look-alikes that are not already on the map (grade files from engine 0.2.0 on).
  const onMap = new Set(entry.neighbors.map((n) => n.id));
  const lookAlikes = (entry.clinical_neighbors ?? []).flatMap((n) => {
    const node = nodeOf(model, n.id);
    const pair = pairOf(model, focusId, n.id);
    return node && pair && !onMap.has(n.id) ? [{ id: n.id, node, pair }] : [];
  });

  return (
    <article aria-labelledby="detail-title" className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-ink">
            <Dot color={clusterColor(cluster?.color_slot)} size={8} />
            {cluster ? cluster.label : "Not in a mechanism cluster"}
          </span>
          {entry.bridge && <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-ink">Links two clusters</span>}
        </div>
        <h2 id="detail-title" className="mt-2 text-xl leading-snug font-semibold text-balance">
          {sentenceLabel(focus.label)}
        </h2>
        {synonyms.length > 0 && <p className="mt-1 text-sm text-ink-2 text-pretty">Also called {synonyms.join(", ")}</p>}
        <p className="mt-1 text-xs text-ink-2">
          <SourceLink href={focus.url} source={focus.source} />
          {researcher && (
            <span className="ml-2 font-mono">
              {focus.id} · centrality {formatScore(entry.centrality)}
            </span>
          )}
        </p>
      </header>

      {!rows.length && <NoConnection model={model} focusId={focusId} />}

      <Section title="Biology">
        <Fact type="Gene" items={profile.genes.length} empty="No gene on record.">
          <SubHeading>{profile.genes.length === 1 ? "Gene" : "Genes"}</SubHeading>
          <ItemList items={profile.genes} mode={mode} limit={4} what="genes" />
        </Fact>
        <Fact type="Mechanism" items={profile.mechanisms.length} empty="No mechanism on record.">
          <SubHeading>{profile.mechanisms.length === 1 ? "Mechanism" : "Mechanisms"}</SubHeading>
          <ItemList
            items={profile.mechanisms}
            mode={mode}
            limit={4}
            what="mechanisms"
            extra={(item) => {
              // How many diseases here share it: a process every disease has cannot tell them apart.
              const reach = info[item.node.id]?.diseases;
              // The source caveat often repeats the description; say it once.
              const description = item.node.description && !(itemEdge(item)?.evidence ?? "").includes(item.node.description) ? item.node.description : null;
              return (
                <>
                  {description && <span className="basis-full text-pretty">{description}</span>}
                  {typeof reach === "number" && (
                    <span className="basis-full">
                      {reach >= model.diseaseCount ? `Shared by all ${model.diseaseCount} diseases here` : `Shared by ${reach} of ${model.diseaseCount} diseases here`}
                    </span>
                  )}
                </>
              );
            }}
          />
        </Fact>
      </Section>

      {/* What the disease looks like, kept apart from its biology as the grades are. */}
      <Section title="How it shows up" hint="Rarest symptoms first: they say the most about a disease.">
        <Fact type="Phenotype" items={profile.symptoms.length} empty="No symptoms on record.">
          <SubHeading>Most specific symptoms</SubHeading>
          <ItemList
            items={profile.symptoms}
            mode={mode}
            limit={5}
            what="symptoms"
            extra={(item) =>
              researcher && info[item.node.id]?.ic !== undefined ? <span className="tabular-nums">IC {formatScore(info[item.node.id]!.ic!)}</span> : null
            }
          />
        </Fact>
        {profile.context.length > 0 && (
          <Fact type="Phenotype" items={profile.context.length} empty="">
            <SubHeading>Onset and inheritance</SubHeading>
            <ItemList items={profile.context} mode={mode} limit={4} what="facts" />
          </Fact>
        )}
      </Section>

      <Section title="Research around it" hint="What already exists that families and researchers can build on.">
        <Fact type="PatientOrg" items={profile.orgs.length} empty="No patient group on record.">
          <SubHeading>{countLabel("PatientOrg", profile.orgs.length)}</SubHeading>
          <ItemList items={profile.orgs} mode={mode} limit={3} what="patient groups" />
        </Fact>
        <Fact type="Asset" items={profile.assets.length} empty="No registry or asset on record.">
          <SubHeading>{countLabel("Asset", profile.assets.length)}</SubHeading>
          <ItemList items={profile.assets} mode={mode} limit={3} what="registries and assets" />
        </Fact>
        <Fact type="Trial" items={profile.trials.length} empty="No clinical study on record.">
          <SubHeading>
            {countLabel("Trial", profile.trials.length)}
            {recruiting > 0 && <span className="font-normal text-ink-2"> · {recruiting} recruiting</span>}
          </SubHeading>
          <ItemList
            items={[...profile.trials].sort((a, b) => Number(isRecruiting(b.node)) - Number(isRecruiting(a.node)))}
            mode={mode}
            limit={3}
            what="clinical studies"
            extra={(item) => {
              const status = trialStatus(item.node);
              return status ? <span className={isRecruiting(item.node) ? "font-semibold text-ink" : ""}>{status}</span> : null;
            }}
          />
        </Fact>
        <Fact type="Grant" items={profile.grants.length} empty="No research grant on record.">
          <SubHeading>{countLabel("Grant", profile.grants.length)}</SubHeading>
          <ItemList items={profile.grants} mode={mode} limit={3} what="grants" />
        </Fact>
        <Fact type="Investigator" items={profile.investigators.length} empty="No researcher on record.">
          <SubHeading>{countLabel("Investigator", profile.investigators.length)}</SubHeading>
          <ItemList items={profile.investigators} mode={mode} limit={4} what="researchers" />
        </Fact>
        <Fact type="Paper" items={profile.papers.length} empty="No paper on record.">
          <SubHeading>{countLabel("Paper", profile.papers.length)}</SubHeading>
          <ItemList items={profile.papers} mode={mode} limit={2} what="papers" />
        </Fact>
      </Section>

      {profile.disputed.length > 0 && (
        <Section title="Disputed by a source" hint="Shown for honesty; never used to grade a link.">
          <ul role="list" className="space-y-2">
            {profile.disputed.map(({ edge, other }) => (
              <li key={edge.id} className="text-sm">
                {edgeSentence(model, edge)}
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <SourceLink href={edge.url} source={edge.source} />
                  <KindTag kind="contradicted" />
                  <span>{TYPE_WORD[other.type]}</span>
                </div>
                {researcher && <EdgeIds edges={[edge]} />}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Closest diseases" hint="By shared biology. Select one to see why.">
        <NeighborList rows={rows} focusShort={short} selectedId={selectedId} mode={mode} onSelect={onSelect} compact />
        {entry.hidden > 0 && <p className="mt-2 text-xs text-ink-2">+{entry.hidden} weaker links not shown</p>}
      </Section>

      {lookAlikes.length > 0 && (
        <Section title="Look alike, different biology" hint="Similar symptoms, onset or inheritance, but little shared biology. Not on the map.">
          <ul className="-mx-2">
            {lookAlikes.map(({ id, node, pair }) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  aria-current={id === selectedId ? "true" : undefined}
                  className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-2 aria-[current=true]:bg-surface-2"
                >
                  <span className="mt-1.5">
                    <Dot color={diseaseColor(model, id)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{shortLabel(node)}</span>
                      {pair.clinical_tier && <ClinicalBadge tier={pair.clinical_tier} />}
                    </span>
                    {pair.clinical_reason && <span className="mt-0.5 block text-xs text-ink-2 text-pretty">{pair.clinical_reason}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}

// No neighbor at all: say so, and show what was compared and what is missing.
function NoConnection({ model, focusId }: { model: AtlasModel; focusId: string }) {
  const coverage = coverageOf(diseaseProfile(model, focusId));
  const type: Record<Dimension, NodeType> = {
    gene: "Gene",
    variant: "Variant",
    mechanism: "Mechanism",
    phenotype: "Phenotype",
    disease: "Phenotype",
    patient_org: "PatientOrg",
    paper: "Paper",
    trial: "Trial",
    grant: "Grant",
    investigator: "Investigator",
    asset: "Asset",
  };
  // Onset and inheritance are symptom-type terms too; listing them would count symptoms twice.
  const dims = DIMENSIONS.filter((d) => d !== "disease");
  const searched = dims.filter((d) => coverage[d] > 0).map((d) => countLabel(type[d], coverage[d]));
  const missing = dims.filter((d) => coverage[d] === 0).map((d) => TYPE_NAME[type[d]].many);
  return (
    <div className="rounded-xl border border-dashed border-ink-3 p-4">
      <p className="font-semibold">No supported connection in this atlas yet.</p>
      <p className="mt-1 text-sm text-ink-2 text-pretty">
        {searched.length ? `We compared ${searched.join(", ")} with every other disease here. None was shared closely enough to count.` : "Nothing is on record for this disease yet, so there was nothing to compare."}
      </p>
      {missing.length > 0 && <p className="mt-1 text-sm text-ink-2 text-pretty">Not on record: {missing.join(", ")}.</p>}
      <p className="mt-2 text-sm text-pretty">A curated gene, mechanism or patient-group link for this disease is what would change the answer.</p>
    </div>
  );
}

// ---------- a selected pair ----------

function ScoreLine({ dim, cap }: { dim: DimensionResult; cap: number | undefined }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2 tabular-nums">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <span className="block h-full rounded-full bg-ink-2" style={{ width: `${Math.round(dim.score * 100)}%` }} />
      </span>
      <span>score {formatScore(dim.score)}</span>
      {dim.raw !== undefined && <span>raw {formatScore(dim.raw)}</span>}
      {dim.percentile !== undefined && <span>percentile {formatPercent(dim.percentile)}</span>}
      {cap !== undefined && <span>cap {formatScore(cap)}</span>}
      <span>
        coverage {dim.coverage.a} / {dim.coverage.b}
      </span>
    </div>
  );
}

function SharedChips({ model, items, mode, umbrellas }: { model: AtlasModel; items: SharedItem[]; mode: Mode; umbrellas: Set<string> }) {
  const [all, setAll] = useState(false);
  const limit = 6;
  const shown = all ? items : items.slice(0, limit);
  // Only shared work can be an umbrella: a group or registry that covers most diseases here.
  // When every item is one, say it once instead of on every chip.
  const allUmbrella = umbrellas.size > 0 && items.every((i) => umbrellas.has(i.id));
  return (
    <div className="mt-2">
      {allUmbrella && (
        <p className="mb-1.5 text-xs text-ink-2">
          {items.length === 1 ? "It covers most diseases here, so it says" : "These cover most diseases here, so they say"} little about this pair.
        </p>
      )}
      <ul role="list" className="flex flex-wrap gap-1.5">
        {shown.map((item) => {
          const node = nodeOf(model, item.id);
          const umbrella = !allUmbrella && umbrellas.has(item.id);
          const cls = `inline-flex max-w-full items-center gap-1 rounded-full border border-ink-3 px-2.5 py-0.5 text-xs whitespace-nowrap text-ink ${item.kind === "observed" ? "" : "border-dashed"}`;
          const chip = (
            <>
              <span className="min-w-0 truncate">{item.label}</span>
              {umbrella && <span className="shrink-0 text-ink-2">· covers most diseases here</span>}
            </>
          );
          return (
            <li key={item.id} className="max-w-full min-w-0" title={`${item.label} · ${KIND_WORD[item.kind]}`}>
              {node ? (
                <ExternalLink href={node.url} className={`${cls} hover:bg-surface-2`}>
                  {chip}
                </ExternalLink>
              ) : (
                <span className={cls}>{chip}</span>
              )}
            </li>
          );
        })}
        {!all && items.length > limit && (
          <li>
            <button
              type="button"
              onClick={() => setAll(true)}
              className="rounded-full px-2 py-0.5 text-xs font-medium text-accent-ink hover:underline"
            >
              +{items.length - limit} more
            </button>
          </li>
        )}
      </ul>
      {mode === "researcher" && (
        <p className="mt-1.5 font-mono text-[0.6875rem] break-all text-ink-2">
          {[...new Set(items.flatMap((i) => i.edges))].join(", ")}
        </p>
      )}
    </div>
  );
}

// The provenance of what is shown: one kind when every shared item agrees, else "observed and inferred".
function itemsKind(items: SharedItem[]): Kind {
  const kinds = new Set(items.map((i) => i.kind));
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-accent-ink hover:underline [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="transition-transform group-open:rotate-90 motion-reduce:transition-none">
          <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2 border-l-2 border-line pl-3 text-xs">{children}</div>
    </details>
  );
}

// Every graph edge behind a line of evidence, read as a sentence with its source, so each claim
// in the panel can be traced to the record that states it. One statement backed by several
// records (a consortium grant listed under three projects) is one sentence with several links.
// A caveat is printed once, under the first statement that carries it.
function EdgeSources({ model, edges, mode }: { model: AtlasModel; edges: GraphEdge[]; mode: Mode }) {
  const [all, setAll] = useState(false);
  const statements: GraphEdge[][] = [];
  const byKey = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const key = [edge.type, edge.subject, edge.object, edge.source, edge.kind, edge.evidence ?? ""].join("|");
    const group = byKey.get(key);
    if (group) group.push(edge);
    else {
      const fresh = [edge];
      byKey.set(key, fresh);
      statements.push(fresh);
    }
  }
  const limit = 6;
  const shown = all ? statements : statements.slice(0, limit);
  return (
    <Disclosure summary={`Where this comes from · ${statements.length}`}>
      <ul role="list" className="space-y-2">
        {shown.map((group, i) => {
          const [edge] = group;
          return (
            <li key={edge.id}>
              <p className="text-pretty text-ink">{edgeSentence(model, edge)}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
                {group.map((e, j) =>
                  j === 0 ? (
                    <SourceLink key={e.id} href={e.url} source={e.source} />
                  ) : (
                    <ExternalLink key={e.id} href={e.url} className="hover:underline">
                      record {j + 1}
                    </ExternalLink>
                  ),
                )}
                <KindTag kind={edge.kind} />
                {mode === "researcher" && (
                  <span className="font-mono text-[0.6875rem] break-all">
                    {group.map((e) => e.id).join(", ")} · confidence {edge.confidence}
                  </span>
                )}
              </div>
              {edge.evidence && edge.evidence !== shown[i - 1]?.[0].evidence && <p className="mt-0.5 text-pretty text-ink-2">{edge.evidence}</p>}
            </li>
          );
        })}
      </ul>
      {!all && statements.length > limit && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 font-medium text-accent-ink hover:underline">
          Show all {statements.length}
        </button>
      )}
    </Disclosure>
  );
}

// The variant-type line has no shared item to cite: show the variants it counted, each with its
// record and the type read from its name.
function VariantSources({ model, ids }: { model: AtlasModel; ids: string[] }) {
  const sides = ids.flatMap((id) => {
    const node = nodeOf(model, id);
    return node ? [{ id, node, rows: variantRows(model, id) }] : [];
  });
  const total = sides.reduce((n, s) => n + s.rows.length, 0);
  if (!total) return null;
  const source = sides.find((s) => s.rows.length)!.rows[0].node.source;
  return (
    <Disclosure summary={`Where this comes from · ${total} ${total === 1 ? "variant" : "variants"}`}>
      <div className="space-y-2.5">
        {sides.map((side) => (
          <div key={side.id}>
            <p className="font-medium text-ink">{evidenceName(side.node)}</p>
            {side.rows.length ? (
              <ul role="list" className="mt-0.5 space-y-0.5">
                {side.rows.map((row) => (
                  <li key={row.node.id} className="flex flex-wrap items-baseline gap-x-2">
                    <ExternalLink href={row.node.url} className="font-mono text-[0.6875rem] break-all text-ink hover:underline">
                      {row.name}
                    </ExternalLink>
                    <span className="text-ink-2">{VARIANT_EFFECT_LABEL[row.effect]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-2">No variant on record.</p>
            )}
          </div>
        ))}
        <p className="text-pretty text-ink-2">Each link opens the variant&apos;s {source} record. The type is read from the variant&apos;s name, not from a curated source.</p>
      </div>
    </Disclosure>
  );
}

// Plain words for the one line that is hard to read without genetics.
const PARENT_GLOSS: Partial<Record<Dimension, string>> = {
  variant: "Loss of function means the change stops the gene from working. Missense means it swaps one building block of the protein.",
};

function DimensionRow({ model, dim, mode, pairIds }: { model: AtlasModel; dim: DimensionResult; mode: Mode; pairIds: string[] }) {
  const kind: Kind | null = dim.shared.length ? itemsKind(dim.shared) : dim.support;
  const gloss = mode === "parent" ? PARENT_GLOSS[dim.dimension] : undefined;
  const edges = sharedEdges(model, dim);
  return (
    <li className="flex gap-2.5 py-2.5">
      <StatusIcon status={dim.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="text-sm font-medium">{DIMENSION_LABEL[dim.dimension]}</h4>
          {kind && <KindTag kind={kind} />}
        </div>
        <p className="mt-0.5 text-sm text-ink-2 text-pretty">{dim.summary}</p>
        {gloss && <p className="mt-1 text-xs text-ink-2 text-pretty">{gloss}</p>}
        {mode === "researcher" && <ScoreLine dim={dim} cap={model.relevance.meta.caps[dim.dimension]} />}
        {dim.shared.length > 0 && <SharedChips model={model} items={dim.shared} mode={mode} umbrellas={umbrellaIds(model, dim)} />}
        {edges.length > 0 && <EdgeSources model={model} edges={edges} mode={mode} />}
        {dim.dimension === "variant" && dim.status !== "unknown" && <VariantSources model={model} ids={pairIds} />}
      </div>
    </li>
  );
}

function PathView({ model, pair, focusId, otherId, mode }: { model: AtlasModel; pair: PairGrade; focusId: string; otherId: string; mode: Mode }) {
  const path = evidencePath(model, pair, focusId, otherId);
  if (!path) return null;
  return (
    <>
      <ol role="list" className="mt-1">
        {path.steps.map((step, i) => (
          <li key={`${step.node.id}-${i}`}>
            {step.connector && (
              <div className={`path-connector ml-[11px] space-y-1 py-2 pl-5 ${step.connector.kind === "observed" ? "" : "kind-inferred"}`}>
                {step.connector.edges.map((edge) => (
                  <div key={edge.id} className="text-xs text-ink-2">
                    <p className="text-pretty text-ink">{edgeSentence(model, edge)}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <SourceLink href={edge.url} source={edge.source} />
                      <KindTag kind={edge.kind} />
                      {mode === "researcher" && (
                        <span className="font-mono text-[0.6875rem]">
                          {edge.id} · confidence {edge.confidence}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink-2">
                <TypeIcon type={step.node.type} className="size-3.5" />
              </span>
              <ExternalLink href={step.node.url} className="min-w-0 text-sm font-medium text-ink hover:underline">
                {shortName(step.node)}
              </ExternalLink>
              <span className="shrink-0 text-xs text-ink-2">{TYPE_WORD[step.node.type]}</span>
            </div>
            {path.groupIsUmbrella && step.node.id === path.sharedGroup?.id && (
              <p className="mt-1 ml-[34px] text-xs text-ink-2 text-pretty">It covers most diseases here, so it is a place to start, not a sign these two are close.</p>
            )}
          </li>
        ))}
      </ol>
      {path.steps.length < 3 && (
        <p className="mt-2 text-xs text-ink-2 text-pretty">No single shared gene, mechanism or symptom ties them; the grade comes from overall overlap.</p>
      )}
      {!path.sharedGroup && <p className="mt-2 text-xs text-ink-2 text-pretty">No shared patient group or registry on record yet.</p>}
    </>
  );
}

function PairView({ model, focusId, mode, onSelect, onFocus, pair, other }: Props & { pair: PairGrade; other: GraphNode }) {
  const focus = nodeOf(model, focusId);
  if (!focus) return null;
  const researcher = mode === "researcher";
  // Grouped by the family each result states, so a grade file is shown the way it was graded
  // (symptoms count as biology before engine 0.2.0 and as clinical resemblance from 0.2.0 on).
  const results = DIMENSIONS.map((d) => pair.dimensions[d]).filter((d): d is DimensionResult => !!d);
  const biology = results.filter((d) => d.family === "biology" && d.status !== "unknown");
  const clinical = results.filter((d) => d.family === "clinical" && d.status !== "unknown");
  const together = results.filter((d) => d.family === "collaboration" && d.shared.length > 0);
  const unknown = results.filter((d) => d.status === "unknown");
  const flags = [...new Set(pair.flags)];
  const scores = [
    `biology ${formatScore(pair.biology)}`,
    ...(typeof pair.clinical === "number" ? [`clinical ${formatScore(pair.clinical)}`] : []),
    `collaboration ${formatScore(pair.collaboration)}`,
  ];
  const pairIds = [focusId, other.id];

  return (
    <article aria-labelledby="detail-title" className="space-y-5">
      <header>
        <button type="button" onClick={() => onSelect(null)} className="text-[0.8125rem] font-medium text-accent-ink hover:underline">
          ‹ Back to {shortLabel(focus)}
        </button>
        <h2 id="detail-title" className="mt-2 text-xl leading-snug font-semibold text-balance">
          {shortLabel(focus, 32)} and {shortLabel(other, 32)}
        </h2>
        <p className="mt-0.5 text-sm text-ink-2 text-pretty">{sentenceLabel(other.label)}</p>
        <dl className="mt-3 divide-y divide-line rounded-xl border border-line">
          <div className="px-3 py-2.5">
            <dt className="text-xs font-medium text-ink-2">Shared biology · sets the distance on the map</dt>
            <dd className="mt-1.5">
              <span className="flex flex-wrap items-center gap-2">
                <TierBadge tier={pair.tier} className="px-2.5 py-1 text-[0.8125rem]" />
                {pair.support && <KindTag kind={pair.support} />}
              </span>
              <p className="mt-1.5 text-[0.9375rem] text-pretty">{pair.tier_reason}</p>
            </dd>
          </div>
          {pair.clinical_tier && (
            <div className="px-3 py-2.5">
              <dt className="text-xs font-medium text-ink-2">How alike they look · symptoms, onset, inheritance</dt>
              <dd className="mt-1.5">
                <ClinicalBadge tier={pair.clinical_tier} className="px-2.5 py-1 text-[0.8125rem]" />
                {pair.clinical_reason && <p className="mt-1.5 text-[0.9375rem] text-pretty">{pair.clinical_reason}</p>}
              </dd>
            </div>
          )}
        </dl>
        {researcher && (
          <p className="mt-2 text-xs text-ink-2 tabular-nums">
            {scores.join(" · ")}
            {pair.lines_of_evidence.length > 0 && ` · lines of evidence: ${pair.lines_of_evidence.map((d) => DIMENSION_LABEL[d].toLowerCase()).join(", ")}`}
          </p>
        )}
      </header>

      <Section title="Why they’re connected" hint="Shared biology, strongest evidence first.">
        {biology.length ? (
          <ul role="list" className="divide-y divide-line">
            {biology.map((dim) => (
              <DimensionRow key={dim.dimension} model={model} dim={dim} mode={mode} pairIds={pairIds} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-2">Nothing biological could be compared for this pair.</p>
        )}
      </Section>

      {clinical.length > 0 && (
        <Section title="How alike they look" hint="Symptoms, onset and inheritance. Shown beside the biology, never used for distance on the map.">
          <ul role="list" className="divide-y divide-line">
            {clinical.map((dim) => (
              <DimensionRow key={dim.dimension} model={model} dim={dim} mode={mode} pairIds={pairIds} />
            ))}
          </ul>
        </Section>
      )}

      <Section title="Already working together" hint="Groups, studies, grants and people already linked to both.">
        {together.length ? (
          <ul role="list" className="divide-y divide-line">
            {together.map((dim) => (
              <DimensionRow key={dim.dimension} model={model} dim={dim} mode={mode} pairIds={pairIds} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-2">No shared group, study, grant or researcher on record yet.</p>
        )}
      </Section>

      {(unknown.length > 0 || flags.length > 0) && (
        <Section title="What we don’t know">
          <ul role="list" className="space-y-1.5 text-sm text-pretty">
            {unknown.map((dim) => (
              <li key={dim.dimension} className="flex gap-2.5">
                <StatusIcon status="unknown" />
                <span>
                  <span className="font-medium">{DIMENSION_LABEL[dim.dimension]}:</span> <span className="text-ink-2">{dim.summary}</span>
                </span>
              </li>
            ))}
            {flags.map((flag) => (
              <li key={flag} className="flex gap-2.5">
                <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-ink-2" />
                <span className="text-ink-2">
                  {FLAG_TEXT[flag]}
                  {researcher && <span className="ml-1 font-mono text-[0.6875rem]">{flag}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {pair.judgments.length > 0 && (
        <Section title="AI review" hint="A second reading by a model. It can only lower a grade or add caveats, never raise one.">
          <ul role="list" className="space-y-2 text-sm">
            {pair.judgments.map((j, i) => (
              <li key={i}>
                <p className="text-pretty">
                  <span className="font-medium">{j.verdict === "supports" ? "Supports" : j.verdict === "weakens" ? "Weakens" : j.verdict === "contradicts" ? "Contradicts" : "Not enough evidence"}</span>
                  {j.dimension !== "overall" && <span className="text-ink-2"> · {DIMENSION_LABEL[j.dimension].toLowerCase()}</span>}: {j.rationale}
                </p>
                {researcher && (
                  <p className="mt-0.5 font-mono text-[0.6875rem] break-all text-ink-2">
                    {j.confidence} confidence · {j.runs} runs · agreement {formatScore(j.agreement)} · cites {j.cited_edges.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Path" hint="Explore connections: how the atlas links them, one sourced step at a time. Solid = observed, dashed = inferred.">
        <PathView model={model} pair={pair} focusId={focusId} otherId={other.id} mode={mode} />
      </Section>

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <button
          type="button"
          onClick={() => onFocus(other.id)}
          className="min-h-9 rounded-full bg-accent px-4 text-sm font-medium text-white hover:brightness-110"
        >
          Center the map here
        </button>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="min-h-9 rounded-full border border-line px-4 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Clear selection
        </button>
      </div>
      <p className="text-xs text-ink-2 text-pretty">
        Shared work is a starting point for a conversation, not medical advice. A scientist has to check eligibility and mechanism.
      </p>
    </article>
  );
}
