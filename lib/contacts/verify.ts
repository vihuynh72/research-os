// What the family sees is decided here, not by the model. The model suggests people, links and emails;
// these rules keep or drop each one against our own records and the pages themselves. Pure.
import type { Candidate, CandidateSource, Confidence, Contact, ContactCheck, Paper, RecordAffiliation } from "./types.ts";
import type { DraftContact } from "./openai.ts";
import type { PageResult } from "./page.ts";
import { MAX_CONTACTS } from "./openai.ts";
import { htmlToText, pageEmails } from "./html.ts";
import { emailNamesPerson, linkNamesPerson, nameMatches, nameOnPage, type PersonName } from "./names.ts";
import { cleanProse, fold, hasContactDetails, institutionOf, isEmail } from "./text.ts";
import { cleanUrl, hostOf, isAllowed, isDocument, isProfileHost, urlKey } from "./urls.ts";

export const MAX_PAGE_FETCHES = 4;
// Less text than this is a script-only shell or a bot wall, not a page that can be judged either way.
const MIN_PAGE_TEXT = 200;

// The check line under a link whose page could not be opened (a bot wall, a timeout). Such a link is kept
// only because its own address carries the person's name, and the line says exactly that.
export const UNREAD_PAGE = "We couldn't open this page to check it. Its address includes their name.";

export interface Removed {
  contacts: number;
  links: number;
  emails: number;
}

export interface Screened {
  draft: DraftContact;
  candidate: Candidate;
  profileUrl: string | null;
  labUrl: string | null;
  email: string | null; // well formed, not yet confirmed
  emailSourceUrl: string | null; // an allowed official page the model says prints the email
}

// "umassmed.edu/sena-esteveslab/lab-members/…" for the server log: what was dropped, without the scheme.
function shortLink(raw: string): string {
  const text = raw.replace(/^https?:\/\/(www\.)?/i, "");
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

// Step 1, before any page is opened. A person is dropped unless their id is on our candidate list and the
// name the model wrote is that candidate's. A link is dropped unless it is http(s), was among the pages the
// web search consulted or cited (or is a record we supplied), and is a page, not social media, a directory
// or a document. `dropped` says what went and why, for the server log.
export function screenDraft(
  drafts: DraftContact[],
  candidates: Candidate[],
  allowed: Set<string>,
): { kept: Screened[]; removed: Removed; dropped: string[] } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const removed: Removed = { contacts: 0, links: 0, emails: 0 };
  const dropped: string[] = [];
  const kept: Screened[] = [];
  const problem = (url: string | null): string | null => {
    if (!url) return "not a plain web link";
    if (!isAllowed(url, allowed)) return "not among the pages the search consulted";
    if (!isProfileHost(url)) return "not an official page";
    return isDocument(url) ? "a document, not a page" : null;
  };
  for (const draft of drafts) {
    const candidate = byId.get(draft.candidate_id);
    if (!candidate || kept.some((k) => k.candidate.id === candidate.id) || !nameMatches(draft.name, candidate)) {
      removed.contacts++;
      dropped.push(`${draft.candidate_id.slice(0, 8)}: not a candidate under that name, or named twice`);
      continue;
    }
    if (kept.length >= MAX_CONTACTS) break;
    const link = (raw: string | null, what: string): string | null => {
      if (!raw) return null;
      const url = cleanUrl(raw);
      const why = problem(url);
      if (!why) return url;
      removed.links++;
      dropped.push(`${candidate.id} ${what} ${shortLink(raw)}: ${why}`);
      return null;
    };
    const profileUrl = link(draft.profile_url, "profile");
    let labUrl = link(draft.lab_url, "lab");
    if (labUrl && profileUrl && urlKey(labUrl) === urlKey(profileUrl)) labUrl = null;
    const claimed = draft.email?.trim().replace(/^mailto:/i, "") || null;
    const email = claimed && isEmail(claimed) ? claimed : null;
    if (claimed && !email) {
      removed.emails++;
      dropped.push(`${candidate.id} email: not an email address`);
    }
    const sourceUrl = cleanUrl(draft.email_source_url);
    kept.push({ draft, candidate, profileUrl, labUrl, email, emailSourceUrl: problem(sourceUrl) ? null : sourceUrl });
  }
  return { kept, removed, dropped };
}

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The PubMed record that prints this email in this person's own affiliation, with PubMed's spelling of it.
function pubmedEmail(person: Candidate, email: string, papers: Paper[]): { email: string; paper: Paper } | null {
  for (const source of person.sources) {
    const paper = source.kind === "paper" ? papers.find((p) => `PMID:${p.pmid}` === source.id) : undefined;
    const author = paper?.authors.find((a) => fold(a.lastName) === fold(person.lastName) && a.emails.some((e) => sameEmail(e, email)));
    const printed = author?.emails.find((e) => sameEmail(e, email));
    if (paper && printed) return { email: printed, paper };
  }
  return null;
}

// Step 2: which pages to open, at most four. Each person's main page first, then a page said to print an
// email PubMed does not have, then lab pages.
export function pagesToFetch(kept: Screened[], papers: Paper[], max = MAX_PAGE_FETCHES): string[] {
  const urls: string[] = [];
  const add = (url: string | null) => {
    if (!url || !url.startsWith("https:") || urls.length >= max || urls.some((u) => urlKey(u) === urlKey(url))) return;
    urls.push(url);
  };
  for (const s of kept) add(s.profileUrl ?? s.labUrl);
  for (const s of kept) if (s.email && !pubmedEmail(s.candidate, s.email, papers)) add(s.emailSourceUrl);
  for (const s of kept) add(s.labUrl);
  return urls;
}

type Verdict = "found" | "unchecked" | "missing";
type EmailPick = { email: string; url: string; check: ContactCheck };

function judge(url: string | null, pages: Map<string, PageResult>, person: Candidate): { verdict: Verdict; page: PageResult | null } {
  const page = url ? pages.get(urlKey(url) ?? "") : undefined;
  if (!page?.ok) return { verdict: "unchecked", page: null };
  const text = htmlToText(page.html);
  if (text.length < MIN_PAGE_TEXT) return { verdict: "unchecked", page: null };
  return { verdict: nameOnPage(fold(text), person) ? "found" : "missing", page };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CONFIDENCE_ORDER: Confidence[] = ["low", "medium", "high"];
const lower = (a: Confidence, b: Confidence) => CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(a), CONFIDENCE_ORDER.indexOf(b))];

// The check line under the reason: the person's role on that record, in plain words. The record's id
// stays in the link's accessible name and in "Copy all".
export function sourceCheck(source: CandidateSource): ContactCheck {
  if (source.kind === "grant") {
    return { ok: true, text: source.role === "co-principal investigator" ? "Listed as a co-lead of the grant (NIH RePORTER)" : "Listed as the lead of the grant (NIH RePORTER)" };
  }
  return { ok: true, text: `Listed as ${source.role} on the paper (PubMed)` };
}

// The reason in plain words, from our records, for when the model's sentence cannot be used.
export function recordWhy(source: CandidateSource): string {
  const title = source.title.replace(/[.\s]+$/, "");
  const when = source.year ? ` (${source.year})` : "";
  if (source.kind === "grant") return `${source.role === "co-principal investigator" ? "Co-leads" : "Leads"} the NIH research grant “${title}”${when}.`;
  return `${capitalize(source.role)} of the paper “${title}”${when}.`;
}

// Kinds of work a sentence may credit only when the person's own records name them, so a reason or a note
// cannot give an overview a gene therapy or a trial it never mentions (the work may be real, but not that
// record's), and nothing promises a family a cure the records do not speak of.
const WORK_CLAIMS: { said: RegExp; shown: RegExp }[] = [
  { said: /\bgene[- ]therap/i, shown: /\bgene[- ]therap|\bgene transfer\b|\baav\b/i },
  { said: /\b(?:gene|genome|base|prime) editing\b|\bcrispr\b/i, shown: /\bediting\b|\bcrispr\b/i },
  { said: /\btrials?\b/i, shown: /\btrials?\b/i },
  { said: /\bcur(?:e|es|ed|ing)\b/i, shown: /\bcur(?:e|es|ed|ing|ative)\b/i },
];

function claimsUnsupportedWork(text: string, records: string): boolean {
  return WORK_CLAIMS.some((claim) => claim.said.test(text) && !claim.shown.test(records));
}

// The model's sentence is kept only when every year and PubMed id it mentions belongs to these records,
// and every kind of work it names appears in their text (title, and abstract for papers).
export function checkedWhy(why: string, sources: CandidateSource[], recordText: (source: CandidateSource) => string = (s) => s.title): string | null {
  if (!why) return null;
  const years = new Set(sources.map((s) => s.year).filter((y): y is number => y !== null));
  for (const m of why.matchAll(/\b(?:19|20)\d{2}\b/g)) if (!years.has(Number(m[0]))) return null;
  const pmids = new Set(sources.filter((s) => s.kind === "paper").map((s) => s.id));
  for (const m of why.matchAll(/\bPMID:?\s*(\d+)/gi)) if (!pmids.has(`PMID:${m[1]}`)) return null;
  return claimsUnsupportedWork(why, sources.map(recordText).join(" ")) ? null : why;
}

// A checked reason as a parent reads it: no PubMed ids (the link beside it carries the record) and no
// database names ("a 2022 GeneReviews article" → "a 2022 medical overview").
export function plainWhy(why: string): string {
  return why
    .replace(/\s*\(\s*PMID:?\s*\d+[^)]*\)/gi, "")
    .replace(/\s*\bPMID:?\s*\d+\s*,?/gi, " ")
    .replace(/\bGeneReviews®?(?:\s+(?:article|chapter|entry|review|summary|overview))?/gi, "medical overview")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/,([.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// The record the reason talks about, so its link points at the right paper or grant.
function sourceFor(why: string, sources: CandidateSource[]): CandidateSource {
  const pmid = /\bPMID:?\s*(\d+)/i.exec(why)?.[1];
  const byPmid = pmid ? sources.find((s) => s.id === `PMID:${pmid}`) : undefined;
  if (byPmid) return byPmid;
  const year = Number(/\b(?:19|20)\d{2}\b/.exec(why)?.[0] ?? 0);
  const kind = /\b(grant|NIH|funded|project)\b/i.test(why) ? "grant" : "paper";
  return (
    sources.find((s) => s.kind === kind && (!year || s.year === year)) ??
    sources.find((s) => s.kind === kind) ??
    sources[0]
  );
}

// "Provost and Executive Deputy Chancellor; Dean, T.H. Chan School of Medicine" → "Provost and Executive
// Deputy Chancellor": the first title only, about 60 characters at most.
export function shortRole(role: string): string {
  const first = role.split(";")[0].trim();
  return first.length <= 60 ? first : `${first.slice(0, 59).replace(/\s+\S*$/, "")}…`;
}

// Notes about pages or searches describe the search, not the person ("The hospital's centre describes…").
const SEARCH_TALK = /\b(?:web ?pages?|pages?|search(?:es|ed|ing)?|websites?|listings?|profiles?|describes?|mentions?)\b/i;
const ABOUT_SOMEONE = /\b(?:he|she|they|his|her|hers|their|theirs|him|them)\b/i;

// A note is shown only when it is a fact about the person (it names them, or says he, she or they), does not
// talk about pages or searches, credits them with no kind of work their records do not show, and the web
// search looked for them; a note about someone it never looked for can only come from the model's memory.
export function checkedNote(note: string, person: PersonName, records: string, searched: boolean): string | null {
  if (!note || !searched || SEARCH_TALK.test(note) || claimsUnsupportedWork(note, records)) return null;
  const namesThem = ` ${fold(note)} `.includes(` ${fold(person.lastName)} `);
  return namesThem || ABOUT_SOMEONE.test(note) ? note : null;
}

// Words that mark an office's mailbox ("info@", "secretariat@", "neuro-office@") rather than a person's.
const SHARED_MAILBOX = new Set([
  "info", "information", "contact", "contacts", "contactus", "secretariat", "secretary", "secretaria", "secretariaat",
  "sekretariat", "secretariado", "admin", "administration", "office", "enquiries", "enquiry", "inquiries", "inquiry",
  "hello", "webmaster", "communication", "communications", "press", "media", "reception", "accueil", "support", "help",
  "general", "mail", "noreply", "team", "lab", "labs",
]);

export function isSharedMailbox(email: string): boolean {
  const local = fold(email.split("@")[0]);
  return SHARED_MAILBOX.has(local.replace(/ /g, "")) || local.split(" ").some((word) => SHARED_MAILBOX.has(word));
}

// Where our records place the person: the record behind the reason first, then their others.
function recordAffiliation(person: Candidate, source: CandidateSource): RecordAffiliation | null {
  const from = [source, ...person.sources].find((s) => s.affiliation);
  return from ? { text: from.affiliation, institution: institutionOf(from.affiliation), kind: from.kind, year: from.year, url: from.url } : null;
}

// A card a family can act on has at least one checked way to reach the person.
const isReachable = (c: Contact) => !!(c.profile_url || c.lab_url || c.email);

// The words of a person's records: titles, and abstracts for papers.
export function recordTextOf(papers: Paper[]): (source: CandidateSource) => string {
  return (source) => `${source.title} ${papers.find((p) => `PMID:${p.pmid}` === source.id)?.abstract ?? ""}`;
}

// Whom the web search looked for: someone a query names, or whose name is in the address of a page it
// consulted.
export function searchedIds(candidates: Candidate[], queries: string[], consulted: string[]): Set<string> {
  const asked = queries.map((q) => ` ${fold(q)} `);
  const ids = new Set<string>();
  for (const c of candidates) {
    const last = fold(c.lastName);
    if ((last && asked.some((q) => q.includes(` ${last} `))) || consulted.some((url) => linkNamesPerson(url, c))) ids.add(c.id);
  }
  return ids;
}

// Step 3, with the pages read.
// A link stays when its page names the person. A page that could not be read stays, marked as not checked,
// only when its own address carries their name; a page that was read and does not name them goes.
// An email stays when PubMed prints it in the person's own affiliation, or when a read official page that
// names them shows it and it is theirs: it carries their name, or it is the only address the page shows and
// is not an office's mailbox.
// The model's role and institution are shown only when a page we read names the person; otherwise our
// records say where they worked. `searched` (ids the web search looked for) gates the notes; without it,
// everyone counts as searched.
export function finalizeContacts(
  kept: Screened[],
  pages: Map<string, PageResult>,
  papers: Paper[],
  searched?: Set<string>,
): { contacts: Contact[]; removed: Removed; dropped: string[] } {
  const removed: Removed = { contacts: 0, links: 0, emails: 0 };
  const dropped: string[] = [];
  const recordText = recordTextOf(papers);
  const contacts = kept.map((s): Contact => {
    const person = s.candidate;
    const profile = judge(s.profileUrl, pages, person);
    const lab = judge(s.labUrl, pages, person);
    const pageCheck = (url: string, verdict: Verdict, what: string): ContactCheck =>
      verdict === "found" ? { ok: true, text: `Name found on ${hostOf(url)} ${what}` } : { ok: false, text: UNREAD_PAGE };
    const keep = (url: string | null, verdict: Verdict, what: string): string | null => {
      if (!url || verdict === "found" || (verdict === "unchecked" && linkNamesPerson(url, person))) return url;
      removed.links++;
      dropped.push(`${person.id} ${what} ${shortLink(url)}: ${verdict === "missing" ? "the page does not name them" : "could not be read, and its address does not name them"}`);
      return null;
    };
    const profileUrl = keep(s.profileUrl, profile.verdict, "profile");
    const labUrl = keep(s.labUrl, lab.verdict, "lab");

    const fromPubmed = (hit: { email: string; paper: Paper }): EmailPick => ({
      email: hit.email,
      url: hit.paper.url,
      check: { ok: true, text: `Email printed on the ${hit.paper.year ? `${hit.paper.year} ` : ""}paper (PubMed)` },
    });
    const fromPage = (email: string, page: PageResult): EmailPick => ({
      email,
      url: page.url,
      check: { ok: true, text: `Email shown on the ${hostOf(page.url)} page that names them` },
    });
    // The model's email: proof from a current official page first, then from PubMed's record.
    let picked: EmailPick | null = null;
    if (s.email) {
      const claimed = s.email;
      for (const { verdict, page } of [profile, lab, judge(s.emailSourceUrl, pages, person)]) {
        if (verdict !== "found" || !page) continue;
        const shown = pageEmails(page.html);
        const printed = shown.find((e) => sameEmail(e, claimed));
        if (printed && (emailNamesPerson(printed, person) || (shown.length === 1 && !isSharedMailbox(printed)))) {
          picked = fromPage(printed, page);
          break;
        }
      }
      const inPubmed = picked ? null : pubmedEmail(person, claimed, papers);
      if (inPubmed) picked = fromPubmed(inPubmed);
      if (!picked) {
        removed.emails++;
        dropped.push(`${person.id} email at ${claimed.split("@")[1]}: not on a confirmed page as theirs, nor in PubMed`);
      }
    }
    // Otherwise an address their own official page prints with their name in it, then PubMed's record of
    // their address: both are verified, so they are offered even when the model left the email out. The
    // page is the more current.
    if (!picked) {
      for (const { verdict, page } of [profile, lab]) {
        const printed = verdict === "found" && page ? pageEmails(page.html).find((e) => emailNamesPerson(e, person)) : undefined;
        if (page && printed) {
          picked = fromPage(printed, page);
          break;
        }
      }
    }
    if (!picked && person.emails[0]) {
      const fromRecord = pubmedEmail(person, person.emails[0], papers);
      if (fromRecord) picked = fromPubmed(fromRecord);
    }

    const nameFound = profile.verdict === "found" || lab.verdict === "found";
    const ceiling: Confidence = nameFound ? "high" : profileUrl || labUrl || picked ? "medium" : "low";
    // Prose that tried to carry an address or number of its own is not shown at all.
    const prose = (value: string, max: number) => (hasContactDetails(value) ? "" : cleanProse(value, max));
    const checked = checkedWhy(prose(s.draft.why, 280), person.sources, recordText);
    const source = checked ? sourceFor(checked, person.sources) : person.sources[0];
    const why = (checked && plainWhy(checked)) || recordWhy(source);
    const draftNote = prose(s.draft.note ?? "", 240);
    const records = person.sources.map(recordText).join(" ");
    const note = checkedNote(draftNote, person, records, !searched || searched.has(person.id));
    if (draftNote && !note) dropped.push(`${person.id} note: not a checked fact about them`);
    return {
      candidate_id: person.id,
      name: person.name,
      role: nameFound ? shortRole(prose(s.draft.role, 120)) : "",
      institution: nameFound ? prose(s.draft.institution, 120) : "",
      affiliation: recordAffiliation(person, source),
      why,
      source,
      source_check: sourceCheck(source),
      profile_url: profileUrl,
      profile_check: profileUrl ? pageCheck(profileUrl, profile.verdict, "profile") : null,
      lab_url: labUrl,
      lab_check: labUrl ? pageCheck(labUrl, lab.verdict, "lab page") : null,
      email: picked?.email ?? null,
      email_source_url: picked?.url ?? null,
      email_check: picked?.check ?? null,
      name_on_page: nameFound,
      confidence: lower(s.draft.confidence, ceiling),
      note,
    };
  });
  // People with a way to reach them come first; otherwise the model's order (best first) stands.
  return { contacts: contacts.sort((a, b) => Number(isReachable(b)) - Number(isReachable(a))), removed, dropped };
}

// "Senior author of…" → "senior author of…", but "NIH grant…" stays as written.
const lowerFirst = (s: string) => (/^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// The summary names the first person the family can reach, with that card's checked reason, so it says
// nothing the cards do not. The model's own sentence is used only when it suggested no one, to say why,
// and then only if it names no one and its years, ids and kinds of work match our records.
export function checkedSummary(
  summary: string,
  contacts: Contact[],
  candidates: Candidate[],
  recordText: (source: CandidateSource) => string = (s) => s.title,
): string {
  const first = contacts.find(isReachable);
  if (first) {
    const where = first.institution || first.affiliation?.institution || "";
    return `Start with ${first.name}${where ? ` at ${where}` : ""}: ${lowerFirst(first.why)}`;
  }
  if (contacts.length > 0) return "No official page or email could be confirmed for these researchers yet. Below is where their papers and grants place them.";
  const text = hasContactDetails(summary) ? "" : cleanProse(summary, 300);
  const folded = ` ${fold(text)} `;
  const namesSomeone = /\b(?:Dr|Prof|Professor)\.?\s+\p{Lu}/u.test(text) || candidates.some((c) => folded.includes(` ${fold(c.lastName)} `));
  if (text && !namesSomeone && checkedWhy(text, candidates.flatMap((c) => c.sources), recordText)) return text;
  return "No researcher from the linked papers and grants could be confirmed, so no one is suggested yet.";
}
