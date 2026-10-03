"""Build the rare-disease graph. One script, one JSON.

Reads a candidate list, fetches public records, and writes
data/seed/rare_graph.json. A missing source stays a gap. Diseases are linked
only when Monarch already says they share a gene or a parent, or when both
list the same Human Phenotype Ontology id inside that cluster.

Usage: python3 pipeline/build_graph.py data/raw/candidates.json
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "seed" / "rare_graph.json"
UA = {"User-Agent": "research-os/0.1 (educational)", "Accept": "application/json"}
BROWSER = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/html",
}


def get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    time.sleep(0.35)
    return payload


def search(database: str, term: str) -> list[dict]:
    query = urllib.parse.urlencode({"db": database, "retmode": "json", "retmax": 3, "term": term})
    ids = get_json(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?{query}").get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    summary = get_json(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
        + urllib.parse.urlencode({"db": database, "retmode": "json", "id": ",".join(ids)})
    ).get("result", {})
    return [{"id": item, "name": (summary.get(item) or {}).get("title")} for item in ids]


def projects(name: str, symbol: str) -> list[dict]:
    body = json.dumps({
        "criteria": {"advanced_text_search": {"operator": "and", "search_field": "projecttitle,terms", "search_text": f"{symbol} {name}"}},
        "limit": 3,
        "offset": 0,
    }).encode()
    request = urllib.request.Request(
        "https://api.reporter.nih.gov/v2/projects/search",
        data=body,
        headers={**UA, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    time.sleep(0.35)
    return [{"id": str(row.get("appl_id")), "name": row.get("project_title")} for row in payload.get("results", [])]


def groups(orpha: str, name: str, symbol: str) -> list[dict]:
    needles = tuple(item.lower() for item in (symbol, *name.split()) if len(item) > 3)
    url = f"https://www.orpha.net/en/patient-organisations?orphaCode={orpha}&diseaseName={urllib.parse.quote(name)}"
    html = urllib.request.urlopen(urllib.request.Request(url, headers=BROWSER), timeout=60).read().decode("utf-8", "replace")
    found, seen = [], set()
    pattern = r'href="(/en/patient-organisations/patient/(\d+)\?[^"]*)"[^>]*>\s*([^<]+?)\s*</a>'
    for match in re.finditer(pattern, html):
        record_id = match.group(2)
        label = re.sub(r"\s+", " ", match.group(3)).strip()
        if record_id in seen or not any(needle in label.lower() for needle in needles):
            continue
        seen.add(record_id)
        found.append({"id": record_id, "name": label, "url": "https://www.orpha.net" + match.group(1).split("?")[0]})
    return found[:6]


def phenotypes(entity: dict) -> list[tuple[str, str]]:
    labels = entity.get("has_phenotype_label") or []
    rows = []
    for index, phenotype_id in enumerate(entity.get("has_phenotype") or []):
        if phenotype_id == "HP:0000007":
            continue
        rows.append((phenotype_id, labels[index] if index < len(labels) else phenotype_id))
    return rows

def add(graph: dict, seen: set[str], node_id: str, node_type: str, name: str | None, url: str | None) -> None:
    if node_id in seen:
        return
    graph["nodes"].append({"id": node_id, "type": node_type, "name": name, "source_url": url})
    seen.add(node_id)


def edge(graph: dict, source: str, target: str, relation: str, url: str, note: str | None = None) -> None:
    row = {"source": source, "target": target, "relation": relation, "evidence_url": url}
    if note:
        row["note"] = note
    graph["edges"].append(row)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 pipeline/build_graph.py data/raw/candidates.json")
    selected = json.loads(Path(sys.argv[1]).read_text())["kept"]
    graph: dict = {"nodes": [], "edges": []}
    seen: set[str] = set()
    by_gene: dict[str, list[str]] = defaultdict(list)
    by_parent: dict[str, list[str]] = defaultdict(list)
    cluster_phenotypes: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    labels: dict[str, str] = {}

    for row in selected:
        mondo = row["id"]
        try:
            entity = get_json(f"https://api-v3.monarchinitiative.org/v3/api/entity/{mondo}")
            gene_rows = search("clinvar", f"{row['gene']}[gene] AND pathogenic[clinsig]")
            paper_rows = search("pubmed", f"{row['gene']} {row['name']}")
            project_rows = projects(row["name"], row["gene"])
            group_rows = groups(row["orpha"], row["name"], row["gene"])
        except Exception as error:
            print("fail", mondo, type(error).__name__, flush=True)
            continue
        gaps = []
        if not gene_rows:
            gaps.append("no pathogenic ClinVar variant")
        if not paper_rows:
            gaps.append("no PubMed hit")
        if not project_rows:
            gaps.append("no NIH RePORTER project")
        if not group_rows:
            gaps.append("no name-matched Orphanet group")
        add(graph, seen, mondo, "disease", row["name"], f"https://monarchinitiative.org/{mondo}")
        graph["nodes"][-1]["orpha"] = row["orpha"]
        graph["nodes"][-1]["gaps"] = gaps
        add(graph, seen, row["gene_id"], "gene", row["gene"], f"https://monarchinitiative.org/{mondo}")
        edge(graph, row["gene_id"], mondo, "causes", f"https://monarchinitiative.org/{mondo}")
        by_gene[row["gene_id"]].append(mondo)
        for parent in row.get("related_to") or []:
            by_parent[parent].append(mondo)
        for item in gene_rows:
            node_id = f"CLINVAR:{item['id']}"
            url = f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{item['id']}/"
            add(graph, seen, node_id, "variant", item["name"], url)
            edge(graph, node_id, row["gene_id"], "variant_of", url)
        for item in paper_rows:
            node_id, url = f"PMID:{item['id']}", f"https://pubmed.ncbi.nlm.nih.gov/{item['id']}/"
            add(graph, seen, node_id, "paper", item["name"], url)
            edge(graph, node_id, mondo, "about", url)
        for item in project_rows:
            node_id = f"NIH:{item['id']}"
            url = f"https://reporter.nih.gov/project-details/{item['id']}"
            add(graph, seen, node_id, "project", item["name"], url)
            edge(graph, node_id, mondo, "funds", url)
        for item in group_rows:
            node_id = f"ORPHA-ORG:{item['id']}"
            add(graph, seen, node_id, "patient_group", item["name"], item["url"])
            edge(graph, node_id, mondo, "works_on", item["url"])
        for phenotype_id, label in phenotypes(entity):
            cluster_phenotypes[row["gene_id"]][phenotype_id].append(mondo)
            labels[phenotype_id] = label
        print(row["name"], gaps, flush=True)

    for diseases in by_gene.values():
        unique = sorted(set(diseases))
        for left, right in zip(unique, unique[1:]):
            edge(graph, left, right, "same_gene", f"https://monarchinitiative.org/{left}")
    for parent, diseases in by_parent.items():
        add(graph, seen, parent, "disease_group", parent, f"https://monarchinitiative.org/{parent}")
        for mondo in sorted(set(diseases)):
            edge(graph, mondo, parent, "subclass_of", f"https://monarchinitiative.org/{mondo}")
    note = "Shared inside an existing Monarch cluster. Not a shared mechanism."
    for phenos in cluster_phenotypes.values():
        members = {disease for rows in phenos.values() for disease in rows}
        if len(members) < 2:
            continue
        for phenotype_id, diseases in phenos.items():
            unique = sorted(set(diseases))
            if len(unique) < 2:
                continue
            add(graph, seen, phenotype_id, "phenotype", labels.get(phenotype_id), f"https://hpo.jax.org/browse/term/{phenotype_id}")
            for mondo in unique:
                edge(graph, mondo, phenotype_id, "has_phenotype", f"https://monarchinitiative.org/{mondo}", note)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(graph, indent=2))
    print("wrote", OUT, "nodes", len(graph["nodes"]), "edges", len(graph["edges"]))


if __name__ == "__main__":
    main()
