// Which names the map prints. A calm map names few things: what was searched, the five most related
// diseases (or the diseases a gene, symptom or group belongs to), the searched disease's own genes,
// its rarest symptoms, its top pathways and patient groups, and the folded research counts, in an
// order that depends on who reads it, never more than LABEL_BUDGET. Symptoms, pathways and groups
// are named only when they are the searched disease's own, so a related disease's symptom never
// reads as one of its. Everything else is a dot whose name shows on hover or selection. Pure.
import { FOLDED_TYPES, type HoodNode } from "../../../lib/graph/neighborhood.ts";
import type { NodeType } from "../../../lib/graph/types.ts";
import { TOP_RELATED } from "../mapSizes.ts";

export const LABEL_BUDGET = 14;
const MAX_ANCHORS = 8;

type Reader = "parent" | "researcher";

const typeOf = (n: HoodNode): NodeType => (n.type === "Bubble" ? n.bubbleType! : n.type);
const byRelevance = (a: HoodNode, b: HoodNode) => b.relevance - a.relevance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Related diseases in the neighborhood's order (ownerRank): best first, equal scores in the grading
// layer's order, which is the order the panel lists them in.
const byRank = (a: HoodNode, b: HoodNode) => a.ownerRank - b.ownerRank || byRelevance(a, b);

// The related diseases that get the emphasis: the five most related among those shown.
export function topRelatedIds(nodes: readonly HoodNode[]): Set<string> {
  return new Set(
    nodes
      .filter((n) => n.role === "related")
      .sort(byRank)
      .slice(0, TOP_RELATED)
      .map((n) => n.id),
  );
}

// Node ids to name, most important first.
export function labelPlan(nodes: readonly HoodNode[], reader: Reader = "parent"): string[] {
  const focus = nodes.filter((n) => n.role === "focus");
  const anchors = nodes.filter((n) => n.role === "anchor").sort(byRelevance).slice(0, MAX_ANCHORS);
  const main = new Set([...focus, ...anchors].map((n) => n.id));
  const top = topRelatedIds(nodes);
  const pick = (test: (n: HoodNode) => boolean, limit = Infinity) => nodes.filter((n) => n.role !== "bubble" && test(n)).sort(byRelevance).slice(0, limit);
  const related = nodes.filter((n) => top.has(n.id)).sort(byRank);
  const own = (test: (n: HoodNode) => boolean, limit: number) => pick((n) => main.has(n.owner) && test(n), limit);
  const ownGenes = own((n) => n.type === "Gene", 2);
  const symptoms = own((n) => n.type === "Phenotype", 3);
  const pathways = own((n) => n.type === "Mechanism", 2);
  const groups = own((n) => n.type === "PatientOrg" || n.type === "Asset", 2);
  const bubbles = nodes.filter((n) => n.role === "bubble").sort((a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0) || byRelevance(a, b));
  const research = bubbles.filter((n) => FOLDED_TYPES.includes(typeOf(n)));
  const genes = pick((n) => n.type === "Gene");
  const order =
    reader === "researcher"
      ? [focus, anchors, related, ownGenes, pathways, symptoms, research, groups, genes, bubbles]
      : [focus, anchors, related, ownGenes, symptoms, groups, pathways, research, genes, bubbles];
  return [...new Set(order.flat().map((n) => n.id))].slice(0, LABEL_BUDGET);
}
