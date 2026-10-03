"""Curate 50 rare diseases from public sources. No API key. No invented joins.

Selection is already done: data/raw/rare50_candidates.json holds diseases
that Monarch lists under rare genetic disease, each with one causal gene and
an Orphanet xref. This script does not choose more.

A missing source stays a gap. Diseases are not joined to each other.
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "seed" / "rare100.json"
CANDIDATES = RAW / "rare100_candidates.json"
UA = {"User-Agent": "research-os/0.1 (educational)", "Accept": "application/json"}
BROWSER = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html",
}


def get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    time.sleep(0.35)
    return payload


def variants(symbol: str) -> list[dict]:
    term = urllib.parse.quote(f"{symbol}[gene] AND pathogenic[clinsig]")
    found = get_json(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&retmode=json&retmax=3&term={term}")
    ids = found.get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    result = get_json(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
        + urllib.parse.urlencode({"db": "clinvar", "retmode": "json", "id": ",".join(ids)})
    ).get("result", {})
    return [
        {
            "id": record_id,
            "name": (result.get(record_id) or {}).get("title"),
            "url": f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{record_id}/",
        }
        for record_id in ids
    ]


def papers(name: str, symbol: str) -> list[dict]:
    term = urllib.parse.quote(f"{symbol} {name}")
    found = get_json(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&sort=relevance&term={term}")
    ids = found.get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    result = get_json(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
        + urllib.parse.urlencode({"db": "pubmed", "retmode": "json", "id": ",".join(ids)})
    ).get("result", {})
    return [
        {"id": pmid, "name": (result.get(pmid) or {}).get("title"), "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"}
        for pmid in ids
    ]


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
    return [
        {
            "id": str(project.get("appl_id")),
            "name": project.get("project_title"),
            "url": f"https://reporter.nih.gov/project-details/{project.get('appl_id')}",
        }
        for project in payload.get("results", [])
    ]


def groups(orpha: str, name: str, symbol: str) -> dict:
    needles = tuple(item.lower() for item in (symbol, *name.split()) if len(item) > 3)
    url = f"https://www.orpha.net/en/patient-organisations?orphaCode={orpha}&diseaseName={urllib.parse.quote(name)}"
    request = urllib.request.Request(url, headers=BROWSER)
    html = urllib.request.urlopen(request, timeout=60).read().decode("utf-8", "replace")
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
    specific = re.search(r"(\d+)\s+specific result", text)
    found = []
    seen = set()
    pattern = r'href="(/en/patient-organisations/patient/(\d+)\?[^"]*)"[^>]*>\s*([^<]+?)\s*</a>'
    for match in re.finditer(pattern, html):
        record_id = match.group(2)
        label = re.sub(r"\s+", " ", match.group(3)).strip()
        if record_id in seen or not any(needle in label.lower() for needle in needles):
            continue
        seen.add(record_id)
        found.append({"id": record_id, "name": label, "url": "https://www.orpha.net" + match.group(1).split("?")[0]})
    return {
        "directory": url,
        "specific_result_count": int(specific.group(1)) if specific else None,
        "groups": found[:6],
    }


def one(row: dict) -> dict:
    gene_rows = variants(row["gene"])
    paper_rows = papers(row["name"], row["gene"])
    project_rows = projects(row["name"], row["gene"])
    group_rows = groups(row["orpha"], row["name"], row["gene"])
    gaps = []
    if not gene_rows:
        gaps.append("no pathogenic ClinVar variant")
    if not paper_rows:
        gaps.append("no PubMed hit")
    if not project_rows:
        gaps.append("no NIH RePORTER project")
    if not group_rows["groups"]:
        gaps.append("no name-matched Orphanet group")
    return {
        "id": row["id"],
        "name": row["name"],
        "source": f"https://monarchinitiative.org/{row['id']}",
        "orpha": {"code": row["orpha"], "url": f"https://www.orpha.net/en/disease/detail/{row['orpha']}"},
        "gene": {"id": row["gene_id"], "name": row["gene"], "source": f"https://monarchinitiative.org/{row['id']}"},
        "variants": gene_rows,
        "papers": paper_rows,
        "projects": project_rows,
        "patient_groups": group_rows,
        "related_to": row.get("related_to") or [],
        "gaps": gaps,
    }


def main() -> None:
    selected = json.loads(CANDIDATES.read_text())["kept"][:50]
    done = json.loads(OUT.read_text()).get("diseases", []) if OUT.exists() else []
    have = {row["id"] for row in done}
    for row in selected:
        if row["id"] in have:
            continue
        try:
            result = one(row)
        except Exception as error:
            result = {"id": row["id"], "name": row["name"], "gaps": [f"fetch failed: {type(error).__name__}"]}
            print("fail", row["id"], error, flush=True)
        done.append(result)
        OUT.write_text(json.dumps({"count": len(done), "diseases": done}, indent=2))
        print(f"{len(done):02d}", row["name"], "gaps", result.get("gaps"), flush=True)
    print("wrote", OUT, "diseases", len(done))


if __name__ == "__main__":
    main()

