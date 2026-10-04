"use client";

// A gene, symptom, pathway, group, paper or grant in the center: the node view of the center itself,
// with the diseases it belongs to and the diseases that share their biology.
import type { GraphNode } from "@/lib/graph/types";
import NodeView from "./NodeView";
import type { PanelProps } from "./types";

export default function CenterView(props: PanelProps & { focus: GraphNode }) {
  return <NodeView {...props} node={props.focus} hoodNode={undefined} />;
}
