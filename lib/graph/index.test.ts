import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { buildGraphIndex, type SearchAliases } from "./index.ts";
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

describe("search forgives", () => {
  const aliases: SearchAliases = {
    [CLN3]: ["Batten disease", "juvenile neuronal ceroid lipofuscinosis", "CLN3"],
    "HP:0001250": ["Seizures", "Epileptic seizure"],
    "HGNC:9325": ["palmitoyl-protein thioesterase 1"],
    "nope:1": ["ignored: no such node"],
  };
  const index = buildGraphIndex(fixture, { aliases });

  test("plurals fold, in the query and in names", () => {
    const hits = index.search("seizures");
    assert.equal(hits[0].node.id, "HP:0001250");
    assert.equal(hits[0].matched, "Seizure", "the label matched, so no other name is noted");
    assert.deepEqual(ids(index.search("Seizure")), ids(hits));
    assert.deepEqual(ids(index.search("neuronal ceroid lipofuscinoses")), [CLN1, CLN3, CLN10]);
  });

  test("typos: one for words of 4-7 letters, two from 8, none in shorter words or numbers", () => {
    assert.equal(index.search("siezure")[0].node.id, "HP:0001250", "a swap of two letters is one edit");
    assert.equal(index.search("sezure")[0].node.id, "HP:0001250");
    assert.deepEqual(ids(index.search("stive")), [SWS]);
    assert.deepEqual(index.search("stibe"), [], "two edits in a 5-letter word");
    assert.deepEqual(ids(index.search("weidemen")), [SWS], "two edits in an 8-letter word");
    assert.deepEqual(index.search("ppt2"), [], "numbers never bend: PPT2 is not PPT1");
    assert.deepEqual(index.search("cnl"), [], "no typo in a 3-letter word");
  });

  test("short words stay strict: no typo into a shorter word, a slipped start or a stem inside a word", () => {
    const noisy = buildGraphIndex(
      graphOf(
        [
          node("D:1", "Disease", "sulfite oxidase deficiency"),
          node("D:2", "Disease", "Witschel dystrophy"),
          node("HP:1", "Phenotype", "Microtia, first degree"),
          node("NIH:1", "Grant", "Notochord vacuoles: investigating its role"),
        ],
        [edge("x1", "has_phenotype", "D:1", "HP:1"), edge("x2", "funds", "NIH:1", "D:2")],
      ),
    );
    assert.deepEqual(noisy.search("fits"), [], "not “its”, “firs(t)”, “Wits(chel)” or “sul-fit-e”");
    assert.deepEqual(ids(noisy.search("frist")), ["HP:1"], "a five-letter word still forgives a swap");
  });

  test("a word that exists is taken as typed, not as a typo for another", () => {
    // "status" is a real word here, so it does not also reach "stuve" or "stive".
    assert.deepEqual(index.search("status"), []);
  });

  test("words in any order, only the last one a prefix", () => {
    assert.deepEqual(ids(index.search("lipofuscinosis neuronal")), [CLN1, CLN3, CLN10]);
    assert.deepEqual(ids(index.search("ceroid neur")), [CLN1, CLN3, CLN10]);
    assert.deepEqual(index.search("neur ceroid"), []);
  });

  test("an alias typed in full is exact; otherwise every label match ranks first", () => {
    const full = index.search("batten disease");
    assert.equal(full[0].node.id, CLN3);
    assert.equal(full[0].matched, "Batten disease");
    // Label prefix, then label word prefixes (by type), then the alias prefix.
    assert.deepEqual(ids(index.search("batten")), ["ORPHA-REG:1", "ORPHA-ORG:3", "PMID:1", CLN3]);
    assert.equal(index.search("batten").at(-1)?.matched, "Batten disease");
    assert.equal(index.search("thioesterase")[0].matched, "palmitoyl-protein thioesterase 1");
  });

  test("words may come from two names of one node; the shorter one explains the match", () => {
    const hits = index.search("juvenile batten");
    assert.deepEqual(ids(hits), [CLN3]);
    assert.equal(hits[0].matched, "Batten disease");
  });

  test("aliases change no other answer", () => {
    const plain = buildGraphIndex(fixture);
    for (const q of ["cln3", "PPT1", "seizure", "juvenile", "HP:0001250", "stüve"]) assert.deepEqual(ids(index.search(q)), ids(plain.search(q)), q);
    assert.equal(index.search("cln3")[0].matched, "CLN3", "a duplicate alias adds nothing");
    assert.deepEqual(index.diseasesFor("HP:0001250"), plain.diseasesFor("HP:0001250"));
    assert.deepEqual(buildGraphIndex(fixture, { aliases: null }).search("batten disease")[0].node.id, "ORPHA-REG:1");
  });

  test("didYouMean offers close names when search finds nothing", () => {
    assert.deepEqual(index.search("wideman"), []);
    assert.deepEqual(ids(index.didYouMean("wideman")), [SWS]);
    assert.deepEqual(ids(index.didYouMean("wideman syndrome")), [SWS], "generic words do not pick names");
    assert.deepEqual(index.didYouMean("wideman", 3, ["Gene"]), []);
    assert.deepEqual(index.didYouMean("xyzzy"), []);
    assert.deepEqual(index.didYouMean(""), []);
    assert.deepEqual(index.didYouMean("wideman", 0), []);
    // Three edits: too many for search, close enough to suggest; equal suggestions in label order.
    assert.deepEqual(index.search("lypofusinosys"), []);
    assert.deepEqual(ids(index.didYouMean("lypofusinosys")), [CLN1, CLN3, CLN10]);
    assert.deepEqual(ids(index.didYouMean("lypofusinosys", 2)), [CLN1, CLN3]);
  });
});

// The real graph and the alias file (scripts/build-search-aliases.ts), when present. What a query
// finds depends on what MONDO and HPO actually list; each test says so.
const GRAPH = new URL("../../public/graph.json", import.meta.url);
const ALIASES = new URL("../../public/search-aliases.json", import.meta.url);
const real = existsSync(GRAPH) && existsSync(ALIASES);

describe("search on public/graph.json with public/search-aliases.json", { skip: real ? false : "graph or alias file not built" }, () => {
  const graph: AtlasGraph = real ? JSON.parse(readFileSync(GRAPH, "utf8")) : graphOf([], []);
  const aliases: Record<string, string[]> = real ? JSON.parse(readFileSync(ALIASES, "utf8")).aliases : {};
  const index = buildGraphIndex(graph, { aliases });
  const top = (q: string) => index.search(q)[0];
  const folded = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const anyAlias = (re: RegExp) => Object.values(aliases).flat().filter((name) => re.test(name));

  test("“Best disease”: MONDO's name for vitelliform macular dystrophy 2, and not the gene's", () => {
    const hits = index.search("Best disease");
    assert.deepEqual(ids(hits), ["MONDO:0007931"]);
    assert.equal(hits[0].matched, "Best disease");
    assert.ok(!aliases["HGNC:12703"].includes("Best disease"), "Monarch lists it for BEST1 too; the alias script leaves it out");
  });

  test("no gene goes by a disease's name", () => {
    const diseaseNames = new Set(graph.nodes.filter((n) => n.type === "Disease").flatMap((n) => [n.label, ...(aliases[n.id] ?? [])].map(folded)));
    for (const gene of graph.nodes.filter((n) => n.type === "Gene")) {
      for (const name of aliases[gene.id] ?? []) {
        assert.ok(!/\b(disease|syndrome|dystrophy)\b/i.test(name), `${gene.label}: ${name}`);
        assert.ok(!diseaseNames.has(folded(name)), `${gene.label}: ${name}`);
      }
    }
  });

  test("“globoid cell leukodystrophy”: a MONDO synonym of Krabbe disease", () => {
    assert.equal(top("globoid cell leukodystrophy").node.id, "MONDO:0009499");
    assert.equal(top("globoid cell leukodystrophy").matched, "globoid cell leukodystrophy");
    assert.equal(top("cell globoid leuko").node.id, "MONDO:0009499", "any order, last word a prefix");
  });

  test("“gauchr”: one typo still finds the five Gaucher diseases first", () => {
    const hits = index.search("gauchr");
    assert.deepEqual(ids(hits).slice(0, 5).sort(), ["MONDO:0009265", "MONDO:0009266", "MONDO:0009267", "MONDO:0009268", "MONDO:0011945"]);
    assert.ok(hits.slice(0, 5).every((h) => h.matched === h.node.label));
  });

  test("“seizures”: the plural folds onto Seizure (HPO also lists “Seizures”)", () => {
    assert.equal(top("seizures").node.id, "HP:0001250");
    assert.ok(aliases["HP:0001250"].includes("Seizures"));
  });

  test("“vision loss”: HPO has no such synonym, but two of Visual impairment's names hold the words", () => {
    assert.ok(!anyAlias(/vision loss/i).length, "no node here is called “vision loss” in HPO");
    const hit = top("vision loss");
    assert.equal(hit.node.id, "HP:0000505");
    assert.equal(hit.matched, "Impaired vision", "one name explains the match: the shorter of the two");
  });

  test("“fits”: a four-letter word finds no noise in long titles", () => {
    assert.deepEqual(index.search("fits"), []);
  });

  test("“costeff”: MONDO's “Costeff syndrome” finds 3-methylglutaconic aciduria type 3", () => {
    const hits = index.search("costeff");
    // The GeneReviews chapter is titled “Costeff Syndrome.”: a label prefix, so it ranks above
    // the disease, which only an alias names that way.
    assert.deepEqual(ids(hits).slice(0, 2), ["PMID:20301646", "MONDO:0009787"]);
    assert.equal(hits[1].matched, "Costeff syndrome");
    assert.equal(top("costeff syndrome").node.id, "MONDO:0009787", "typed in full, the alias is exact and the disease leads");
  });

  test("“morquio”: MONDO's Morquio names lead to mucopolysaccharidosis type 4B (the only Morquio here)", () => {
    assert.equal(top("morquio").node.id, "MONDO:0009660");
    assert.equal(top("morquio").matched, "Morquio syndrome B");
    assert.deepEqual(ids(index.search("morkio")), [], "two edits in a 6-letter word is too far for search");
    assert.deepEqual(ids(index.didYouMean("morkio")), ["MONDO:0009660"], "but close enough to suggest");
  });

  test("“lysosomal storage”: a MONDO grouping, not a synonym of any disease here, so only a paper title matches", () => {
    assert.deepEqual(anyAlias(/lysosomal storage/i), []);
    assert.deepEqual(ids(index.search("lysosomal storage")), ["PMID:38253667"]);
  });

  test("did you mean: close names, and none when nothing is close", () => {
    assert.deepEqual(index.search("gaushur"), []);
    assert.deepEqual(ids(index.didYouMean("gaushur")), ["MONDO:0009265", "MONDO:0009266", "MONDO:0009267"]);
    assert.equal(index.didYouMean("tay sax")[0].node.id, "MONDO:0010100");
    assert.deepEqual(index.didYouMean("cancer"), []);
  });

  test("every alias belongs to a node of the graph and differs from its label", () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const [id, names] of Object.entries(aliases)) {
      const node = byId.get(id);
      assert.ok(node, id);
      for (const name of names) assert.notEqual(folded(name), folded(node.label), `${id}: ${name}`);
    }
  });

  test("search stays fast: well under 20 ms a query", () => {
    const queries = ["Best disease", "globoid cell leukodystrophy", "gauchr", "seizures", "vision loss", "costeff", "morquio", "lysosomal storage", "g", "xyzzy"];
    for (const q of queries) index.search(q); // warm up
    const start = performance.now();
    const rounds = 5;
    for (let i = 0; i < rounds; i++) for (const q of queries) index.search(q);
    const each = (performance.now() - start) / (rounds * queries.length);
    assert.ok(each < 20, `${each.toFixed(1)} ms a query`);
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
