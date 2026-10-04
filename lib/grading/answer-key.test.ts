// Holds the engine to data/curated/answer_key.json. For each rated pair of the atlas, the literature
// (or a mentor who re-rates it) says whether the two diseases share the same molecular machinery
// (high), related but different biology (medium), or nothing beyond broad processes (low). The
// biology score must rank every high pair above every medium pair above every low pair, and each
// pair's tier must fit its rating.
//
// Where the engine disagrees with the key for a reason that has been traced to the engine or the data,
// the pair is listed in KNOWN_DISAGREEMENTS with that reason (docs/grading.md, section 10) and held
// out of the ranking. The test fails when a new disagreement appears (fix the engine, the data or the
// key, and say which) and when a listed one no longer holds (take it off the list). When a mentor
// changes a rating, change the key, not this test.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { shortLabel } from "../graph/labels.ts";
import type { AtlasGraph } from "../graph/types.ts";
import { buildContext, diseaseName, scoreDimensions } from "./dimensions.ts";
import { gradeGraph } from "./grade.ts";
import { synthesizePair } from "./synthesize.ts";
import { CLINICAL_TIER_WORD, ENGINE_VERSION, pairKey, type HpoReference, type PairGrade, type Tier } from "./types.ts";

const GRAPH = "public/graph.json";
const REFERENCE = "data/reference/hpo-reference.json";
const KEY = "data/curated/answer_key.json";

type Rating = "high" | "medium" | "low";

interface AnswerKey {
  version: number;
  rated_by: string;
  rated_on: string;
  sources: Record<string, string>;
  biology: { a: string; b: string; names?: string; expected: Rating; why: string; source: string; more_sources?: string[] }[];
}

const RATINGS: readonly Rating[] = ["high", "medium", "low"];
const RANK: Record<Rating, number> = { high: 3, medium: 2, low: 1 };
const ALLOWED: Record<Rating, readonly Tier[]> = {
  high: ["strong", "moderate"],
  medium: ["moderate"],
  low: ["exploratory", "none"],
};

// Rated pairs the engine cannot place as the literature does, with the cause. Keys are pairKey(a, b).
const KNOWN_DISAGREEMENTS: Record<string, string> = {
  // Variants are recorded per gene, not per disease, so every allelic pair rests on the gene line
  // alone (0.70): the engine cannot tell one protein broken the same way from one broken differently,
  // and one shared gene outweighs a specific pathway shared by two genes.
  [pairKey("MONDO:0007077", "MONDO:0015014")]: "data: allelic pairs score the gene line alone (0.70), whatever the mechanism",
  [pairKey("MONDO:0007057", "MONDO:0012439")]: "data: allelic pairs score the gene line alone (0.70), whatever the mechanism",
  // Reactome 97 lists MLPH in one lowest-level pathway, the MITF-M targets of pigmentation (reached by
  // 8 diseases here), not in a melanosome transport pathway with MYO5A.
  [pairKey("MONDO:0008962", "MONDO:0012220")]: "data: Reactome has no transport pathway with both MYO5A and MLPH",
  // A pathway lists its enzymes and its substrates alike. CS/DS degradation (7 of the 81 diseases with
  // a mechanism) holds HEXB, the enzyme, and decorin, a substrate proteoglycan; the three ClinVar
  // records of each gene also read as loss-of-function, which lifts the pair from 0.37 to 0.53.
  // Tay-Sachs disease and the same dystrophy stay exploratory (0.448) only because HEXA's records read
  // as mixed.
  [pairKey("MONDO:0010006", "MONDO:0012401")]: "data: Reactome lists the decorin substrate beside the HEXB enzyme in CS/DS degradation",
  // A pathway lists a regulator and its targets alike. The 12-protein pathway of MITF-M targets in
  // extracellular matrix and EMT (3 diseases here) holds MITF and SOX2 because MITF-M binds SOX2 in
  // melanoma cells, so the pair scores 0.53 on it.
  [pairKey("MONDO:0007077", "MONDO:0008799")]: "data: Reactome lists SOX2 as an MITF-M target gene, which reads as a shared pathway",
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

interface Row {
  key: string;
  label: string;
  expected: Rating;
  why: string;
  grade: PairGrade;
}

// What is wrong with one row against the others: a tier outside its rating, or a pair of another
// rating that the biology score puts on the wrong side of it (ties count as wrong).
function problemsOf(row: Row, others: Row[]): string[] {
  const problems: string[] = [];
  if (!ALLOWED[row.expected].includes(row.grade.tier)) {
    problems.push(`rated ${row.expected} (${row.why}), graded ${row.grade.tier} (${row.grade.tier_reason})`);
  }
  for (const other of others) {
    if (other.key === row.key || other.expected === row.expected) continue;
    const above = RANK[row.expected] > RANK[other.expected];
    if (above ? row.grade.biology <= other.grade.biology : row.grade.biology >= other.grade.biology) {
      problems.push(
        `rated ${row.expected}, so it must score ${above ? "above" : "below"} ${other.label} (${other.expected}), but ${row.grade.biology} vs ${other.grade.biology}`,
      );
    }
  }
  return problems;
}

const missing = [GRAPH, REFERENCE, KEY].filter((path) => !existsSync(path));

test(
  "biology grades follow the answer key",
  { skip: missing.length ? `${missing.join(" and ")} missing: run npm run data:hpo && npm run data:graph` : false },
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
    const rows: Row[] = key.biology.map((entry) => {
      const name = entry.names ?? `${entry.a} ${entry.b}`;
      for (const id of [entry.a, entry.b]) assert.equal(nodes.get(id)?.type, "Disease", `${KEY}: ${id} is not a disease in ${GRAPH}`);
      // Every rating says why and cites where that comes from.
      assert.ok(typeof entry.why === "string" && entry.why.trim(), `${KEY}: ${name} has no "why"`);
      assert.ok(typeof entry.source === "string" && entry.source, `${KEY}: ${name} has no "source"`);
      for (const source of [entry.source, ...(entry.more_sources ?? [])]) {
        assert.match(key.sources[source] ?? "", /^https:\/\/\S+$/, `${KEY}: ${name} cites "${source}", which is not a URL in sources`);
      }
      const [a, b] = entry.a < entry.b ? [entry.a, entry.b] : [entry.b, entry.a];
      const names = { a: diseaseName(ctx, a), b: diseaseName(ctx, b) };
      const grade = listed.get(pairKey(a, b)) ?? synthesizePair(a, b, scoreDimensions(ctx, a, b), [], names);
      const label = entry.names ?? `${shortLabel(nodes.get(entry.a) ?? { label: entry.a })}-${shortLabel(nodes.get(entry.b) ?? { label: entry.b })}`;
      return { key: pairKey(a, b), label, expected: entry.expected, why: entry.why, grade };
    });
    assert.ok(rows.length > 0, `${KEY} rates no pairs`);
    assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, `${KEY} rates a pair twice`);

    const held = rows.filter((row) => !KNOWN_DISAGREEMENTS[row.key]);
    const tau = kendallTauB(
      rows.map((row) => RANK[row.expected]),
      rows.map((row) => row.grade.biology),
    );
    const heldTau = kendallTauB(
      held.map((row) => RANK[row.expected]),
      held.map((row) => row.grade.biology),
    );
    const width = Math.max(...rows.map((row) => row.label.length));
    const lines = [
      `Answer key (${key.rated_by}, ${key.rated_on}) vs engine ${ENGINE_VERSION} on ${GRAPH}:`,
      `  ${"pair".padEnd(width)}  expected  biology  tier         clinical  looks                   verdict`,
      ...[...rows]
        .sort((x, y) => RANK[y.expected] - RANK[x.expected] || y.grade.biology - x.grade.biology || (x.label < y.label ? -1 : 1))
        .map(
          ({ key: id, label, expected, grade }) =>
            `  ${label.padEnd(width)}  ${expected.padEnd(8)}  ${grade.biology.toFixed(4)}   ${grade.tier.padEnd(11)}  ${grade.clinical.toFixed(4)}    ${CLINICAL_TIER_WORD[grade.clinical_tier].toLowerCase().padEnd(22)}  ${KNOWN_DISAGREEMENTS[id] ? `known disagreement (${KNOWN_DISAGREEMENTS[id]})` : "ok"}`,
        ),
      `  Kendall's tau-b (rating vs biology): ${tau.toFixed(4)} over all ${rows.length} pairs, ${heldTau.toFixed(4)} over the ${held.length} held to the key`,
    ];
    console.log(lines.join("\n"));

    // Every pair held to the key: its tier fits its rating, and the score orders it among the others.
    const problems = held.flatMap((row) => problemsOf(row, held).map((problem) => `${row.label}: ${problem}`));
    assert.deepEqual(problems, [], `the engine disagrees with ${KEY}:\n  ${problems.join("\n  ")}`);
    for (const rating of RATINGS) assert.ok(held.some((row) => row.expected === rating), `no ${rating} pair is held to the key`);

    // Every known disagreement still holds; one that no longer does should come off the list.
    for (const [id, reason] of Object.entries(KNOWN_DISAGREEMENTS)) {
      const row = rows.find((r) => r.key === id);
      assert.ok(row, `KNOWN_DISAGREEMENTS lists ${id}, which ${KEY} does not rate`);
      assert.ok(
        problemsOf(row, held).length > 0,
        `${row.label} now agrees with the key (${reason} no longer applies): remove it from KNOWN_DISAGREEMENTS and docs/grading.md`,
      );
    }
  },
);
