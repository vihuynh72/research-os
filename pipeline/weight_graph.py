"""Add source-backed weights to data/seed/rare_graph.json.

Symptom edges get HPO information content. Shared-gene edges get the
specificity of that gene inside this atlas. Disease pairs that share a
symptom set get a SimGIC score and its percentile against the HPO null
model. Other relations stay unweighted: the sources do not measure them.

Usage: python3 pipeline/weight_graph.py
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRAPH = ROOT / "data" / "seed" / "rare_graph.json"
HPO = ROOT / "data" / "reference" / "hpo-reference.json"
UNINFORMATIVE = {"HP:0000001", "HP:0000118"}


def round4(value: float) -> float:
    return round(value + 0, 4)


def percentile(value: float, quantiles: list[dict]) -> float:
    if value <= quantiles[0]["value"]:
        return quantiles[0]["p"]
    for left, right in zip(quantiles, quantiles[1:]):
        if value <= right["value"]:
            span = right["value"] - left["value"]
            if span <= 0:
                return right["p"]
            fraction = (value - left["value"]) / span
            return round4(left["p"] + fraction * (right["p"] - left["p"]))
    return quantiles[-1]["p"]


def close(terms: set[str], ancestors: dict[str, list[str]]) -> set[str]:
    closed = set()
    for term in terms:
        if term not in UNINFORMATIVE:
            closed.add(term)
        for ancestor in ancestors.get(term, []):
            if ancestor not in UNINFORMATIVE:
                closed.add(ancestor)
    return closed


def simgic(left: set[str], right: set[str], ic: dict[str, float]) -> float:
    shared = union = 0.0
    for term in left:
        weight = ic.get(term, 0)
        union += weight
        if term in right:
            shared += weight
    for term in right:
        if term not in left:
            union += ic.get(term, 0)
    return shared / union if union else 0


def main() -> None:
    graph = json.loads(GRAPH.read_text())
    reference = json.loads(HPO.read_text())
    terms = reference["terms"]
    ic = {term_id: float(term.get("ic") or 0) for term_id, term in terms.items()}
    ancestors = {term_id: term.get("ancestors") or [] for term_id, term in terms.items()}
    diseases = [node["id"] for node in graph["nodes"] if node["type"] == "disease"]
    n_diseases = len(diseases)

    phenotypes: dict[str, set[str]] = defaultdict(set)
    gene_of: dict[str, str] = {}
    for edge in graph["edges"]:
        if edge["relation"] == "has_phenotype":
            phenotypes[edge["source"]].add(edge["target"])
        elif edge["relation"] == "causes":
            gene_of[edge["target"]] = edge["source"]

    gene_count: dict[str, int] = defaultdict(int)
    for disease in diseases:
        if disease in gene_of:
            gene_count[gene_of[disease]] += 1

    phenotype_weights = 0
    gene_weights = 0
    for edge in graph["edges"]:
        edge.pop("weight", None)
        edge.pop("weight_method", None)
        if edge["relation"] == "has_phenotype" and edge["target"] in ic:
            edge["weight"] = round4(ic[edge["target"]])
            edge["weight_method"] = "hpo_ic"
            phenotype_weights += 1
        elif edge["relation"] == "same_gene":
            gene = gene_of.get(edge["source"])
            count = gene_count.get(gene or "", 0)
            if gene and count >= 2 and n_diseases > 1:
                edge["weight"] = round4(1 - math.log(count) / math.log(n_diseases))
                edge["weight_method"] = "gene_specificity"
                gene_weights += 1

    closed = {disease: close(phenotypes[disease], ancestors) for disease in diseases}
    pairs = []
    for index, left in enumerate(diseases):
        if not closed[left]:
            continue
        for right in diseases[index + 1 :]:
            if not closed[right] or not (closed[left] & closed[right]):
                continue
            score = simgic(closed[left], closed[right], ic)
            pairs.append({
                "a": left,
                "b": right,
                "simgic": round4(score),
                "percentile": percentile(score, reference["meta"]["null"]["quantiles"]),
                "method": "simgic_hpo_null",
            })
    pairs.sort(key=lambda row: (-row["percentile"], row["a"], row["b"]))
    graph["weights"] = {
        "method": "HPO information content for symptom edges; gene specificity for same_gene; SimGIC percentile for disease pairs.",
        "hpo_version": reference["meta"]["hpo_version"],
        "annotations_version": reference["meta"]["annotations_version"],
        "n_diseases_in_ic": reference["meta"]["n_diseases"],
        "phenotype_edges_weighted": phenotype_weights,
        "same_gene_edges_weighted": gene_weights,
        "pairs": pairs,
    }
    GRAPH.write_text(json.dumps(graph, indent=2) + "\n")
    print(
        "weighted",
        phenotype_weights,
        "phenotype edges,",
        gene_weights,
        "same_gene edges,",
        len(pairs),
        "disease pairs",
    )


if __name__ == "__main__":
    main()
