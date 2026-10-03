"""Fetch a public CLN / Batten seed. No API key. No OpenAI.

Monarch entity pages supply disease, causal gene, and phenotypes.
ClinicalTrials.gov supplies studies. Patient groups are not fetched.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
SEED = ROOT / "data" / "seed"
RAW.mkdir(parents=True, exist_ok=True)
SEED.mkdir(parents=True, exist_ok=True)

DISEASES = [
    "MONDO:0009744",
    "MONDO:0008769",
    "MONDO:0008767",
    "MONDO:0011144",
    "MONDO:0012588",
]
MECHANISM_ID = "PW:NCL-LYSOSOME"
TITLE_NEEDLE = {
    "MONDO:0009744": ("cln1", "ppt1"),
    "MONDO:0008769": ("cln2", "tpp1", "cerliponase"),
    "MONDO:0008767": ("cln3",),
    "MONDO:0011144": ("cln6",),
    "MONDO:0012588": ("cln7", "mfsd8"),
}
UA = {"User-Agent": "research-os/0.1 (educational)", "Accept": "application/json"}


def get(url: str) -> dict:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def node(node_id: str, node_type: str, name: str, **extra: object) -> dict:
    payload = {"id": node_id, "type": node_type, "name": name}
    payload.update(extra)
    return payload


def edge(edge_id: str, source: str, target: str, relation: str, evidence_url: str) -> dict:
    return {
        "id": edge_id,
        "source": source,
        "target": target,
        "relation": relation,
        "status": "sourced",
        "evidence_url": evidence_url,
    }


def main() -> None:
    nodes = [
        node(
            MECHANISM_ID,
            "mechanism",
            "Lysosomal lipofuscin accumulation",
            note="Shared process. Not a claim that one therapy treats the other CLNs.",
        )
    ]
    edges = []
    seen = {MECHANISM_ID}

    for mondo_id in DISEASES:
        entity = get(f"https://api.monarchinitiative.org/v3/api/entity/{mondo_id}")
        (RAW / f"entity_{mondo_id.replace(':', '_')}.json").write_text(json.dumps(entity))
        page = f"https://monarchinitiative.org/{mondo_id}"
        nodes.append(
            node(
                mondo_id,
                "disease",
                entity.get("name"),
                synonyms=entity.get("exact_synonym") or [],
                orpha=next((x for x in entity.get("xref") or [] if str(x).startswith("Orphanet:")), None),
                source_url=page,
            )
        )
        edges.append(edge(f"e-{mondo_id}-mech", mondo_id, MECHANISM_ID, "disrupts_process", page))
        for gene in entity.get("causal_gene") or []:
            gene_id = gene["id"]
            if gene_id not in seen:
                nodes.append(node(gene_id, "gene", gene.get("name") or gene_id))
                seen.add(gene_id)
            edges.append(edge(f"e-{gene_id}-{mondo_id}", gene_id, mondo_id, "causes", page))
        labels = entity.get("has_phenotype_label") or []
        for index, pheno_id in enumerate(entity.get("has_phenotype") or []):
            if pheno_id == "HP:0000007":
                continue
            if pheno_id not in seen:
                label = labels[index] if index < len(labels) else pheno_id
                nodes.append(node(pheno_id, "phenotype", label))
                seen.add(pheno_id)
            edges.append(edge(f"e-{mondo_id}-{pheno_id}", mondo_id, pheno_id, "has_phenotype", page))
        print(mondo_id, entity.get("name"))

    trials = get(
        "https://clinicaltrials.gov/api/v2/studies?"
        + urllib.parse.urlencode({"query.cond": "neuronal ceroid lipofuscinosis", "pageSize": "40"})
    )
    (RAW / "clinicaltrials_cln.json").write_text(json.dumps(trials))
    for study in trials.get("studies", []):
        protocol = study.get("protocolSection") or {}
        ident = protocol.get("identificationModule") or {}
        status = protocol.get("statusModule") or {}
        nct_id = ident.get("nctId")
        if not nct_id:
            continue
        title = ident.get("briefTitle") or nct_id
        url = f"https://clinicaltrials.gov/study/{nct_id}"
        nodes.append(node(nct_id, "study", title, overall_status=status.get("overallStatus"), source_url=url))
        title_l = title.lower()
        for mondo_id, needles in TITLE_NEEDLE.items():
            if any(needle in title_l for needle in needles):
                edges.append(edge(f"e-{nct_id}-{mondo_id}", nct_id, mondo_id, "studies", url))

    graph = {
        "slice": "CLN / Batten",
        "persona": "Maria",
        "nodes": nodes,
        "edges": edges,
        "not_fetched": ["patient groups", "papers"],
    }
    (SEED / "cln_graph.json").write_text(json.dumps(graph, indent=2))
    counts = {}
    for item in nodes:
        counts[item["type"]] = counts.get(item["type"], 0) + 1
    print(counts, "edges", len(edges))


if __name__ == "__main__":
    main()
