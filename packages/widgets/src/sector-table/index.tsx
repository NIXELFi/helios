import type { Widget } from "../types";
import { SectorTableConfigEditor } from "./config-editor";
import { SectorTableRender, type SectorTableConfig } from "./render";

export const sectorTableWidget: Widget<SectorTableConfig> = {
  type: "sector_table",
  defaultConfig: { sectorCount: 3, maxRows: 8, hideUntrusted: true },
  ConfigEditor: SectorTableConfigEditor,
  Render: SectorTableRender,
  // Channel requirements are session-level (speed for distance integration),
  // not widget-level — the renderer validates and reports missing-data at
  // render time rather than gating via the required-channels list.
  requiredChannels: () => [],
};

export type { SectorTableConfig } from "./render";
export { buildSectorTable, formatLapTime } from "./compute";
