"""Add shared-phenotype edges inside clusters the graph already has.

Reads saved Monarch entities. Does not fetch. A phenotype edge is written
only when two diseases share the Human Phenotype Ontology id and Monarch
already links those diseases by the same gene or the same parent.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
GRAPH = ROOT / "data" / "seed" / "rare_graph.json"


def cluster_of(graph: dict) -> dict[str, str]:
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        if parent[node] != node:
            parent[node] = find(parent[node])
        return parent[node]

    diseases = {node["id"] for node in graph["nodes"] if node["type"] == "disease"}
    for disease in diseases:
        find(disease)
    for edge in graph["edges"]:
        if edge["relation"] in ("same_gene", "subclass_of") and edge["source"] in diseases:
            other = edge["target"] if edge["target"] in diseases else edge["source"]
            if other in diseases and edge["relation"] == "same_gene":
                parent[find(edge["source"])] = find(edge["target"])
        if edge["relation"] == "subclass_of":
            parent.setdefault(edge["target"], edge["target"])
            if edge["source"] in diseases:
                parent[find(edge["source"])] = find(edge["target"])
    return {disease: find(disease) for disease in diseases}


def phenotypes(mondo: str) -> list[tuple[str, str]]:
    path = RAW / f"entity_{mondo.replace(':', '_')}.json"
    if not path.exists():
        return []
    entity = json.loads(path.read_text())
    labels = entity.get("has_phenotype_label") or []
    rows = []
    for index, phenotype_id in enumerate(entity.get("has_phenotype") or []):
        if phenotype_id == "HP:0000007":
            continue
        label = labels[index] if index < len(labels) else phenotype_id
        rows.append((phenotype_id, label))
    return rows


def main() -> None:
    graph = json.loads(GRAPH.read_text())
    clusters = cluster_of(graph)
    names = {node["id"]: node["name"] for node in graph["nodes"]}
    seen = {node["id"] for node in graph["nodes"]}
    by_cluster: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    labels = {}
    covered = 0
    for mondo, cluster in clusters.items():
        rows = phenotypes(mondo)
        if not rows:
            continue
        covered += 1
        for phenotype_id, label in rows:
            by_cluster[cluster][phenotype_id].append(mondo)
            labels[phenotype_id] = label

    added = 0
    for cluster, phenos in by_cluster.items():
        for phenotype_id, diseases in phenos.items():
            unique = sorted(set(diseases))
            if len(unique) < 2:
                continue
            if phenotype_id not in seen:
                graph["nodes"].append({
                    "id": phenotype_id,
                    "type": "phenotype",
                    "name": labels.get(phenotype_id, phenotype_id),
                    "source_url": f"https://hpo.jax.org/browse/term/{phenotype_id}",
                })
                seen.add(phenotype_id)
            for mondo in unique:
                graph["edges"].append({
                    "source": mondo,
                    "target": phenotype_id,
                    "relation": "has_phenotype",
                    "evidence_url": f"https://monarchinitiative.org/{mondo}",
                    "note": "Shared inside an existing Monarch cluster. Not a shared mechanism.",
                })
                added += 1
    GRAPH.write_text(json.dumps(graph, indent=2))
    print("entities with phenotypes", covered, "of", len(clusters))
    print("phenotype edges", added, "phenotype nodes", sum(1 for node in graph["nodes"] if node["type"] == "phenotype"))


if __name__ == "__main__":
    main()
