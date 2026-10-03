import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyVariant, countEffects } from "./variants.ts";

test("the 15 seed variant names classify as expected", () => {
  const expected: [string, string][] = [
    ["NM_000310.4(PPT1):c.1A>T (p.Met1Leu)", "lof"], // start codon lost
    ["NM_000310.4(PPT1):c.138C>A (p.Cys46Ter)", "lof"], // nonsense
    ["NM_000310.4(PPT1):c.224C>A (p.Thr75Asn)", "missense"],
    ["GRCh38/hg38 11p15.4(chr11:4793595-7562692)x1", "lof"], // one copy lost
    ["NM_000391.4(TPP1):c.141_144del (p.Leu49fs)", "lof"],
    ["NM_000391.4(TPP1):c.1053dup (p.Leu352fs)", "lof"],
    ["NM_001042432.2(CLN3):c.70_73del (p.Arg24fs)", "lof"],
    ["NM_001042432.2(CLN3):c.461-2A>C", "lof"], // canonical splice acceptor
    ["NM_001042432.2(CLN3):c.887A>G (p.Tyr296Cys)", "missense"],
    ["Single allele", "unknown"],
    ["NM_017882.3(CLN6):c.761del (p.Phe254fs)", "lof"],
    ["NM_017882.3(CLN6):c.516T>G (p.Tyr172Ter)", "lof"],
    ["NM_001371596.2(MFSD8):c.54_62+11del", "lof"], // deletion runs across the +1/+2 donor site
    ["NM_001371596.2(MFSD8):c.496del (p.Thr166fs)", "lof"],
    ["NM_001371596.2(MFSD8):c.624C>A (p.Asn208Lys)", "missense"],
  ];
  for (const [label, effect] of expected) assert.equal(classifyVariant(label), effect, label);
});

test("protein notation: nonsense, frameshift, start loss, stop loss, synonymous, in-frame", () => {
  assert.equal(classifyVariant("NM_1(G):c.10C>T (p.Arg4*)"), "lof");
  assert.equal(classifyVariant("NM_1(G):c.10C>T (p.R4X)"), "lof");
  assert.equal(classifyVariant("NM_1(G):c.10del (p.Leu4ProfsTer12)"), "lof");
  assert.equal(classifyVariant("NM_1(G):c.2T>C (p.M1?)"), "lof");
  assert.equal(classifyVariant("NM_1(G):c.1180T>C (p.Ter394GlnextTer?)"), "other");
  assert.equal(classifyVariant("NM_1(G):c.123C>T (p.Leu41=)"), "other");
  assert.equal(classifyVariant("NM_1(G):c.1521_1523del (p.Phe508del)"), "other");
  assert.equal(classifyVariant("NM_1(G):c.20C>T (p.(Thr7Ile))"), "missense");
  assert.equal(classifyVariant("NM_1(G):c.20C>T (p.T7I)"), "missense");
  assert.equal(classifyVariant("NM_1(G):c.10_11delinsTA (p.Cys4Ter)"), "lof");
});

test("cDNA notation when no protein change is given", () => {
  assert.equal(classifyVariant("NM_1(G):c.123+1G>A"), "lof"); // donor +1
  assert.equal(classifyVariant("NM_1(G):c.124-1G>A"), "lof"); // acceptor -1
  assert.equal(classifyVariant("NM_1(G):c.123+5G>A"), "unknown"); // deeper intronic: not readable
  assert.equal(classifyVariant("NM_1(G):c.100-10_101del"), "lof"); // runs across -2/-1
  assert.equal(classifyVariant("NM_1(G):c.99+5_100-5del"), "unknown"); // inside one intron
  assert.equal(classifyVariant("NM_1(G):c.123_124del"), "lof"); // 2 bases: frameshift
  assert.equal(classifyVariant("NM_1(G):c.123_125del"), "other"); // 3 bases: in frame
  assert.equal(classifyVariant("NM_1(G):c.123_124insAT"), "lof");
  assert.equal(classifyVariant("NM_1(G):c.123_124insATG"), "other");
  assert.equal(classifyVariant("NM_1(G):c.123_125delinsAT"), "lof");
  assert.equal(classifyVariant("NM_1(G):c.2T>G"), "lof"); // inside the start codon
  assert.equal(classifyVariant("NM_1(G):c.224C>A"), "unknown"); // exonic change, consequence not stated
  assert.equal(classifyVariant("NM_1(G):c.-45G>A"), "unknown"); // 5' UTR
  assert.equal(classifyVariant("NM_1(G):c.(?_-1)_(124+1_125-1)del"), "lof"); // whole-exon deletion
});

test("copy number: losses are loss of function, gains are not", () => {
  assert.equal(classifyVariant("GRCh38/hg38 1p34.2(chr1:40000-50000)x0"), "lof");
  assert.equal(classifyVariant("GRCh38/hg38 1p34.2(chr1:40000-50000)x3"), "other");
});

test("unreadable names are unknown, never guessed", () => {
  for (const label of ["", "Single allele", "Haplotype", "PPT1 deficiency", "NM_1(G):c.[123A>G;456C>T]"]) {
    assert.equal(classifyVariant(label), "unknown", label);
  }
});

test("countEffects tallies the seed CLN3 variants", () => {
  assert.deepEqual(
    countEffects([
      "NM_001042432.2(CLN3):c.70_73del (p.Arg24fs)",
      "NM_001042432.2(CLN3):c.461-2A>C",
      "NM_001042432.2(CLN3):c.887A>G (p.Tyr296Cys)",
      "Single allele",
    ]),
    { lof: 2, missense: 1, other: 0, unknown: 1 },
  );
});
