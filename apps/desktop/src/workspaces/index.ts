import type { Workspace } from "./types";
import { overviewDefault } from "./overview-default";
import { engineFocus } from "./engine-focus";

export type { TileSpec, WidgetType, Workspace } from "./types";

export const WORKSPACES: Workspace[] = [
  { id: "overview",     label: "Overview",     color: "#FFC627", tiles: overviewDefault },
  { id: "engine-focus", label: "Engine focus", color: "#EF5350", tiles: engineFocus },
];
