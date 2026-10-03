"""Print Maria's path for one disease. Reads the seed. No network.

Usage: python3 pipeline/path_for.py MONDO:0008767
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SEED = Path(__file__).resolve().parents[1] / "data" / "seed" / "cln_graph.json"
SHARED = Path(__file__).resolve().parents[1] / "data" / "seed" / "cln_shared_phenotypes.json"


def main() -> None:
    disease_id = sys.argv[1] if len(sys.argv) > 1 else "MONDO:0008767"
    graph = json.loads(SEED.read_text())
    names = {node["id"]: node for node in graph["nodes"]}
    disease = names.get(disease_id)
    if not disease:
        raise SystemExit(f"not in seed: {disease_id}")

    print(disease["name"], disease_id)
    print("source", disease.get("source_url"))

    def linked(relation: str, as_target: bool) -> list[dict]:
        hits = []
        for edge in graph["edges"]:
            if edge["relation"] != relation:
                continue
            other = edge["source"] if as_target and edge["target"] == disease_id else None
            if edge["source"] == disease_id and not as_target:
                other = edge["target"]
            if other is None and as_target and edge["target"] == disease_id:
                other = edge["source"]
            if other:
                hits.append(names.get(other, {"id": other, "name": other, "type": "?"}))
        return hits

    genes = [node for edge in graph["edges"] if edge["relation"] == "causes" and edge["target"] == disease_id
             for node in [names.get(edge["source"])] if node]
    print("\ngene")
    for gene in genes:
        print(f"  {gene['name']}  {gene['id']}")
        variants = [
            names[edge["source"]]
            for edge in graph["edges"]
            if edge["relation"] == "variant_of" and edge["target"] == gene["id"] and edge["source"] in names
        ]
        for variant in variants:
            print(f"    variant  {variant['name'][:70]}")

    print("\nmechanism")
    for edge in graph["edges"]:
        if edge["source"] == disease_id and edge["relation"] == "disrupts_process":
            node = names[edge["target"]]
            print(f"  {node['name']}  status={edge['status']}")

    shared = json.loads(SHARED.read_text())
    print("\nshared phenotypes")
    for row in shared:
        if disease["name"] in row["diseases"] and row["disease_count"] >= 3:
            others = [name for name in row["diseases"] if name != disease["name"]]
            print(f"  {row['disease_count']}  {row['name']}")
            print(f"      also {', '.join(others[:3])}")

    for relation, label in (("studies", "studies"), ("about", "papers"), ("funds", "projects")):
        print(f"\n{label}")
        count = 0
        for edge in graph["edges"]:
            if edge["relation"] == relation and edge["target"] == disease_id:
                node = names.get(edge["source"], {})
                print(f"  {node.get('name', edge['source'])[:75]}")
                print(f"      {edge.get('evidence_url')}")
                count += 1
        if count == 0:
            print("  none")

    print("\ngap")
    for edge in graph["edges"]:
        if edge["source"] == disease_id and edge["relation"] == "missing_group":
            gap = names[edge["target"]]
            print(f"  {gap['name']}")
            print(f"  next: {gap['next_question']}")


if __name__ == "__main__":
    main()
