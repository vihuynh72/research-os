"""Turn the weighted seed into the graph and pair file the atlas page loads.

A pair percent is the SimGIC percentile, not a noisy-OR of caps.
Usage: python3 pipeline/export_atlas.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed" / "rare_graph.json"
GRAPH_OUT = ROOT / "public" / "graph.json"
RELEVANCE_OUT = ROOT / "public" / "relevance.json"
NODE_TYPE = {
    "disease": "Disease", "disease_group": "Disease", "gene": "Gene",
    "variant": "Variant", "phenotype": "Phenotype", "patient_group": "PatientOrg",
    "paper": "Paper", "project": "Grant",
}
SOURCE = {
    "MONDO": "Monarch", "HGNC": "HGNC", "CLINVAR": "ClinVar", "HP": "HPO",
    "PMID": "PubMed", "NIH": "NIH RePORTER", "ORPHA-ORG": "Orphanet",
}


def source_name(node_id: str) -> str:
    prefix = node_id.split(":", 1)[0]
    return SOURCE.get(prefix, prefix)


def tier_of(percent: float) -> str:
    if percent >= 0.99:
        return "strong"
    if percent >= 0.95:
        return "moderate"
    if percent >= 0.8:
        return "weak"
    return "none"


def build_graph(seed: dict, generated: str) -> dict:
    nodes = []
    for node in seed["nodes"]:
        node_type = NODE_TYPE.get(node["type"])
        if not node_type:
            continue
        row = {
            "id": node["id"], "type": node_type,
            "label": node.get("name") or node["id"],
            "source": source_name(node["id"]), "url": node.get("source_url") or "",
        }
        attributes = {}
        if node.get("orpha"):
            attributes["orphanet"] = node["orpha"]
        if node.get("gaps"):
            attributes["gaps"] = node["gaps"]
        if attributes:
            row["attributes"] = attributes
        nodes.append(row)
    edges, seen = [], {}
    for edge in seed["edges"]:
        relation = edge["relation"]
        key = (edge["source"], edge["target"], relation)
        seen[key] = seen.get(key, 0) + 1
        suffix = "" if seen[key] == 1 else f"-{seen[key]}"
        note = edge.get("note") or ""
        if edge.get("weight_method") == "hpo_ic":
            note = (note + " Weight is HPO information content, 0 to 1.").strip()
        elif edge.get("weight_method") == "gene_specificity":
            note = (note + " Weight is how specific this gene is in the atlas.").strip()
        row = {
            "id": f"e-{edge['source']}-{edge['target']}-{relation}{suffix}".replace(":", "_"),
            "type": relation, "subject": edge["source"], "object": edge["target"],
            "source": source_name(edge["source"]), "url": edge.get("evidence_url") or "",
            "date": "2026-10-03", "confidence": edge.get("weight", 1),
            "kind": "inferred" if relation == "same_gene" else "observed",
        }
        if note:
            row["evidence"] = note
        edges.append(row)
    return {
        "meta": {
            "schema_version": "0.1.0", "generated_at": generated,
            "notes": "Adapted from data/seed/rare_graph.json. Confidence is HPO information content or gene specificity where a source supports it.",
        },
        "nodes": nodes, "edges": edges,
    }


def build_relevance(seed: dict, graph: dict, generated: str) -> dict:
    empty = {
        "dimension": "gene",
        "family": "biology",
        "score": 0, "status": "unknown", "kind": "none",
        "coverage": {"a": 0, "b": 0},
        "shared": [],
        "support": None,
        "summary": "Not used. The pair percent is the SimGIC percentile.",
        "flags": [],
        "detail": "Not used. The pair percent is the SimGIC percentile.",
        "evidence_edge_ids": [],
    }
    dimensions = (
        "gene", "variant", "mechanism", "phenotype", "disease", "patient_org",
        "paper", "trial", "grant", "investigator", "asset",
    )
    weights = seed.get("weights") or {}
    pair_rows = []
    for pair in weights.get("pairs") or []:
        a, b = sorted((pair["a"], pair["b"]))
        percent = pair["percentile"]
        pair_rows.append({
            "a": a, "b": b, "biology": percent, "clinical": pair["simgic"],
            "collaboration": 0, "relevance": percent, "tier": tier_of(percent),
            "tier_reason": f"Closer than {round(percent * 100)}% of random disease pairs by SimGIC.",
            "clinical_tier": "similar", "clinical_reason": f"SimGIC {pair['simgic']}.",
            "support": None, "lines_of_evidence": [],
            "dimensions": {
                name: {**empty, "dimension": name, "family": "biology" if name in ("gene", "variant", "mechanism") else "clinical" if name in ("phenotype", "disease") else "collaboration"}
                for name in dimensions
            },
            "flags": [], "judgments": [],
        })
    diseases = [
        node["id"] for node in graph["nodes"]
        if node["type"] == "Disease" and node["id"].startswith("MONDO:")
    ]
    by_disease = {disease: [] for disease in diseases}
    for pair in pair_rows:
        if pair["tier"] == "none":
            continue
        by_disease[pair["a"]].append(pair)
        by_disease[pair["b"]].append(pair)
    entries = {}
    for disease in diseases:
        ranked = sorted(by_disease[disease], key=lambda row: -row["relevance"])
        neighbors = []
        for row in ranked[:8]:
            other = row["b"] if row["a"] == disease else row["a"]
            neighbors.append({
                "id": other, "tier": row["tier"], "relevance": row["relevance"],
                "clinical": row["clinical"], "collaboration": 0,
            })
        entries[disease] = {
            "id": disease, "cluster": None, "centrality": 0, "bridge": False,
            "coords3d": [0, 0, 0], "neighbors": neighbors,
            "hidden": max(0, len(ranked) - 8), "clinical_neighbors": neighbors,
        }
    return {
        "meta": {
            "version": "0.2.0",
            "engine_version": "0.2.0",
            "graph_generated_at": generated,
            "generated_at": generated,
            "method": "deterministic-baseline",
            "ic_source": "hpo-annotations",
            "caps": {name: 0 for name in dimensions},
            "thresholds": {"strong": 0.99, "moderate": 0.95, "exploratory": 0.8},
            "clinical_thresholds": {"very_similar": 0.65, "similar": 0.4, "somewhat": 0.2},
            "max_neighbors": 8,
            "notes": [
                weights.get("method", ""),
                "Pair relevance is the SimGIC percentile against random disease pairs. Caps are recorded as 0 because they are not used.",
            ],
        },
        "diseases": entries, "pairs": pair_rows, "clusters": [], "bridges": [],
    }


def main() -> None:
    seed = json.loads(SEED.read_text())
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    graph = build_graph(seed, generated)
    relevance = build_relevance(seed, graph, generated)
    GRAPH_OUT.write_text(json.dumps(graph, indent=2) + "\n")
    RELEVANCE_OUT.write_text(json.dumps(relevance) + "\n")
    print("wrote", len(graph["nodes"]), "nodes", len(graph["edges"]), "edges", len(relevance["pairs"]), "pairs")


if __name__ == "__main__":
    main()

