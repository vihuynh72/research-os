import test from "node:test";
import assert from "node:assert/strict";
import type { AtlasGraph } from "../../lib/graph/types.ts";
import { cleanGraph, decodeEntities, displayName, distinctNames, fitName, wrapName } from "./names.ts";

test("HTML entities in source records become plain text", () => {
  assert.equal(decodeEntities("CATS - The Cure &amp; Action for Tay-Sachs (CATS) Foundation"), "CATS - The Cure & Action for Tay-Sachs (CATS) Foundation");
  assert.equal(decodeEntities("&lt;5% &quot;rare&quot; &#38; &#x26; &#X2014; caf&eacute; &Ouml;GG"), '<5% "rare" & & — café ÖGG');
  assert.equal(decodeEntities("Smith &amp;amp; Jones"), "Smith & Jones", "escaped twice");
  assert.equal(decodeEntities("A &unknown; entity, &#0; and a bare & stay"), "A &unknown; entity, &#0; and a bare & stay");
  assert.equal(decodeEntities("Tay-Sachs disease"), "Tay-Sachs disease");
});

test("the cleaned graph decodes labels, synonyms and evidence once and reuses the rest", () => {
  const graph: AtlasGraph = {
    meta: { schema_version: "0.1.0", generated_at: "2026-10-03T00:00:00Z" },
    nodes: [
      { id: "O1", type: "PatientOrg", label: "Cure &amp; Action", synonyms: ["C&amp;A"], source: "Orphanet", url: "https://example.org/o1" },
      { id: "D1", type: "Disease", label: "Tay-Sachs disease", source: "Monarch", url: "https://example.org/d1" },
    ],
    edges: [
      { id: "e1", type: "works_on", subject: "O1", object: "D1", source: "Orphanet", url: "https://example.org", date: "2026-10-03", confidence: 0.5, kind: "inferred", evidence: "name contains &quot;Tay&quot;" },
    ],
  };
  const clean = cleanGraph(graph);
  assert.equal(clean.nodes[0].label, "Cure & Action");
  assert.deepEqual(clean.nodes[0].synonyms, ["C&A"]);
  assert.equal(clean.edges[0].evidence, 'name contains "Tay"');
  assert.equal(clean.nodes[1], graph.nodes[1], "an unchanged node is the same object");
  assert.equal(graph.nodes[0].label, "Cure &amp; Action", "the input is left as it was");
  const plain = { ...graph, nodes: [graph.nodes[1]], edges: [] };
  assert.equal(cleanGraph(plain), plain, "nothing to decode: the same graph");
});

test("a long name keeps the end that tells it apart", () => {
  assert.equal(fitName("oculocutaneous albinism type 1A", 24), "oculocutaneous… type 1A");
  assert.equal(fitName("Hermansky-Pudlak syndrome 10", 24), "Hermansky-Pudlak… 10");
  assert.match(fitName("spondyloepiphyseal dysplasia, Stanescu type", 26), /… Stanescu type$/);
  assert.equal(fitName("Kniest dysplasia", 24), "Kniest dysplasia", "a name that fits is left whole");
  for (const max of [20, 24, 32]) assert.ok(fitName("mild spondyloepiphyseal dysplasia due to COL2A1 mutation with early-onset osteoarthritis", max).length <= max);
});

test("names wrap over lines, evenly, without splitting their tail", () => {
  assert.deepEqual(wrapName("oculocutaneous albinism type 1A", 26, 2), ["oculocutaneous", "albinism type 1A"]);
  assert.deepEqual(wrapName("Hermansky-Pudlak syndrome 10", 26, 2), ["Hermansky-Pudlak", "syndrome 10"]);
  assert.deepEqual(wrapName("GM1 gangliosidosis type 2", 24, 2), ["GM1 gangliosidosis", "type 2"]);
  const long = wrapName("mild spondyloepiphyseal dysplasia due to COL2A1 mutation with early-onset osteoarthritis", 26, 2);
  assert.equal(long.length, 2);
  assert.ok(long.every((line) => line.length <= 26) && long[1].endsWith("…"));
});

test("short names of a set are never alike", () => {
  const labels = ["oculocutaneous albinism type 1A", "oculocutaneous albinism type 1B", "oculocutaneous albinism type 2", "Griscelli syndrome type 1", "Griscelli syndrome type 2", "spondyloepiphyseal dysplasia congenita", "spondyloepiphyseal dysplasia with metatarsal shortening"];
  const names = distinctNames(labels.map((label, i) => ({ id: `d${i}`, label })), 24);
  assert.equal(new Set(names.values()).size, labels.length);
  assert.ok([...names.values()].every((n) => n.length <= 24));
});

test("a compact synonym wins when there is one", () => {
  assert.equal(displayName({ label: "CLN3 disease", synonyms: ["Batten disease", "CLN3"] }, 40), "CLN3");
  assert.equal(displayName({ label: "Krabbe disease" }, 40), "Krabbe disease");
});
