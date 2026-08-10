import type { Widget } from "../types";
import { SectorTableConfigEditor } from "./config-editor";
import { SectorTableRender, type SectorTableConfig } from "./render";

export const sectorTableWidget: Widget<SectorTableConfig> = {
  type: "sector_table",
  label: "Sector Splits",
  summarize: (c) => (c.sectorCount > 0 ? `${c.sectorCount} sectors` : null),
  defaultConfig: { sectorCount: 3, maxRows: 8, hideUntrusted: true },
  ConfigEditor: SectorTableConfigEditor,
  Render: SectorTableRender,
  // Channel requirements are session-level (speed for distance integration),
  // not widget-level — requiresSpeed tells the host to include each session's
  // speed channel(s) in the slice; the renderer still validates and reports
  // missing-data at render time.
  requiredChannels: () => [],
  requiresSpeed: () => true,
};

export type { SectorTableConfig } from "./render";
export { buildSectorTable, formatLapTime } from "./compute";
