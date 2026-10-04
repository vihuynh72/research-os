"use client";

// Right column: the evidence. It explains whatever is selected, in this order of precedence: a
// line on the map, a related disease (the pair's grades and why), any other node; with nothing
// selected, what is in the center. Each view is built as a cited document (panel/viewModel.ts) and
// rendered by the components in panel/.
import { nodeOf } from "./format";
import CenterView from "./panel/CenterView";
import DiseaseView from "./panel/DiseaseView";
import EdgeView from "./panel/EdgeView";
import NodeView from "./panel/NodeView";
import PairView from "./panel/PairView";
import type { PanelProps } from "./panel/types";

export default function DetailPanel(props: PanelProps) {
  const { model, focusId, selection } = props;
  const focus = nodeOf(model, focusId);
  if (!focus) return null;
  // Keyed so folded sections and "Show all" lists start fresh for every new subject.
  if (selection?.kind === "edge") return <EdgeView key={selection.id} {...props} edge={selection.edge} />;
  if (selection?.kind === "pair") return <PairView key={selection.id} {...props} pair={selection.pair} other={selection.node} anchorId={selection.anchor} />;
  if (selection?.kind === "node") return <NodeView key={selection.id} {...props} node={selection.node} hoodNode={selection.hoodNode} />;
  if (focus.type === "Disease") return <DiseaseView key={focusId} {...props} />;
  return <CenterView key={focusId} {...props} focus={focus} />;
}
