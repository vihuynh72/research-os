import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Contact } from "./types.ts";
import type { DraftContact } from "./openai.ts";
import type { PageResult } from "./page.ts";
import { buildCandidates } from "./candidates.ts";
import { parsePubmedXml } from "./pubmed.ts";
import { mapReporter } from "./reporter.ts";
import { allowList, urlKey } from "./urls.ts";
import {
  UNREAD_PAGE,
  checkedNote,
  checkedSummary,
  checkedWhy,
  finalizeContacts,
  isSharedMailbox,
  pagesToFetch,
  plainWhy,
  recordWhy,
  screenDraft,
  searchedIds,
  shortRole,
  sourceCheck,
} from "./verify.ts";

const papers = parsePubmedXml(readFileSync(new URL("./fixtures/efetch.xml", import.meta.url), "utf8")).filter((p) => p.pmid === "35145305");
const grants = mapReporter(JSON.parse(readFileSync(new URL("./fixtures/reporter.json", import.meta.url), "utf8")), ["8593531"]);
const candidates = buildCandidates(papers, grants); // c1 Sena-Esteves (senior), c2 Flotte (first), c3 Dersh (grant)

const draft = (over: Partial<DraftContact>): DraftContact => ({
  candidate_id: "c1",
  name: "Miguel Sena-Esteves",
  role: "Professor of Neurology",
  institution: "UMass Chan Medical School",
  why: "Senior author of a 2022 paper on gene therapy for Tay-Sachs disease.",
  profile_url: null,
  lab_url: null,
  email: null,
  email_source_url: null,
  confidence: "high",
  note: null,
  ...over,
});

const LAB = "https://www.umassmed.edu/sena-esteves-lab/";
const FLOTTE = "https://profiles.umassmed.edu/display/flotte";
const PDF = "https://www.umassmed.edu/files/job-posting.pdf";
const SENA_FACULTY = "https://www.umassmed.edu/cancer-center/research/research-faculty-staff/sena-esteves-miguel/";
const BY_NUMBER = "https://directory.umassmed.edu/main?p_id=22336";
const allowed = allowList([
  `${LAB}?utm_source=openai`,
  FLOTTE,
  "https://flotte-lab.example.edu/",
  "https://www.linkedin.com/in/x",
  "https://pubmed.ncbi.nlm.nih.gov/35145305/",
  PDF,
  SENA_FACULTY,
  BY_NUMBER,
]);

const filler = "Our group develops gene therapies for inherited disorders of the nervous system. ".repeat(4);
const page = (url: string, html: string, ok = true): PageResult => ({ url, finalUrl: url, ok, status: ok ? 200 : 403, html: ok ? html : "" });
const pagesOf = (...list: PageResult[]) => new Map(list.map((p) => [urlKey(p.url)!, p]));

test("a person is kept only with a real candidate id and that candidate's name, once", () => {
  const { kept, removed } = screenDraft(
    [
      draft({}),
      draft({ candidate_id: "c9" }),
      draft({ candidate_id: "c2", name: "Miguel Sena-Esteves" }),
      draft({ candidate_id: "c1", name: "M. Sena-Esteves" }),
      draft({ candidate_id: "c2", name: "Terence R. Flotte" }),
    ],
    candidates,
    allowed,
  );
  assert.deepEqual(
    kept.map((k) => k.candidate.id),
    ["c1", "c2"],
  );
  assert.equal(removed.contacts, 3, "unknown id, someone else's name, and a repeat");
});

test("a link is kept only if the search consulted it and it is an official page; tracking is removed", () => {
  const { kept, removed, dropped } = screenDraft(
    [
      draft({ profile_url: `${LAB}?utm_source=openai#top`, lab_url: LAB }),
      draft({ candidate_id: "c2", name: "Terence Flotte", profile_url: "https://www.linkedin.com/in/x", lab_url: "https://made-up.example.edu/flotte" }),
      draft({ candidate_id: "c3", name: "Devin Dersh", profile_url: PDF }),
    ],
    candidates,
    allowed,
  );
  assert.equal(kept[0].profileUrl, LAB);
  assert.equal(kept[0].labUrl, null, "the same page twice is shown once");
  assert.deepEqual([kept[1].profileUrl, kept[1].labUrl], [null, null]);
  assert.equal(kept[2].profileUrl, null, "a consulted PDF is still a document, not a profile");
  assert.equal(removed.links, 3, "LinkedIn is never a profile; one was never consulted; one is a document");
  assert.deepEqual(dropped, [
    "c2 profile linkedin.com/in/x: not an official page",
    "c2 lab made-up.example.edu/flotte: not among the pages the search consulted",
    "c3 profile umassmed.edu/files/job-posting.pdf: a document, not a page",
  ]);
});

test("pages to open: each person's main page first, then a page said to print a new email, then labs; four at most", () => {
  const { kept } = screenDraft(
    [
      draft({ profile_url: LAB, email: "miguel.esteves@umassmed.edu" }),
      draft({ candidate_id: "c2", name: "Terence Flotte", lab_url: "https://flotte-lab.example.edu/", profile_url: null, email: "tflotte@umassmed.edu", email_source_url: FLOTTE }),
    ],
    candidates,
    allowed,
  );
  assert.deepEqual(pagesToFetch(kept, papers), [LAB, "https://flotte-lab.example.edu/", FLOTTE]);
  assert.deepEqual(pagesToFetch(kept, papers, 1), [LAB]);
});

test("a read page that names the person confirms the link; one that does not removes it; one that could not be read is marked", () => {
  const { kept } = screenDraft(
    [
      draft({ profile_url: LAB }),
      draft({ candidate_id: "c2", name: "Terence R. Flotte", profile_url: FLOTTE, lab_url: "https://flotte-lab.example.edu/" }),
    ],
    candidates,
    allowed,
  );
  const pages = pagesOf(
    page(LAB, `<h1>Miguel Sena-Esteves, PhD</h1><p>${filler}</p>`),
    page(FLOTTE, "", false),
    page("https://flotte-lab.example.edu/", `<h1>Lab news</h1><p>${filler}</p>`),
  );
  const { contacts, removed } = finalizeContacts(kept, pages, papers);
  const [sena, flotte] = contacts;
  assert.deepEqual(sena.profile_check, { ok: true, text: "Name found on umassmed.edu profile" });
  assert.equal(sena.name_on_page, true);
  assert.equal(sena.confidence, "high");
  assert.equal(flotte.profile_url, FLOTTE, "unread, but its address names him");
  assert.deepEqual(flotte.profile_check, { ok: false, text: UNREAD_PAGE });
  assert.equal(UNREAD_PAGE, "We couldn't open this page to check it. Its address includes their name.");
  assert.equal(flotte.lab_url, null, "the lab page was read and does not name him");
  assert.equal(flotte.name_on_page, false);
  assert.equal(flotte.confidence, "medium", "nothing confirmed on a page: never high");
  assert.equal(removed.links, 1);
});

test("a page that could not be read stays only when its own address names the person", () => {
  const { kept } = screenDraft(
    [draft({ profile_url: SENA_FACULTY }), draft({ candidate_id: "c2", name: "Terence Flotte", profile_url: BY_NUMBER })],
    candidates,
    allowed,
  );
  // Both sites refuse automatic readers (a bot wall answers 403).
  const blocked = pagesOf(page(SENA_FACULTY, "", false), page(BY_NUMBER, "", false));
  const { contacts, removed, dropped } = finalizeContacts(kept, blocked, papers);
  const [sena, flotte] = contacts;
  assert.equal(sena.profile_url, SENA_FACULTY, "…/sena-esteves-miguel/ says whose page it is");
  assert.equal(sena.profile_check?.ok, false);
  assert.equal(flotte.profile_url, null, "…/main?p_id=22336 could be anyone's");
  assert.equal(removed.links, 1);
  assert.deepEqual(dropped, ["c2 profile directory.umassmed.edu/main?p_id=22336: could not be read, and its address does not name them"]);
  const read = finalizeContacts(kept, pagesOf(page(BY_NUMBER, `<h1>Terence R. Flotte, MD</h1><p>${filler}</p>`)), papers);
  assert.equal(read.contacts.find((c) => c.candidate_id === "c2")?.profile_url, BY_NUMBER, "once read and naming him, any address is fine");
});

test("an email stays only when PubMed prints it for this person or a confirmed official page shows it", () => {
  const { kept } = screenDraft(
    [
      draft({ profile_url: LAB, email: "MIGUEL.ESTEVES@umassmed.edu" }),
      draft({ candidate_id: "c2", name: "Terence Flotte", profile_url: FLOTTE, email: "tflotte@umassmed.edu", email_source_url: FLOTTE }),
      draft({ candidate_id: "c3", name: "Devin Dersh", why: "Led an NIH grant on Tay-Sachs disease in 2013.", email: "devin.dersh@nih.gov", confidence: "medium" }),
    ],
    candidates,
    allowed,
  );
  const pages = pagesOf(page(LAB, `<h1>Miguel Sena-Esteves</h1><p>${filler}</p>`), page(FLOTTE, `<h1>Terence R. Flotte, MD</h1><p>${filler}</p><a href="mailto:tflotte@umassmed.edu">Email</a>`));
  const { contacts, removed } = finalizeContacts(kept, pages, papers);
  const [sena, flotte, dersh] = contacts;
  assert.equal(sena.email, "Miguel.esteves@umassmed.edu", "PubMed's spelling");
  assert.deepEqual(sena.email_check, { ok: true, text: "Email printed on the 2022 paper (PubMed)" });
  assert.equal(sena.email_source_url, "https://pubmed.ncbi.nlm.nih.gov/35145305/");
  assert.equal(flotte.email, "tflotte@umassmed.edu");
  assert.deepEqual(flotte.email_check, { ok: true, text: "Email shown on the profiles.umassmed.edu page that names them" });
  assert.equal(dersh.email, null, "printed nowhere we could read");
  assert.equal(dersh.confidence, "low", "no way to reach him was confirmed");
  assert.equal(removed.emails, 1);
});

test("an address on a page is the person's only when it carries their name, or is the only one and not an office's", () => {
  const shared = `<h1>Miguel Sena-Esteves</h1><p>${filler}</p><p>Department office: neuro-info@umassmed.edu</p><a href="mailto:Miguel.Esteves@umassmed.edu">Email</a>`;
  const { kept } = screenDraft([draft({ profile_url: LAB, email: "neuro-info@umassmed.edu" })], candidates, allowed);
  const [sena] = finalizeContacts(kept, pagesOf(page(LAB, shared)), papers).contacts;
  assert.equal(sena.email, "Miguel.Esteves@umassmed.edu", "the office address is not his; his own, on the same page, is offered");
  assert.deepEqual(sena.email_check, { ok: true, text: "Email shown on the umassmed.edu page that names them" });

  const own = screenDraft([draft({ candidate_id: "c2", name: "Terence Flotte", profile_url: FLOTTE, email: "terry.f@umassmed.edu" })], candidates, allowed).kept;
  const single = pagesOf(page(FLOTTE, `<h1>Terence R. Flotte, MD</h1><p>${filler}</p><p>Contact: terry.f@umassmed.edu</p>`));
  assert.equal(finalizeContacts(own, single, papers).contacts[0].email, "terry.f@umassmed.edu", "the one address on his own page");

  const office = screenDraft([draft({ candidate_id: "c2", name: "Terence Flotte", profile_url: FLOTTE, email: "tf-office@umassmed.edu" })], candidates, allowed).kept;
  const officeOnly = pagesOf(page(FLOTTE, `<h1>Terence R. Flotte, MD</h1><p>${filler}</p><p>Contact: tf-office@umassmed.edu</p>`));
  assert.equal(finalizeContacts(office, officeOnly, papers).contacts[0].email, "Terry.Flotte@umassmed.edu", "an office's mailbox is not his, even alone; PubMed's is offered");
  const busy = pagesOf(page(FLOTTE, `<h1>Terence R. Flotte, MD</h1><p>${filler}</p><p>terry.f@umassmed.edu · dean-office@umassmed.edu</p>`));
  assert.equal(finalizeContacts(own, busy, papers).contacts[0].email, "Terry.Flotte@umassmed.edu", "among several, an address without his name is not trusted");
});

test("an office's mailbox is told by its words", () => {
  for (const email of ["info@chu.fr", "neuro-info@umassmed.edu", "secretariat.genetics@uni.it", "contact@cats.org", "dean-office@umassmed.edu", "noreply@uni.edu", "Lab.Admin@uni.edu"]) {
    assert.ok(isSharedMailbox(email), email);
  }
  for (const email of ["terry.f@umassmed.edu", "mberger@chu-clermontferrand.fr", "toroc@mail.nih.gov", "informatics.lee@uni.edu"]) {
    assert.ok(!isSharedMailbox(email), email);
  }
});

test("with no page read, PubMed's record of the person's email is offered", () => {
  const { kept } = screenDraft([draft({ profile_url: LAB })], candidates, allowed);
  const [unread] = finalizeContacts(kept, new Map(), papers).contacts;
  assert.equal(unread.email, "Miguel.esteves@umassmed.edu");
  const flotte = screenDraft([draft({ candidate_id: "c2", name: "Terence Flotte", email: "tflotte@umassmed.edu" })], candidates, allowed).kept;
  const { contacts, removed } = finalizeContacts(flotte, new Map(), papers);
  assert.equal(contacts[0].email, "Terry.Flotte@umassmed.edu", "the model's unconfirmed guess is replaced by PubMed's");
  assert.equal(removed.emails, 1);
});

test("the model's role and institution show only when a page we read names the person; otherwise our record speaks", () => {
  const long = "Provost and Executive Deputy Chancellor; Dean, T.H. Chan School of Medicine";
  const { kept } = screenDraft(
    [draft({ profile_url: LAB, role: "Professor of Neurology" }), draft({ candidate_id: "c2", name: "Terence Flotte", profile_url: FLOTTE, role: long, institution: "UMass Chan" })],
    candidates,
    allowed,
  );
  const [sena, flotte] = finalizeContacts(kept, pagesOf(page(LAB, `<h1>Miguel Sena-Esteves</h1><p>${filler}</p>`), page(FLOTTE, "", false)), papers).contacts;
  assert.deepEqual([sena.role, sena.institution], ["Professor of Neurology", "UMass Chan Medical School"]);
  assert.deepEqual([flotte.role, flotte.institution], ["", ""], "his page could not be read, so the model's words are not shown");
  assert.deepEqual(flotte.affiliation, {
    text: "Department of Pediatrics, UMass Chan Medical School, Worcester, MA, USA",
    institution: "UMass Chan Medical School",
    kind: "paper",
    year: 2022,
    url: "https://pubmed.ncbi.nlm.nih.gov/35145305/",
  });
  assert.equal(shortRole(long), "Provost and Executive Deputy Chancellor");
  assert.equal(shortRole("Distinguished Professor of Pediatrics, Molecular Genetics and Microbiology, and Medicine"), "Distinguished Professor of Pediatrics, Molecular Genetics…");
});

test("model prose with contact details of its own is not shown; a reason that names the wrong year is replaced", () => {
  const { kept } = screenDraft(
    [draft({ candidate_id: "c2", name: "Terence Flotte", why: "First author of the 2021 trial.", note: "Write to t.flotte@example.com.", role: "Dean, call 508-856-1234" })],
    candidates,
    allowed,
  );
  const [flotte] = finalizeContacts(kept, new Map(), papers).contacts;
  assert.equal(flotte.why, "First author of the paper “AAV gene therapy for Tay-Sachs disease” (2022).");
  assert.equal(flotte.note, null);
  assert.equal(flotte.role, "");
  assert.deepEqual(flotte.source_check, { ok: true, text: "Listed as first author on the paper (PubMed)" });
});

test("a note is shown only as a checked fact about the person", () => {
  const records = "AAV gene therapy for Tay-Sachs disease.";
  const sena = candidates[0];
  assert.equal(checkedNote("His lab works on both Tay-Sachs and Sandhoff disease.", sena, records, true), "His lab works on both Tay-Sachs and Sandhoff disease.");
  assert.equal(checkedNote("Sena-Esteves now also studies Canavan disease.", sena, records, true), "Sena-Esteves now also studies Canavan disease.", "it names him");
  assert.equal(checkedNote("Leads the Tay-Sachs Gene Therapy Consortium.", sena, records, true), null, "no subject: a claim about no one in particular");
  assert.equal(checkedNote("The hospital’s lysosomal disease center describes work related to Gaucher disease.", sena, records, true), null, "about a centre's page");
  assert.equal(checkedNote("The current page found confirms his background.", sena, records, true), null, "about the search");
  assert.equal(checkedNote("He runs a clinical trial that could cure it.", sena, records, true), null, "a trial and a cure his records never mention");
  assert.equal(checkedNote("His lab works on both diseases.", sena, records, false), null, "the web search never looked for him");
  const { kept } = screenDraft([draft({ note: "The current page found confirms his research background." })], candidates, allowed);
  const { contacts, dropped } = finalizeContacts(kept, new Map(), papers);
  assert.equal(contacts[0].note, null);
  assert.deepEqual(dropped, ["c1 note: not a checked fact about them"]);
  const unsearched = screenDraft([draft({ note: "His lab works on both diseases." })], candidates, allowed).kept;
  assert.equal(finalizeContacts(unsearched, new Map(), papers, new Set(["c2"])).contacts[0].note, null);
  assert.equal(finalizeContacts(unsearched, new Map(), papers, new Set(["c1"])).contacts[0].note, "His lab works on both diseases.");
});

test("whom the web search looked for: a query naming them, or a consulted page whose address does", () => {
  const ids = searchedIds(candidates, ["Miguel Sena-Esteves UMass Chan Medical School", "gene therapy Tay-Sachs"], ["https://www.umassmed.edu/chancellor/organization-chart/terence-r-flotte-md/"]);
  assert.deepEqual([...ids].sort(), ["c1", "c2"]);
  assert.deepEqual([...searchedIds(candidates, ["Devin Dersh Penn"], [])], ["c3"]);
  assert.deepEqual([...searchedIds(candidates, [], [])], []);
});

test("a reason may not credit a record with a kind of work its title and abstract never name", () => {
  // The GeneReviews chapter "Gaucher Disease" is an overview. Its first author does lead gene therapy work,
  // but not in this record (seen live, 2026-10-03).
  const chapter = parsePubmedXml(readFileSync(new URL("./fixtures/efetch.xml", import.meta.url), "utf8")).filter((p) => p.pmid === "20301446");
  const [, hughes] = buildCandidates(chapter, []);
  const wrong = "First author of a 2023 paper describing a study of a potential gene therapy for Gaucher disease type 1.";
  assert.equal(checkedWhy(wrong, hughes.sources), null);
  assert.equal(checkedWhy("First author of a 2023 overview of Gaucher disease for doctors and families.", hughes.sources), "First author of a 2023 overview of Gaucher disease for doctors and families.");
  assert.equal(checkedWhy("Led a 2022 clinical trial of a cure.", candidates[0].sources), null, "the AAV paper's title names a gene therapy, not a trial or a cure");
  assert.ok(checkedWhy("Senior author of a 2022 paper on gene therapy for Tay-Sachs disease.", candidates[0].sources));
  assert.equal(hughes.id, "c2");
  const kept = screenDraft([draft({ candidate_id: "c2", name: "Derralynn Hughes", why: wrong })], [hughes], allowed).kept;
  const [card] = finalizeContacts(kept, new Map(), chapter).contacts;
  assert.equal(card.why, "First author of the paper “Gaucher Disease” (2023).", "our own record's words instead");
});

test("reasons are checked against the person's own records, then said in plain words", () => {
  const [sena, , dersh] = candidates;
  assert.equal(checkedWhy("Senior author of a 2022 paper (PMID 35145305).", sena.sources), "Senior author of a 2022 paper (PMID 35145305).");
  assert.equal(checkedWhy("Senior author of a 2019 paper.", sena.sources), null);
  assert.equal(checkedWhy("Author of PMID 12345.", sena.sources), null);
  assert.equal(checkedWhy("", sena.sources), null);
  assert.equal(plainWhy("Senior author of a 2022 paper (PMID 35145305)."), "Senior author of a 2022 paper.");
  assert.equal(plainWhy("Senior author of a 2022 GeneReviews article about Sandhoff disease."), "Senior author of a 2022 medical overview about Sandhoff disease.");
  assert.equal(plainWhy("First author of PMID 35145305, a 2022 paper."), "First author of a 2022 paper.");
  assert.equal(plainWhy("Senior author, PMID 35145305."), "Senior author.");
  assert.equal(recordWhy(dersh.sources[0]), "Leads the NIH research grant “Endoplasmic reticulum quality control of mutant HexA enzyme in Tay-Sachs disease” (2013).");
  assert.deepEqual(sourceCheck(dersh.sources[0]), { ok: true, text: "Listed as the lead of the grant (NIH RePORTER)" });
  assert.deepEqual(sourceCheck(sena.sources[0]), { ok: true, text: "Listed as senior author on the paper (PubMed)" });
  const { kept } = screenDraft([draft({ why: "Senior author of a 2022 paper on gene therapy for Tay-Sachs disease (PMID 35145305)." })], candidates, allowed);
  assert.equal(finalizeContacts(kept, new Map(), papers).contacts[0].why, "Senior author of a 2022 paper on gene therapy for Tay-Sachs disease.");
});

test("the summary is built from the first person the family can reach, never from the model's own claims", () => {
  const card = (over: Partial<Contact>) => ({ candidate_id: "c1", name: "Miguel Sena-Esteves", role: "", institution: "", affiliation: null, why: "Senior author of a 2022 paper.", email: null, profile_url: null, lab_url: null, ...over }) as Contact;
  const sena = card({ email: "Miguel.esteves@umassmed.edu", affiliation: { text: "UMass Chan Medical School, Worcester, MA, USA", institution: "UMass Chan Medical School", kind: "paper", year: 2022, url: "u" } });
  const unreachable = card({ candidate_id: "c2", name: "Terence R Flotte" });
  const claim = "Contact Miguel Sena-Esteves first because he leads the Tay-Sachs Gene Therapy Consortium.";
  assert.equal(checkedSummary(claim, [unreachable, sena], candidates), "Start with Miguel Sena-Esteves at UMass Chan Medical School: senior author of a 2022 paper.");
  assert.equal(
    checkedSummary("", [card({ email: "x@y.edu", institution: "Kazan Federal University", why: "NIH grant lead since 2013." })], candidates),
    "Start with Miguel Sena-Esteves at Kazan Federal University: NIH grant lead since 2013.",
    "an initial acronym keeps its capitals",
  );
  assert.match(checkedSummary(claim, [unreachable], candidates), /^No official page or email could be confirmed for these researchers yet\./);
  // With nobody suggested, the model may say why, if it names no one and claims nothing the records do not show.
  assert.equal(checkedSummary("None of these papers is about the disease itself.", [], candidates), "None of these papers is about the disease itself.");
  const nobody = /^No researcher from the linked papers and grants could be confirmed/;
  assert.match(checkedSummary("Flotte was the only option.", [], candidates), nobody);
  assert.match(checkedSummary("Ask Dr. Cynthia Tifft at NIH instead.", [], candidates), nobody);
  assert.match(checkedSummary("The 2019 trial is the best lead.", [], candidates), nobody);
  assert.match(checkedSummary("Write to x@y.edu.", [], candidates), nobody);
});
