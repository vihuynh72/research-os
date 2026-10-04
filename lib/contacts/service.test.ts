import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import type { ContactsBody, ContactsProgress, ContactsResult } from "./types.ts";
import type { PageResult } from "./page.ts";
import { parsePubmedXml } from "./pubmed.ts";
import { mapReporter } from "./reporter.ts";
import { MESSAGES, createContactFinder, findContacts, statusFor, validDiseaseIds, type ContactDeps } from "./service.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const papers = parsePubmedXml(fixture("efetch.xml"));
const grants = mapReporter(JSON.parse(fixture("reporter.json")), ["8593531"]);
const response: unknown = JSON.parse(fixture("openai-response.json"));

const node = (id: string, type: NodeType, label = id): GraphNode => ({ id, type, label, source: "test", url: `https://example.org/${id}` });
const edge = (subject: string, type: string, object: string): GraphEdge => ({
  id: `e-${type}-${subject}-${object}`,
  type,
  subject,
  object,
  source: "test",
  url: "https://example.org",
  date: "2026-10-03",
  confidence: 0.6,
  kind: "inferred",
});
const graph: AtlasGraph = {
  meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
  nodes: [
    node("MONDO:0010100", "Disease", "Tay-Sachs disease"),
    node("MONDO:0009265", "Disease", "Gaucher disease type I"),
    node("MONDO:3", "Disease", "Lonely disease"),
    node("MONDO:4", "Disease", "Disease with only a patient group"),
    node("PMID:35145305", "Paper", "AAV gene therapy for Tay-Sachs disease."),
    node("PMID:28218669", "Paper", "A Review of Gaucher Disease Pathophysiology, Clinical Presentation and Treatments."),
    node("NIH:8593531", "Grant", "Endoplasmic reticulum quality control of mutant HexA enzyme in Tay-Sachs disease"),
    node("HGNC:4878", "Gene", "HEXA"),
    { ...node("ORPHA-ORG:9", "PatientOrg", "Friends of the Disease"), url: "https://www.orpha.net/en/patient-organisations/patient/9" },
  ],
  edges: [
    edge("PMID:35145305", "about", "MONDO:0010100"),
    edge("NIH:8593531", "funds", "MONDO:0010100"),
    edge("PMID:28218669", "about", "MONDO:0009265"),
    edge("ORPHA-ORG:9", "works_on", "MONDO:4"),
  ],
};

const filler = "Our group develops gene therapies for inherited disorders of the nervous system. ".repeat(4);
const PAGES: Record<string, string> = {
  "https://www.umassmed.edu/sena-esteves-lab/": `<title>Sena-Esteves Lab</title><h1>Miguel Sena-Esteves, PhD</h1><p>${filler}</p><a href="mailto:Miguel.Esteves@umassmed.edu">Email</a>`,
  "https://profiles.umassmed.edu/display/flotte": `<h1>Terence R. Flotte, MD</h1><p>Dean, School of Medicine. ${filler}</p>`,
  "https://flotte-lab.example.edu/": `<h1>Gene therapy news</h1><p>${filler}</p>`,
};

function fakes(over: Partial<ContactDeps> = {}) {
  const calls = { model: 0, pages: [] as string[], requests: [] as unknown[], log: [] as string[] };
  const deps: ContactDeps = {
    fetchPapers: async (pmids) => papers.filter((p) => pmids.includes(p.pmid)),
    fetchGrants: async (ids) => grants.filter((g) => ids.includes(g.applId)),
    askModel: async (request) => {
      calls.model++;
      calls.requests.push(request);
      return response;
    },
    fetchPage: async (url): Promise<PageResult> => {
      calls.pages.push(url);
      const html = PAGES[url];
      return html ? { url, finalUrl: url, ok: true, status: 200, html } : { url, finalUrl: url, ok: false, status: 403, html: "", reason: "HTTP 403" };
    },
    log: (message) => calls.log.push(message),
    ...over,
  };
  return { deps, calls };
}

const NOW = Date.parse("2026-10-03T12:00:00Z");

test("from a disease to checked contacts: records, one model call, then the checks", async () => {
  const { deps, calls } = fakes();
  const steps: ContactsProgress[] = [];
  const body = await findContacts({ graph, diseaseIds: ["MONDO:0010100"], model: "gpt-6-luna", deps, now: () => NOW, onProgress: (p) => steps.push(p) });
  assert.ok(!("error" in body));
  const result = body as ContactsResult;
  assert.deepEqual(steps, [
    { type: "progress", step: "read", papers: 1, grants: 1 },
    { type: "progress", step: "search" },
    { type: "progress", step: "check" },
  ]);
  assert.equal(calls.model, 1);
  assert.deepEqual(calls.pages, ["https://www.umassmed.edu/sena-esteves-lab/", "https://profiles.umassmed.edu/display/flotte", "https://flotte-lab.example.edu/"]);

  const [sena, flotte, dersh] = result.contacts;
  assert.deepEqual(
    result.contacts.map((c) => c.name),
    ["Miguel Sena-Esteves", "Terence R Flotte", "Devin Dersh"],
  );
  assert.deepEqual(
    {
      profile: [sena.profile_url, sena.profile_check?.text],
      email: [sena.email, sena.email_check?.text],
      why: sena.why,
      source: sena.source_check.text,
      where: [sena.role, sena.institution, sena.affiliation?.institution],
      confidence: sena.confidence,
    },
    {
      profile: ["https://www.umassmed.edu/sena-esteves-lab/", "Name found on umassmed.edu profile"],
      // PubMed lists it too, but the current official page is the stronger proof, so the page is named.
      email: ["Miguel.Esteves@umassmed.edu", "Email shown on the umassmed.edu page that names them"],
      why: "Senior author of a 2022 paper on gene therapy for Tay-Sachs disease.",
      source: "Listed as senior author on the paper (PubMed)",
      where: ["Professor of Neurology", "UMass Chan Medical School", "UMass Chan Medical School"],
      confidence: "high",
    },
  );
  // Flotte: the profile names him; the cited lab page does not, so it goes; the email the model gave is printed
  // nowhere we read, so PubMed's is offered; the reason named a year he has no paper in; the note held an address.
  assert.equal(flotte.profile_check?.text, "Name found on profiles.umassmed.edu profile");
  assert.equal(flotte.lab_url, null);
  assert.equal(flotte.email, "Terry.Flotte@umassmed.edu");
  assert.equal(flotte.why, "First author of the paper “AAV gene therapy for Tay-Sachs disease” (2022).");
  assert.equal(flotte.note, null);
  // Dersh: LinkedIn is not an official page, so there is no way to reach him that we could confirm.
  assert.deepEqual([dersh.profile_url, dersh.email, dersh.confidence], [null, null, "low"]);
  assert.equal(dersh.source.id, "NIH:8593531");
  assert.equal(dersh.source_check.text, "Listed as the lead of the grant (NIH RePORTER)");
  assert.deepEqual(dersh.affiliation, { text: "University of Pennsylvania, Philadelphia, PA, United States", institution: "University of Pennsylvania", kind: "grant", year: 2013, url: "https://reporter.nih.gov/project-details/8593531" });

  assert.deepEqual(result.removed, { contacts: 1, links: 2, emails: 1 });
  // Built from the first card, not taken from the model ("…who led the 2022 Tay-Sachs gene therapy study").
  assert.equal(result.summary, "Start with Miguel Sena-Esteves at UMass Chan Medical School: senior author of a 2022 paper on gene therapy for Tay-Sachs disease.");
  assert.equal(result.model, "gpt-5.4-mini", "the model that answered, as OpenAI names it");
  assert.deepEqual(result.diseases, [{ id: "MONDO:0010100", name: "Tay-Sachs disease" }]);
  assert.deepEqual(result.searched.papers.map((p) => [p.ref, p.lead]), [["PMID 35145305", { role: "senior author", name: "Miguel Sena-Esteves", place: "UMass Chan Medical School" }]]);
  assert.deepEqual(result.searched.grants.map((g) => [g.ref, g.year, g.lead]), [["NIH grant 8593531", 2013, { role: "grant lead", name: "Devin Dersh", place: "University of Pennsylvania" }]]);
  assert.deepEqual(result.patient_groups, []);
  assert.equal(result.generated_at, "2026-10-03T12:00:00.000Z");
  const sent = JSON.stringify(calls.requests[0]);
  assert.ok(sent.includes("CANDIDATES (the only people you may choose)") && sent.includes("Devin Dersh"));
  assert.ok(calls.log.some((line) => line.startsWith("MONDO:0010100: 3 web search calls")));
});

test("a person the web search never looked for keeps no note, and the log says so", async () => {
  // The same answer, but no search result or opened page names Dersh (the fixture's LinkedIn hit is gone).
  type Item = { type: string; action?: { sources?: { url?: string }[] }; content?: { text: string }[] };
  const quiet = JSON.parse(JSON.stringify(response)) as { output: Item[] };
  for (const item of quiet.output) if (item.action?.sources) item.action.sources = item.action.sources.filter((src) => !src.url?.includes("dersh"));
  const message = quiet.output.find((item) => item.type === "message")!.content![0];
  const answer = JSON.parse(message.text);
  answer.contacts[2].note = "He now runs a lab at the NIH.";
  message.text = JSON.stringify(answer);
  const { deps, calls } = fakes({ askModel: async () => quiet });
  const body = (await findContacts({ graph, diseaseIds: ["MONDO:0010100"], model: "m", deps, now: () => NOW })) as ContactsResult;
  assert.equal(body.contacts.find((c) => c.name === "Devin Dersh")?.note, null);
  assert.ok(calls.log.includes("chosen without a web search for them: c3"));
  assert.ok(calls.log.includes("dropped c3 note: not a checked fact about them"));
});

test("nothing linked: a clear answer without asking OpenAI, pointing to a patient group when there is one", async () => {
  const { deps, calls } = fakes();
  const body = await findContacts({ graph, diseaseIds: ["MONDO:3"], model: "m", deps });
  assert.equal("error" in body && body.error.code, "nothing_to_search");
  assert.equal("error" in body && body.error.message, MESSAGES.nothing_to_search);
  assert.equal(statusFor(body), 200);
  const grouped = await findContacts({ graph, diseaseIds: ["MONDO:4"], model: "m", deps });
  assert.equal("error" in grouped && grouped.error.message, `${MESSAGES.nothing_to_search} The patient groups RareVerse lists for this disease may know researchers to contact.`);
  assert.equal(calls.model, 0);
});

test("when the records or the model fail, the answer says so plainly, without guessing why", async () => {
  const down = async () => {
    throw new Error("503");
  };
  const records = await findContacts({ graph, diseaseIds: ["MONDO:0010100"], model: "m", deps: fakes({ fetchPapers: down, fetchGrants: down }).deps });
  assert.equal("error" in records && records.error.code, "upstream_failed");
  const model = await findContacts({ graph, diseaseIds: ["MONDO:0010100"], model: "m", deps: fakes({ askModel: down }).deps });
  assert.equal("error" in model && model.error.code, "upstream_failed");
  assert.equal("error" in model && model.error.message, "PubMed, NIH or OpenAI did not answer. Please try again.");
  assert.equal(statusFor(model), 502);
  const cut = await findContacts({ graph, diseaseIds: ["MONDO:0010100"], model: "m", deps: fakes({ askModel: async () => ({ status: "incomplete", output: [] }) }).deps });
  assert.equal("error" in cut && cut.error.code, "upstream_failed");
});

test("only 1–2 known, different disease ids are accepted", () => {
  for (const bad of [[], ["MONDO:0010100", "MONDO:0010100"], ["MONDO:0010100", "MONDO:0009265", "MONDO:3"], "MONDO:0010100", [42], ["MONDO:404"], ["HGNC:4878"], null]) {
    assert.equal(validDiseaseIds(bad, graph), null, JSON.stringify(bad));
  }
  assert.deepEqual(validDiseaseIds(["MONDO:0010100", "MONDO:0009265"], graph), ["MONDO:0010100", "MONDO:0009265"]);
});

const finder = (deps: ContactDeps, over: Partial<Parameters<typeof createContactFinder>[0]> = {}) =>
  createContactFinder({ deps, model: () => "gpt-6-luna", hasKey: () => true, now: () => NOW, ...over });
type Finder = ReturnType<typeof finder>;
const code = (started: ReturnType<Finder["start"]>) => (started.kind === "answer" && "error" in started.body ? started.body.error.code : started.kind);
const errorOf = (started: ReturnType<Finder["start"]>) => (started.kind === "answer" && "error" in started.body ? started.body.error : null);
const settle = async (started: ReturnType<Finder["start"]>): Promise<ContactsBody | null> => (started.kind === "job" ? started.result : null);

test("the same question twice costs one OpenAI call: answers are cached and a running question is joined", async () => {
  const { deps, calls } = fakes();
  const f = finder(deps);
  const first = f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" });
  const joined = f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "b" });
  assert.equal(first.kind, "job");
  assert.equal(joined.kind, "job");
  if (first.kind !== "job" || joined.kind !== "job") return;
  assert.equal(first.result, joined.result);
  const seen: string[] = [];
  joined.listen((p) => seen.push(p.step));
  await first.result;
  const again = f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "c" });
  assert.equal(again.kind, "answer");
  assert.equal(calls.model, 1);
  assert.ok(seen.includes("check"), "a joined request still hears the progress");
});

test("guards: no key, bad input, per-client limit, and at most so many OpenAI calls at once", async () => {
  const { deps } = fakes();
  const noKey = finder(deps, { hasKey: () => false });
  assert.equal(code(noKey.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" })), "no_key");
  assert.equal(code(noKey.start({ graph, diseaseIds: ["MONDO:3"], client: "a" })), "nothing_to_search", "said even without a key");
  assert.equal(code(noKey.start({ graph, diseaseIds: ["nope"], client: "a" })), "bad_request");

  const limited = finder(deps, { rateLimit: 1 });
  await settle(limited.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" }));
  const second = limited.start({ graph, diseaseIds: ["MONDO:0009265"], client: "a" });
  assert.equal(code(second), "rate_limited");
  assert.deepEqual(errorOf(second), { code: "rate_limited", message: "Too many new contact searches in a short time. Please try again in 10 minutes.", retry_after_sec: 600 });
  assert.equal(statusFor(second.kind === "answer" ? second.body : { error: { code: "bad_request", message: "" } }), 429);
  const other = limited.start({ graph, diseaseIds: ["MONDO:0009265"], client: "b" });
  assert.equal(code(other), "job", "another client is not held back");
  await settle(other);

  let release = () => {};
  const slow = fakes({ askModel: () => new Promise((resolve) => (release = () => resolve(response))) });
  const busy = finder(slow.deps, { maxInFlight: 1 });
  const running = busy.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" });
  await new Promise((r) => setTimeout(r, 10));
  const blocked = busy.start({ graph, diseaseIds: ["MONDO:0009265"], client: "b" });
  assert.equal(code(blocked), "rate_limited");
  assert.equal(errorOf(blocked)?.retry_after_sec, 20, "a short wait: the dialog offers to try again");
  release();
  await settle(running);
});

test("new searches per hour are capped for the whole server, whatever client each request claims to be", async () => {
  let t = NOW;
  const { deps, calls } = fakes();
  const f = finder(deps, { hourlyLimit: 2, now: () => t });
  // A script that sends a new X-Forwarded-For each time looks like a new client every time.
  await settle(f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "ip:1" }));
  await settle(f.start({ graph, diseaseIds: ["MONDO:0009265"], client: "ip:2" }));
  const third = f.start({ graph, diseaseIds: ["MONDO:0009265", "MONDO:0010100"], client: "ip:3" });
  assert.equal(code(third), "rate_limited");
  assert.match(errorOf(third)!.message, /^The contact finder has reached its limit of new searches for this hour\. Diseases already looked up still open right away\. Please try this one again in 60 minutes\.$/);
  assert.equal(calls.model, 2);
  assert.equal(f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "ip:4" }).kind, "answer", "a question already answered still opens");
  t += 60 * 60 * 1000 + 1;
  assert.equal(code(f.start({ graph, diseaseIds: ["MONDO:0009265", "MONDO:0010100"], client: "ip:3" })), "job", "a new hour, a new budget");
});

test("a request one limit refuses uses up nothing of the other", async () => {
  const { deps } = fakes();
  const f = finder(deps, { rateLimit: 1, hourlyLimit: 2 });
  await settle(f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" }));
  for (let i = 0; i < 5; i++) assert.equal(code(f.start({ graph, diseaseIds: ["MONDO:0009265"], client: "a" })), "rate_limited");
  assert.equal(code(f.start({ graph, diseaseIds: ["MONDO:0009265"], client: "b" })), "job", "the refused requests did not spend the hour's budget");
});

test("a failed search is not cached, so trying again really tries again", async () => {
  let fail = true;
  const { deps, calls } = fakes({
    askModel: async () => {
      calls.model++;
      if (fail) throw new Error("timeout");
      return response;
    },
  });
  const f = finder(deps);
  const first = f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" });
  assert.ok(first.kind === "job" && "error" in (await first.result));
  fail = false;
  const second = f.start({ graph, diseaseIds: ["MONDO:0010100"], client: "a" });
  assert.ok(second.kind === "job" && !("error" in (await second.result)));
  assert.equal(calls.model, 2);
});
