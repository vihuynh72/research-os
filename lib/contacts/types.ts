// Shapes shared by the contact finder's server code (lib/contacts) and its dialog
// (components/atlas/contact). Types only, so importing them never pulls server code into the browser.

// One author of a PubMed record, in the order the paper lists them.
export interface PaperAuthor {
  lastName: string;
  foreName: string; // "Terence R"
  affiliation: string; // the first affiliation, plain text
  emails: string[]; // printed in this author's affiliation, and either in no other author's or carrying their name
  orcid: string | null;
}

export interface Paper {
  pmid: string;
  url: string;
  title: string;
  journal: string;
  year: number | null;
  abstract: string; // the first ~800 characters
  authors: PaperAuthor[];
}

export interface GrantInvestigator {
  name: string;
  firstName: string;
  lastName: string;
  contact: boolean; // the contact principal investigator of a multi-PI grant
}

export interface Grant {
  applId: string;
  url: string;
  title: string;
  organization: string;
  place: string; // "Philadelphia, PA, United States"
  fiscalYear: number | null;
  years: string; // project period, "2013–2014"
  investigators: GrantInvestigator[];
}

// Where a candidate comes from: their role on one paper or grant that RareVerse links to the disease.
export interface CandidateSource {
  kind: "paper" | "grant";
  id: string; // "PMID:35145305" or "NIH:8593531"
  ref: string; // "PMID 35145305" or "NIH grant 8593531"
  role: string; // "senior author", "first author", "sole author", "corresponding author", "principal investigator"
  title: string;
  year: number | null;
  url: string;
  affiliation: string; // where this record places the person (no emails), or ""
}

// A person the model may choose. Only these people can ever be shown.
export interface Candidate {
  id: string; // c1, c2, …
  name: string;
  firstName: string;
  lastName: string;
  affiliation: string;
  emails: string[]; // from PubMed affiliations: a verified source for an email
  orcid: string | null;
  sources: CandidateSource[];
}

export type Confidence = "high" | "medium" | "low";

// One line of the "how we checked" list on a card. ok=false is a neutral "could not check", never a failure
// that is shown: anything that failed a check is removed before the answer leaves the server.
export interface ContactCheck {
  ok: boolean;
  text: string;
}

// Where one of our records places the person, word for word: deterministic, unlike the model's role and
// institution, which are shown only when an official page we read names the person.
export interface RecordAffiliation {
  text: string; // "Clinical Professor, Medicine (Genetics), University College, Dublin, Ireland"
  institution: string; // the university, hospital or institute in it ("University College"), or ""
  kind: "paper" | "grant";
  year: number | null;
  url: string;
}

export interface Contact {
  candidate_id: string;
  name: string; // as written in PubMed or NIH RePORTER, never the model's spelling
  role: string; // from the web search, kept only when a page we read names the person; else ""
  institution: string; // likewise
  affiliation: RecordAffiliation | null;
  why: string;
  source: CandidateSource;
  source_check: ContactCheck;
  profile_url: string | null;
  profile_check: ContactCheck | null;
  lab_url: string | null;
  lab_check: ContactCheck | null;
  email: string | null;
  email_source_url: string | null;
  email_check: ContactCheck | null;
  name_on_page: boolean;
  confidence: Confidence;
  note: string | null;
}

export interface SearchedRecord {
  id: string;
  ref: string;
  title: string;
  year: number | null;
  url: string;
  // Who led it, from the record itself: the senior (last) author or the contact principal investigator.
  lead: { role: string; name: string; place: string } | null;
}

// A patient group RareVerse lists for the disease (Orphanet's directory, matched by name).
export interface PatientGroup {
  name: string;
  url: string;
}

export interface ContactsResult {
  contacts: Contact[];
  summary: string;
  model: string;
  diseases: { id: string; name: string }[];
  searched: { papers: SearchedRecord[]; grants: SearchedRecord[] };
  patient_groups: PatientGroup[];
  // What the server-side checks took out of the model's answer: people not on the candidate list or with
  // a mismatched name, links that were not among the pages consulted or did not name the person, emails
  // that were not printed on an official page or in PubMed.
  removed: { contacts: number; links: number; emails: number };
  generated_at: string;
}

export type ContactsErrorCode = "no_key" | "nothing_to_search" | "rate_limited" | "upstream_failed" | "bad_request";

export interface ContactsError {
  error: { code: ContactsErrorCode; message: string; retry_after_sec?: number };
}

export type ContactsBody = ContactsResult | ContactsError;

// With `Accept: application/x-ndjson` the route streams one JSON object per line: progress, then the body.
export type ContactsStep = "read" | "search" | "check";
export interface ContactsProgress {
  type: "progress";
  step: ContactsStep;
  papers?: number;
  grants?: number;
}
export type ContactsLine = ContactsProgress | { type: "done"; body: ContactsBody };
