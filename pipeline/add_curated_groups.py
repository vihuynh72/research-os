"""Add Orphanet groups and the registry that were opened in a browser.

These rows are status=curated. They attach to the lysosomal mechanism,
not to one CLN, because the directory was 'including CLN3', not CLN3-only.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed" / "cln_graph.json"
CURATED = ROOT / "data" / "curated" / "orphanet_groups.json"
MECHANISM = "PW:NCL-LYSOSOME"


def main() -> None:
    graph = json.loads(SEED.read_text())
    curated = json.loads(CURATED.read_text())
    drop = {item["id"] for item in curated["groups"] + curated["registries"]}
    nodes = [node for node in graph["nodes"] if node["id"] not in drop and node["id"] != "GAP:patient-group"]
    edges = [
        edge
        for edge in graph["edges"]
        if edge["relation"] != "missing_group"
        and edge["source"] not in drop
        and edge["target"] not in drop
    ]

    for group in curated["groups"]:
        nodes.append(
            {
                "id": group["id"],
                "type": "patient_group",
                "name": group["name"],
                "country": group["country"],
                "source_url": group["orpha_url"],
                "website": group.get("website"),
                "checked": curated["checked"],
            }
        )
        edges.append(
            {
                "id": f"e-{group['id']}-mech",
                "source": group["id"],
                "target": MECHANISM,
                "relation": "works_on",
                "status": "curated",
                "evidence_url": group["orpha_url"],
                "note": curated["caveat"],
            }
        )

    for registry in curated["registries"]:
        nodes.append(
            {
                "id": registry["id"],
                "type": "registry",
                "name": registry["name"],
                "source_url": registry["orpha_url"],
                "website": registry.get("website"),
                "checked": curated["checked"],
            }
        )
        edges.append(
            {
                "id": f"e-{registry['id']}-mech",
                "source": registry["id"],
                "target": MECHANISM,
                "relation": "registers",
                "status": "curated",
                "evidence_url": registry["orpha_url"],
                "note": curated["caveat"],
            }
        )

    graph["nodes"] = nodes
    graph["edges"] = edges
    graph["not_fetched"] = []
    SEED.write_text(json.dumps(graph, indent=2))
    print("groups", len(curated["groups"]), "registries", len(curated["registries"]))


if __name__ == "__main__":
    main()
