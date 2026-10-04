import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { efetchUrl, parsePubmedXml } from "./pubmed.ts";

// A real efetch answer (2026-10-03), trimmed of reference lists: a journal article that prints two authors'
// emails, a GeneReviews chapter, and a review whose thirteen authors all print one.
const xml = readFileSync(new URL("./fixtures/efetch.xml", import.meta.url), "utf8");
const papers = parsePubmedXml(xml);

test("every record in an efetch answer is read, articles and book chapters alike", () => {
  assert.deepEqual(
    papers.map((p) => p.pmid),
    ["35145305", "20301446", "28218669"],
  );
});

test("a journal article: title, journal, year, abstract and authors in order", () => {
  const aav = papers[0];
  assert.equal(aav.title, "AAV gene therapy for Tay-Sachs disease.");
  assert.equal(aav.journal, "Nature medicine");
  assert.equal(aav.year, 2022);
  assert.equal(aav.url, "https://pubmed.ncbi.nlm.nih.gov/35145305/");
  assert.ok(aav.abstract.length > 200 && aav.abstract.length <= 801);
  assert.equal(aav.authors.length, 30);
  const [first, last] = [aav.authors[0], aav.authors[29]];
  assert.deepEqual([first.foreName, first.lastName, first.orcid], ["Terence R", "Flotte", "0000-0002-8255-0588"]);
  assert.deepEqual(first.emails, ["Terry.Flotte@umassmed.edu"], "the same address in two affiliations is listed once");
  assert.match(first.affiliation, /^Department of Pediatrics, UMass Chan Medical School/);
  assert.deepEqual([last.foreName, last.lastName], ["Miguel", "Sena-Esteves"]);
  assert.deepEqual(last.emails, ["Miguel.esteves@umassmed.edu"]);
  assert.equal(aav.authors.filter((a) => a.emails.length > 0).length, 2);
});

test("a GeneReviews chapter: its own title and authors (not the book's editors), dated by its last revision", () => {
  const chapter = papers[1];
  assert.equal(chapter.title, "Gaucher Disease");
  assert.equal(chapter.journal, "GeneReviews®");
  assert.equal(chapter.year, 2023);
  assert.deepEqual(
    chapter.authors.map((a) => `${a.foreName} ${a.lastName}`),
    ["Derralynn A Hughes", "Gregory M Pastores"],
  );
  assert.match(chapter.abstract, /^Clinical characteristics: /, "structured abstracts keep their labels");
});

test("accented names are decoded and every author's printed email is kept with its author", () => {
  const review = papers[2];
  assert.equal(review.authors[0].foreName, "Jérôme");
  assert.equal(review.authors[0].lastName, "Stirnemann");
  assert.deepEqual(review.authors[9].emails, ["anais.brassier@nck.aphp.fr"]);
  assert.equal(review.authors.filter((a) => a.emails.length === 1).length, 13);
});

test("an address printed for several authors stays only with the author whose name it carries", () => {
  // PMID 25146916 (real, 2026-10-03): the first and the last author each print both corresponding emails.
  const [behr] = parsePubmedXml(readFileSync(new URL("./fixtures/efetch-shared-emails.xml", import.meta.url), "utf8"));
  const first = behr.authors[0];
  const last = behr.authors[behr.authors.length - 1];
  assert.deepEqual([first.lastName, first.emails], ["Carelli", ["valerio.carelli@unibo.it"]]);
  assert.deepEqual([last.lastName, last.emails], ["Bertini", ["ebertini@tin.it"]]);
  assert.equal(behr.authors.filter((a) => a.emails.length > 0).length, 2);
});

test("records that cannot be read are skipped, not guessed", () => {
  assert.deepEqual(parsePubmedXml(""), []);
  assert.deepEqual(parsePubmedXml("<ERROR>Empty id list</ERROR>"), []);
  assert.deepEqual(parsePubmedXml("<PubmedArticle><MedlineCitation><PMID>abc</PMID></MedlineCitation></PubmedArticle>"), []);
});

test("efetch identifies RareVerse to NCBI only when the server is told how", () => {
  assert.equal(efetchUrl(["1", "2"]), "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=1%2C2&retmode=xml");
  assert.match(efetchUrl(["1"], { NCBI_TOOL: "rareverse", NCBI_EMAIL: "team@example.org" }), /&tool=rareverse&email=team%40example\.org$/);
});
