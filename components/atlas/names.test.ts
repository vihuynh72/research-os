import test from "node:test";
import assert from "node:assert/strict";
import { displayName, distinctNames, fitName, wrapName } from "./names.ts";

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
