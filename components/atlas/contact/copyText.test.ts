import test from "node:test";
import assert from "node:assert/strict";
import type { Contact, ContactsResult } from "../../../lib/contacts/types.ts";
import {
  BEFORE_YOU_WRITE,
  CONFIDENCE_WORD,
  SHORT_FOOTER,
  affiliationLine,
  contactTitle,
  contactsAsText,
  emailSubject,
  footerText,
  howWeChecked,
  leadLine,
  linkParts,
  mailtoHref,
  recordLink,
  removedText,
  roleHelp,
  shortAffiliation,
  stepText,
  whereLine,
} from "./copyText.ts";

const sena: Contact = {
  candidate_id: "c1",
  name: "Miguel Sena-Esteves",
  role: "",
  institution: "",
  affiliation: {
    text: "Horae Gene Therapy Center and The Li Weibo Institute for Rare Diseases Research, UMass Chan Medical School, Worcester, MA, USA",
    institution: "UMass Chan Medical School",
    kind: "paper",
    year: 2022,
    url: "https://pubmed.ncbi.nlm.nih.gov/35145305/",
  },
  why: "Senior author of a 2022 paper on gene therapy for Tay-Sachs disease.",
  source: {
    kind: "paper",
    id: "PMID:35145305",
    ref: "PMID 35145305",
    role: "senior author",
    title: "AAV gene therapy for Tay-Sachs disease.",
    year: 2022,
    url: "https://pubmed.ncbi.nlm.nih.gov/35145305/",
    affiliation: "Horae Gene Therapy Center and The Li Weibo Institute for Rare Diseases Research, UMass Chan Medical School, Worcester, MA, USA",
  },
  source_check: { ok: true, text: "Listed as senior author on the paper (PubMed)" },
  profile_url: "https://www.umassmed.edu/sena-esteveslab/lab-members/principal-investigator/",
  profile_check: { ok: false, text: "We couldn't open this page to check it. Its address includes their name." },
  lab_url: null,
  lab_check: null,
  email: "Miguel.esteves@umassmed.edu",
  email_source_url: "https://pubmed.ncbi.nlm.nih.gov/35145305/",
  email_check: { ok: true, text: "Email printed on the 2022 paper (PubMed)" },
  name_on_page: false,
  confidence: "medium",
  note: null,
};

const pastores: Contact = {
  ...sena,
  candidate_id: "c5",
  name: "Gregory M Pastores",
  affiliation: { text: "Clinical Professor, Medicine (Genetics), University College, Dublin, Ireland", institution: "University College", kind: "paper", year: 2023, url: "https://pubmed.ncbi.nlm.nih.gov/20301446/" },
  why: "Senior author of a 2023 medical overview of Gaucher disease.",
  source: { ...sena.source, id: "PMID:20301446", ref: "PMID 20301446", title: "Gaucher Disease", year: 2023, url: "https://pubmed.ncbi.nlm.nih.gov/20301446/" },
  profile_url: null,
  profile_check: null,
  email: null,
  email_source_url: null,
  email_check: null,
  confidence: "low",
};

const result: ContactsResult = {
  contacts: [sena, pastores],
  summary: "Start with Miguel Sena-Esteves at UMass Chan Medical School: senior author of a 2022 paper on gene therapy for Tay-Sachs disease.",
  model: "gpt-6-luna",
  diseases: [{ id: "MONDO:0010100", name: "Tay-Sachs disease" }],
  searched: { papers: [], grants: [] },
  patient_groups: [],
  removed: { contacts: 0, links: 2, emails: 1 },
  generated_at: "2026-10-03T12:00:00.000Z",
};

test("the dialog is titled with the full disease names", () => {
  assert.equal(contactTitle(["Tay-Sachs disease"]), "Who to contact about Tay-Sachs disease");
  assert.equal(contactTitle(["Tay-Sachs disease", "Sandhoff disease"]), "Who to contact about Tay-Sachs disease and Sandhoff disease");
  assert.equal(contactTitle([]), "Who to contact");
});

test("the footer names the model once it is known and always says to confirm; phones get one short line", () => {
  assert.equal(
    footerText("gpt-6-luna"),
    "Found by OpenAI gpt-6-luna with web search, then checked against PubMed and NIH records. Confirm before you write. RareVerse never sends messages for you.",
  );
  assert.match(footerText(null), /^Uses OpenAI with web search/);
  assert.equal(SHORT_FOOTER, "Found with AI (OpenAI), then checked. Confirm before you write.");
  const how = howWeChecked("gpt-6-luna");
  assert.match(how[0], /^OpenAI gpt-6-luna looked among the authors and grant leads/);
  assert.ok(how.some((line) => line.includes("“Partly checked” means")));
  assert.equal(how.at(-1), "Confirm before you write. RareVerse never sends messages for you.");
});

test("the pill says what it measures: the contact details, not the person", () => {
  assert.deepEqual(CONFIDENCE_WORD, { high: "Contact details checked", medium: "Contact details partly checked", low: "Contact details not confirmed" });
});

test("each role on the cards is explained once, in plain words", () => {
  const flotte = { ...sena, source: { ...sena.source, role: "first author" } };
  const dersh = { ...sena, source: { ...sena.source, kind: "grant" as const, role: "principal investigator" } };
  assert.deepEqual(roleHelp([sena, flotte, pastores, dersh]), [
    "Senior author: usually the head of the lab that did the work.",
    "First author: usually the person who did most of the work.",
    "Grant lead: the researcher NIH funds to run the project.",
  ]);
  assert.equal(recordLink(sena.source), "Read the paper");
  assert.equal(recordLink(dersh.source), "See the grant");
});

test("before writing: who you are, the paper, what to ask, what to expect, and no medical advice", () => {
  assert.equal(BEFORE_YOU_WRITE.tips.length, 4);
  assert.match(BEFORE_YOU_WRITE.tips.join(" "), /which disease.*paper or grant.*studies, trials or patient registries.*weeks/);
  assert.equal(BEFORE_YOU_WRITE.caution, "Researchers can't give medical advice about a particular patient. For care, talk to your own doctor.");
  const subject = emailSubject(["Tay-Sachs disease"], sena.source);
  assert.equal(subject, "Question about your Tay-Sachs disease research (2022 paper)");
  assert.equal(emailSubject(["Tay-Sachs disease", "Sandhoff disease"], { ...sena.source, kind: "grant", year: 2014 }), "Question about your Tay-Sachs disease and Sandhoff disease research (2014 NIH grant)");
  assert.equal(mailtoHref("Miguel.esteves@umassmed.edu", subject), "mailto:Miguel.esteves@umassmed.edu?subject=Question%20about%20your%20Tay-Sachs%20disease%20research%20(2022%20paper)");
});

test("under a name: the role from a page that names them, else where their record places them", () => {
  assert.equal(whereLine(sena), "UMass Chan Medical School (on the 2022 paper)");
  assert.equal(whereLine({ ...sena, role: "Professor of Hematology", institution: "CHU Clermont-Ferrand" }), "Professor of Hematology · CHU Clermont-Ferrand");
  assert.equal(
    whereLine({ ...sena, affiliation: { ...sena.affiliation!, institution: "" } }),
    "Horae Gene Therapy Center and The Li Weibo Institute for Rare Diseases Research, UMass… (on the 2022 paper)",
    "no institution known: the affiliation as printed, cut to one line",
  );
  assert.equal(whereLine({ ...sena, affiliation: null }), "");
  assert.equal(affiliationLine(pastores), "Affiliation on the 2023 paper: University College, Dublin, Ireland");
  assert.equal(affiliationLine(pastores, true), "Affiliation on the 2023 paper: Clinical Professor, Medicine (Genetics), University College, Dublin, Ireland");
  const long = "Unidad de Investigación Epidemiológica y en Servicios de Salud, Centro Médico Nacional de Occidente, Instituto Mexicano del Seguro Social, Guadalajara 44329, Jalisco, Mexico";
  assert.equal(shortAffiliation({ text: long, institution: "Instituto Mexicano del Seguro Social" }), "Instituto Mexicano del Seguro Social, Jalisco, Mexico");
  assert.equal(shortAffiliation({ text: "Department of Genetics, University of Pennsylvania", institution: "University of Pennsylvania" }), "University of Pennsylvania");
  assert.equal(shortAffiliation({ text: "Division of Pediatric Genetics", institution: "" }), "Division of Pediatric Genetics");
  assert.equal(affiliationLine({ ...pastores, affiliation: { ...pastores.affiliation!, kind: "grant", text: "University of Pennsylvania, Philadelphia, PA, United States", institution: "University of Pennsylvania" } }), "Organization on the 2023 grant: University of Pennsylvania, PA, United States");
  assert.equal(leadLine({ role: "senior author", name: "Gregory M Pastores", place: "University College" }), "Senior author: Gregory M Pastores, University College");
});

test("two links on one site are told apart by the end of their address", () => {
  assert.deepEqual(linkParts("https://www.umassmed.edu/sena-esteveslab/lab-members/principal-investigator/"), { host: "umassmed.edu", hint: "principal investigator" });
  assert.deepEqual(linkParts("https://www.umassmed.edu/cancer-center/research/research-faculty-staff/sena-esteves-miguel/"), { host: "umassmed.edu", hint: "sena esteves miguel" });
  assert.deepEqual(linkParts("https://kpfu.ru/main?p_id=22336&p_lang=2&p_type=2"), { host: "kpfu.ru", hint: "" }, "a generic word says nothing");
  assert.deepEqual(linkParts("https://example.edu/people/12345/index.html"), { host: "example.edu", hint: "" });
  assert.deepEqual(linkParts("https://www.unige.ch/medecine/dr-j%C3%A9r%C3%B4me-stirnemann"), { host: "unige.ch", hint: "dr jérôme stirnemann" });
  assert.deepEqual(linkParts("https://www.chu-clermontferrand.fr/centre-de-competences-maladies-lysosomales"), { host: "chu-clermontferrand.fr", hint: "centre de competences maladies…" });
  assert.deepEqual(linkParts("not a link"), { host: "not a link", hint: "" });
});

test("loading steps run in the present and are done in the past", () => {
  assert.equal(stepText("read", 4, 1), "Reading 4 papers from PubMed and 1 grant from NIH");
  assert.equal(stepText("read", 4, 1, true), "Read 4 papers from PubMed and 1 grant from NIH");
  assert.equal(stepText("read", 0, 2, true), "Read 2 grants from NIH");
  assert.equal(stepText("read", null, null), "Reading the linked papers from PubMed");
  assert.equal(stepText("search", null, null, true), "Searched the web for contact pages");
  assert.equal(stepText("check", null, null), "Checking each contact");
});

test("what the checks removed is said in plain words, or not at all", () => {
  assert.equal(removedText(result.removed), "Our checks removed 2 links and 1 email that could not be confirmed.");
  assert.equal(removedText({ contacts: 1, links: 0, emails: 0 }), "Our checks removed 1 suggested person that could not be confirmed.");
  assert.equal(removedText({ contacts: 0, links: 0, emails: 0 }), "");
});

test("Copy all gives every contact with where each detail was checked, and the record ids", () => {
  assert.equal(
    contactsAsText(result, "Who to contact about Tay-Sachs disease"),
    [
      "Who to contact about Tay-Sachs disease",
      "RareVerse, 2026-10-03. Found by OpenAI gpt-6-luna with web search, then checked against PubMed and NIH records. Confirm before you write. RareVerse never sends messages for you.",
      "",
      "Start with Miguel Sena-Esteves at UMass Chan Medical School: senior author of a 2022 paper on gene therapy for Tay-Sachs disease.",
      "",
      "1. Miguel Sena-Esteves (contact details partly checked)",
      "   Affiliation on the 2022 paper: Horae Gene Therapy Center and The Li Weibo Institute for Rare Diseases Research, UMass Chan Medical School, Worcester, MA, USA",
      "   Why: Senior author of a 2022 paper on gene therapy for Tay-Sachs disease.",
      "   Source: https://pubmed.ncbi.nlm.nih.gov/35145305/ (PMID 35145305)",
      "     ✓ Listed as senior author on the paper (PubMed)",
      "   Profile: https://www.umassmed.edu/sena-esteveslab/lab-members/principal-investigator/",
      "     – We couldn't open this page to check it. Its address includes their name.",
      "   Email: Miguel.esteves@umassmed.edu",
      "     ✓ Email printed on the 2022 paper (PubMed)",
      "",
      "Also wrote about this (no official page or email found):",
      "- Gregory M Pastores. Senior author of a 2023 medical overview of Gaucher disease.",
      "  Affiliation on the 2023 paper: Clinical Professor, Medicine (Genetics), University College, Dublin, Ireland",
      "  Source: https://pubmed.ncbi.nlm.nih.gov/20301446/ (PMID 20301446)",
      "",
    ].join("\n"),
  );
  const current = contactsAsText({ ...result, contacts: [{ ...sena, role: "Associate Professor", institution: "UMass Chan Medical School" }] }, "T");
  assert.match(current, /\n {3}Associate Professor, UMass Chan Medical School\n {3}Affiliation on the 2022 paper: /);
  assert.match(contactsAsText({ ...result, contacts: [pastores] }, "T"), /\nResearchers on these records \(no official page or email found\):\n- Gregory M Pastores\./);
});
