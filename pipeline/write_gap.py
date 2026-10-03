"""Write the unsupported end of Maria's path. No network. No invented group."""

from __future__ import annotations

import json
from pathlib import Path

SEED = Path(__file__).resolve().parents[1] / "data" / "seed" / "cln_graph.json"
GAP_ID = "GAP:patient-group"


def main() -> None:
    graph = json.loads(SEED.read_text())
    nodes = [node for node in graph["nodes"] if node["id"] != GAP_ID]
    edges = [edge for edge in graph["edges"] if GAP_ID not in (edge["source"], edge["target"])]
    nodes.append(
        {
            "id": GAP_ID,
            "type": "gap",
            "name": "No verified patient group in this seed",
            "missing": "patient organization and registry",
            "looked_in": [
                "https://api.orphacode.org returned 401 without an API key",
                "https://www.orpha.net/en/disease/detail/228346 has no organization list in the public HTML",
                "Orphadata free XML products downloaded were classification and HPO, not groups",
            ],
            "next_question": "Which verified group site, opened and checked, covers CLN3 and already has a registry?",
            "do_not": "Do not infer a group from a disease name. Do not suggest a shared trial from this gap.",
        }
    )
    for node in graph["nodes"]:
        if node["type"] != "disease":
            continue
        edges.append(
            {
                "id": f"e-{node['id']}-{GAP_ID}",
                "source": node["id"],
                "target": GAP_ID,
                "relation": "missing_group",
                "status": "gap",
                "evidence_url": "https://api.orphacode.org/",
                "note": "Searched. No supported patient-organization edge.",
            }
        )
    graph["nodes"] = nodes
    graph["edges"] = edges
    graph["not_fetched"] = ["verified patient-group page"]
    SEED.write_text(json.dumps(graph, indent=2))
    print("gap edges", sum(1 for edge in edges if edge["relation"] == "missing_group"))


if __name__ == "__main__":
    main()
