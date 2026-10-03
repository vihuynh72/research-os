"""Attach a few PubMed papers to each CLN disease. No API key. No OpenAI.

Uses NCBI E-utilities. Three papers per disease, title search only.
Does not claim a paper applies to another CLN.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed" / "cln_graph.json"
UA = {"User-Agent": "research-os/0.1 (educational)", "Accept": "application/json"}

QUERIES = {
    "MONDO:0009744": "CLN1 PPT1 neuronal ceroid lipofuscinosis",
    "MONDO:0008769": "CLN2 TPP1 cerliponase neuronal ceroid lipofuscinosis",
    "MONDO:0008767": "CLN3 Batten disease",
    "MONDO:0011144": "CLN6 neuronal ceroid lipofuscinosis",
    "MONDO:0012588": "CLN7 MFSD8 neuronal ceroid lipofuscinosis",
}


def get(url: str) -> dict:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def search(term: str) -> list[str]:
    query = urllib.parse.urlencode(
        {"db": "pubmed", "retmode": "json", "retmax": "3", "sort": "relevance", "term": term}
    )
    payload = get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?{query}")
    time.sleep(0.5)
    return payload.get("esearchresult", {}).get("idlist", [])


def summaries(pmids: list[str]) -> dict:
    query = urllib.parse.urlencode({"db": "pubmed", "retmode": "json", "id": ",".join(pmids)})
    payload = get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?{query}")
    time.sleep(0.5)
    return payload.get("result", {})


def main() -> None:
    graph = json.loads(SEED.read_text())
    nodes = graph["nodes"]
    edges = graph["edges"]
    seen = {node["id"] for node in nodes}

    for mondo_id, term in QUERIES.items():
        pmids = search(term)
        if not pmids:
            print("none", mondo_id)
            continue
        result = summaries(pmids)
        for pmid in pmids:
            paper = result.get(pmid) or {}
            node_id = f"PMID:{pmid}"
            if node_id not in seen:
                nodes.append(
                    {
                        "id": node_id,
                        "type": "paper",
                        "name": paper.get("title"),
                        "journal": paper.get("fulljournalname"),
                        "year": paper.get("pubdate"),
                        "source_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    }
                )
                seen.add(node_id)
            edges.append(
                {
                    "id": f"e-{node_id}-{mondo_id}",
                    "source": node_id,
                    "target": mondo_id,
                    "relation": "about",
                    "status": "sourced",
                    "evidence_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    "note": "Title search hit. Not a claim the paper's result transfers to another CLN.",
                }
            )
        print(mondo_id, pmids)

    graph["not_fetched"] = [
        "patient groups: Paul adds a row only after opening the URL",
        "ClinVar variants",
        "NIH RePORTER",
    ]
    SEED.write_text(json.dumps(graph, indent=2))
    print("papers", sum(1 for node in nodes if node["type"] == "paper"))


if __name__ == "__main__":
    main()
