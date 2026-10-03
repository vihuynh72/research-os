"""Find NCL / Batten groups on the public Orphanet directory. No API key.

The disease page is not the directory. The directory is the HTML list at
/en/patient-organisations?orphaCode=... and it says how many results are
specific versus merely including the disease. Only name matches are kept.
Hand-curated rows are the test, not the source.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
MANIFEST = ROOT / "data" / "manifest.json"
OUT = RAW / "orphanet_groups.json"
UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
}
NAME_NEEDLE = ("ncl", "jncl", "incl", "batten", "ceroid", "lipofusc")


def get(url: str) -> str:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", "replace")


def cards(html: str, path_bit: str) -> list[dict]:
    hits = []
    seen = set()
    pattern = rf'href="(/en/{path_bit}/(\d+)\?[^"]*)"[^>]*>\s*([^<]+?)\s*</a>'
    for match in re.finditer(pattern, html):
        href, record_id, label = match.group(1), match.group(2), match.group(3)
        name = re.sub(r"\s+", " ", label).strip()
        if record_id in seen or not any(needle in name.lower() for needle in NAME_NEEDLE):
            continue
        seen.add(record_id)
        card = html[max(0, match.start() - 1200):match.start()]
        country = re.search(r'class="fw-bold">([^<]+)</(?:div|span)>', card)
        hits.append(
            {
                "id": record_id,
                "name": name,
                "country": country.group(1).strip().title() if country else None,
                "orpha_url": "https://www.orpha.net" + href.split("?")[0],
            }
        )
    return hits


def main() -> None:
    manifest = json.loads(MANIFEST.read_text())
    found = []
    for disease in manifest["diseases"]:
        orpha = disease["orpha"]
        name = urllib.parse.quote(disease["name"])
        org_url = f"https://www.orpha.net/en/patient-organisations?orphaCode={orpha}&diseaseName={name}"
        reg_url = f"https://www.orpha.net/en/research-trials/registries?orphaCode={orpha}&diseaseName={name}"
        org_html = get(org_url)
        reg_html = get(reg_url)
        (RAW / f"orphanet_orgs_{orpha}.html").write_text(org_html)
        (RAW / f"orphanet_regs_{orpha}.html").write_text(reg_html)
        specific = re.search(r"(\d+)\s+specific result", re.sub(r"<[^>]+>", " ", org_html))
        row = {
            "mondo": disease["id"],
            "orpha": orpha,
            "directory": org_url,
            "specific_result_count": int(specific.group(1)) if specific else None,
            "groups": cards(org_html, "patient-organisations/patient"),
            "registries": cards(reg_html, "research-trials/registry"),
        }
        found.append(row)
        print(disease["id"], "groups", len(row["groups"]), "registries", len(row["registries"]))
    OUT.write_text(json.dumps(found, indent=2))


if __name__ == "__main__":
    main()
