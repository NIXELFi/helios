import type { Workspace } from "./types";
import { overviewDefault } from "./overview-default";
import { engineFocus } from "./engine-focus";

export type { TileSpec, WidgetType, Workspace } from "./types";

export const WORKSPACES: Workspace[] = [
  { id: "overview", label: "Overview", tiles: overviewDefault },
  { id: "engine-focus", label: "Engine focus", tiles: engineFocus },
];
