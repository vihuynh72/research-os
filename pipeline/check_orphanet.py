"""The hand-curated Orphanet file is the expected output of the scrape.

Names, ids, and countries must match. Anything the scrape finds that was not
hand-checked, or anything hand-checked that the scrape missed, fails the run.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURATED = ROOT / "data" / "curated" / "orphanet_groups.json"
SCRAPED = ROOT / "data" / "raw" / "orphanet_groups.json"


def by_id(rows: list[dict]) -> dict[str, dict]:
    return {row["id"].split(":")[-1]: row for row in rows}


def compare(kind: str, expected: dict[str, dict], got: dict[str, dict]) -> list[str]:
    failures = []
    for record_id, row in expected.items():
        found = got.get(record_id)
        if not found:
            failures.append(f"missing {kind} {record_id} {row['name']}")
            continue
        if found["name"] != row["name"]:
            failures.append(f"name mismatch {record_id}: {found['name']!r} != {row['name']!r}")
        if found.get("country") != row.get("country"):
            failures.append(
                f"country mismatch {record_id}: {found.get('country')!r} != {row.get('country')!r}"
            )
        if found["orpha_url"] != row["orpha_url"]:
            failures.append(f"url mismatch {record_id}")
    for record_id in sorted(set(got) - set(expected)):
        failures.append(f"unexpected {kind} {record_id} {got[record_id]['name']}")
    return failures


def main() -> None:
    curated = json.loads(CURATED.read_text())
    scraped = json.loads(SCRAPED.read_text())
    got_groups: dict[str, dict] = {}
    got_regs: dict[str, dict] = {}
    for page in scraped:
        got_groups.update(by_id(page["groups"]))
        got_regs.update(by_id(page["registries"]))
    failures = compare("group", by_id(curated["groups"]), got_groups)
    failures += compare("registry", by_id(curated["registries"]), got_regs)
    print("groups", len(got_groups), "expected", len(curated["groups"]))
    print("registries", len(got_regs), "expected", len(curated["registries"]))
    if failures:
        print("FAIL")
        for item in failures:
            print(" ", item)
        raise SystemExit(1)
    print("scrape matches hand-curated Orphanet rows")


if __name__ == "__main__":
    main()
