"""Rebuild the seed, then check it against the hand-curated Orphanet rows.

Usage:
  python3 pipeline/run_seed.py --offline   # no network, checks the saved seed
  python3 pipeline/run_seed.py             # refetch, then check
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed" / "cln_graph.json"
CURATED = ROOT / "data" / "curated" / "orphanet_groups.json"
STEPS = [
    "fetch_cln_seed.py",
    "fetch_pubmed.py",
    "fetch_reporter.py",
    "fetch_clinvar.py",
    "shared_phenotypes.py",
    "fetch_orphanet_groups.py",
    "add_curated_groups.py",
    "check_orphanet.py",
]


def run(script: str) -> None:
    print(f"\n-- {script}")
    subprocess.run([sys.executable, str(ROOT / "pipeline" / script)], check=True)


def offline_checks() -> None:
    graph = json.loads(SEED.read_text())
    curated = json.loads(CURATED.read_text())
    names = {node["id"]: node for node in graph["nodes"]}
    edges = graph["edges"]
    failures = []

    disease = names.get("MONDO:0008767")
    if not disease or not disease.get("source_url"):
        failures.append("CLN3 missing or unsourced")
    gene_edges = [edge for edge in edges if edge["relation"] == "causes" and edge["target"] == "MONDO:0008767"]
    if not gene_edges:
        failures.append("CLN3 has no causal gene")
    variants = [
        edge for edge in edges
        if edge["relation"] == "variant_of" and edge["target"] == gene_edges[0]["source"]
    ] if gene_edges else []
    if len(variants) < 1:
        failures.append("CLN3 gene has no variant")
    for relation in ("studies", "about", "funds"):
        hits = [edge for edge in edges if edge["relation"] == relation and edge["target"] == "MONDO:0008767"]
        if not hits or any(not edge.get("evidence_url") for edge in hits):
            failures.append(f"CLN3 has no sourced {relation} edge")

    for group in curated["groups"]:
        node = names.get(group["id"])
        if not node:
            failures.append(f"curated group missing: {group['name']}")
            continue
        if node.get("source_url") != group["orpha_url"]:
            failures.append(f"group source drifted: {group['name']}")
        attached = [
            edge for edge in edges
            if edge["source"] == group["id"] and edge.get("evidence_url")
        ]
        if not attached:
            failures.append(f"group has no curated edge: {group['name']}")
    for registry in curated["registries"]:
        if registry["id"] not in names:
            failures.append(f"curated registry missing: {registry['name']}")

    if any(edge["relation"] == "missing_group" for edge in edges):
        failures.append("gap edge still present after curated groups were added")
    if failures:
        print("FAIL")
        for item in failures:
            print(" ", item)
        raise SystemExit(1)
    print("offline checks passed")
    print(" nodes", len(graph["nodes"]), "edges", len(edges))


def main() -> None:
    if "--offline" in sys.argv:
        offline_checks()
        return
    for script in STEPS:
        run(script)
    offline_checks()


if __name__ == "__main__":
    main()
