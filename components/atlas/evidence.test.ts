import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AtlasGraph, GraphEdge } from "../../lib/graph/types.ts";
import { evidenceBadge, evidenceBadgeOf, plainEvidence } from "./evidence.ts";

const PUBMED =
  "PubMed search hit: one of the first 3 results for the gene symbol and the disease name (pipeline/build_graph.py), not a curated link.";
const NIH =
  "NIH RePORTER search hit: one of the first 3 projects whose title or terms match the gene symbol and the disease name (pipeline/build_graph.py), not a curated link.";
const orphanet = (words: string) =>
  `Orphanet patient-organisation directory result for this disease, kept by pipeline/build_graph.py because the group's name contains ${words} from the disease name; a name match, not a curated link.`;

const edge = (source: string, kind: GraphEdge["kind"], evidence?: string) => ({ source, kind, evidence });

test("search hits and name matches read as plain sentences, without file paths", () => {
  assert.equal(plainEvidence({ evidence: PUBMED }), "Found by a PubMed search for the gene and disease names (top 3 results). Not reviewed by a curator.");
  assert.equal(plainEvidence({ evidence: NIH }), "Found by an NIH RePORTER search for the gene and disease names (top 3 projects). Not reviewed by a curator.");
  assert.equal(
    plainEvidence({ evidence: orphanet('"Krabbe"') }),
    "Listed in Orphanet's patient-group directory; matched because its name contains “Krabbe”. Not confirmed by the group.",
  );
  assert.equal(
    plainEvidence({ evidence: orphanet('"dermal" and "dysplasia"') }),
    "Listed in Orphanet's patient-group directory; matched because its name contains “dermal” and “dysplasia”. Not confirmed by the group.",
  );
});

test("the dataset-wide symptom note is left out; other sentences stay, minus any path", () => {
  assert.equal(plainEvidence({ evidence: "Shared inside an existing Monarch cluster. Not a shared mechanism." }), null);
  assert.equal(plainEvidence({ evidence: "Reactome lists SOX2 in TCF dependent signaling in response to WNT." }), "Reactome lists SOX2 in TCF dependent signaling in response to WNT.");
  assert.equal(plainEvidence({ evidence: "A directory result, kept by pipeline/build_graph.py because it matched." }), "A directory result because it matched.");
  assert.equal(plainEvidence({ evidence: "Counted per gene (first 3 records, pipeline/build_graph.py), not per disease." }), "Counted per gene (first 3 records), not per disease.");
  assert.equal(plainEvidence({ evidence: "Read from the release (data/reference/pathways.json)." }), "Read from the release.");
  assert.equal(plainEvidence({}), null);
});

test("every evidence string in the graph reads without developer leftovers", () => {
  const graph: AtlasGraph = JSON.parse(readFileSync(new URL("../../public/graph.json", import.meta.url), "utf8"));
  for (const e of graph.edges) {
    const text = plainEvidence(e);
    if (text) assert.doesNotMatch(text, /pipeline\/|\.py\b|\.ts\b|kept by/, e.id);
    assert.doesNotMatch(evidenceBadge(e).label, /pipeline|\.py/, e.id);
  }
});

test("one badge per link: stated by its source, how it was inferred, or disputed", () => {
  assert.deepEqual(evidenceBadge(edge("Monarch", "observed")), { label: "Stated by Monarch", style: "stated" });
  assert.deepEqual(evidenceBadge(edge("PubMed", "inferred", PUBMED)), { label: "Search match · not reviewed", style: "inferred" });
  assert.deepEqual(evidenceBadge(edge("NIH RePORTER", "inferred", NIH)), { label: "Search match · not reviewed", style: "inferred" });
  assert.deepEqual(evidenceBadge(edge("Orphanet", "inferred", orphanet('"Krabbe"'))), { label: "Name match · not confirmed", style: "inferred" });
  assert.deepEqual(evidenceBadge(edge("A model", "inferred")), { label: "Inferred", style: "inferred" });
  assert.deepEqual(evidenceBadge(edge("ClinVar", "contradicted")), { label: "Disputed", style: "disputed" });
});

test("a claim on several links is stated only when every link is, and never more than its grade", () => {
  const monarch = edge("Monarch", "observed");
  const reactome = edge("Reactome", "observed");
  const pubmed = edge("PubMed", "inferred", PUBMED);
  assert.equal(evidenceBadgeOf([monarch, reactome, monarch])?.label, "Stated by Monarch and Reactome");
  assert.equal(evidenceBadgeOf([pubmed, pubmed])?.label, "Search match · not reviewed");
  assert.equal(evidenceBadgeOf([pubmed, edge("Orphanet", "inferred", orphanet('"Krabbe"'))])?.label, "Inferred");
  assert.equal(evidenceBadgeOf([monarch, pubmed])?.label, "Partly inferred");
  assert.equal(evidenceBadgeOf([monarch, reactome], "inferred")?.label, "Inferred", "a grade read from variant names is inferred though ClinVar states each variant");
  assert.equal(evidenceBadgeOf([], "inferred")?.label, "Inferred");
  assert.equal(evidenceBadgeOf([monarch, edge("ClinVar", "contradicted")])?.style, "disputed");
  assert.equal(evidenceBadgeOf([]), null);
  const many = ["A", "B", "C", "D"].map((s) => edge(s, "observed"));
  assert.equal(evidenceBadgeOf(many)?.label, "Stated by 4 sources");
});
