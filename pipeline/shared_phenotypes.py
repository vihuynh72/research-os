"""Phenotypes shared by two or more CLN diseases. Reads the seed. No network."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

SEED = Path(__file__).resolve().parents[1] / "data" / "seed" / "cln_graph.json"


def main() -> None:
    graph = json.loads(SEED.read_text())
    names = {node["id"]: node["name"] for node in graph["nodes"]}
    by_phenotype: dict[str, list[str]] = defaultdict(list)
    for edge in graph["edges"]:
        if edge["relation"] != "has_phenotype":
            continue
        by_phenotype[edge["target"]].append(edge["source"])

    shared = []
    for phenotype_id, diseases in by_phenotype.items():
        unique = sorted(set(diseases))
        if len(unique) < 2:
            continue
        shared.append(
            {
                "id": phenotype_id,
                "name": names.get(phenotype_id, phenotype_id),
                "disease_count": len(unique),
                "diseases": [names.get(disease_id, disease_id) for disease_id in unique],
            }
        )
    shared.sort(key=lambda row: (-row["disease_count"], row["name"]))
    out = SEED.parent / "cln_shared_phenotypes.json"
    out.write_text(json.dumps(shared, indent=2))
    print(f"{len(shared)} shared phenotypes")
    for row in shared[:12]:
        print(f"{row['disease_count']}  {row['name']}")


if __name__ == "__main__":
    main()
