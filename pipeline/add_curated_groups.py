"""Attach patient groups and registries found by the Orphanet scrape.

The hand-curated file is not an input. pipeline/check_orphanet.py compares
this output to that file. A group attaches to the shared mechanism, because
the directory says the result includes the disease rather than being specific.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed" / "cln_graph.json"
SCRAPED = ROOT / "data" / "raw" / "orphanet_groups.json"
MECHANISM = "PW:NCL-LYSOSOME"
NOTE = "Orphanet directory result includes this disease. Not a disease-specific listing."


def main() -> None:
    graph = json.loads(SEED.read_text())
    scraped = json.loads(SCRAPED.read_text())
    groups = {}
    registries = {}
    for page in scraped:
        for group in page["groups"]:
            groups[group["id"]] = group
        for registry in page["registries"]:
            registries[registry["id"]] = registry

    drop = {f"ORPHA-ORG:{item}" for item in groups} | {f"ORPHA-REG:{item}" for item in registries}
    nodes = [node for node in graph["nodes"] if node["id"] not in drop and node["id"] != "GAP:patient-group"]
    edges = [
        edge
        for edge in graph["edges"]
        if edge["relation"] not in ("missing_group", "works_on", "registers")
        and edge["source"] not in drop
        and edge["target"] not in drop
    ]

    for group in groups.values():
        node_id = f"ORPHA-ORG:{group['id']}"
        nodes.append(
            {
                "id": node_id,
                "type": "patient_group",
                "name": group["name"],
                "country": group.get("country"),
                "source_url": group["orpha_url"],
            }
        )
        edges.append(
            {
                "id": f"e-{node_id}-mech",
                "source": node_id,
                "target": MECHANISM,
                "relation": "works_on",
                "status": "sourced",
                "evidence_url": group["orpha_url"],
                "note": NOTE,
            }
        )

    for registry in registries.values():
        node_id = f"ORPHA-REG:{registry['id']}"
        nodes.append(
            {
                "id": node_id,
                "type": "registry",
                "name": registry["name"],
                "country": registry.get("country"),
                "source_url": registry["orpha_url"],
            }
        )
        edges.append(
            {
                "id": f"e-{node_id}-mech",
                "source": node_id,
                "target": MECHANISM,
                "relation": "registers",
                "status": "sourced",
                "evidence_url": registry["orpha_url"],
                "note": NOTE,
            }
        )

    graph["nodes"] = nodes
    graph["edges"] = edges
    graph["not_fetched"] = []
    SEED.write_text(json.dumps(graph, indent=2))
    print("groups", len(groups), "registries", len(registries))


if __name__ == "__main__":
    main()
