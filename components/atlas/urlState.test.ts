import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLD, defaultThreshold, parseState, stateQuery } from "./urlState.ts";

test("a new search opens where its related diseases are on the map", () => {
  assert.equal(defaultThreshold([]), DEFAULT_THRESHOLD, "nothing related: the plain default");
  assert.equal(defaultThreshold([{ relevance: 0.86 }, { relevance: 0.5 }], 0.45), 0.8, "a strong link: strong links first");
  assert.equal(defaultThreshold([{ relevance: 0.7 }, { relevance: 0.48 }], 0.45), 0.45, "no strong link: every moderate one");
  assert.equal(defaultThreshold([{ relevance: 0.4451 }], 0.45), 0.4, "only weaker links: the best one, rounded down to 5%");
  assert.equal(defaultThreshold([{ relevance: 0.7 }]), 0.7, "no cutoffs in the grade file: the best one");
  for (const related of [[{ relevance: 0.7 }], [{ relevance: 0.6281 }, { relevance: 0.3 }], [{ relevance: 0.2 }]]) {
    const t = defaultThreshold(related, 0.45);
    assert.ok(related.some((r) => r.relevance >= t - 1e-9), `at ${t} the best related disease is shown`);
  }
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
