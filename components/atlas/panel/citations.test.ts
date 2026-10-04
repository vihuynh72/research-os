import test from "node:test";
import assert from "node:assert/strict";
import { citationRegistry, type CitationInput } from "./citations.ts";

const rec = (source: string, url: string, claim: string): CitationInput => ({ source, url, claim, badge: { label: `Stated by ${source}`, style: "stated" }, date: "2026-10-03" });

test("records are numbered in order of first use", () => {
  const reg = citationRegistry();
  assert.deepEqual(reg.cite([rec("Monarch", "https://m/1", "HEXA gene causes Tay-Sachs disease.")]), [1]);
  assert.deepEqual(reg.cite([rec("Reactome", "https://r/1", "HEXA gene is in pathway X."), rec("Monarch", "https://m/2", "HEXB gene causes Sandhoff disease.")]), [2, 3]);
  assert.deepEqual(
    reg.records().map((r) => [r.n, r.source]),
    [
      [1, "Monarch"],
      [2, "Reactome"],
      [3, "Monarch"],
    ],
  );
});

test("one entry per source, url and claim; a repeat keeps its number", () => {
  const reg = citationRegistry();
  const a = rec("Monarch", "https://m/1", "HEXA gene causes Tay-Sachs disease.");
  reg.cite([a]);
  reg.cite([rec("PubMed", "https://p/1", "A paper is about Tay-Sachs disease.")]);
  assert.deepEqual(reg.cite([{ ...a }, a]), [1], "the same record twice is cited once");
  // The same page backing a different claim is a different entry.
  assert.deepEqual(reg.cite([rec("Monarch", "https://m/1", "Tay-Sachs disease has symptom Seizure.")]), [3]);
  assert.equal(reg.records().length, 3);
});

test("a claim's numbers come out ascending, whatever order they were cited in", () => {
  const reg = citationRegistry();
  reg.cite([rec("A", "u1", "one."), rec("B", "u2", "two.")]);
  assert.deepEqual(reg.cite([rec("B", "u2", "two."), rec("A", "u1", "one.")]), [1, 2]);
});

test("numbering is stable: the same citations in the same order give the same numbers", () => {
  const run = () => {
    const reg = citationRegistry();
    return [reg.cite([rec("X", "u", "c."), rec("Y", "v", "d.")]), reg.cite([rec("Y", "v", "d."), rec("Z", "w", "e.")]), reg.records().map((r) => r.claim)];
  };
  assert.deepEqual(run(), run());
});

test("records() is a copy: callers cannot renumber the registry", () => {
  const reg = citationRegistry();
  reg.cite([rec("X", "u", "c.")]);
  reg.records()[0].n = 99;
  assert.equal(reg.records()[0].n, 1);
});
