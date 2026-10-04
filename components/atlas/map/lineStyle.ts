// How a line on the map is drawn. Disease-to-disease lines carry the story, so their width says the
// tier of the link: the grade file's own cutoffs (relevance.meta.thresholds) decide which tier a
// line's strength reaches, never above the pair's own grade (a strong pair also needs two lines of
// evidence). Evidence lines stay thin and neutral; dashed means inferred. Pure.
import type { HoodEdge } from "../../../lib/graph/neighborhood.ts";
import type { Tier } from "../../../lib/grading/types.ts";

export interface Thresholds {
  strong: number;
  moderate: number;
  exploratory: number;
}

export type LineTier = "strong" | "moderate" | "exploratory" | "under";

const ORDER: LineTier[] = ["under", "exploratory", "moderate", "strong"];

export const LINE_WIDTH: Record<LineTier, number> = { strong: 4.5, moderate: 2.5, exploratory: 1.25, under: 0.75 };

export function lineTier(strength: number, cutoffs: Thresholds, graded?: Tier): LineTier {
  const reached: LineTier =
    strength >= cutoffs.strong - 1e-9 ? "strong" : strength >= cutoffs.moderate - 1e-9 ? "moderate" : strength >= cutoffs.exploratory - 1e-9 ? "exploratory" : "under";
  if (!graded) return reached;
  const grade: LineTier = graded === "none" ? "under" : graded;
  return ORDER[Math.min(ORDER.indexOf(reached), ORDER.indexOf(grade))];
}

export interface LineStyle {
  width: number;
  opacity: number;
  dash?: string;
  color: string;
  glow: boolean;
}

// `faint`: a line to a disease just under the filter.
export function lineStyle(e: HoodEdge, cutoffs: Thresholds, faint = false): LineStyle {
  const dash = e.kind === "observed" ? undefined : "5 4";
  if (e.role === "similarity") {
    const tier = faint ? "under" : lineTier(e.strength, cutoffs, e.tier);
    const opacity = faint ? 0.35 : tier === "strong" ? 0.95 : tier === "moderate" ? 0.85 : 0.7;
    return { width: LINE_WIDTH[tier], opacity, dash, color: "var(--accent)", glow: tier === "strong" };
  }
  if (e.role === "bridge") return { width: LINE_WIDTH.exploratory, opacity: 0.6, dash: "3 4", color: "var(--ink-2)", glow: false };
  return { width: 0.9, opacity: 0.45, dash, color: "var(--ink-3)", glow: false };
}
