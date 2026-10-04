// The contact finder from question to checked answer. Network access comes in through `deps`, so the whole
// flow also runs in tests with recorded answers. The route (app/api/contacts) only adapts it to HTTP.
import type { AtlasGraph } from "../graph/types.ts";
import type { ContactsBody, ContactsError, ContactsErrorCode, ContactsProgress, ContactsResult, Grant, Paper, SearchedRecord } from "./types.ts";
import type { PageResult } from "./page.ts";
import { buildCandidates, patientGroups, planSources } from "./candidates.ts";
import { createRateLimiter, createTtlCache, type TtlCache } from "./limits.ts";
import { buildRequest, parseDraft, readResponse, type ModelAnswer } from "./openai.ts";
import { displayAffiliation, institutionOf } from "./text.ts";
import { allowList, hostOf, urlKey } from "./urls.ts";
import { checkedSummary, finalizeContacts, pagesToFetch, recordTextOf, screenDraft, searchedIds } from "./verify.ts";

export interface ContactDeps {
  fetchPapers(pmids: string[], signal: AbortSignal): Promise<Paper[]>;
  fetchGrants(applIds: string[], signal: AbortSignal): Promise<Grant[]>;
  askModel(request: unknown, signal: AbortSignal): Promise<unknown>;
  fetchPage(url: string, signal: AbortSignal): Promise<PageResult>;
  log(message: string): void; // server log only: statuses and hosts, never the key or page contents
}

// What the visitor reads. Generic on purpose for upstream failures: a rejected key, an exhausted quota or an
// unknown model id say "did not answer" too; the server log has the status and the error code.
export const MESSAGES: Record<ContactsErrorCode, string> = {
  no_key: "The contact finder is not switched on for this site yet: the server has no OpenAI key.",
  nothing_to_search: "RareVerse has no papers or research grants linked here yet, so there is no one to look up.",
  rate_limited: "Too many contact searches in a short time. Please try again in a few minutes.",
  upstream_failed: "PubMed, NIH or OpenAI did not answer. Please try again.",
  bad_request: "This request could not be read. Reload the page and try again.",
};

export function errorBody(code: ContactsErrorCode, message = MESSAGES[code], retryAfterSec?: number): ContactsError {
  return { error: retryAfterSec ? { code, message, retry_after_sec: retryAfterSec } : { code, message } };
}

export function statusFor(body: ContactsBody): number {
  if (!("error" in body)) return 200;
  return { nothing_to_search: 200, bad_request: 400, rate_limited: 429, no_key: 503, upstream_failed: 502 }[body.error.code];
}

// With no record to read, a patient group RareVerse lists for the disease is the next place to ask.
function nothingToSearch(graph: AtlasGraph, ids: string[]): ContactsError {
  if (patientGroups(graph, ids).length === 0) return errorBody("nothing_to_search");
  const which = ids.length === 1 ? "this disease" : "these diseases";
  return errorBody("nothing_to_search", `${MESSAGES.nothing_to_search} The patient groups RareVerse lists for ${which} may know researchers to contact.`);
}

// 1–2 different Disease ids that exist in the graph, or null.
export function validDiseaseIds(value: unknown, graph: AtlasGraph): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  if (!value.every((id) => typeof id === "string" && id.length <= 64) || new Set(value).size !== value.length) return null;
  const diseases = new Set(graph.nodes.filter((n) => n.type === "Disease").map((n) => n.id));
  return value.every((id) => diseases.has(id)) ? (value as string[]) : null;
}

// Who led each record we read, from the record itself, for the "What we read" list.
function paperRecord(p: Paper): SearchedRecord {
  const last = p.authors[p.authors.length - 1];
  const where = last ? displayAffiliation(last.affiliation) : "";
  return {
    id: `PMID:${p.pmid}`,
    ref: `PMID ${p.pmid}`,
    title: p.title,
    year: p.year,
    url: p.url,
    lead: last
      ? { role: p.authors.length === 1 ? "sole author" : "senior author", name: `${last.foreName} ${last.lastName}`.trim(), place: institutionOf(where) || displayAffiliation(where, 120) }
      : null,
  };
}

function grantRecord(g: Grant): SearchedRecord {
  const pi = g.investigators[0]; // the contact principal investigator comes first
  return {
    id: `NIH:${g.applId}`,
    ref: `NIH grant ${g.applId}`,
    title: g.title,
    year: g.fiscalYear,
    url: g.url,
    lead: pi ? { role: "grant lead", name: pi.name, place: g.organization } : null,
  };
}

// The whole request stays under 45 s: records first, then OpenAI with what is left minus time for the checks.
const BUDGET_MS = 44_000;
const RECORDS_MS = 10_000;
const CHECKS_RESERVE_MS = 7_500;
const PAGE_MS = 6_000;

export interface FindArgs {
  graph: AtlasGraph;
  diseaseIds: string[];
  model: string;
  deps: ContactDeps;
  now?: () => number;
  onProgress?: (progress: ContactsProgress) => void;
}

export async function findContacts({ graph, diseaseIds, model, deps, now = Date.now, onProgress }: FindArgs): Promise<ContactsBody> {
  const deadline = now() + BUDGET_MS;
  const left = () => Math.max(500, deadline - now());
  const plan = planSources(graph, diseaseIds);
  if (plan.diseases.length !== diseaseIds.length) return errorBody("bad_request");
  if (plan.papers.length === 0 && plan.grants.length === 0) return nothingToSearch(graph, diseaseIds);
  const diseases = plan.diseases.map((d) => ({ id: d.id, name: d.label }));

  // 1. Our own records: PubMed and NIH RePORTER, read in parallel.
  onProgress?.({ type: "progress", step: "read", papers: plan.papers.length, grants: plan.grants.length });
  const recordsSignal = AbortSignal.timeout(Math.min(RECORDS_MS, left()));
  const [paperRead, grantRead] = await Promise.allSettled([
    deps.fetchPapers(plan.papers.map((n) => n.id.slice("PMID:".length)), recordsSignal),
    deps.fetchGrants(plan.grants.map((n) => n.id.slice("NIH:".length)), recordsSignal),
  ]);
  if (paperRead.status === "rejected") deps.log(`PubMed not read: ${(paperRead.reason as Error)?.message}`);
  if (grantRead.status === "rejected") deps.log(`NIH RePORTER not read: ${(grantRead.reason as Error)?.message}`);
  const papers = paperRead.status === "fulfilled" ? paperRead.value : [];
  const grants = grantRead.status === "fulfilled" ? grantRead.value : [];
  const candidates = buildCandidates(papers, grants);
  if (candidates.length === 0) {
    if (paperRead.status === "rejected" || grantRead.status === "rejected") return errorBody("upstream_failed");
    return errorBody("nothing_to_search", "The papers and grants linked here name no researchers to look up.");
  }

  // 2. One OpenAI call: choose among the candidates, search the web for their current pages.
  onProgress?.({ type: "progress", step: "search" });
  const today = new Date(now()).toISOString().slice(0, 10);
  let answer: ModelAnswer;
  try {
    const raw = await deps.askModel(buildRequest(model, { today, diseases, papers, grants, candidates }), AbortSignal.timeout(Math.max(1000, left() - CHECKS_RESERVE_MS)));
    answer = readResponse(raw);
  } catch (error) {
    deps.log(`OpenAI call failed: ${(error as Error)?.name === "TimeoutError" ? "timed out" : (error as Error)?.message}`);
    return errorBody("upstream_failed");
  }
  const draft = answer.status === "completed" ? parseDraft(answer.text) : null;
  if (!draft) {
    deps.log(`OpenAI answer unusable: status ${answer.status || "unknown"}${answer.refusal ? ", refused" : ""}`);
    return errorBody("upstream_failed");
  }

  // 3. Deterministic checks: ids and names, links against what the search consulted, then the pages themselves.
  onProgress?.({ type: "progress", step: "check" });
  const supplied = [...papers.map((p) => p.url), ...grants.map((g) => g.url)];
  const allowed = allowList([...answer.consulted, ...answer.cited, ...supplied]);
  const screened = screenDraft(draft.contacts, candidates, allowed);
  const urls = pagesToFetch(screened.kept, papers);
  const pageSignal = AbortSignal.timeout(Math.min(PAGE_MS, left()));
  const read = await Promise.all(urls.map((url) => deps.fetchPage(url, pageSignal).catch(() => null)));
  const pages = new Map<string, PageResult>();
  read.forEach((page, i) => {
    if (page) pages.set(urlKey(urls[i]) ?? urls[i], page);
    if (!page?.ok) deps.log(`page not read: ${hostOf(urls[i])} (${page?.reason ?? "error"})`);
  });
  const searched = searchedIds(candidates, answer.queries, answer.consulted);
  const final = finalizeContacts(screened.kept, pages, papers, searched);
  for (const line of [...screened.dropped, ...final.dropped]) deps.log(`dropped ${line}`);
  const unsearched = screened.kept.filter((s) => !searched.has(s.candidate.id)).map((s) => s.candidate.id);
  if (unsearched.length > 0) deps.log(`chosen without a web search for them: ${unsearched.join(", ")}`);
  const tokens = answer.tokens ? `, ${answer.tokens.input} input and ${answer.tokens.output} output tokens` : "";
  deps.log(
    `${diseaseIds.join("+")}: ${answer.searches} web search calls${tokens}, ${answer.consulted.length} pages consulted, ${draft.contacts.length} suggested, ${final.contacts.length} kept`,
  );
  return {
    contacts: final.contacts,
    summary: checkedSummary(draft.summary, final.contacts, candidates, recordTextOf(papers)),
    model: answer.model || model,
    diseases,
    searched: { papers: papers.map(paperRecord), grants: grants.map(grantRecord) },
    patient_groups: patientGroups(graph, diseaseIds),
    removed: {
      contacts: screened.removed.contacts,
      links: screened.removed.links + final.removed.links,
      emails: screened.removed.emails + final.removed.emails,
    },
    generated_at: new Date(now()).toISOString(),
  };
}

export type Started =
  | { kind: "answer"; body: ContactsBody }
  | { kind: "job"; result: Promise<ContactsBody>; listen(listener: (progress: ContactsProgress) => void): () => void };

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CACHE_ENTRIES = 300;
// Part of the cache key: raise it when the instructions or the checks change, so no answer made under the
// old rules is served again.
export const RULES_VERSION = 7;

const HOUR_MS = 60 * 60 * 1000;
const EVERYONE = "*";

export interface FinderConfig {
  deps: ContactDeps;
  model: () => string;
  hasKey: () => boolean;
  now?: () => number;
  cache?: TtlCache<ContactsResult>;
  rateLimit?: number; // new searches per client per window
  rateWindowMs?: number;
  hourlyLimit?: number; // new searches per hour for the whole server, whoever asks
  maxInFlight?: number;
}

interface Job {
  result: Promise<ContactsBody>;
  listen(listener: (progress: ContactsProgress) => void): () => void;
}

const inMinutes = (sec: number) => (sec <= 60 ? "in a minute" : `in ${Math.ceil(sec / 60)} minutes`);

// One finder per server process. Answers are cached by disease ids for 24 h; a question already running is
// joined instead of asked twice. Only a new question costs an OpenAI call, and each one must pass three
// limits: at most 2 calls at once, about 6 per client per 10 minutes, and a cap per hour for the whole
// server that no request header can change.
export function createContactFinder(config: FinderConfig) {
  const now = config.now ?? Date.now;
  const cache = config.cache ?? createTtlCache<ContactsResult>(CACHE_TTL_MS, CACHE_ENTRIES, now);
  const perClient = createRateLimiter(config.rateLimit ?? 6, config.rateWindowMs ?? 10 * 60 * 1000, now);
  const hourly = createRateLimiter(config.hourlyLimit ?? 30, HOUR_MS, now);
  const maxInFlight = config.maxInFlight ?? 2;
  const running = new Map<string, Job>();

  return {
    start({ graph, diseaseIds, client }: { graph: AtlasGraph; diseaseIds: unknown; client: string }): Started {
      const ids = validDiseaseIds(diseaseIds, graph);
      if (!ids) return { kind: "answer", body: errorBody("bad_request") };
      const plan = planSources(graph, ids);
      if (plan.papers.length === 0 && plan.grants.length === 0) return { kind: "answer", body: nothingToSearch(graph, ids) };
      const model = config.model();
      const key = `v${RULES_VERSION}|${model}|${[...ids].sort().join(",")}`;
      const cached = cache.get(key);
      if (cached) return { kind: "answer", body: cached };
      if (!config.hasKey()) return { kind: "answer", body: errorBody("no_key") };
      const joined = running.get(key);
      if (joined) return { kind: "job", ...joined };
      if (running.size >= maxInFlight) {
        return { kind: "answer", body: errorBody("rate_limited", "Other contact searches are running right now. Please try again in a moment.", 20) };
      }
      // Both limits are checked before either counts a use, so a refused request uses up nothing.
      const mine = perClient.check(client);
      if (!mine.ok) {
        return { kind: "answer", body: errorBody("rate_limited", `Too many new contact searches in a short time. Please try again ${inMinutes(mine.retryAfterSec)}.`, mine.retryAfterSec) };
      }
      const all = hourly.check(EVERYONE);
      if (!all.ok) {
        const message = `The contact finder has reached its limit of new searches for this hour. Diseases already looked up still open right away. Please try this one again ${inMinutes(all.retryAfterSec)}.`;
        return { kind: "answer", body: errorBody("rate_limited", message, all.retryAfterSec) };
      }
      perClient.take(client);
      hourly.take(EVERYONE);

      const listeners = new Set<(progress: ContactsProgress) => void>();
      let last: ContactsProgress | null = null;
      const onProgress = (progress: ContactsProgress) => {
        last = progress;
        for (const listener of listeners) listener(progress);
      };
      const result = findContacts({ graph, diseaseIds: ids, model, deps: config.deps, now, onProgress })
        .catch((error: unknown) => {
          config.deps.log(`contact finder failed: ${(error as Error)?.message}`);
          return errorBody("upstream_failed");
        })
        .then((body) => {
          if (!("error" in body)) cache.set(key, body);
          return body;
        })
        .finally(() => {
          running.delete(key);
          listeners.clear();
        });
      const job: Job = {
        result,
        listen(listener) {
          if (last) listener(last);
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      running.set(key, job);
      return { kind: "job", ...job };
    },
  };
}
