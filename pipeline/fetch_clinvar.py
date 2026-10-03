"""Attach a few pathogenic ClinVar variants to each CLN gene. No API key.

The brief says a shared gene name is not enough. These edges are
variant -> gene -> disease, each with a ClinVar URL.
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

# Gene symbol to the disease it causes in this slice. One gene, one disease.
GENES = {
    "PPT1": "MONDO:0009744",
    "TPP1": "MONDO:0008769",
    "CLN3": "MONDO:0008767",
    "CLN6": "MONDO:0011144",
    "MFSD8": "MONDO:0012588",
}


def get(url: str) -> dict:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    time.sleep(0.4)
    return payload


def search(symbol: str) -> list[str]:
    term = f"{symbol}[gene] AND pathogenic[clinsig]"
    query = urllib.parse.urlencode({"db": "clinvar", "retmode": "json", "retmax": "3", "term": term})
    payload = get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?{query}")
    return payload.get("esearchresult", {}).get("idlist", [])


def summaries(variation_ids: list[str]) -> dict:
    query = urllib.parse.urlencode({"db": "clinvar", "retmode": "json", "id": ",".join(variation_ids)})
    payload = get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?{query}")
    return payload.get("result", {})


def main() -> None:
    graph = json.loads(SEED.read_text())
    nodes = graph["nodes"]
    edges = graph["edges"]
    seen = {node["id"] for node in nodes}
    gene_ids = {
        node["name"]: node["id"]
        for node in nodes
        if node["type"] == "gene" and node["name"] in GENES
    }

    for symbol, mondo_id in GENES.items():
        gene_id = gene_ids.get(symbol)
        if not gene_id:
            print("missing gene node", symbol)
            continue
        variation_ids = search(symbol)
        if not variation_ids:
            print("none", symbol)
            continue
        result = summaries(variation_ids)
        for variation_id in variation_ids:
            record = result.get(variation_id) or {}
            title = record.get("title") or f"ClinVar {variation_id}"
            node_id = f"CLINVAR:{variation_id}"
            if node_id not in seen:
                nodes.append(
                    {
                        "id": node_id,
                        "type": "variant",
                        "name": title,
                        "clinical_significance": record.get("clinical_significance", {}).get("description")
                        if isinstance(record.get("clinical_significance"), dict)
                        else record.get("clinical_significance"),
                        "source_url": f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{variation_id}/",
                    }
                )
                seen.add(node_id)
            edges.append(
                {
                    "id": f"e-{node_id}-{gene_id}",
                    "source": node_id,
                    "target": gene_id,
                    "relation": "variant_of",
                    "status": "sourced",
                    "evidence_url": f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{variation_id}/",
                    "note": f"Pathogenic ClinVar hit for {symbol}. Does not by itself link this variant to another disease.",
                }
            )
        print(symbol, variation_ids)

    graph["not_fetched"] = ["patient groups: Orphanet organization API requires a key"]
    SEED.write_text(json.dumps(graph, indent=2))
    print("variants", sum(1 for node in nodes if node["type"] == "variant"))


if __name__ == "__main__":
    main()
