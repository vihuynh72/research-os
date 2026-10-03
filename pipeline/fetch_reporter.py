"""Attach NIH RePORTER projects to each CLN disease. No API key. No OpenAI.

A title or terms hit is not a claim the award treats another CLN.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed" / "cln_graph.json"
URL = "https://api.reporter.nih.gov/v2/projects/search"

QUERIES = {
    "MONDO:0009744": ("and", "CLN1 PPT1"),
    "MONDO:0008769": ("or", "CLN2 TPP1 cerliponase"),
    "MONDO:0008767": ("and", "CLN3 Batten"),
    "MONDO:0011144": ("and", "CLN6"),
    "MONDO:0012588": ("or", "CLN7 MFSD8"),
}


def search(operator: str, text: str) -> list[dict]:
    body = json.dumps(
        {
            "criteria": {
                "advanced_text_search": {
                    "operator": operator,
                    "search_field": "projecttitle,terms",
                    "search_text": text,
                }
            },
            "limit": 3,
            "offset": 0,
        }
    ).encode()
    request = urllib.request.Request(
        URL,
        data=body,
        headers={"User-Agent": "research-os/0.1", "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    return payload.get("results") or []


def main() -> None:
    graph = json.loads(SEED.read_text())
    nodes = graph["nodes"]
    edges = graph["edges"]
    seen = {node["id"] for node in nodes}

    for mondo_id, (operator, text) in QUERIES.items():
        hits = search(operator, text)
        print(mondo_id, len(hits))
        for project in hits:
            project_num = project.get("core_project_num") or project.get("project_num")
            if not project_num:
                continue
            node_id = f"NIH:{project_num}"
            if node_id not in seen:
                agency = (project.get("agency_ic_admin") or {}).get("abbreviation")
                nodes.append(
                    {
                        "id": node_id,
                        "type": "project",
                        "name": project.get("project_title"),
                        "pi": project.get("contact_pi_name"),
                        "fiscal_year": project.get("fiscal_year"),
                        "agency": agency,
                        "source_url": project.get("project_detail_url"),
                    }
                )
                seen.add(node_id)
            edges.append(
                {
                    "id": f"e-{node_id}-{mondo_id}",
                    "source": node_id,
                    "target": mondo_id,
                    "relation": "funds",
                    "status": "sourced",
                    "evidence_url": project.get("project_detail_url"),
                    "note": "RePORTER title or terms hit. Not a claim the work transfers to another CLN.",
                }
            )

    graph["not_fetched"] = [
        "patient groups: Orphanet organization API requires a key",
        "ClinVar variants",
    ]
    SEED.write_text(json.dumps(graph, indent=2))
    print("projects", sum(1 for node in nodes if node["type"] == "project"))


if __name__ == "__main__":
    main()
