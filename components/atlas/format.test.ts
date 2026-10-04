import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph } from "../../lib/graph/types.ts";
import type { RelevanceDoc } from "../../lib/grading/types.ts";
import { DIMENSIONS } from "../../lib/grading/types.ts";
import { DIMENSION_WORD, buildModel, engineText, exampleNodes } from "./format.ts";

test("engine sentences call a Reactome item a pathway, keeping case and plural", () => {
  assert.equal(
    engineText("Exploratory: their genes share one mechanism, CS/DS degradation (7 of the 81 diseases with a mechanism on record)."),
    "Exploratory: their genes share one pathway, CS/DS degradation (7 of the 81 diseases with a pathway on record).",
  );
  assert.equal(engineText("Their genes share 5 mechanisms. Mechanism: X. MECHANISMS"), "Their genes share 5 pathways. Pathway: X. PATHWAYS");
  assert.equal(engineText("No mechanistic claim, no change."), "No mechanistic claim, no change.");
});

test("every line of evidence has a plain name, and none says mechanism", () => {
  for (const d of DIMENSIONS) assert.ok(DIMENSION_WORD[d] && !/mechanism/i.test(DIMENSION_WORD[d]), d);
  assert.equal(DIMENSION_WORD.mechanism, "Shared pathway");
});

test("the start screen suggests Tay-Sachs disease, GBA1 and Visual impairment, else the automatic pick", () => {
  const graph: AtlasGraph = JSON.parse(readFileSync(new URL("../../public/graph.json", import.meta.url), "utf8"));
  const relevance: RelevanceDoc = JSON.parse(readFileSync(new URL("../../public/relevance.json", import.meta.url), "utf8"));
  assert.deepEqual(
    exampleNodes(buildModel(graph, relevance)).map((n) => n.id),
    ["MONDO:0010100", "HGNC:4177", "HP:0000505"],
  );
  const withoutGba1 = { ...graph, nodes: graph.nodes.filter((n) => n.id !== "HGNC:4177") };
  const examples = exampleNodes(buildModel(withoutGba1, relevance));
  assert.deepEqual(examples.map((n) => n.type), ["Disease", "Gene", "Phenotype"]);
  assert.equal(examples[0].id, "MONDO:0010100");
  assert.notEqual(examples[1].id, "HGNC:4177", "a missing example falls back to the automatic pick of its kind");
});
