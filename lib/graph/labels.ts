import type { GraphNode } from "./types.ts";

const SHORT_NAME = /^[A-Z][A-Za-z0-9-]{1,9}$/;

// A short display name for tight spaces (map labels). Prefers a compact synonym such as
// "CLN3"; otherwise truncates the label. The full label stays in panels and tooltips.
export function shortLabel(node: Pick<GraphNode, "label" | "synonyms">, max = 22): string {
  const compact = (node.synonyms ?? [])
    .filter((s) => SHORT_NAME.test(s) && /\d/.test(s))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (compact.length) return compact[0];
  return node.label.length <= max ? node.label : `${node.label.slice(0, max - 1).trimEnd()}…`;
}

// Sentence-case a label for running text without touching acronyms ("CLN3", "PPT1").
export function sentenceLabel(label: string): string {
  return label.length ? label[0].toUpperCase() + label.slice(1) : label;
}
