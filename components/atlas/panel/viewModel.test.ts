import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph } from "../../../lib/graph/types.ts";
import type { RelevanceDoc } from "../../../lib/grading/types.ts";
import { buildNeighborhood } from "../../../lib/graph/neighborhood.ts";
import { buildModel, nodeOf, pairOf } from "../format.ts";
import { cleanGraph } from "../names.ts";
import { PATHWAY_NOTE, SAME_GENE_CAVEAT } from "../explain.ts";
import { buildDiseaseDoc, buildEdgeDoc, buildNodeDoc, buildPairDoc, pathwayDataCount, type Claim, type SectionVM } from "./viewModel.ts";

const graph: AtlasGraph = cleanGraph(JSON.parse(readFileSync(new URL("../../../public/graph.json", import.meta.url), "utf8")));
const relevance: RelevanceDoc = JSON.parse(readFileSync(new URL("../../../public/relevance.json", import.meta.url), "utf8"));
const model = buildModel(graph, relevance);

const TAY_SACHS = "MONDO:0010100";
const SANDHOFF = "MONDO:0010006";
const GAUCHER_1 = "MONDO:0009265";
const GAUCHER_2 = "MONDO:0009266";
const ACHONDRO = "MONDO:0008702";
const PERTHES = "MONDO:0007885";
const CTX = "MONDO:0008948";
const GBA1 = "HGNC:4177";
const HEXA = "HGNC:4878";

// Every factual sentence of a document, with where it sits.
function claimsOf(doc: { sections: SectionVM[]; steps: { text: string; cites: number[]; because: string; becauseCites: number[] }[] }, extra: Claim[] = []): { where: string; claim: Claim }[] {
  const out = extra.map((claim) => ({ where: "header", claim }));
  for (const s of doc.sections) {
    for (const b of s.blocks) {
      if (b.kind === "claims" || b.kind === "bullets") for (const c of b.kind === "claims" ? b.claims : b.items) out.push({ where: s.id, claim: c });
      if (b.kind === "rows") {
        for (const r of b.rows) if (r.reason) out.push({ where: `${s.id}/${r.id}`, claim: r.reason });
        if (b.empty && !b.rows.length) out.push({ where: `${s.id}/empty`, claim: b.empty });
      }
      if (b.kind === "items") {
        // A list whose items all rest on the same records cites them once, at its heading.
        for (const i of b.items) out.push({ where: `${s.id}/${i.id}`, claim: { text: i.label, cites: i.cites.length ? i.cites : (b.cites ?? []) } });
        if (b.empty && !b.items.length) out.push({ where: `${s.id}/empty`, claim: b.empty });
      }
    }
  }
  for (const s of doc.steps) out.push({ where: "next step", claim: { text: s.text, cites: s.cites } }, { where: "next step/because", claim: { text: s.because, cites: s.becauseCites } });
  return out;
}

// Sources lists only what the panel shows: every record is cited by a sentence on screen, so no
// "searched, nothing found" entry can sit beside a list that has items.
function assertNoStrayRecords(doc: Parameters<typeof claimsOf>[0] & { sources: { n: number; claim: string }[] }, extra: Claim[] = [], label = "") {
  const shown = new Set(claimsOf(doc, extra).flatMap(({ claim }) => claim.cites));
  for (const s of doc.sources) assert.ok(shown.has(s.n), `${label} [${s.n}] is cited by nothing on screen: ${s.claim}`);
}

function assertCited(doc: Parameters<typeof claimsOf>[0] & { sources: { n: number; url: string; claim: string }[] }, extra: Claim[] = []) {
  const claims = claimsOf(doc, extra);
  assert.ok(claims.length > 0);
  for (const { where, claim } of claims) {
    assert.ok(claim.cites.length > 0, `uncited claim in ${where}: ${claim.text}`);
    for (const n of claim.cites) assert.ok(n >= 1 && n <= doc.sources.length, `${where} cites [${n}] of ${doc.sources.length}`);
  }
  assert.deepEqual(
    doc.sources.map((s) => s.n),
    doc.sources.map((_, i) => i + 1),
    "sources are numbered 1..N",
  );
  for (const s of doc.sources) {
    assert.match(s.url, /^https:\/\//, s.claim);
    assert.doesNotMatch(`${s.claim} ${s.url}`, /pipeline\/|\.py\b|\be-(causes|has_phenotype|in_pathway|about|variant_of|works_on|funds)-/, s.claim);
  }
}

// Caregiver text never says "mechanism" for a pathway; the only uses say a pathway is not one.
function assertNoMechanism(texts: string[]) {
  const allowed = [PATHWAY_NOTE, "is not sharing a mechanism"];
  for (const t of texts) {
    let rest = t;
    for (const a of allowed) rest = rest.split(a).join("");
    assert.doesNotMatch(rest, /mechanism/i, t);
  }
}

function textsOf(doc: { sections: SectionVM[] }): string[] {
  return doc.sections.flatMap((s) => [
    s.title,
    s.hint ?? "",
    ...s.blocks.flatMap((b) =>
      b.kind === "note" ? [b.text] : b.kind === "claims" ? b.claims.map((c) => c.text) : b.kind === "bullets" ? b.items.map((c) => c.text) : b.kind === "rows" ? b.rows.map((r) => r.reason?.text ?? "") : b.items.map((i) => i.note ?? ""),
    ),
  ]);
}

test("81 of the 93 diseases have pathway data, as the grades say", () => {
  assert.equal(pathwayDataCount(model), 81);
});

test("Tay-Sachs: every claim is cited, sources resolve, the first two sections with content are open", () => {
  const doc = buildDiseaseDoc(model, TAY_SACHS, "parent")!;
  assertCited(doc);
  assertNoMechanism(textsOf(doc));
  assert.equal(doc.group?.label, "Shares the CS/DS degradation pathway");
  assert.deepEqual(
    doc.sections.filter((s) => s.open).map((s) => s.id),
    ["related", "biology"],
    "Looks similar is empty for Tay-Sachs (no symptoms on record), so Biology opens instead",
  );
  const related = doc.sections[0].blocks[0];
  assert.equal(related.kind, "rows");
  if (related.kind === "rows") {
    assert.equal(related.rows[0].id, SANDHOFF);
    assert.match(related.rows[0].reason!.text, /Hyaluronan degradation/);
  }
  assert.match(doc.summary.text, /^Based on \d+ sources: \d+ stated by curated databases/);
  assert.ok(doc.steps.length > 0);
});

test("the disease document is the same on every build (stable numbering)", () => {
  assert.deepEqual(buildDiseaseDoc(model, TAY_SACHS, "parent"), buildDiseaseDoc(model, TAY_SACHS, "parent"));
});

test("Gaucher I and II: the same-gene caveat, the shared/differs/review sections, all cited", () => {
  const pair = pairOf(model, GAUCHER_1, GAUCHER_2)!;
  const doc = buildPairDoc(model, GAUCHER_1, GAUCHER_1, nodeOf(model, GAUCHER_2)!, pair, "parent")!;
  assertCited(doc, [doc.biology.why, ...(doc.clinical ? [doc.clinical.why] : [])]);
  assertNoMechanism([...textsOf(doc), doc.biology.why.text, doc.clinical?.why.text ?? ""]);
  assert.deepEqual(
    doc.sections.map((s) => s.id),
    ["shared", "differs", "review", "together"],
  );
  const notes = doc.sections[0].blocks.flatMap((b) => (b.kind === "note" ? [b.text] : []));
  assert.ok(notes.includes(SAME_GENE_CAVEAT));
  assert.equal(doc.biology.why.text, "Both are linked to changes in the same gene, GBA1.");
  assert.ok(!textsOf(doc).includes(doc.biology.why.text), "the verdict's sentence is not repeated below it");
  assert.doesNotMatch(doc.clinical!.why.text, /more overlap than unrelated diseases have/);
  assert.equal(doc.biology.why.cites[0], 1, "the verdict cites first");
});

test("achondrogenesis and Perthes carry the same-gene caveat", () => {
  const pair = pairOf(model, ACHONDRO, PERTHES)!;
  const doc = buildPairDoc(model, ACHONDRO, ACHONDRO, nodeOf(model, PERTHES)!, pair, "parent")!;
  assertCited(doc, [doc.biology.why]);
  assert.ok(doc.sections[0].blocks.some((b) => b.kind === "note" && b.text === SAME_GENE_CAVEAT));
  assert.ok(textsOf(doc).some((t) => /Few symptoms are on record for Legg-Calve-Perthes disease \(2\)/.test(t)));
});

test("Tay-Sachs and Sandhoff: the shared pathway names both genes and keeps pathway apart from mechanism", () => {
  const pair = pairOf(model, TAY_SACHS, SANDHOFF)!;
  const doc = buildPairDoc(model, TAY_SACHS, TAY_SACHS, nodeOf(model, SANDHOFF)!, pair, "parent")!;
  assertCited(doc, [doc.biology.why]);
  assert.match(doc.biology.why.text, /^Their genes, HEXA and HEXB, are both listed in the Reactome pathway “Hyaluronan degradation”, which only 2 of the 81 diseases/);
  assert.ok(textsOf({ sections: [doc.sections[0]] }).includes(PATHWAY_NOTE));
  assert.match(textsOf({ sections: [doc.sections[1]] }).join(" "), /Different genes: HEXA for Tay-Sachs disease, HEXB for Sandhoff disease/);
});

test("a gene and a symptom in the center: every claim cited, rarity in words", () => {
  for (const id of ["HGNC:4177", "HP:0001250"]) {
    const hood = buildNeighborhood(graph, relevance, id, {});
    const doc = buildNodeDoc(model, hood, id, nodeOf(model, id)!, undefined, 0.2, "parent");
    assertCited(doc, doc.intro);
    assertNoMechanism([...textsOf(doc), ...doc.intro.map((c) => c.text)]);
  }
  const hood = buildNeighborhood(graph, relevance, "HP:0001250", {});
  const seizure = buildNodeDoc(model, hood, "HP:0001250", nodeOf(model, "HP:0001250")!, undefined, 0.2, "parent");
  assert.ok(seizure.intro.some((c) => /is a (rare|an uncommon|common) symptom|is an uncommon symptom|is a common symptom/.test(c.text)));
});

test("a folded line is titled by its group and lists every member", () => {
  const hood = buildNeighborhood(graph, relevance, GAUCHER_1, {});
  const folded = hood.nodes.find((n) => n.role === "bubble" && n.bubbleType === "Phenotype");
  const line = hood.edges.find((e) => e.role === "bubble" && (e.a === folded?.id || e.b === folded?.id));
  assert.ok(line, "Gaucher disease type I has a folded group of symptoms on its map");
  const doc = buildEdgeDoc(model, hood, GAUCHER_1, line!, 0.2, "parent");
  assert.match(doc.title, /^\S.* has \d+ more symptoms on record$/);
  // The line carries only the members its records touch, and the title counts exactly those.
  const members = doc.sections[0].blocks[0];
  const n = members.kind === "items" ? members.items.length : -1;
  assert.ok(n > 0);
  assert.equal(doc.title.match(/has (\d+) more/)?.[1], String(n));
  const owner = line!.a.startsWith("bubble:") ? line!.b : line!.a;
  const onRecord = graph.edges.filter((e) => e.type === "has_phenotype" && e.subject === owner).length;
  assert.ok(n <= onRecord, `${n} members, ${onRecord} symptoms on record for ${owner}`);
  assertCited(doc);
});

test("Sources never lists a record nothing on screen cites: every disease, its related pairs, every gene", () => {
  for (const d of model.index.diseases) {
    const doc = buildDiseaseDoc(model, d.id, "researcher")!;
    assertNoStrayRecords(doc, doc.facts, d.label);
    for (const nb of model.relevance.diseases[d.id]?.neighbors ?? []) {
      const pair = pairOf(model, d.id, nb.id)!;
      const pd = buildPairDoc(model, d.id, d.id, nodeOf(model, nb.id)!, pair, "researcher")!;
      assertNoStrayRecords(pd, [pd.biology.why, ...(pd.clinical ? [pd.clinical.why] : [])], `${d.label} / ${nb.id}`);
    }
  }
  for (const g of graph.nodes.filter((n) => n.type === "Gene")) {
    const hood = buildNeighborhood(graph, relevance, g.id, {});
    const doc = buildNodeDoc(model, hood, g.id, g, undefined, 0.2, "researcher");
    assertNoStrayRecords(doc, doc.intro, g.label);
  }
});

test("no false absence: Tay-Sachs, GBA1, HEXA and CTX list no 'no gene' or 'no pathway' record beside a list that has one", () => {
  const ts = buildDiseaseDoc(model, TAY_SACHS, "parent")!;
  assert.ok(!ts.sources.some((s) => /lists no gene|no specific pathway kept/.test(s.claim)), ts.sources.map((s) => s.claim).join("\n"));
  assert.match(ts.summary.text, /^Based on \d+ sources: \d+ stated by curated databases, \d+ inferred(, 1 search with no result)?$/);
  for (const id of [GBA1, HEXA]) {
    const hood = buildNeighborhood(graph, relevance, id, {});
    const doc = buildNodeDoc(model, hood, id, nodeOf(model, id)!, undefined, 0.2, "parent");
    assert.ok(!doc.sources.some((s) => /no specific pathway kept/.test(s.claim)), id);
  }
  // HEXA selected around Tay-Sachs: the header line cites the link, and its sentence is not repeated.
  const hood = buildNeighborhood(graph, relevance, TAY_SACHS, {});
  const hexa = buildNodeDoc(model, hood, TAY_SACHS, nodeOf(model, HEXA)!, hood.nodes.find((n) => n.id === HEXA), 0.2, "parent");
  assert.equal(hexa.relevance?.text, "Directly linked to Tay-Sachs disease");
  assert.deepEqual(hexa.relevance?.cites, [1]);
  assert.deepEqual(hexa.intro.map((c) => c.text), ["HEXA is a gene. Monarch links changes in it to Tay-Sachs disease."]);
  const ctx = buildDiseaseDoc(model, CTX, "parent")!;
  assertCited(ctx, ctx.facts.filter((f) => f.cites.length));
  assertNoStrayRecords(ctx, ctx.facts);
});

test("the header cites the disease's own gene; related rows leave that record out", () => {
  const doc = buildDiseaseDoc(model, TAY_SACHS, "parent")!;
  assert.deepEqual(doc.facts[0], { text: "HEXA gene", cites: [1] });
  const related = doc.sections[0].blocks[0];
  assert.ok(related.kind === "rows" && related.rows.length > 1);
  if (related.kind === "rows") for (const r of related.rows) assert.ok(!r.reason!.cites.includes(1), `${r.name}: ${r.reason!.cites}`);
});

test("gene changes: one record wording and one badge in every view", () => {
  const ts = buildDiseaseDoc(model, TAY_SACHS, "researcher")!;
  const hood = buildNeighborhood(graph, relevance, HEXA, {});
  const hexa = buildNodeDoc(model, hood, HEXA, nodeOf(model, HEXA)!, undefined, 0.2, "researcher");
  const clinvar = (doc: { sources: { source: string; claim: string; badge: { label: string } }[] }) => doc.sources.filter((s) => s.source === "ClinVar").map((s) => `${s.claim} | ${s.badge.label}`).sort();
  assert.equal(clinvar(ts).length, 3);
  assert.deepEqual(clinvar(ts), clinvar(hexa));
  assert.ok(clinvar(ts).includes("ClinVar lists a gene change in HEXA (single allele); its type isn't clear from its name. | Type read from name"), clinvar(ts).join("\n"));
});

test("the pair's researcher totals show all three aggregate scores", () => {
  const pair = pairOf(model, GAUCHER_1, GAUCHER_2)!;
  const doc = buildPairDoc(model, GAUCHER_1, GAUCHER_1, nodeOf(model, GAUCHER_2)!, pair, "researcher")!;
  assert.deepEqual(doc.totals, [
    { label: "Biology (relevance)", value: "0.70" },
    { label: "Clinical", value: "0.04" },
    { label: "Working together", value: "0.37" },
  ]);
});

test("a line through shared research says how the items were found", () => {
  const hood = buildNeighborhood(graph, relevance, TAY_SACHS, {});
  const bridge = hood.edges.find((e) => e.role === "bridge" && edgesAre(e.edgeIds, "inferred"));
  if (!bridge) return; // nothing shared around Tay-Sachs on this data
  const doc = buildEdgeDoc(model, hood, TAY_SACHS, bridge, 0.2, "parent");
  assert.doesNotMatch(doc.title, /already work together/);
  assert.match(doc.title, /^(Shared research|Shared patient groups|A shared patient group|Shared research and patient groups) links? /);
  const claims = doc.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "claims" ? b.claims.map((c) => c.text) : [])));
  for (const c of claims) assert.match(c, /search links|matched to .* by name/, c);
  assertCited(doc);
  assertNoStrayRecords(doc);
});

function edgesAre(ids: string[], kind: string): boolean {
  return ids.length > 0 && ids.every((id) => model.edgeById.get(id)?.kind === kind);
}
