import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph } from "../../lib/graph/types.ts";
import type { RelevanceDoc } from "../../lib/grading/types.ts";
import { applyThreshold, buildNeighborhood } from "../../lib/graph/neighborhood.ts";
import { constellationScene, neighborhoodScene } from "./scene3d.ts";
import { buildModel, formatPercent, type AtlasModel } from "./format.ts";
import { cleanGraph } from "./names.ts";
import { defaultThreshold } from "./urlState.ts";
import { LABEL_BUDGET, topRelatedIds } from "./map/labelBudget.ts";

// The atlas's own data, cleaned as AtlasApp cleans it.
function fixture(): AtlasModel {
  const graph: AtlasGraph = JSON.parse(readFileSync(new URL("../../public/graph.json", import.meta.url), "utf8"));
  const relevance: RelevanceDoc = JSON.parse(readFileSync(new URL("../../public/relevance.json", import.meta.url), "utf8"));
  return buildModel(cleanGraph(graph), relevance);
}

const TAY_SACHS = "MONDO:0010100";

test("the blank 3D scene contains every disease at finite coordinates, with only a few names", () => {
  const model = fixture();
  const scene = constellationScene(model);
  assert.equal(scene.nodes.length, model.diseaseCount);
  assert.equal(new Set(scene.nodes.map((node) => node.id)).size, model.diseaseCount);
  assert(scene.nodes.every((node) => node.coords.length === 3 && node.coords.every(Number.isFinite)));
  const named = scene.nodes.filter((node) => node.labelled);
  assert(named.length > 0 && named.length <= 8, `${named.length} names`);
  // As on the 2D universe, the names are the colored groups' ("COL2A1 · 12"), not single diseases.
  for (const node of named) assert.match(node.shortLabel, / · \d+$/);
  assert.deepEqual(scene, constellationScene(model));
});

test("the focused 3D scene preserves filters, provenance, and selection", () => {
  const model = fixture();
  const focus = model.index.diseases[0].id;
  const hood = buildNeighborhood(model.graph, model.relevance, focus);
  const filtered = applyThreshold(hood, 0.5, new Set(["Phenotype"]));
  const selected = filtered.nodes.find((node) => node.id !== focus)?.id ?? null;
  const scene = neighborhoodScene(model, hood, filtered, 0.5, selected);
  assert.deepEqual(scene.nodes.map((node) => node.id), [...filtered.nodes, ...filtered.ghosts].map((node) => node.id));
  assert(scene.nodes.every((node) => node.coords.every(Number.isFinite)));
  assert.equal(scene.nodes.find((node) => node.id === focus)?.emphasis, "focus");
  const ids = new Set(scene.nodes.map((node) => node.id));
  const edges = [...filtered.faintEdges, ...filtered.edges].filter((edge) => ids.has(edge.a) && ids.has(edge.b));
  scene.links.forEach((link, index) => {
    assert(ids.has(link.a) && ids.has(link.b));
    assert.equal(link.dashed, edges[index].role === "bridge" || edges[index].kind !== "observed");
    assert.equal(link.strength, edges[index].strength);
    assert.equal(link.emphasis, edges[index].id === selected ? "selected" : "normal");
  });
  assert.deepEqual(scene, neighborhoodScene(model, hood, filtered, 0.5, selected));
});

test("the 3D map follows the 2D map's design: white focus disc, top five named with their grade, few names", () => {
  const model = fixture();
  const hood = buildNeighborhood(model.graph, model.relevance, TAY_SACHS);
  const threshold = defaultThreshold(hood.related);
  const filtered = applyThreshold(hood, threshold);
  const scene = neighborhoodScene(model, hood, filtered, threshold, null);
  const focus = scene.nodes.find((node) => node.id === TAY_SACHS)!;
  assert.equal(focus.color, "var(--surface)");
  assert.equal(focus.ink, "var(--accent)");
  assert(focus.labelled && focus.strong && focus.icon);
  const top = topRelatedIds(filtered.nodes);
  assert.equal(top.size, 5);
  for (const id of top) {
    const node = scene.nodes.find((n) => n.id === id)!;
    assert(node.labelled && node.strong, `${node.label} is named`);
    assert.match(node.tierLabel ?? "", /^([A-Z][a-z]+ · )?\d+(\.\d)?%$/, "the grade, then the percent");
  }
  assert(scene.nodes.filter((node) => node.labelled).length <= LABEL_BUDGET);
  assert(scene.nodes.every((node) => node.shortLabel[0] === node.shortLabel[0].toUpperCase()), "names in sentence case");
  assert(scene.nodes.every((node) => !/mechanism/i.test(`${node.detail} ${node.label}`)), "pathway, never mechanism");
  assert(scene.rings.some((ring) => ring.kind === "filter" && ring.label === `≥ ${formatPercent(threshold)}`));
});
