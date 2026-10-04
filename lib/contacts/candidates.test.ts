import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph, GraphEdge, GraphNode, NodeType } from "../graph/types.ts";
import type { Paper, PaperAuthor } from "./types.ts";
import { MAX_CANDIDATES, buildCandidates, nameKeys, patientGroups, planSources, titleMentions } from "./candidates.ts";
import { parsePubmedXml } from "./pubmed.ts";
import { mapReporter } from "./reporter.ts";

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
    node("MONDO:1", "Disease", "Tay-Sachs disease"),
    node("MONDO:2", "Disease", "Sandhoff disease"),
    node("MONDO:3", "Disease", "Lonely disease"),
    node("PMID:100", "Paper", "Search-and-replace genome editing without double-strand breaks."),
    node("PMID:150", "Paper", "New approaches to Tay Sachs therapy."),
    node("PMID:200", "Paper", "AAV gene therapy for Tay-Sachs disease."),
    node("PMID:250", "Paper", "The GM2 gangliosidoses: Tay-Sachs and Sandhoff."),
    node("PMID:300", "Paper", "Sandhoff Disease."),
    node("PMID:400", "Paper", "Microglia-neuron crosstalk maintains brain homeostasis."),
    node("NIH:10", "Grant", "HexA quality control in Tay-Sachs disease"),
    node("NIH:11", "Grant", "HexA quality control in Tay-Sachs disease"),
    node("NIH:12", "Grant", "Lysosome biology"),
    node("HGNC:1", "Gene", "HEXA"),
    { ...node("ORPHA-ORG:1", "PatientOrg", "CATS - The Cure &amp; Action for Tay-Sachs (CATS) Foundation"), url: "https://www.orpha.net/en/patient-organisations/patient/1" },
    { ...node("ORPHA-ORG:2", "PatientOrg", "National Tay-Sachs &amp; Allied Diseases Association"), url: "https://www.orpha.net/en/patient-organisations/patient/2" },
  ],
  edges: [
    ...["PMID:100", "PMID:150", "PMID:200", "PMID:250"].map((p) => edge(p, "about", "MONDO:1")),
    ...["PMID:250", "PMID:300", "PMID:400"].map((p) => edge(p, "about", "MONDO:2")),
    ...["NIH:10", "NIH:11", "NIH:12"].map((g) => edge(g, "funds", "MONDO:1")),
    edge("HGNC:1", "causes", "MONDO:1"),
    edge("ORPHA-ORG:1", "works_on", "MONDO:1"),
    edge("ORPHA-ORG:2", "works_on", "MONDO:1"),
    edge("ORPHA-ORG:2", "works_on", "MONDO:2"),
  ],
};

const ids = (nodes: GraphNode[]) => nodes.map((n) => n.id);

test("a disease name's own words decide whether a title is about it", () => {
  assert.deepEqual(nameKeys("Tay-Sachs disease"), ["taysachs"]);
  assert.deepEqual(nameKeys("Gaucher disease type I"), ["gaucher"]);
  assert.deepEqual(nameKeys("oculocutaneous albinism type 1A"), ["oculocutaneous", "albinism"]);
  assert.ok(titleMentions("New approaches to Tay Sachs therapy.", ["taysachs"]));
  assert.ok(!titleMentions("Search-and-replace genome editing.", ["taysachs"]));
  assert.ok(!titleMentions("Anything", []));
});

test("one disease: papers that name it first, newest first; a renewed grant is read once", () => {
  const plan = planSources(graph, ["MONDO:1"]);
  assert.deepEqual(ids(plan.diseases), ["MONDO:1"]);
  assert.deepEqual(ids(plan.papers), ["PMID:250", "PMID:200", "PMID:150", "PMID:100"]);
  assert.deepEqual(ids(plan.grants), ["NIH:11", "NIH:12"]);
});

test("a pair: shared papers first, then each disease's own in turn, at most four", () => {
  const plan = planSources(graph, ["MONDO:1", "MONDO:2"]);
  assert.deepEqual(ids(plan.papers), ["PMID:250", "PMID:200", "PMID:300", "PMID:150"]);
  assert.deepEqual(ids(plan.grants), ["NIH:11", "NIH:12"]);
});

test("a disease with nothing linked has nothing to read", () => {
  const plan = planSources(graph, ["MONDO:3"]);
  assert.deepEqual([plan.papers.length, plan.grants.length], [0, 0]);
  assert.deepEqual(ids(planSources(graph, ["HGNC:1"]).diseases), [], "only diseases count");
});

test("the patient groups RareVerse lists for the disease(s), names decoded, each once", () => {
  assert.deepEqual(patientGroups(graph, ["MONDO:1", "MONDO:2"]), [
    { name: "CATS - The Cure & Action for Tay-Sachs (CATS) Foundation", url: "https://www.orpha.net/en/patient-organisations/patient/1" },
    { name: "National Tay-Sachs & Allied Diseases Association", url: "https://www.orpha.net/en/patient-organisations/patient/2" },
  ]);
  assert.deepEqual(patientGroups(graph, ["MONDO:3"]), []);
});

const papers = parsePubmedXml(readFileSync(new URL("./fixtures/efetch.xml", import.meta.url), "utf8"));
const grants = mapReporter(JSON.parse(readFileSync(new URL("./fixtures/reporter.json", import.meta.url), "utf8")), ["8593531"]);

test("candidates: each paper's senior and first author, and each grant's leader, with stable ids", () => {
  const candidates = buildCandidates(papers, grants);
  assert.deepEqual(
    candidates.map((c) => [c.id, c.name, c.sources[0].role]),
    [
      ["c1", "Miguel Sena-Esteves", "senior author"],
      ["c2", "Terence R Flotte", "first author"],
      ["c3", "Gregory M Pastores", "senior author"],
      ["c4", "Derralynn A Hughes", "first author"],
      ["c5", "Marc G Berger", "senior author"],
      ["c6", "Jérôme Stirnemann", "first author"],
      ["c7", "Devin Dersh", "principal investigator"],
    ],
  );
  const [sena] = candidates;
  assert.deepEqual(sena.emails, ["Miguel.esteves@umassmed.edu"]);
  assert.equal(sena.orcid, "0000-0003-0854-0143");
  assert.deepEqual(sena.sources[0], {
    kind: "paper",
    id: "PMID:35145305",
    ref: "PMID 35145305",
    role: "senior author",
    title: "AAV gene therapy for Tay-Sachs disease.",
    year: 2022,
    url: "https://pubmed.ncbi.nlm.nih.gov/35145305/",
    affiliation: "Horae Gene Therapy Center and The Li Weibo Institute for Rare Diseases Research, UMass Chan Medical School, Worcester, MA, USA",
  });
  assert.equal(candidates[1].sources[0].affiliation, "Department of Pediatrics, UMass Chan Medical School, Worcester, MA, USA", "the email printed in the affiliation is left out");
  assert.deepEqual(candidates[6].sources[0], {
    kind: "grant",
    id: "NIH:8593531",
    ref: "NIH grant 8593531",
    role: "principal investigator",
    title: "Endoplasmic reticulum quality control of mutant HexA enzyme in Tay-Sachs disease",
    year: 2013,
    url: "https://reporter.nih.gov/project-details/8593531",
    affiliation: "University of Pennsylvania, Philadelphia, PA, United States",
  });
  assert.equal(candidates[6].affiliation, "University of Pennsylvania, Philadelphia, PA, United States");
});

const author = (foreName: string, lastName: string, emails: string[] = []): PaperAuthor => ({ foreName, lastName, affiliation: "Somewhere", emails, orcid: null });
const paper = (pmid: string, authors: PaperAuthor[]): Paper => ({ pmid, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, title: `Paper ${pmid}`, journal: "J", year: 2020, abstract: "", authors });

test("a middle author with an email is a corresponding author, unless most authors print one", () => {
  const few = buildCandidates([paper("1", [author("A", "Alpha"), author("B", "Beta", ["b@uni.edu"]), author("C", "Gamma")])], []);
  assert.deepEqual(
    few.map((c) => [c.name, c.sources[0].role]),
    [
      ["C Gamma", "senior author"],
      ["A Alpha", "first author"],
      ["B Beta", "corresponding author"],
    ],
  );
  const all = buildCandidates([paper("2", ["A", "B", "C", "D", "E"].map((x) => author(x, `${x}son`, [`${x}@uni.edu`])))], []);
  assert.deepEqual(all.map((c) => c.name), ["E Eson", "A Ason"]);
  const sole = buildCandidates([paper("3", [author("Solo", "Writer")])], []);
  assert.equal(sole[0].sources[0].role, "sole author");
});

test("one person on two records is one candidate with both roles; a different first name is someone else", () => {
  const candidates = buildCandidates(
    [
      paper("1", [author("Terence R", "Flotte", ["Terry.Flotte@umassmed.edu"]), author("Ann", "Other")]),
      paper("2", [author("Ann", "Other"), author("Bea", "Middle"), author("T", "Flotte")]),
      paper("3", [author("Thomas", "Flotte"), author("Zed", "Last")]),
    ],
    [],
  );
  const roles = (firstName: string) => candidates.find((c) => c.firstName === firstName)!.sources.map((s) => `${s.role} of ${s.ref}`);
  assert.deepEqual(roles("Terence R"), ["first author of PMID 1", "senior author of PMID 2"], "T. Flotte (an initial) is Terence R Flotte");
  assert.deepEqual(roles("Ann"), ["senior author of PMID 1", "first author of PMID 2"]);
  assert.deepEqual(roles("Thomas"), ["first author of PMID 3"], "Thomas Flotte is someone else");
  assert.deepEqual(candidates.find((c) => c.firstName === "Terence R")!.emails, ["Terry.Flotte@umassmed.edu"]);
  assert.equal(candidates.length, 4);
});

test("too many people: senior authors stay, first authors of later papers go first", () => {
  const many = Array.from({ length: 12 }, (_, i) => paper(String(i + 1), [author(`First${i}`, `F${i}`), author(`Senior${i}`, `S${i}`)]));
  const candidates = buildCandidates(many, []);
  assert.equal(candidates.length, MAX_CANDIDATES);
  assert.equal(candidates.filter((c) => c.sources[0].role === "senior author").length, 12);
  assert.deepEqual(
    candidates.map((c) => c.id),
    candidates.map((_, i) => `c${i + 1}`),
  );
});
