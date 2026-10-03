import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGraphIndex } from "../../lib/graph/index.ts";
import type { AtlasGraph } from "../../lib/graph/types.ts";
import type { RelevanceDoc } from "../../lib/grading/types.ts";
import { applyThreshold, buildNeighborhood } from "../../lib/graph/neighborhood.ts";
import { constellationScene, neighborhoodScene } from "./scene3d.ts";
import type { AtlasModel } from "./format";

function fixture(): AtlasModel {
  const graph: AtlasGraph = JSON.parse(readFileSync(new URL("../../public/graph.sample.json", import.meta.url), "utf8"));
  const relevance: RelevanceDoc = JSON.parse(readFileSync(new URL("../../public/relevance.sample.json", import.meta.url), "utf8"));
  return {
    graph,
    relevance,
    index: buildGraphIndex(graph),
    edgeById: new Map(graph.edges.map((edge) => [edge.id, edge])),
    pairs: new Map(),
    clusters: new Map(relevance.clusters.map((cluster) => [cluster.id, cluster])),
    diseaseCount: graph.nodes.filter((node) => node.type === "Disease").length,
  };
}

test("the blank 3D scene contains every disease at finite coordinates", () => {
  const model = fixture();
  const scene = constellationScene(model);
  assert.equal(scene.nodes.length, model.diseaseCount);
  assert.equal(new Set(scene.nodes.map((node) => node.id)).size, model.diseaseCount);
  assert(scene.nodes.every((node) => node.coords.length === 3 && node.coords.every(Number.isFinite)));
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