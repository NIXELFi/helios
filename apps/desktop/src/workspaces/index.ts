import type { Workspace } from "./types";
import { overviewDefault } from "./overview-default";
import { engineFocus } from "./engine-focus";
import { lapAnalysis } from "./lap-analysis";

export type { TileSpec, WidgetType, Workspace } from "./types";

export const WORKSPACES: Workspace[] = [
  { id: "overview",     label: "Overview",     color: "#FFC627", tiles: overviewDefault },
  { id: "lap-analysis", label: "Lap Analysis", color: "#4FC3F7", tiles: lapAnalysis },
  { id: "engine-focus", label: "Engine focus", color: "#EF5350", tiles: engineFocus },
];
