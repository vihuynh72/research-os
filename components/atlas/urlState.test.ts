import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLD, defaultThreshold, parseState, stateQuery } from "./urlState.ts";

const related = (...values: number[]) => values.map((relevance) => ({ relevance }));

test("a new search opens with its five most related diseases on the map", () => {
  assert.equal(defaultThreshold([]), DEFAULT_THRESHOLD, "nothing related: the plain default");
  assert.equal(defaultThreshold(related(0.7, 0.45, 0.45, 0.41, 0.41, 0.32, 0.2)), 0.41, "the fifth one's relevance");
  assert.equal(defaultThreshold(related(0.32, 0.7, 0.41, 0.45, 0.2, 0.41, 0.45)), 0.41, "in any order");
  assert.equal(defaultThreshold(related(0.6281, 0.3)), 0.3, "fewer than five: the last one");
  assert.equal(defaultThreshold(related(0.4451)), 0.44, "rounded down to a whole percent");
  assert.equal(defaultThreshold(related(0.95, 0.9, 0.88, 0.86, 0.85, 0.5)), 0.8, "never above 80%");
  assert.equal(defaultThreshold(related(0.03)), 0.05, "never below 5%");
  for (const values of [[0.7], [0.6281, 0.3], [0.2], [0.7, 0.45, 0.45, 0.41, 0.41, 0.41, 0.2], [0.5099999999]]) {
    const t = defaultThreshold(related(...values));
    const shown = values.filter((v) => v >= t - 1e-9).length;
    assert.ok(shown >= Math.min(5, values.length), `at ${t}, ${shown} of ${values.join(", ")} are shown`);
  }
  const tied = related(0.7, 0.45, 0.45, 0.41, 0.41, 0.41, 0.2);
  const t = defaultThreshold(tied);
  assert.equal(tied.filter((r) => r.relevance >= t - 1e-9).length, 6, "ties with the fifth come in together");
});

test("the filter is in the link only when someone set it", () => {
  const plain = parseState({ d: "MONDO:1" });
  assert.equal(plain.threshold, null);
  assert.equal(stateQuery(plain), "?d=MONDO:1");
  const set = parseState({ d: "MONDO:1", r: "80" });
  assert.equal(set.threshold, 0.8);
  assert.equal(stateQuery(set), "?d=MONDO:1&r=80", "a filter the person chose stays, even at 80%");
  assert.equal(stateQuery(parseState({ d: "MONDO:1", r: "135" })), "?d=MONDO:1&r=100");
  assert.equal(stateQuery(parseState({})), "", "no center: the start screen");
  assert.deepEqual(parseState({ d: "X", hide: "Gene,Nonsense,Disease", open: "b,a,a" }).hidden, ["Disease", "Gene"]);
});

test("a shared 3D link opens the 3D view; a link without view opens the 2D map", () => {
  const shared = parseState({ d: "MONDO:1", sel: "MONDO:2", view: "3d", mode: "researcher" });
  assert.equal(shared.view, "3d");
  assert.equal(stateQuery(shared), "?d=MONDO:1&sel=MONDO:2&view=3d&mode=researcher", "the view survives the round trip");
  assert.equal(stateQuery(parseState({ view: "3d" })), "?view=3d", "the start screen in 3D");
  assert.equal(parseState({ d: "MONDO:1" }).view, "2d");
  assert.equal(parseState({ d: "MONDO:1", view: "2d" }).view, "2d");
  assert.equal(parseState({ d: "MONDO:1", view: "4d" }).view, "2d", "an unknown view opens the map");
  assert.equal(stateQuery(parseState({ d: "MONDO:1", view: "2d" })), "?d=MONDO:1", "the default view stays out of the link");
  assert.equal(stateQuery(parseState({ d: "MONDO:1", list: "1" })), "?d=MONDO:1&list=1");
});
