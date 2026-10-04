import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { buildGraphIndex } from "./index.ts";
import type { AtlasGraph, EdgeKind, GraphEdge, GraphNode, NodeType } from "./types.ts";

const node = (id: string, type: NodeType, label: string, synonyms?: string[]): GraphNode => ({
  id,
  type,
  label,
  ...(synonyms ? { synonyms } : {}),
  source: "Test",
  url: `https://example.org/${id}`,
});

const edge = (id: string, type: string, subject: string, object: string, kind: EdgeKind = "observed"): GraphEdge => ({
  id,
  type,
  subject,
  object,
  source: "Test",
  url: "https://example.org/evidence",
  date: "2026-10-03",
  confidence: 1,
  kind,
});

const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): AtlasGraph => ({
  meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
  nodes,
  edges,
});

const CLN1 = "MONDO:0000001";
const CLN3 = "MONDO:0000003";
const CLN10 = "MONDO:0000010";
const SWS = "MONDO:0000099";

// Every node type, every route to a disease, and one disputed edge. Nodes and edges are out of
// order on purpose so the index has to sort.
const fixture = graphOf(
  [
    node(SWS, "Disease", "Stüve-Wiedemann syndrome"),
    node(CLN10, "Disease", "neuronal ceroid lipofuscinosis 10", ["CLN10"]),
    node(CLN3, "Disease", "neuronal ceroid lipofuscinosis 3", ["CLN3", "Juvenile CLN3 disease"]),
    node(CLN1, "Disease", "neuronal ceroid lipofuscinosis 1", ["CLN1", "PPT1 neuronal ceroid lipofuscinosis"]),
    node("HGNC:2074", "Gene", "CLN3"),
    node("HGNC:9325", "Gene", "PPT1"),
    node("HGNC:2529", "Gene", "CTSD"),
    node("CLINVAR:1", "Variant", "NM_000310.4(PPT1):c.138C>A (p.Cys46Ter)"),
    node("PW:LYSO", "Mechanism", "Lysosomal lipofuscin accumulation"),
    node("HP:0001250", "Phenotype", "Seizure"),
    node("HP:0007359", "Phenotype", "Focal-onset seizure"),
    node("HP:0002133", "Phenotype", "Status epilepticus"),
    node("ORPHA-ORG:1", "PatientOrg", "Svenska NCL föreningen"),
    node("ORPHA-ORG:2", "PatientOrg", "Børnenes NCL-forening"),
    node("ORPHA-ORG:3", "PatientOrg", "Beyond Batten Disease Foundation"),
    node("ORPHA-REG:1", "Asset", "Batten Disease Registry"),
    node("clinicaltrials:NCT0000001", "Trial", "Seizure outcomes in CLN3 disease"),
    node("clinicaltrials:NCT0000002", "Trial", "Seizure diary study"),
    node("PMID:1", "Paper", "Antiseizure medication use in Batten disease"),
    node("NIH:G1", "Grant", "CLN3 natural history consortium"),
    node("reporter:pi-doe-jane", "Investigator", "Jane Doe"),
  ],
  [
    edge("e09", "causes", "HGNC:2074", CLN3),
    edge("e01", "causes", "HGNC:9325", CLN1),
    edge("e02", "variant_of", "CLINVAR:1", "HGNC:9325"),
    edge("e03", "disrupts_process", CLN3, "PW:LYSO", "inferred"),
    edge("e04", "disrupts_process", CLN1, "PW:LYSO", "inferred"),
    edge("e05", "in_pathway", "HGNC:2529", "PW:LYSO"),
    edge("e06", "causes", "HGNC:2529", CLN10),
    edge("e07", "has_phenotype", CLN3, "HP:0001250"),
    edge("e08", "has_phenotype", CLN1, "HP:0001250"),
    edge("e10", "has_phenotype", CLN10, "HP:0007359"),
    edge("e11", "has_phenotype", CLN1, "HP:0002133", "contradicted"),
    edge("e12", "works_on", "ORPHA-ORG:1", "PW:LYSO", "inferred"),
    edge("e13", "works_on", "ORPHA-ORG:2", CLN10, "inferred"),
    edge("e14", "works_on", "ORPHA-ORG:3", "HGNC:2074", "inferred"),
    edge("e15", "registers", "ORPHA-REG:1", "PW:LYSO", "inferred"),
    edge("e16", "studies", "clinicaltrials:NCT0000001", CLN3, "inferred"),
    edge("e17", "about", "PMID:1", CLN3, "inferred"),
    edge("e18", "funds", "NIH:G1", CLN3, "inferred"),
    edge("e19", "funds", "NIH:G1", SWS, "inferred"),
    edge("e20", "investigates", "reporter:pi-doe-jane", "NIH:G1"),
    edge("e21", "authored", "reporter:pi-doe-jane", "PMID:1"),
  ],
);

const ids = (hits: { node: GraphNode }[]) => hits.map((h) => h.node.id);

describe("buildGraphIndex on a fixture", () => {
  const index = buildGraphIndex(fixture);

  test("byId, edgesOf and diseases", () => {
    assert.equal(index.byId.size, fixture.nodes.length);
    assert.equal(index.byId.get("HGNC:2074")?.label, "CLN3");
    assert.deepEqual(index.edgesOf(CLN3).map((e) => e.id), ["e03", "e07", "e09", "e16", "e17", "e18"]);
    // The disputed edge is still evidence to show, so edgesOf keeps it.
    assert.deepEqual(index.edgesOf("HP:0002133").map((e) => e.id), ["e11"]);
    assert.deepEqual(index.edgesOf("nope"), []);
    assert.deepEqual(index.diseases.map((d) => d.id), [CLN1, CLN3, CLN10, SWS]);
  });

  test("diseasesFor on each node type", () => {
    const expected: [string, string[]][] = [
      [CLN3, [CLN3]], // Disease: itself
      ["HGNC:2074", [CLN3]], // Gene: adjacent diseases
      ["HGNC:2529", [CLN10]], // Gene linked to a mechanism still gives only its own disease
      ["CLINVAR:1", [CLN1]], // Variant: its gene's diseases
      ["PW:LYSO", [CLN1, CLN3, CLN10]], // Mechanism: adjacent diseases plus its genes' diseases
      ["HP:0001250", [CLN1, CLN3]], // Phenotype: adjacent diseases
      ["HP:0007359", [CLN10]],
      ["HP:0002133", []], // only a contradicted edge: leads nowhere
      ["ORPHA-ORG:1", [CLN1, CLN3, CLN10]], // PatientOrg via a mechanism
      ["ORPHA-ORG:2", [CLN10]], // PatientOrg linked to the disease
      ["ORPHA-ORG:3", [CLN3]], // PatientOrg via a gene
      ["ORPHA-REG:1", [CLN1, CLN3, CLN10]], // Asset via a mechanism
      ["clinicaltrials:NCT0000001", [CLN3]], // Trial
      ["clinicaltrials:NCT0000002", []], // Trial with no disease link
      ["PMID:1", [CLN3]], // Paper
      ["NIH:G1", [CLN3, SWS]], // Grant
      ["reporter:pi-doe-jane", [CLN3, SWS]], // Investigator: diseases of their grants and papers
      ["nope", []],
    ];
    for (const [id, diseases] of expected) assert.deepEqual(index.diseasesFor(id), diseases, id);
  });

  test("returned arrays are copies", () => {
    index.diseasesFor("PW:LYSO").push("x");
    index.edgesOf(CLN3).pop();
    assert.deepEqual(index.diseasesFor("PW:LYSO"), [CLN1, CLN3, CLN10]);
    assert.equal(index.edgesOf(CLN3).length, 6);
  });

  test("ranks exact > prefix > word-prefix > substring and drops hits without a disease", () => {
    const hits = index.search("seizure");
    // "Seizure diary study" is a prefix match but has no disease link, so it is dropped.
    assert.deepEqual(ids(hits), ["HP:0001250", "clinicaltrials:NCT0000001", "HP:0007359", "PMID:1"]);
    assert.deepEqual(hits[0].diseases, [CLN1, CLN3]);
    assert.deepEqual(index.search("status epilepticus"), []);
  });

  test("ties break by type priority, shorter label, label order, then id", () => {
    const cln3 = index.search("cln3");
    assert.deepEqual(ids(cln3), [CLN3, "HGNC:2074", "NIH:G1", "clinicaltrials:NCT0000001"]);
    assert.equal(cln3[0].matched, "CLN3");
    assert.equal(cln3[1].matched, "CLN3");

    const ppt1 = index.search("PPT1");
    assert.deepEqual(ids(ppt1), ["HGNC:9325", CLN1, "CLINVAR:1"]);
    assert.equal(ppt1[1].matched, "PPT1 neuronal ceroid lipofuscinosis");

    assert.deepEqual(ids(index.search("neuronal ceroid")), [CLN1, CLN3, CLN10]);

    // Same rank, type and label length: label in reading order, then id.
    const tied = buildGraphIndex(
      graphOf(
        [node("D:1", "Disease", "Disease 2"), node("D:2", "Disease", "Disease 1"), node("D:4", "Disease", "Disease 3"), node("D:3", "Disease", "Disease 3")],
        [],
      ),
    );
    assert.deepEqual(ids(tied.search("disease")), ["D:2", "D:1", "D:3", "D:4"]);
  });

  test("case-, accent- and punctuation-insensitive", () => {
    assert.deepEqual(ids(index.search("STÜVE")), [SWS]);
    assert.deepEqual(ids(index.search("stuve wiedemann")), [SWS]);
    assert.deepEqual(ids(index.search("sEiZuRe")), ids(index.search("seizure")));
    assert.deepEqual(ids(index.search("FORENINGEN")), ["ORPHA-ORG:1"]);
    assert.deepEqual(ids(index.search("föreningen")), ["ORPHA-ORG:1"]);
    assert.deepEqual(ids(index.search("BØRNENES")), ["ORPHA-ORG:2"]);
    assert.deepEqual(ids(index.search("bornenes")), ["ORPHA-ORG:2"]);
    assert.equal(index.search("juvenile")[0].matched, "Juvenile CLN3 disease");
  });

  test("matches ids only when the query has a digit", () => {
    const hits = index.search("HP:0001250");
    assert.deepEqual(ids(hits), ["HP:0001250"]);
    assert.equal(hits[0].matched, "HP:0001250");
    assert.deepEqual(ids(index.search("0001250")), ["HP:0001250"]);
    assert.deepEqual(index.search("hp"), []);
  });

  test("empty queries and limits", () => {
    assert.deepEqual(index.search(""), []);
    assert.deepEqual(index.search("   "), []);
    assert.deepEqual(index.search("--"), []);
    assert.deepEqual(index.search("seizure", 0), []);

    const many = buildGraphIndex(
      graphOf(
        [node(CLN1, "Disease", "neuronal ceroid lipofuscinosis 1"), ...Array.from({ length: 12 }, (_, i) => node(`HP:${1000 + i}`, "Phenotype", `Seizure type ${i + 1}`))],
        Array.from({ length: 12 }, (_, i) => edge(`p${i}`, "has_phenotype", CLN1, `HP:${1000 + i}`)),
      ),
    );
    assert.equal(many.search("seizure").length, 8);
    assert.equal(many.search("seizure", 3).length, 3);
    assert.equal(many.search("seizure", 20).length, 12);
    assert.deepEqual(ids(many.search("seizure", 3)), ["HP:1000", "HP:1001", "HP:1002"]);
  });

  test("a type filter keeps only those types", () => {
    const index = buildGraphIndex(fixture);
    const all = index.search("seizure", 20);
    assert.ok(all.some((h) => h.node.type === "Trial") && all.some((h) => h.node.type === "Phenotype"));
    const symptoms = index.search("seizure", 20, ["Phenotype"]);
    assert.ok(symptoms.length > 0 && symptoms.every((h) => h.node.type === "Phenotype"));
    const research = index.search("seizure", 20, ["Trial", "Paper", "Grant", "Investigator"]);
    assert.ok(research.length > 0 && research.every((h) => ["Trial", "Paper", "Grant", "Investigator"].includes(h.node.type)));
    assert.deepEqual(index.search("seizure", 20, []), all, "an empty filter means everything");
  });

  test("suggest lists a type's nodes that reach the most diseases", () => {
    const index = buildGraphIndex(fixture);
    const symptoms = index.suggest(["Phenotype"], 5);
    assert.equal(symptoms[0].node.id, "HP:0001250", "Seizure reaches two diseases");
    assert.ok(symptoms.every((h) => h.node.type === "Phenotype" && h.diseases.length > 0));
    assert.ok(!symptoms.some((h) => h.node.id === "HP:0002133"), "a symptom reached only through a disputed edge is not suggested");
    assert.deepEqual(index.suggest([], 5), []);
    assert.equal(index.suggest(["Phenotype"], 1).length, 1);
  });
});

// The generated seed sample (npm run data:sample), when present.
const SAMPLE = new URL("../../public/graph.sample.json", import.meta.url);
const sample: AtlasGraph | null = existsSync(SAMPLE) ? JSON.parse(readFileSync(SAMPLE, "utf8")) : null;
const SAMPLE_CLN = ["MONDO:0008767", "MONDO:0008769", "MONDO:0009744", "MONDO:0011144", "MONDO:0012588"];

describe("buildGraphIndex on public/graph.sample.json", { skip: sample ? false : "not generated yet: npm run data:sample" }, () => {
  const graph = sample as AtlasGraph;
  const index = buildGraphIndex(graph ?? graphOf([], []));
  const labelsVerified = !(graph?.meta.notes ?? "").includes("not yet verified against HPO");

  test("cln3 finds the disease first, then the gene", () => {
    const hits = index.search("cln3");
    assert.deepEqual(ids(hits).slice(0, 2), ["MONDO:0008767", "HGNC:2074"]);
    assert.equal(hits[0].matched, "CLN3");
    assert.deepEqual(hits[1].diseases, ["MONDO:0008767"]);
  });

  test("PPT1 finds the gene, then its disease through a synonym", () => {
    const hits = index.search("PPT1");
    assert.equal(hits[0].node.id, "HGNC:9325");
    assert.deepEqual(hits[0].diseases, ["MONDO:0009744"]);
    const disease = hits.find((h) => h.node.id === "MONDO:0009744");
    assert.equal(disease?.matched, "PPT1 neuronal ceroid lipofuscinosis");
  });

  test("seizure resolves to HP:0001250 once labels come from HPO", { skip: labelsVerified ? false : "phenotype labels not yet verified against HPO" }, () => {
    const hits = index.search("seizure");
    assert.equal(hits[0].node.id, "HP:0001250");
    assert.equal(hits[0].node.label, "Seizure");
    const withSeizure = graph.edges
      .filter((e) => e.type === "has_phenotype" && e.object === "HP:0001250")
      .map((e) => e.subject)
      .sort();
    assert.deepEqual(hits[0].diseases, withSeizure);
    // The seed bug put "Seizure" on HP:0000253 and HP:6000571; no other node may keep that label.
    assert.deepEqual(graph.nodes.filter((n) => n.label === "Seizure").map((n) => n.id), ["HP:0001250"]);
  });

  test("batten reaches every CLN disease through groups, registries and grants", () => {
    const hits = index.search("batten");
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.diseases.length > 0));
    assert.ok(hits[0].node.label.toLowerCase().startsWith("batten"), hits[0].node.label);
    assert.deepEqual([...new Set(hits.flatMap((h) => h.diseases))].sort(), SAMPLE_CLN);
  });

  test("accented names are found without accents and in any case", () => {
    const accented = graph.nodes.filter((n) => n.label !== n.label.normalize("NFD").replace(/\p{M}+/gu, ""));
    assert.ok(accented.length > 0);
    for (const target of accented) {
      const plain = target.label.normalize("NFD").replace(/\p{M}+/gu, "");
      const hits = index.search(plain.toUpperCase(), 50);
      if (index.diseasesFor(target.id).length) assert.ok(ids(hits).includes(target.id), target.label);
    }
  });

  test("diseasesFor on each node type", () => {
    const linked = (id: string, type: string) =>
      graph.edges.filter((e) => e.type === type && (e.subject === id || e.object === id)).map((e) => (e.subject === id ? e.object : e.subject));

    for (const disease of index.diseases) assert.deepEqual(index.diseasesFor(disease.id), [disease.id]);
    assert.equal(index.diseases.length, SAMPLE_CLN.length);
    assert.deepEqual(index.diseasesFor("HGNC:2074"), ["MONDO:0008767"]);
    assert.deepEqual(index.diseasesFor("PW:NCL-LYSOSOME"), SAMPLE_CLN);
    assert.deepEqual(index.diseasesFor("clinicaltrials:NCT03770572"), ["MONDO:0008767"]);
    assert.deepEqual(index.diseasesFor("PMID:37400440"), ["MONDO:0008767"]);
    assert.deepEqual(index.diseasesFor("NIH:U54HD122210"), ["MONDO:0008767", "MONDO:0008769", "MONDO:0011144"]);

    for (const n of graph.nodes) {
      const found = index.diseasesFor(n.id);
      if (n.type === "Variant") {
        const genes = linked(n.id, "variant_of");
        assert.equal(genes.length, 1, n.id);
        assert.deepEqual(found, index.diseasesFor(genes[0]), n.id);
        assert.ok(found.length > 0, n.id);
      } else if (n.type === "Phenotype") {
        assert.deepEqual(found, linked(n.id, "has_phenotype").sort(), n.id);
      } else if (n.type === "PatientOrg" || n.type === "Asset") {
        // Orphanet directory matches attach to the shared mechanism, so they reach all five.
        assert.deepEqual(found, SAMPLE_CLN, n.id);
      } else if (n.type === "Investigator") {
        const grants = linked(n.id, "investigates");
        assert.ok(grants.length > 0, n.id);
        assert.deepEqual(found, [...new Set(grants.flatMap((g) => index.diseasesFor(g)))].sort(), n.id);
      }
    }
  });

  test("studies without a disease link stay out of search", () => {
    const unlinked = graph.nodes.filter((n) => n.type === "Trial" && index.diseasesFor(n.id).length === 0);
    assert.ok(unlinked.length > 0);
    for (const trial of unlinked) assert.ok(!ids(index.search(trial.label, 50)).includes(trial.id), trial.id);
  });
});
