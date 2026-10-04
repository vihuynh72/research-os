import test from "node:test";
import assert from "node:assert/strict";
import { FLAGS } from "../../lib/grading/types.ts";
import * as say from "./explain.ts";

test("same-gene sentences are plain and carry the caveat separately", () => {
  assert.equal(say.sameGeneClaim(["COL2A1"]), "Both are linked to changes in the same gene, COL2A1.");
  assert.equal(say.sameGeneClaim(["A", "B"]), "Both are linked to changes in the same genes, A and B.");
  assert.match(say.SAME_GENE_CAVEAT, /different ways/);
});

test("a shared pathway names the genes, the pathway and how few diseases share it", () => {
  assert.equal(
    say.pathwayClaim({ pathway: "Hyaluronan degradation", genes: ["HEXA", "HEXB"], reach: 2, withData: 81 }),
    "Their genes, HEXA and HEXB, are both listed in the Reactome pathway “Hyaluronan degradation”, which only 2 of the 81 diseases with pathway data share.",
  );
  assert.equal(say.pathwayReason({ pathway: "X", genes: ["A"], reach: 9, withData: 81 }), "Their genes share the pathway “X” (9 of 81 diseases with pathway data).");
  assert.match(say.pathwaysWithGeneClaim(2, "GBA1"), /^The 2 pathways they share come with GBA1 itself/);
  assert.match(say.PATHWAY_NOTE, /not that the diseases share a mechanism/);
});

test("gene-change types are said in words, never as LOF or missense jargon", () => {
  const text = say.variantClaim("partial", { genes: ["HEXB"], kind: "mostly_lof", lof: 3, classified: 3 }, { genes: ["HEXA"], kind: "mixed", lof: 1, classified: 2 });
  assert.equal(text, "Their gene changes partly agree in type: HEXB's mostly switch the gene off (3 of 3); HEXA's are a mix of types (1 of 2 switch it off).");
  assert.doesNotMatch(text, /LOF|loss-of-function|missense/i);
  assert.match(say.geneLevelVariantsClaim(["GBA1"]), /belong to GBA1 itself/);
});

test("the symptom comparison never contradicts a 'looks different' tier", () => {
  const gaucher = say.symptomClaim({ shared: 7, rare: 1, score: 0.0507, percentile: 0.9915, tier: "different" });
  assert.equal(gaucher, "7 shared symptoms, 1 of them rare: slightly more overlap than unrelated diseases, too little to look alike.");
  assert.match(say.symptomClaim({ shared: 14, rare: 4, score: 1, tier: "very_similar" }), /about as much overlap as two records of the same disease/);
  assert.match(say.symptomClaim({ shared: 1, rare: 0, score: 0, percentile: 0.6, tier: "different" }), /^1 shared symptom, a common one: no more overlap/);
  assert.equal(say.noSymptomsClaim(["A", "B"]), "No symptoms on record for either disease, so they can't be compared.");
});

test("symptom rarity in words", () => {
  assert.equal(say.rarityWord(0.9), "Rare");
  assert.equal(say.rarityWord(0.6), "Uncommon");
  assert.equal(say.rarityWord(0.2), "Common");
  assert.equal(say.rarityWord(undefined), null);
  assert.equal(say.rarityClaim("Seizure", 0.2, (x) => `${Math.floor(x * 100)}%`), "Seizure is a common symptom: more specific than only 20% of symptoms recorded for rare diseases.");
});

test("the data's gap notes in plain words, each tied to the dataset searched", () => {
  assert.equal(say.gapText("no NIH RePORTER project"), "No NIH-funded project found.");
  assert.equal(say.gapText("no name-matched Orphanet group"), "No patient group found in Orphanet's directory by name.");
  assert.equal(say.gapText("no PubMed hit"), "No PubMed paper found.");
  assert.equal(say.gapText("something new"), "Something new.");
  assert.equal(say.gapDataset("no NIH RePORTER project"), "nih");
  assert.equal(say.gapDataset("no name-matched Orphanet group"), "orphanet");
  assert.equal(say.gapDataset("no PubMed hit"), "pubmed");
});

test("every flag reads as plain words or is said elsewhere, never as jargon", () => {
  for (const flag of FLAGS) {
    const text = say.reviewText(flag, { gene: "GBA1", fewFor: [{ name: "Legg-Calve-Perthes disease", n: 2 }] });
    if (text === null) continue;
    assert.doesNotMatch(text, /allelic|phenotype|SimGIC|\bIC\b|\bLOF\b|AI review/, flag);
  }
  assert.match(say.reviewText("same_gene_allelic", { gene: "GBA1" })!, /GBA1/);
  assert.match(say.reviewText("few_annotations", { fewFor: [{ name: "Legg-Calve-Perthes disease", n: 2 }] })!, /Legg-Calve-Perthes disease \(2\)/);
});

test("the evidence summary counts sources by kind", () => {
  assert.equal(say.summaryText({ total: 12, stated: 9, inferred: 3, searched: 0, disputed: 0 }), "Based on 12 sources: 9 stated by curated databases, 3 inferred");
  assert.equal(say.summaryText({ total: 3, stated: 1, inferred: 0, searched: 2, disputed: 0 }), "Based on 3 sources: 1 stated by curated databases, 2 searches with no result");
  assert.equal(say.shortSource("HPO (via Monarch)"), "HPO");
  assert.equal(say.shortSource("Orphanet directory"), "Orphanet");
});

test("cluster names in plain words", () => {
  assert.equal(say.plainClusterName("Same gene: COL2A1"), "Linked to the gene COL2A1");
  assert.equal(say.plainClusterName("Melanin biosynthesis"), "Shares the melanin biosynthesis pathway");
  assert.equal(say.plainClusterName("CS/DS degradation"), "Shares the CS/DS degradation pathway");
  assert.equal(say.plainClusterName("Golgi Associated Vesicle Biogenesis"), "Shares the Golgi Associated Vesicle Biogenesis pathway");
  assert.equal(say.plainClusterName(null), "Not in a group yet");
  assert.equal(say.shortClusterName("Same gene: COL2A1"), "COL2A1");
});
