// The concrete next step for a family or patient group, built only from sourced items in the
// atlas: a researcher or grant already working across two related diseases, a registry or group on
// the shared mechanism, a recruiting study. When nothing supports a step, it says so and names the
// question that would change the answer. Pure and deterministic.
import type { AtlasGraph, GraphEdge, GraphNode } from "./types.ts";
import type { CollaborationDimension, PairGrade, RelevanceDoc, SharedItem } from "../grading/types.ts";
import { TIER_ORDER, pairKey } from "../grading/types.ts";
import { shortLabel } from "./labels.ts";
import { kindOf, type LinkKind } from "./neighborhood.ts";

export interface NextStep {
  kind: "contact" | "registry" | "group" | "study" | "gap";
  text: string; // the step, one plain sentence
  because: string; // why it is supported, one or two plain sentences
  caveat?: string; // what the evidence does not show, from the edge's own evidence text
  target?: { id: string; label: string; url: string; source: string };
  edgeIds: string[];
  evidence: LinkKind | null;
}

const OPEN_STUDY = new Set(["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"]);

// Which shared research items make the best first contact, best first.
const CONTACT_ORDER: CollaborationDimension[] = ["investigator", "grant", "trial", "paper", "patient_org", "asset"];

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function nextSteps(
  graph: AtlasGraph,
  relevance: RelevanceDoc | null,
  focusId: string,
  relatedId: string | null = null,
  limit = 3,
): NextStep[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  const focus = byId.get(focusId);
  if (!focus) return [];
  // Whole names (up to a long length): similar diseases ("... type 1A", "... type 1B") must not read the same.
  const name = (id: string) => shortLabel(byId.get(id) ?? { label: id }, 64);
  const target = (node: GraphNode) => ({ id: node.id, label: node.label, url: node.url, source: node.source });
  const evidenceOf = (ids: string[]) => kindOf(ids.map((id) => edgeById.get(id)?.kind ?? "inferred"));
  const caveatOf = (ids: string[]) =>
    ids
      .map((id) => edgeById.get(id))
      .filter((e): e is GraphEdge => !!e && e.kind !== "observed" && !!e.evidence)
      .map((e) => e.evidence!)[0];

  const steps: NextStep[] = [];
  const used = new Set<string>();
  const pairs = new Map<string, PairGrade>((relevance?.pairs ?? []).map((p) => [pairKey(p.a, p.b), p]));
  const neighbors = relevance?.diseases[focusId]?.neighbors ?? [];
  const candidates = neighbors
    .filter((n) => (relatedId ? n.id === relatedId : TIER_ORDER[n.tier] >= TIER_ORDER.moderate))
    .sort((x, y) => TIER_ORDER[y.tier] - TIER_ORDER[x.tier] || y.relevance - x.relevance || cmp(x.id, y.id));

  // 1. Someone already working across both diseases: the fastest route to a shared study.
  // Bridges carry only non-umbrella items: a group every disease shares says nothing about this pair.
  for (const nb of candidates) {
    const pair = pairs.get(pairKey(focusId, nb.id));
    const bridge = relevance?.bridges.find((b) => pairKey(b.a, b.b) === pairKey(focusId, nb.id));
    if (!pair || !bridge) continue;
    const bridgeEdges = new Set(bridge.edges);
    for (const dim of CONTACT_ORDER) {
      const item = pair.dimensions[dim].shared.find(
        (s: SharedItem) => !used.has(s.id) && s.edges.length > 0 && s.edges.every((e) => bridgeEdges.has(e)),
      );
      if (!item) continue;
      const node = byId.get(item.id);
      if (!node) continue;
      used.add(item.id);
      const both = `${name(focusId)} and ${name(nb.id)}`;
      const text =
        dim === "investigator"
          ? `Contact ${node.label}, who already works on both ${both}.`
          : dim === "grant"
            ? `Look at the grant "${shortLabel(node, 80)}": it already covers both ${both}. Its team is a natural first contact.`
            : dim === "trial"
              ? `Read the study "${shortLabel(node, 80)}": it already involves both ${both}.`
              : dim === "paper"
                ? `Read "${shortLabel(node, 80)}", which covers both ${both}.`
                : `Reach out to ${node.label}, which already serves both ${both}.`;
      steps.push({
        kind: "contact",
        text,
        because: `${name(nb.id)} shares biology with ${name(focusId)} (${nb.tier} link), and this ${dim === "investigator" ? "researcher" : "work"} already spans both.`,
        caveat: caveatOf(item.edges),
        target: target(node),
        edgeIds: item.edges,
        evidence: evidenceOf(item.edges),
      });
      break;
    }
    if (steps.length >= limit) return steps;
  }

  // 2. A registry, then a patient group, on a mechanism the focus shares with a related disease.
  const sharedMechanisms = new Map<string, string[]>(); // mechanism id -> related disease ids
  for (const nb of candidates) {
    for (const m of pairs.get(pairKey(focusId, nb.id))?.dimensions.mechanism.shared ?? []) {
      const list = sharedMechanisms.get(m.id) ?? [];
      list.push(nb.id);
      sharedMechanisms.set(m.id, list);
    }
  }
  const linkedTo = (mechanismId: string, type: GraphNode["type"]) =>
    graph.edges
      .filter((e) => e.kind !== "contradicted" && (e.subject === mechanismId || e.object === mechanismId))
      .map((e) => ({ edge: e, node: byId.get(e.subject === mechanismId ? e.object : e.subject) }))
      .filter((x): x is { edge: GraphEdge; node: GraphNode } => x.node?.type === type)
      .sort((x, y) => Number(hasWebsite(y.node)) - Number(hasWebsite(x.node)) || cmp(x.node.label, y.node.label));
  for (const kind of ["registry", "group"] as const) {
    for (const [mechanismId, relatedIds] of [...sharedMechanisms].sort((x, y) => cmp(x[0], y[0]))) {
      const hit = linkedTo(mechanismId, kind === "registry" ? "Asset" : "PatientOrg").find((x) => !used.has(x.node.id));
      if (!hit) continue;
      used.add(hit.node.id);
      const focusEdge = graph.edges.find(
        (e) => e.kind !== "contradicted" && ((e.subject === focusId && e.object === mechanismId) || (e.object === focusId && e.subject === mechanismId)),
      );
      const edgeIds = [hit.edge.id, ...(focusEdge ? [focusEdge.id] : [])].sort(cmp);
      const mechanism = byId.get(mechanismId)?.label ?? mechanismId;
      const others = relatedIds.map(name).join(", ");
      steps.push({
        kind,
        text:
          kind === "registry"
            ? `Ask ${hit.node.label} whether ${name(focusId)} families can join or reuse its design.`
            : `Connect with ${hit.node.label}${country(hit.node)}, which works on ${mechanism}.`,
        because: `${name(focusId)} shares the mechanism "${mechanism}" with ${others}, and this ${kind === "registry" ? "registry" : "group"} works on that mechanism.`,
        caveat: caveatOf([hit.edge.id]),
        target: target(hit.node),
        edgeIds,
        evidence: evidenceOf(edgeIds),
      });
      break;
    }
    if (steps.length >= limit) return steps;
  }

  // 3. An open study for the disease itself.
  const studies = graph.edges
    .filter((e) => e.kind !== "contradicted" && (e.subject === focusId || e.object === focusId))
    .map((e) => ({ edge: e, node: byId.get(e.subject === focusId ? e.object : e.subject) }))
    .filter((x): x is { edge: GraphEdge; node: GraphNode } => x.node?.type === "Trial" && OPEN_STUDY.has(String(x.node.attributes?.overall_status ?? "")))
    .sort((x, y) => cmp(x.node.id, y.node.id));
  if (studies.length && steps.length < limit) {
    const { edge, node } = studies[0];
    steps.push({
      kind: "study",
      text: `Check whether your family is eligible for "${shortLabel(node, 80)}" (${String(node.attributes?.overall_status).toLowerCase().replace(/_/g, " ")}).`,
      because: `It is linked to ${name(focusId)} and is open or about to open.`,
      caveat: caveatOf([edge.id]),
      target: target(node),
      edgeIds: [edge.id],
      evidence: evidenceOf([edge.id]),
    });
  }

  if (!steps.length) {
    steps.push({
      kind: "gap",
      text: `No supported next step for ${name(focusId)} in this atlas yet.`,
      because: `We looked for researchers, grants, studies, patient groups and registries linked to ${name(focusId)} or to a disease that shares its biology, and found none with a source. Next question: which verified group already runs a registry for ${name(focusId)}?`,
      edgeIds: [],
      evidence: null,
    });
  }
  return steps.slice(0, limit);
}

function hasWebsite(node: GraphNode): boolean {
  return typeof node.attributes?.website === "string" && node.attributes.website.length > 0;
}

function country(node: GraphNode): string {
  return typeof node.attributes?.country === "string" ? ` (${node.attributes.country})` : "";
}
