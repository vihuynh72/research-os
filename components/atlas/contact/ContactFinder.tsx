"use client";

// "Who can I contact?": a button that opens a dialog with the researchers behind the papers and grants
// linked to a disease. OpenAI suggests them with web search; the server (app/api/contacts) checks every
// person, link and email before anything is shown here.
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Contact, ContactCheck, ContactsBody, ContactsErrorCode, ContactsLine, ContactsResult, ContactsStep, PatientGroup } from "@/lib/contacts/types";
import {
  BEFORE_YOU_WRITE,
  CONFIDENCE_HINT,
  CONFIDENCE_WORD,
  LOADING_NOTE,
  SHORT_FOOTER,
  TOOLTIP,
  UNREAD_PAGES,
  affiliationLine,
  contactTitle,
  contactsAsText,
  emailSubject,
  footerText,
  howWeChecked,
  isReachable,
  leadLine,
  linkParts,
  mailtoHref,
  recordLink,
  removedText,
  roleHelp,
  stepText,
  whereLine,
} from "./copyText";

type Phase =
  | { phase: "idle" }
  | { phase: "loading"; step: ContactsStep; papers: number | null; grants: number | null }
  | { phase: "done"; result: ContactsResult }
  | { phase: "error"; code: ContactsErrorCode | "network"; message: string; retryAfterSec?: number };

// The state belongs to one question (the disease ids); another question starts from idle.
type State = Phase & { key: string };

const IDLE: Phase = { phase: "idle" };

async function askServer(diseaseIds: string[], signal: AbortSignal, onLine: (line: ContactsLine) => void): Promise<ContactsBody> {
  const res = await fetch("/api/contacts", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/x-ndjson, application/json" },
    body: JSON.stringify({ diseaseIds }),
  });
  if (!(res.headers.get("content-type") ?? "").includes("ndjson") || !res.body) return (await res.json()) as ContactsBody;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as ContactsLine;
      if (parsed.type === "done") return parsed.body;
      onLine(parsed);
    }
  }
  throw new Error("The answer ended early.");
}

const NETWORK_MESSAGE = "Could not reach RareVerse. Check your connection and try again.";

export function ContactFinderButton({ diseaseIds, label = "Who can I contact?", names }: { diseaseIds: string[]; label?: string; names?: string[] }) {
  const key = diseaseIds.join("|");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ key, ...IDLE });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const tooltipId = useId();
  const current: Phase = state.key === key ? state : IDLE;

  // A question still running for other diseases, or for a panel that has gone, is dropped.
  useEffect(() => () => controllerRef.current?.abort(), [key]);

  const search = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const forKey = key;
    const update = (next: Phase) => {
      if (!controller.signal.aborted) setState({ key: forKey, ...next });
    };
    update({ phase: "loading", step: "read", papers: null, grants: null });
    askServer(forKey.split("|"), controller.signal, (line) => {
      if (line.type !== "progress") return;
      setState((s) =>
        s.key === forKey && s.phase === "loading" ? { ...s, step: line.step, papers: line.papers ?? s.papers, grants: line.grants ?? s.grants } : s,
      );
    }).then(
      (body) =>
        update(
          "error" in body
            ? { phase: "error", code: body.error.code, message: body.error.message, retryAfterSec: body.error.retry_after_sec }
            : { phase: "done", result: body },
        ),
      () => update({ phase: "error", code: "network", message: NETWORK_MESSAGE }),
    );
  };

  // Opening again after an error asks again: a wait that has passed, or a network that is back, needs no
  // extra click.
  const openDialog = () => {
    setOpen(true);
    if (current.phase === "idle" || current.phase === "error") search();
  };

  const title = contactTitle(names ?? (current.phase === "done" ? current.result.diseases.map((d) => d.name) : []));

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-describedby={tooltipId}
        title={TOOLTIP}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2 motion-reduce:transition-none sm:min-h-9"
      >
        <SparkleIcon className="size-4 shrink-0 text-accent-ink" />
        <span>{label}</span>
        <span className="rounded-full border border-line px-1.5 text-[0.6875rem] leading-4 font-semibold tracking-wide text-ink-2">AI</span>
      </button>
      <span id={tooltipId} hidden>
        {TOOLTIP}
      </span>
      {open && (
        <ContactDialog
          title={title}
          state={current}
          onRetry={search}
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

// Copy to the clipboard, say so through the dialog's live region, and show "Copied" on the button for 2 s.
function useCopy(announce: (message: string) => void): [string | null, (text: string, what: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (text: string, what: string) => {
    // The clipboard exists only on secure pages (https or localhost).
    (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
      () => {
        setCopied(what);
        announce(`${what} copied.`);
      },
      () => announce("Could not copy. Select the text and copy it instead."),
    );
  };
  return [copied, copy];
}

type Copy = (text: string, what: string) => void;

function ContactDialog({ title, state, onRetry, onClose }: { title: string; state: Phase; onRetry: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [announcement, setAnnouncement] = useState("");

  // showModal puts the dialog in the top layer, makes the page behind it inert (the focus trap) and closes
  // it on Escape; it also gives the dialog its role and modality. The page behind does not scroll meanwhile.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
    };
  }, []);

  // closedby="any" closes on a click outside; browsers without it (Safari) get the same here: a click on
  // the backdrop lands on the dialog element itself, outside its box.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if ("closedBy" in HTMLDialogElement.prototype || event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) event.currentTarget.close();
  };

  const result = state.phase === "done" ? state.result : null;
  const [copied, copy] = useCopy(setAnnouncement);

  return (
    // Anchored near the top, so the header stays put while the answer grows below it.
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      closedby="any"
      onClose={onClose}
      onClick={onClick}
      className="mx-auto mt-[3dvh] mb-auto w-[min(40rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40 sm:mt-[8dvh] dark:border-white/15 dark:backdrop:bg-black/65"
    >
      <div className="flex max-h-[90dvh] flex-col sm:max-h-[min(84dvh,52rem)]">
        <header className="flex items-start gap-3 border-b border-line px-4 pt-4 pb-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
              <SparkleIcon className="size-3.5 text-accent-ink" />
              AI contact finder
            </p>
            <h2 id={titleId} className="mt-1 text-lg leading-snug font-semibold text-balance text-ink">
              {title}
            </h2>
            {/* Hidden on phones to leave room for the results; screen readers still get it as the description. */}
            <p id={descriptionId} className="mt-1 hidden text-sm text-ink-2 text-pretty sm:block">
              Researchers behind the papers and grants linked here, with the official pages we could check.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="-mt-1 -mr-1 grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink sm:size-9"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="panel-scroll min-h-0 flex-1 px-4 py-4 sm:px-5" aria-busy={state.phase === "loading"}>
          {state.phase === "loading" && <Progress state={state} />}
          {state.phase === "done" && <Results result={state.result} copy={copy} copied={copied} />}
          {state.phase === "error" && <ErrorView code={state.code} message={state.message} retryAfterSec={state.retryAfterSec} onRetry={onRetry} />}
        </div>

        <footer className="flex items-center gap-3 border-t border-line px-4 py-2.5 sm:px-5 sm:py-3">
          <p className="flex-1 text-xs leading-relaxed text-ink-2 text-pretty">
            <span className="sm:hidden">{SHORT_FOOTER}</span>
            <span className="hidden sm:inline">{footerText(result?.model ?? null)}</span>
          </p>
          {result && result.contacts.length > 0 && (
            <button
              type="button"
              onClick={() => copy(contactsAsText(result, title), "All contacts")}
              className="min-h-10 shrink-0 rounded-full border border-line px-4 text-sm font-medium whitespace-nowrap text-ink hover:bg-surface-2 sm:min-h-9"
            >
              {copied === "All contacts" ? "Copied" : "Copy all"}
            </button>
          )}
        </footer>
      </div>
      <p aria-live="polite" className="visually-hidden">
        {liveText(state)} {announcement}
      </p>
    </dialog>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function liveText(state: Phase): string {
  if (state.phase === "loading") return `${stepText(state.step, state.papers, state.grants)}…`;
  if (state.phase === "error") return state.message;
  if (state.phase === "done") {
    const n = state.result.contacts.filter(isReachable).length;
    return n > 0 ? `Found ${plural(n, "person", "people")} you can contact.` : "No one could be confirmed yet.";
  }
  return "";
}

const STEPS: ContactsStep[] = ["read", "search", "check"];

function Progress({ state }: { state: Extract<Phase, { phase: "loading" }> }) {
  const at = STEPS.indexOf(state.step);
  return (
    <div className="py-2">
      <ol className="space-y-3.5">
        {STEPS.map((step, i) => {
          const status = i < at ? "done" : i === at ? "active" : "todo";
          return (
            <li key={step} className="flex items-center gap-3 text-sm" aria-current={status === "active" ? "step" : undefined}>
              <StepMark status={status} />
              <span className={status === "todo" ? "text-ink-2" : "text-ink"}>{stepText(step, state.papers, state.grants, status === "done")}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-5 text-xs text-ink-2">{LOADING_NOTE}</p>
    </div>
  );
}

function StepMark({ status }: { status: "done" | "active" | "todo" }) {
  if (status === "done") {
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-white">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <svg viewBox="0 0 20 20" width="20" height="20" className="shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)" strokeWidth="2" />
        <path d="M10 2a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className="size-5 shrink-0 rounded-full border-2 border-line" aria-hidden="true" />;
}

function ExternalLink({ href, children, className = "", title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} title={title}>
      {children}
      <span aria-hidden="true" className="ml-0.5 text-[0.85em]">
        ↗
      </span>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

// The link to the paper or grant behind a reason: plain words on screen, the record's id and title in its
// tooltip and accessible name.
function RecordLink({ source, children }: { source: Contact["source"]; children: ReactNode }) {
  return (
    <ExternalLink href={source.url} title={`${source.title} (${source.ref})`} className="font-medium whitespace-nowrap text-accent-ink hover:underline">
      {children}
      <span className="visually-hidden">
        , {source.ref}, “{source.title}”
      </span>
    </ExternalLink>
  );
}

function Results({ result, copy, copied }: { result: ContactsResult; copy: Copy; copied: string | null }) {
  if (result.contacts.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-line p-4">
          <p className="text-[0.9375rem] font-semibold text-ink">No one could be confirmed yet</p>
          <p className="mt-1 text-sm text-ink-2 text-pretty">{result.summary}</p>
        </div>
        <PatientGroups groups={result.patient_groups} />
        <p className="text-sm text-ink-2 text-pretty">The papers and grants below list who led them and where they worked.</p>
        <WhatWeRead result={result} open />
        <HowWeChecked result={result} />
      </div>
    );
  }
  const reachable = result.contacts.filter(isReachable);
  const unreached = result.contacts.filter((c) => !isReachable(c));
  const help = roleHelp(result.contacts);
  const diseaseNames = result.diseases.map((d) => d.name);
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[0.9375rem] leading-relaxed text-ink text-pretty">{result.summary}</p>
        {help.length > 0 && <p className="mt-1.5 text-xs leading-relaxed text-ink-2 text-pretty">{help.join(" ")}</p>}
      </div>
      {reachable.length > 0 && (
        <ul role="list" className="space-y-3">
          {reachable.map((contact, i) => (
            <ContactCard key={contact.candidate_id} contact={contact} startHere={i === 0 && reachable.length > 1} diseaseNames={diseaseNames} copy={copy} copied={copied} />
          ))}
        </ul>
      )}
      {reachable.length > 0 && <BeforeYouWrite />}
      {unreached.length > 0 && <Unreached contacts={unreached} also={reachable.length > 0} />}
      {reachable.length === 0 && <PatientGroups groups={result.patient_groups} />}
      <WhatWeRead result={result} />
      <HowWeChecked result={result} />
    </div>
  );
}

const CONFIDENCE_DOTS: Record<Contact["confidence"], number> = { high: 3, medium: 2, low: 1 };

function ConfidencePill({ level }: { level: Contact["confidence"] }) {
  return (
    <span title={CONFIDENCE_HINT} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
      <span aria-hidden="true" className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className={`size-1.5 rounded-full ${i < CONFIDENCE_DOTS[level] ? "bg-accent" : "bg-ink-3/50"}`} />
        ))}
      </span>
      {CONFIDENCE_WORD[level]}
    </span>
  );
}

function ContactCard({
  contact: c,
  startHere,
  diseaseNames,
  copy,
  copied,
}: {
  contact: Contact;
  startHere: boolean;
  diseaseNames: string[];
  copy: Copy;
  copied: string | null;
}) {
  const where = whereLine(c);
  const emailKey = `${c.name}'s email`;
  // Two pages that could not be opened share one check line instead of repeating it.
  const bothUnread = !!(c.profile_check && c.lab_check && !c.profile_check.ok && !c.lab_check.ok);
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      {startHere && (
        <p className="mb-2">
          <span className="rounded-full bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] px-2 py-0.5 text-xs font-medium text-accent-ink">Start here</span>
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <h3 className="text-[0.9375rem] leading-snug font-semibold text-ink">{c.name}</h3>
        <ConfidencePill level={c.confidence} />
      </div>
      {where && <p className="mt-0.5 text-sm text-ink-2 text-pretty">{where}</p>}
      <p className="mt-2.5 text-sm text-ink text-pretty">
        <span className="font-medium">Why: </span>
        {c.why} <RecordLink source={c.source}>{recordLink(c.source)}</RecordLink>
      </p>
      <CheckLine check={c.source_check} />
      <ul role="list" className="mt-3 space-y-2.5 border-t border-line pt-3">
        {c.profile_url && (
          <Route label="Profile" check={bothUnread ? null : c.profile_check}>
            <PageLink url={c.profile_url} what={`profile of ${c.name}`} />
          </Route>
        )}
        {c.lab_url && (
          <Route label="Lab" check={bothUnread ? { ok: false, text: UNREAD_PAGES } : c.lab_check}>
            <PageLink url={c.lab_url} what={`lab page of ${c.name}`} />
          </Route>
        )}
        {c.email && (
          <Route label="Email" check={c.email_check}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* The subject line is filled in, so the researcher sees at once what the email is about. */}
              <a href={mailtoHref(c.email, emailSubject(diseaseNames, c.source))} className="text-sm font-medium break-all text-accent-ink hover:underline">
                {c.email}
              </a>
              <button
                type="button"
                onClick={() => copy(c.email!, emailKey)}
                aria-label={`Copy ${emailKey}`}
                className="min-h-11 rounded-full border border-line px-3 text-xs font-medium text-ink hover:bg-surface-2 sm:min-h-7 sm:px-2.5"
              >
                {copied === emailKey ? "Copied" : "Copy"}
              </button>
            </span>
          </Route>
        )}
      </ul>
      {/* The model's own note (c.note) is never shown: nothing checks it against a source. */}
    </li>
  );
}

// "umassmed.edu · principal investigator ↗": the site, then the end of the address, so two links on one site
// can be told apart.
function PageLink({ url, what }: { url: string; what: string }) {
  const { host, hint } = linkParts(url);
  return (
    <ExternalLink href={url} className="text-sm font-medium break-words text-accent-ink hover:underline">
      {host}
      {hint && <span className="font-normal"> · {hint}</span>}
      <span className="visually-hidden">, {what}</span>
    </ExternalLink>
  );
}

function Route({ label, check, children }: { label: string; check: ContactCheck | null; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3">
      <span className="pt-0.5 text-xs font-medium text-ink-2">{label}</span>
      <div className="min-w-0">
        {children}
        <CheckLine check={check} />
      </div>
    </li>
  );
}

// ✓ for a check that passed; a dash for one that could not be made. The words always say which.
function CheckLine({ check }: { check: ContactCheck | null }) {
  if (!check) return null;
  return (
    <p className="mt-0.5 flex items-start gap-1.5 text-xs text-ink-2">
      {check.ok ? (
        <svg viewBox="0 0 16 16" width="12" height="12" className="mt-0.5 shrink-0 text-[var(--kind-comm-ink)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" className="mt-0.5 shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M5.5 8h5" />
        </svg>
      )}
      <span className="text-pretty">{check.text}</span>
    </p>
  );
}

function BeforeYouWrite() {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-xl bg-surface-2 px-4 py-3">
      <h3 id={id} className="text-sm font-semibold text-ink">
        {BEFORE_YOU_WRITE.title}
      </h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-ink marker:text-ink-3">
        {BEFORE_YOU_WRITE.tips.map((tip) => (
          <li key={tip} className="text-pretty">
            {tip}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-ink-2 text-pretty">{BEFORE_YOU_WRITE.caution}</p>
    </section>
  );
}

// People the model chose for whom no page or email could be confirmed: below the cards, compact, with where
// their own record places them.
function Unreached({ contacts, also }: { contacts: Contact[]; also: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-xl border border-line px-4 py-3">
      <h3 id={id} className="text-sm font-semibold text-ink">
        {also ? "Also wrote about this" : "Researchers on these records"}
      </h3>
      <p className="text-xs text-ink-2">No official page or email could be confirmed for them.</p>
      <ul role="list" className="mt-1 divide-y divide-line">
        {contacts.map((c) => (
          <li key={c.candidate_id} className="py-2.5 text-sm text-pretty">
            <p className="font-medium text-ink">{c.name}</p>
            <p className="mt-0.5 text-ink">
              {c.why}{" "}
              <RecordLink source={c.source}>{c.source.kind === "grant" ? "See their details on the grant" : "See their details on the paper"}</RecordLink>
            </p>
            {c.affiliation && (
              <p title={c.affiliation.text} className="mt-0.5 text-xs text-ink-2">
                {affiliationLine(c)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// From graph.json, not from the AI: the patient groups RareVerse lists for the disease.
function PatientGroups({ groups }: { groups: PatientGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="text-sm text-pretty">
      <p className="text-ink">Patient groups often know these researchers:</p>
      <ul role="list" className="mt-1 space-y-1">
        {groups.map((g) => (
          <li key={g.url}>
            <ExternalLink href={g.url} className="font-medium text-accent-ink hover:underline">
              {g.name}
            </ExternalLink>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-2">Listed in Orphanet&apos;s directory under the disease&apos;s name; not confirmed.</p>
    </div>
  );
}

function WhatWeRead({ result, open = false }: { result: ContactsResult; open?: boolean }) {
  const records = [...result.searched.papers, ...result.searched.grants];
  if (records.length === 0) return null;
  return (
    <details open={open} className="rounded-xl border border-line px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-ink">
        What we read ({plural(result.searched.papers.length, "paper", "papers")}
        {result.searched.grants.length > 0 ? `, ${plural(result.searched.grants.length, "grant", "grants")}` : ""})
      </summary>
      <ul role="list" className="mt-2 space-y-2.5">
        {records.map((r) => (
          <li key={r.id} className="text-sm text-pretty">
            <ExternalLink href={r.url} className="text-ink hover:underline">
              {r.title || r.ref}
            </ExternalLink>
            <span className="ml-1.5 text-xs whitespace-nowrap text-ink-2 tabular-nums">
              {r.ref}
              {r.year ? ` · ${r.year}` : ""}
            </span>
            {r.lead && <p className="mt-0.5 text-xs text-ink-2">{leadLine(r.lead)}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function HowWeChecked({ result }: { result: ContactsResult }) {
  const removed = removedText(result.removed);
  return (
    <details className="rounded-xl border border-line px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-ink">How we checked</summary>
      <div className="mt-2 space-y-2 text-sm text-ink-2 text-pretty">
        {howWeChecked(result.model).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {removed && <p>{removed}</p>}
      </div>
    </details>
  );
}

const ERROR_TITLE: Record<ContactsErrorCode | "network", string> = {
  no_key: "Not switched on here yet",
  nothing_to_search: "Nothing to search from yet",
  rate_limited: "Please wait a little",
  upstream_failed: "The search did not finish",
  bad_request: "Something went wrong",
  network: "Could not reach RareVerse",
};

// "Try again" is offered only when trying now can work: not during a wait of more than a minute (the message
// says how long; opening the dialog again later asks again).
function ErrorView({ code, message, retryAfterSec, onRetry }: { code: ContactsErrorCode | "network"; message: string; retryAfterSec?: number; onRetry: () => void }) {
  const retry = code === "upstream_failed" || code === "network" || (code === "rate_limited" && (retryAfterSec ?? 0) <= 60);
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="text-[0.9375rem] font-semibold text-ink">{ERROR_TITLE[code]}</p>
      <p className="mt-1 text-sm text-ink-2 text-pretty">{message}</p>
      {retry && (
        <button type="button" onClick={onRetry} className="mt-3 min-h-10 rounded-full bg-accent px-4 text-sm font-medium text-white hover:brightness-110 sm:min-h-9">
          Try again
        </button>
      )}
    </div>
  );
}

function SparkleIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M7 1.5 8.4 5.8 12.7 7.2 8.4 8.6 7 12.9 5.6 8.6 1.3 7.2 5.6 5.8Z" />
      <path d="M12.5 9.8 13.1 11.9 15.2 12.5 13.1 13.1 12.5 15.2 11.9 13.1 9.8 12.5 11.9 11.9Z" />
    </svg>
  );
}
