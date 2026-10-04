// Words for the contact finder dialog: its title, footer, card labels, tips and the "Copy all" text. Pure, so
// the same sentences are tested once and shown everywhere.
import type { CandidateSource, Contact, ContactCheck, ContactsResult, ContactsStep, SearchedRecord } from "../../../lib/contacts/types.ts";

export const TOOLTIP = "Uses OpenAI to find the researchers behind the papers and grants linked here, then checks each contact.";

export function contactTitle(names: string[]): string {
  if (names.length === 0) return "Who to contact";
  return `Who to contact about ${names.length === 1 ? names[0] : `${names[0]} and ${names[1]}`}`;
}

// The footer on wide screens. Phones get SHORT_FOOTER, and the rest moves into "How we checked".
export function footerText(model: string | null): string {
  const found = model
    ? `Found by OpenAI ${model} with web search, then checked against PubMed and NIH records.`
    : "Uses OpenAI with web search, then checks each contact against PubMed and NIH records.";
  return `${found} Confirm before you write. RareVerse never sends messages for you.`;
}

export const SHORT_FOOTER = "Found with AI (OpenAI), then checked. Confirm before you write.";

export function howWeChecked(model: string | null): string[] {
  return [
    `${model ? `OpenAI ${model}` : "OpenAI"} looked among the authors and grant leads of the records RareVerse links here, and searched the web for their official pages.`,
    "RareVerse then checked each one: the person is on the paper or grant, each page was opened to look for their name, and each email is printed on a page that names them or in PubMed. Anything that failed was removed.",
    "“Contact details checked” means an official page we opened names them. “Partly checked” means we have a link or an email we could not confirm on a current page. “Not confirmed” means we found no current page.",
    "Confirm before you write. RareVerse never sends messages for you.",
  ];
}

// What the pill on a card measures: how sure we are that the links and email belong to this person, not how
// good a contact they are (the order and "Start here" say that).
export const CONFIDENCE_WORD: Record<Contact["confidence"], string> = {
  high: "Contact details checked",
  medium: "Contact details partly checked",
  low: "Contact details not confirmed",
};

export const CONFIDENCE_HINT = "How sure we are that these links and this email belong to this person.";

// A card a family can act on has at least one checked way to reach the person.
export const isReachable = (c: Contact) => !!(c.profile_url || c.lab_url || c.email);

// Why a role on a paper or grant matters, said once for each role the cards show.
const ROLE_HELP: Record<string, string> = {
  "senior author": "Senior author: usually the head of the lab that did the work.",
  "first author": "First author: usually the person who did most of the work.",
  "sole author": "Sole author: wrote the paper alone.",
  "corresponding author": "Corresponding author: the person the journal lists for questions about the paper.",
  "principal investigator": "Grant lead: the researcher NIH funds to run the project.",
  "co-principal investigator": "Grant co-lead: one of the researchers NIH funds to run the project.",
};

export function roleHelp(contacts: Contact[]): string[] {
  const lines: string[] = [];
  for (const c of contacts) {
    const line = ROLE_HELP[c.source.role];
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

export const BEFORE_YOU_WRITE = {
  title: "Before you write",
  tips: [
    "Say who you are and which disease you are writing about.",
    "Name the paper or grant you found here, so they know why you chose them.",
    "Ask whether they know of studies, trials or patient registries you could join.",
    "Keep it short. Replies can take weeks, so it is fine to write to more than one person.",
  ],
  caution: "Researchers can't give medical advice about a particular patient. For care, talk to your own doctor.",
};

const recordWord = (source: Pick<CandidateSource, "kind">) => (source.kind === "grant" ? "grant" : "paper");

// "Read the paper" or "See the grant": the link beside the reason. Its id and title go in the accessible name.
export function recordLink(source: CandidateSource): string {
  return source.kind === "grant" ? "See the grant" : "Read the paper";
}

// "Question about your Tay-Sachs disease research (2022 paper)", ready in the email's subject line.
export function emailSubject(diseaseNames: string[], source: CandidateSource): string {
  const what = source.kind === "grant" ? "NIH grant" : "paper";
  return `Question about your ${diseaseNames.length > 0 ? `${diseaseNames.join(" and ")} ` : ""}research (${source.year ? `${source.year} ` : ""}${what})`;
}

export function mailtoHref(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

// The line under a name: their current role and institution when an official page we read names them;
// otherwise where our record places them, and when.
export function whereLine(c: Contact): string {
  const current = [c.role, c.institution].filter(Boolean).join(" · ");
  if (current || !c.affiliation) return current;
  const a = c.affiliation;
  const place = a.institution || (a.text.length > 90 ? `${a.text.slice(0, 89).replace(/\s+\S*$/, "")}…` : a.text);
  return `${place} (on the ${a.year ? `${a.year} ` : ""}${recordWord(a)})`;
}

// The institution and the last two parts of the address after it, so a long affiliation stays short:
// "Unidad de Investigación…, Instituto Mexicano del Seguro Social, Guadalajara 44329, Jalisco, Mexico" →
// "Instituto Mexicano del Seguro Social, Jalisco, Mexico". Without a known institution, the text as printed.
export function shortAffiliation(a: { text: string; institution: string }): string {
  const at = a.institution ? a.text.indexOf(a.institution) : -1;
  if (at < 0) return a.institution || a.text;
  const after = a.text
    .slice(at + a.institution.length)
    .split(/[;,]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [a.institution, ...after.slice(-2)].join(", ");
}

// "Affiliation on the 2023 paper: University College, Dublin, Ireland", or with the affiliation in full.
export function affiliationLine(c: Contact, full = false): string {
  const a = c.affiliation;
  if (!a) return "";
  return `${a.kind === "grant" ? "Organization" : "Affiliation"} on the ${a.year ? `${a.year} ` : ""}${recordWord(a)}: ${full ? a.text : shortAffiliation(a)}`;
}

// "Senior author: Miguel Sena-Esteves, UMass Chan Medical School" under a record in "What we read".
export function leadLine(lead: NonNullable<SearchedRecord["lead"]>): string {
  return `${lead.role.charAt(0).toUpperCase()}${lead.role.slice(1)}: ${lead.name}${lead.place ? `, ${lead.place}` : ""}`;
}

// The check line shown once under two pages that could not be opened (see UNREAD_PAGE in lib/contacts/verify).
export const UNREAD_PAGES = "We couldn't open these pages to check them. Their addresses include the person's name.";

// Address segments that say nothing about whose page it is.
const GENERIC_SEGMENT = /^(?:index|main|home|default|view|display|page|pages|profile|profiles|people|person|staff|en|eng|english|faculty|show|detail|details|bio|about)$/i;

// Link text for a page: the site, then the last words of its address, so two links on one site can be told
// apart ("umassmed.edu" · "principal investigator"). An address that ends in an id or a generic word gives
// the site alone.
export function linkParts(url: string): { host: string; hint: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: url, hint: "" };
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean).reverse();
  for (const raw of segments) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // keep it as written
    }
    const words = segment.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+.]+/g, " ").trim();
    if (GENERIC_SEGMENT.test(words) || !/\p{L}{3}/u.test(words)) continue;
    return { host, hint: words.length > 40 ? `${words.slice(0, 39).replace(/\s+\S*$/, "")}…` : words };
  }
  return { host, hint: "" };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// A loading step, in the present while it runs and in the past once done.
export function stepText(step: ContactsStep, papers: number | null, grants: number | null, done = false): string {
  if (step === "search") return done ? "Searched the web for contact pages" : "Searching the web for contact pages";
  if (step === "check") return done ? "Checked each contact" : "Checking each contact";
  const verb = done ? "Read" : "Reading";
  if (papers === null) return `${verb} the linked papers from PubMed`;
  const read = papers > 0 ? `${verb} ${plural(papers, "paper", "papers")} from PubMed` : verb;
  return grants ? `${read}${papers > 0 ? " and" : ""} ${plural(grants, "grant", "grants")} from NIH` : read;
}

export const LOADING_NOTE = "This usually takes about 15 seconds. You can close this and come back.";

// "Our checks removed 1 suggested person, 2 links and 1 email that could not be confirmed." or "".
export function removedText(removed: ContactsResult["removed"]): string {
  const parts = [
    removed.contacts > 0 ? plural(removed.contacts, "suggested person", "suggested people") : "",
    removed.links > 0 ? plural(removed.links, "link", "links") : "",
    removed.emails > 0 ? plural(removed.emails, "email", "emails") : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Our checks removed ${list} that could not be confirmed.`;
}

// Plain text to paste into an email or a note: every contact, each detail with the check under it, as in the
// dialog, with the PubMed and NIH ids a researcher would look for.
export function contactsAsText(result: ContactsResult, title: string): string {
  const lines = [title, `RareVerse, ${result.generated_at.slice(0, 10)}. ${footerText(result.model)}`, ""];
  if (result.summary) lines.push(result.summary, "");
  const row = (label: string, value: string, check: ContactCheck | null) => {
    lines.push(`   ${label}: ${value}`);
    if (check) lines.push(`     ${check.ok ? "✓" : "–"} ${check.text}`);
  };
  const reachable = result.contacts.filter(isReachable);
  const unreached = result.contacts.filter((c) => !isReachable(c));
  reachable.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.name} (${CONFIDENCE_WORD[c.confidence].toLowerCase()})`);
    const current = [c.role, c.institution].filter(Boolean).join(", ");
    if (current) lines.push(`   ${current}`);
    if (c.affiliation) lines.push(`   ${affiliationLine(c, true)}`);
    lines.push(`   Why: ${c.why}`);
    row("Source", `${c.source.url} (${c.source.ref})`, c.source_check);
    if (c.profile_url) row("Profile", c.profile_url, c.profile_check);
    if (c.lab_url) row("Lab", c.lab_url, c.lab_check);
    if (c.email) row("Email", c.email, c.email_check);
    lines.push("");
  });
  if (unreached.length > 0) {
    lines.push(reachable.length > 0 ? "Also wrote about this (no official page or email found):" : "Researchers on these records (no official page or email found):");
    for (const c of unreached) {
      lines.push(`- ${c.name}. ${c.why}`);
      if (c.affiliation) lines.push(`  ${affiliationLine(c, true)}`);
      lines.push(`  Source: ${c.source.url} (${c.source.ref})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
