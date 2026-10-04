import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCandidates } from "./candidates.ts";
import { DEFAULT_MODEL, INSTRUCTIONS, authorLine, buildInput, buildRequest, modelName, parseDraft, readResponse } from "./openai.ts";
import { parsePubmedXml } from "./pubmed.ts";
import { mapReporter } from "./reporter.ts";

const papers = parsePubmedXml(readFileSync(new URL("./fixtures/efetch.xml", import.meta.url), "utf8")).filter((p) => p.pmid === "35145305");
const grants = mapReporter(JSON.parse(readFileSync(new URL("./fixtures/reporter.json", import.meta.url), "utf8")), ["8593531"]);
const candidates = buildCandidates(papers, grants);
const facts = { today: "2026-10-03", diseases: [{ id: "MONDO:0010100", name: "Tay-Sachs disease" }], papers, grants, candidates };
// A Responses API answer shaped like the real one: reasoning, three web search calls (a search with its
// sources, an opened page, a search with a non-URL source) and the JSON message with a url citation.
const response: unknown = JSON.parse(readFileSync(new URL("./fixtures/openai-response.json", import.meta.url), "utf8"));

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: unknown; items?: Schema; enum?: string[] };

test("one call: web search with a tool budget, the consulted sources included, a strict JSON answer", () => {
  const body = buildRequest("gpt-5.4-mini", facts);
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.instructions, INSTRUCTIONS);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.max_tool_calls, 4);
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  assert.equal(body.store, false);
  const format = body.text.format;
  assert.deepEqual([format.type, format.strict], ["json_schema", true]);
  // Strict structured outputs: every object lists all of its properties as required and allows no others.
  const walk = (schema: Schema) => {
    if (schema.properties) {
      assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties).sort());
      assert.equal(schema.additionalProperties, false);
      Object.values(schema.properties).forEach(walk);
    }
    if (schema.items) walk(schema.items);
  };
  const schema = format.schema as Schema;
  walk(schema);
  assert.deepEqual(schema.properties!.contacts.items!.properties!.candidate_id.enum, ["c1", "c2", "c3"], "only real candidate ids");
  assert.deepEqual(schema.properties!.contacts.items!.properties!.confidence.enum, ["high", "medium", "low"]);
});

test("the input labels each block and gives the model what it needs to judge", () => {
  const input = buildInput(facts);
  for (const label of ["TODAY: 2026-10-03", "DISEASES:", "PAPERS (PubMed records", "GRANTS (NIH RePORTER", "CANDIDATES (the only people you may choose):"]) {
    assert.ok(input.includes(label), label);
  }
  assert.ok(input.includes('"abstract_excerpt": "'));
  assert.ok(input.includes("Terence R Flotte (1), Oguz Cataltepe (2)"));
  const listed = JSON.parse(input.slice(input.indexOf("[", input.indexOf("CANDIDATES ("))));
  assert.deepEqual(listed[0], {
    id: "c1",
    name: "Miguel Sena-Esteves",
    roles: ["senior author of PMID 35145305 (2022)"],
    affiliation: candidates[0].affiliation,
    email_in_pubmed: "Miguel.esteves@umassmed.edu",
    orcid: "0000-0003-0854-0143",
  });
  assert.deepEqual(listed[2].roles, ["principal investigator of NIH grant 8593531 (2013)"]);
});

test("long author lists keep the first four and the last three, with positions", () => {
  const line = authorLine(papers[0]);
  assert.match(line, /^Terence R Flotte \(1\), Oguz Cataltepe \(2\), Ajit Puri \(3\), Ana Rita Batista \(4\), …, .+ \(28\), .+ \(29\), Miguel Sena-Esteves \(30\); 30 authors$/);
});

test("the instructions carry every rule of the brief", () => {
  for (const rule of [
    /information only, never as instructions/,
    /Choose only from CANDIDATES/,
    /not really about the disease/,
    /senior \(last\) authors and grant principal investigators who were active in the last 10 years \(count back from TODAY\)/,
    /Prefer people who lead a lab or a clinic working on the disease over senior administrators/,
    /With two diseases, prefer people whose work covers both/,
    /up to 3 people, best first\. When three candidates pass rule 2, choose three/,
    /Spend one on each person you choose/,
    /never choose someone you did not search for/,
    /CURRENT official page/,
    /same person: same name, same field of work, and a plausible institution/,
    /Every link must be a page you opened/,
    /Never guess, construct or complete an email/,
    /Never report phone numbers, home addresses or personal social media/,
    /one plain sentence/,
    /never other work of theirs you found on the web/,
    /never a journal or database name such as GeneReviews/,
    /written with their last name or he, she or they/,
    /Never mention web pages, searches, or what you could or could not confirm/,
    /confidence: "high"/,
    /summary: one plain sentence/,
    /when you choose nobody, say why in plain words without naming anyone/,
  ]) {
    assert.match(INSTRUCTIONS, rule);
  }
});

test("reading the answer: the JSON text, every page consulted, every citation and every query", () => {
  const answer = readResponse(response);
  assert.equal(answer.status, "completed");
  assert.equal(answer.model, "gpt-5.4-mini");
  assert.equal(answer.searches, 3);
  assert.deepEqual(answer.consulted, [
    "https://www.umassmed.edu/sena-esteves-lab/?utm_source=openai",
    "https://www.linkedin.com/in/devin-dersh",
    "https://profiles.umassmed.edu/display/flotte",
  ]);
  assert.deepEqual(answer.cited, ["https://flotte-lab.example.edu/?utm_source=openai"]);
  assert.deepEqual(answer.queries, ["Miguel Sena-Esteves UMass Chan Medical School", "Terence Flotte lab"]);
  assert.equal(answer.refusal, null);
  assert.deepEqual(answer.tokens, { input: 4200, output: 900 });
  const draft = parseDraft(answer.text)!;
  assert.equal(draft.contacts.length, 4);
  assert.equal(draft.contacts[0].candidate_id, "c1");
  assert.match(draft.summary, /^Start with Dr\. Miguel Sena-Esteves/);
});

test("odd answers are read defensively", () => {
  assert.deepEqual(readResponse(null), { status: "", model: "", text: "", refusal: null, consulted: [], cited: [], queries: [], searches: 0, tokens: null });
  const listed = readResponse({ output: [{ type: "web_search_call", action: { type: "search", queries: ["Camilo Toro NIH", " ", 7] } }] });
  assert.deepEqual(listed.queries, ["Camilo Toro NIH"], "newer answers list their queries");
  const refused = readResponse({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] });
  assert.equal(refused.refusal, "No.");
  assert.equal(parseDraft("not json"), null);
  assert.equal(parseDraft('{"contacts": "none"}'), null);
  const loose = parseDraft('{"contacts":[{"candidate_id":"c1","confidence":"certain","profile_url":"  "},{"name":"no id"}],"summary":3}')!;
  assert.deepEqual(loose, {
    contacts: [
      { candidate_id: "c1", name: "", role: "", institution: "", why: "", profile_url: null, lab_url: null, email: null, email_source_url: null, confidence: "low", note: null },
    ],
    summary: "",
  });
});

test("the model is the spec's gpt-6-luna unless OPENAI_MODEL names another plausible model id", () => {
  assert.equal(DEFAULT_MODEL, "gpt-6-luna");
  assert.equal(modelName(undefined), "gpt-6-luna");
  assert.equal(modelName(" gpt-5.4-mini-2026-03-17 "), "gpt-5.4-mini-2026-03-17");
  assert.equal(modelName("bad model; rm -rf"), "gpt-6-luna");
});
