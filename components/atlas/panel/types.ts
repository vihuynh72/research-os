// The panel's props, the same for every view: DetailPanel routes them unchanged.
import type { Neighborhood, ThresholdResult } from "../../../lib/graph/neighborhood.ts";
import type { AtlasModel, Mode, Selection } from "../format.ts";

export interface PanelProps {
  model: AtlasModel;
  hood: Neighborhood;
  filtered: ThresholdResult;
  focusId: string;
  selection: Selection | null;
  threshold: number;
  mode: Mode;
  onSelect(id: string | null): void;
  onFocus(id: string): void;
  onThreshold(value: number): void;
}
