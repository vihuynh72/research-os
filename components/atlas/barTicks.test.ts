import test from "node:test";
import assert from "node:assert/strict";
import { labelledTicks } from "./barTicks.ts";

const ticks = (strong: number, moderate: number, exploratory: number) => [
  { v: 1, label: "Direct" },
  { v: strong, label: "Strong" },
  { v: moderate, label: "Moderate" },
  { v: exploratory, label: "Exploratory" },
];

test("tick labels far apart all print", () => {
  assert.deepEqual([...labelledTicks(ticks(0.75, 0.45, 0.2), 500, true)].sort(), ["Direct", "Exploratory", "Moderate", "Strong"]);
});

test("cutoffs near 100 never print over each other; tiers keep their labels before Direct", () => {
  const vertical = labelledTicks(ticks(0.99, 0.95, 0.8), 500, true);
  assert.ok(vertical.has("Strong") && vertical.has("Moderate") && vertical.has("Exploratory"));
  assert.ok(!vertical.has("Direct"), "Direct 100 sits 5px from Strong 99: one of them goes");
  const horizontal = labelledTicks(ticks(0.99, 0.95, 0.8), 330, false);
  assert.ok(!(horizontal.has("Strong") && horizontal.has("Moderate")), "under a narrow bar, 99 and 95 do not both fit");
});

test("before the bar is measured every label prints (server render)", () => {
  assert.equal(labelledTicks(ticks(0.99, 0.95, 0.8), 0, true).size, 4);
});
