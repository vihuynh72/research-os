// Holds the engine to data/curated/answer_key.json. For each CLN pair, the literature (or a mentor
// who re-rates it) says whether the two diseases share their biology closely (high), partly
// (medium) or only as members of the same family (low). The biology score must rank every high pair
// above every medium pair above every low pair, and each pair's tier must fit its rating.
// When a mentor changes a rating, change the key, not this test; then fix the engine or say why not.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { shortLabel } from "../graph/labels.ts";
import type { AtlasGraph } from "../graph/types.ts";
import { buildContext, diseaseName, scoreDimensions } from "./dimensions.ts";
import { gradeGraph } from "./grade.ts";
import { synthesizePair } from "./synthesize.ts";
import { CLINICAL_TIER_WORD, ENGINE_VERSION, pairKey, type HpoReference, type PairGrade, type Tier } from "./types.ts";

const GRAPH = "public/graph.sample.json";
const REFERENCE = "data/reference/hpo-reference.json";
const KEY = "data/curated/answer_key.json";

type Rating = "high" | "medium" | "low";

interface AnswerKey {
  version: number;
  rated_by: string;
  rated_on: string;
  biology: { a: string; b: string; names?: string; expected: Rating; why: string; source?: string }[];
}

const RATINGS: readonly Rating[] = ["high", "medium", "low"];
const RANK: Record<Rating, number> = { high: 3, medium: 2, low: 1 };
const ALLOWED: Record<Rating, readonly Tier[]> = {
  high: ["strong", "moderate"],
  medium: ["moderate"],
  low: ["exploratory", "none"],
};

// Kendall's tau-b: rank agreement between two lists, corrected for ties (the ratings have many).
// 1 = same order, 0 = unrelated, -1 = reversed.
function kendallTauB(x: number[], y: number[]): number {
  let agreement = 0;
  let untiedX = 0;
  let untiedY = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const dx = Math.sign(x[i] - x[j]);
      const dy = Math.sign(y[i] - y[j]);
      agreement += dx * dy;
      if (dx) untiedX++;
      if (dy) untiedY++;
    }
  }
  return untiedX && untiedY ? agreement / Math.sqrt(untiedX * untiedY) : 0;
}

test("Kendall's tau-b on a hand-worked example", () => {
  assert.equal(kendallTauB([1, 2, 3], [10, 20, 30]), 1);
  assert.equal(kendallTauB([1, 2, 3], [30, 20, 10]), -1);
  // 4 concordant pairs, one tie in each list: 4 / sqrt(5 * 5).
  assert.ok(Math.abs(kendallTauB([1, 1, 2, 3], [1, 2, 2, 3]) - 0.8) < 1e-12);
});

const missing = [GRAPH, REFERENCE, KEY].filter((path) => !existsSync(path));

test(
  "biology grades follow the answer key",
  { skip: missing.length ? `${missing.join(" and ")} missing: run npm run data:hpo && npm run data:sample` : false },
  () => {
    const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
    const graph = read<AtlasGraph>(GRAPH);
    const reference = read<HpoReference>(REFERENCE);
    const key = read<AnswerKey>(KEY);
    const doc = gradeGraph(graph, reference);
    const listed = new Map(doc.pairs.map((pair) => [pairKey(pair.a, pair.b), pair]));
    const ctx = buildContext(graph, reference);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

    // A pair the output leaves out (nothing gradable in common) is graded directly, so every rated
    // pair is checked, shown or not.
    const rows = key.biology.map((entry) => {
      for (const id of [entry.a, entry.b]) assert.equal(nodes.get(id)?.type, "Disease", `${KEY}: ${id} is not a disease in ${GRAPH}`);
      const [a, b] = entry.a < entry.b ? [entry.a, entry.b] : [entry.b, entry.a];
      const names = { a: diseaseName(ctx, a), b: diseaseName(ctx, b) };
      const grade: PairGrade = listed.get(pairKey(a, b)) ?? synthesizePair(a, b, scoreDimensions(ctx, a, b), [], names);
      const label = entry.names ?? `${shortLabel(nodes.get(entry.a) ?? { label: entry.a })}-${shortLabel(nodes.get(entry.b) ?? { label: entry.b })}`;
      return { entry, grade, label };
    });
    assert.ok(rows.length > 0, `${KEY} rates no pairs`);

    const tau = kendallTauB(
      rows.map((row) => RANK[row.entry.expected]),
      rows.map((row) => row.grade.biology),
    );
    const lines = [
      `Answer key (${key.rated_by}, ${key.rated_on}) vs engine ${ENGINE_VERSION} on ${GRAPH}:`,
      `  pair        expected  biology  tier         clinical  looks`,
      ...[...rows]
        .sort((x, y) => RANK[y.entry.expected] - RANK[x.entry.expected] || y.grade.biology - x.grade.biology || (x.label < y.label ? -1 : 1))
        .map(
          ({ entry, grade, label }) =>
            `  ${label.padEnd(10)}  ${entry.expected.padEnd(8)}  ${grade.biology.toFixed(4)}   ${grade.tier.padEnd(11)}  ${grade.clinical.toFixed(4)}    ${CLINICAL_TIER_WORD[grade.clinical_tier].toLowerCase()}`,
        ),
      `  Kendall's tau-b (rating vs biology): ${tau.toFixed(4)} over ${rows.length} pairs`,
    ];
    console.log(lines.join("\n"));

    const biologyOf = (rating: Rating) => rows.filter((row) => row.entry.expected === rating);
    for (let i = 0; i < RATINGS.length; i++) {
      for (let j = i + 1; j < RATINGS.length; j++) {
        const upper = biologyOf(RATINGS[i]);
        const lower = biologyOf(RATINGS[j]);
        if (!upper.length || !lower.length) continue;
        const weakest = upper.reduce((m, row) => (row.grade.biology < m.grade.biology ? row : m));
        const strongest = lower.reduce((m, row) => (row.grade.biology > m.grade.biology ? row : m));
        assert.ok(
          weakest.grade.biology > strongest.grade.biology,
          `every ${RATINGS[i]} pair must score above every ${RATINGS[j]} pair: ${weakest.label} (${RATINGS[i]}) ${weakest.grade.biology} <= ${strongest.label} (${RATINGS[j]}) ${strongest.grade.biology}`,
        );
      }
    }
    for (const { entry, grade, label } of rows) {
      assert.ok(
        ALLOWED[entry.expected].includes(grade.tier),
        `${label}: rated ${entry.expected} (${entry.why}), graded ${grade.tier} (${grade.tier_reason})`,
      );
    }
  },
);
