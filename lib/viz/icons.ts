// Stroke icons for node types on a 24x24 grid. One source for the SVG map (as <path d>) and the
// 3D canvas (as new Path2D(d)), so a type looks the same in both views. Draw with fill none,
// round caps and joins, stroke width about 1.8.
import type { NodeType } from "../graph/types.ts";

export const ICON_PATH: Record<NodeType, string> = {
  Disease: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v8M8 12h8",
  Gene: "M7 3c0 4.5 10 4.5 10 9s-10 4.5-10 9M17 3c0 4.5-10 4.5-10 9s10 4.5 10 9M8.5 6.5h7M8.5 17.5h7M10 12h4",
  Variant: "M12 3l7.5 9-7.5 9-7.5-9zM12 9.5v5",
  Mechanism: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15M12 9v3l2 2",
  Phenotype: "M3 12h4l2.2-5.5 4.3 11 2.3-5.5H21",
  PatientOrg: "M9 11a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM3.5 20c0-3.1 2.5-5.5 5.5-5.5s5.5 2.4 5.5 5.5M16.5 11.5a2.5 2.5 0 1 0 0-5M20.5 20c0-2.5-1.4-4.5-3.6-5.2",
  Paper: "M6.5 3h7.5l4 4v14h-11.5zM14 3v4h4M9.5 12h5M9.5 16h5",
  Trial: "M9.5 3h5M10.5 3v6l-5 8.8a2 2 0 0 0 1.7 3.2h9.6a2 2 0 0 0 1.7-3.2l-5-8.8V3M7.6 15h8.8",
  Grant: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM14.5 9.3c-.4-.9-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4.2 0 1.1-1.1 2-2.5 2-1.1 0-2.1-.6-2.5-1.5M12 6v1.8M12 16v2",
  Investigator: "M12 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM4.5 21c0-4.1 3.4-7.5 7.5-7.5s7.5 3.4 7.5 7.5",
  Asset: "M4.5 6c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3-3.4 3-7.5 3-7.5-1.3-7.5-3zM4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3",
};
