"""Group diseases that score close together.

A link is a disease pair in the strong or moderate tier. Louvain finds the
groups. Each group is named after its rarest shared symptom, because this
graph has no mechanism edges to name it from. The eight largest groups get
color slots. Diseases that share a grant, a researcher, or a study would be
bridges; this graph has none of those edges, so the bridge list stays empty.
"""

from __future__ import annotations


def louvain(nodes: list[str], links: list[dict]) -> list[list[str]]:
    if not nodes:
        return []
    index = {node: i for i, node in enumerate(nodes)}
    weight = [[0.0] * len(nodes) for _ in nodes]
    strength = [0.0] * len(nodes)
    total = 0.0
    for link in links:
        i, j = index[link["a"]], index[link["b"]]
        if i == j:
            continue
        weight[i][j] += link["weight"]
        weight[j][i] += link["weight"]
        strength[i] += link["weight"]
        strength[j] += link["weight"]
        total += link["weight"]
    if total == 0:
        return []
    community = list(range(len(nodes)))

    def move() -> bool:
        changed = False
        for i in range(len(nodes)):
            current = community[i]
            best, best_gain = current, 0.0
            seen = set()
            for j in range(len(nodes)):
                if weight[i][j] == 0 or community[j] in seen:
                    continue
                seen.add(community[j])
                gain = sum(weight[i][k] for k in range(len(nodes)) if community[k] == community[j])
                if community[j] == current:
                    gain -= weight[i][i]
                inside = sum(strength[k] for k in range(len(nodes)) if community[k] == community[j])
                gain -= strength[i] * (inside - (strength[i] if community[j] == current else 0)) / (2 * total)
                if gain > best_gain + 1e-12 or (abs(gain - best_gain) <= 1e-12 and community[j] < best):
                    best, best_gain = community[j], gain
            if best != current:
                community[i] = best
                changed = True
        return changed

    while move():
        pass
    groups: dict[int, list[str]] = {}
    for i, node in enumerate(nodes):
        groups.setdefault(community[i], []).append(node)
    return [sorted(group) for group in groups.values() if len(group) > 1]


def build(graph: dict, pairs: list[dict]) -> tuple[list[dict], dict[str, str | None], dict[str, float]]:
    labels = {node["id"]: node.get("label") or node["id"] for node in graph["nodes"]}
    linked = [pair for pair in pairs if pair["tier"] in ("strong", "moderate")]
    nodes = sorted({pair[side] for pair in linked for side in ("a", "b")})
    groups = louvain(nodes, [{"a": pair["a"], "b": pair["b"], "weight": pair["relevance"]} for pair in linked])
    groups.sort(key=lambda group: (-len(group), group[0]))

    used: set[str] = set()
    clusters = []
    for position, members in enumerate(groups, start=1):
        inside = set(members)
        rarest = None
        for pair in pairs:
            if pair["a"] not in inside or pair["b"] not in inside:
                continue
            for item in pair["dimensions"]["phenotype"]["shared"]:
                if item["id"] in used:
                    continue
                if rarest is None or item["weight"] > rarest["weight"]:
                    rarest = item
        if rarest:
            used.add(rarest["id"])
            label = f"Shared symptoms: {rarest['label']}"
        else:
            label = f"Group {position}"
        clusters.append({
            "id": f"c-group-{position}",
            "label": label,
            "size": len(members),
            "members": members,
            "mechanisms": [],
            "color_slot": position if position <= 8 else None,
        })

    cluster_of = {disease: None for disease in (node["id"] for node in graph["nodes"] if node["type"] == "Disease")}
    for cluster in clusters:
        for member in cluster["members"]:
            cluster_of[member] = cluster["id"]
    strength: dict[str, float] = {}
    for pair in linked:
        strength[pair["a"]] = strength.get(pair["a"], 0) + pair["relevance"]
        strength[pair["b"]] = strength.get(pair["b"], 0) + pair["relevance"]
    strongest = max(strength.values(), default=0)
    centrality = {disease: round(value / strongest, 4) if strongest else 0 for disease, value in strength.items()}
    return clusters, cluster_of, centrality
