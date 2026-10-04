// PubMed records for the contact finder: one E-utilities efetch call and a careful regex reader for its
// XML (no XML dependency). Journal articles and book chapters (GeneReviews) are both read.
import type { Paper, PaperAuthor } from "./types.ts";
import { emailNamesPerson } from "./names.ts";
import { decodeEntities, findEmails, xmlText } from "./text.ts";

const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const ABSTRACT_CHARS = 800;
const MAX_XML_BYTES = 8_000_000;

export function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

// NCBI asks heavy users to identify themselves with `tool` and `email`; they are sent only when the server
// sets NCBI_TOOL / NCBI_EMAIL, because a made-up contact would be worse than none.
export function efetchUrl(pmids: string[], env: { NCBI_TOOL?: string; NCBI_EMAIL?: string } = {}): string {
  const params = new URLSearchParams({ db: "pubmed", id: pmids.join(","), retmode: "xml" });
  if (env.NCBI_TOOL) params.set("tool", env.NCBI_TOOL);
  if (env.NCBI_EMAIL) params.set("email", env.NCBI_EMAIL);
  return `${EFETCH}?${params}`;
}

export async function fetchPapers(pmids: string[], signal: AbortSignal, env: { NCBI_TOOL?: string; NCBI_EMAIL?: string } = {}): Promise<Paper[]> {
  if (pmids.length === 0) return [];
  const res = await fetch(efetchUrl(pmids, env), { signal, headers: { accept: "application/xml" } });
  if (!res.ok) throw new Error(`PubMed efetch answered ${res.status}`);
  const xml = await res.text();
  if (xml.length > MAX_XML_BYTES) throw new Error("PubMed efetch answer is too large");
  return parsePubmedXml(xml);
}

export function parsePubmedXml(xml: string): Paper[] {
  const papers: Paper[] = [];
  for (const match of xml.matchAll(/<(PubmedArticle|PubmedBookArticle)>([\s\S]*?)<\/\1>/g)) {
    const paper = match[1] === "PubmedArticle" ? readArticle(match[2]) : readBookChapter(match[2]);
    if (paper) papers.push(paper);
  }
  return papers;
}

// The inner text of the first <tag …>…</tag> (exact tag name, so "Article" never matches "ArticleTitle").
function element(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? match[1] : null;
}

function elements(xml: string, tag: string): { attrs: string; body: string }[] {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? "", body: m[2] }));
}

function text(xml: string | null): string {
  return xml === null ? "" : xmlText(xml);
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match ? decodeEntities(match[1]) : null;
}

function yearOf(dateXml: string | null): number | null {
  if (!dateXml) return null;
  const match = /(?:<Year>|<MedlineDate>)\s*(\d{4})/.exec(dateXml);
  return match ? Number(match[1]) : null;
}

function readArticle(xml: string): Paper | null {
  const pmid = text(element(xml, "PMID"));
  const article = element(xml, "Article");
  if (!/^\d+$/.test(pmid) || article === null) return null;
  const journal = element(article, "Journal") ?? "";
  return {
    pmid,
    url: pubmedUrl(pmid),
    title: text(element(article, "ArticleTitle")),
    journal: text(element(journal, "Title")) || text(element(journal, "ISOAbbreviation")),
    year: yearOf(element(journal, "PubDate")) ?? yearOf(element(article, "ArticleDate")),
    abstract: readAbstract(element(article, "Abstract")),
    authors: readAuthors(element(article, "AuthorList")),
  };
}

// GeneReviews chapters are revised for years after they first appear, so the last revision dates them.
function readBookChapter(xml: string): Paper | null {
  const doc = element(xml, "BookDocument");
  if (doc === null) return null;
  const pmid = text(element(doc, "PMID"));
  if (!/^\d+$/.test(pmid)) return null;
  const book = element(doc, "Book") ?? "";
  const outsideBook = doc.replace(/<Book(?:\s[^>]*)?>[\s\S]*?<\/Book>/, "");
  const authorList = elements(outsideBook, "AuthorList").find((list) => attr(list.attrs, "Type") !== "editors");
  return {
    pmid,
    url: pubmedUrl(pmid),
    title: text(element(outsideBook, "ArticleTitle")),
    journal: text(element(book, "BookTitle")),
    year: yearOf(element(doc, "DateRevised")) ?? yearOf(element(doc, "ContributionDate")) ?? yearOf(element(book, "PubDate")),
    abstract: readAbstract(element(outsideBook, "Abstract")),
    authors: readAuthors(authorList?.body ?? null),
  };
}

function readAbstract(xml: string | null): string {
  if (!xml) return "";
  const parts = elements(xml, "AbstractText").map(({ attrs, body }) => {
    const label = attr(attrs, "Label");
    const part = text(body);
    return label && part ? `${label.charAt(0)}${label.slice(1).toLowerCase()}: ${part}` : part;
  });
  const whole = parts.filter(Boolean).join(" ");
  if (whole.length <= ABSTRACT_CHARS) return whole;
  return `${whole.slice(0, ABSTRACT_CHARS).replace(/\s+\S*$/, "")}…`;
}

// People only: group authors (<CollectiveName>) and entries PubMed marks invalid are skipped.
function readAuthors(xml: string | null): PaperAuthor[] {
  if (!xml) return [];
  const authors: PaperAuthor[] = [];
  for (const { attrs, body } of elements(xml, "Author")) {
    if (attr(attrs, "ValidYN") === "N") continue;
    const lastName = text(element(body, "LastName"));
    if (!lastName) continue;
    const affiliations = elements(body, "Affiliation").map((a) => text(a.body));
    authors.push({
      lastName,
      foreName: text(element(body, "ForeName")) || text(element(body, "Initials")),
      affiliation: affiliations[0] ?? "",
      emails: findEmails(affiliations.join(" ")),
      orcid: readOrcid(body),
    });
  }
  // Some records print one affiliation, addresses and all, for several authors (PMID 25146916 gives both
  // of its corresponding authors both emails). Such an address stays only with the author whose name it
  // carries, so no one is shown a co-author's email as their own.
  const holders = (email: string) => authors.filter((a) => a.emails.some((e) => e.toLowerCase() === email.toLowerCase())).length;
  return authors.map((a) => ({
    ...a,
    emails: a.emails.filter((e) => holders(e) === 1 || emailNamesPerson(e, { firstName: a.foreName, lastName: a.lastName })),
  }));
}

function readOrcid(authorXml: string): string | null {
  const id = elements(authorXml, "Identifier").find((i) => attr(i.attrs, "Source") === "ORCID");
  const digits = id ? text(id.body).replace(/^.*orcid\.org\//i, "").replace(/[^0-9X]/gi, "").toUpperCase() : "";
  return digits.length === 16 ? digits.match(/.{4}/g)!.join("-") : null;
}
