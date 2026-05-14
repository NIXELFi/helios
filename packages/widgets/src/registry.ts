import type { Widget } from "./types";
import { stripChartWidget } from "./strip-chart";
import { numericReadoutWidget } from "./numeric-readout";
import { roundGaugeWidget } from "./round-gauge";
import { barGaugeWidget } from "./bar-gauge";
import { engineBarWidget } from "./engine-bar";
import { gpsTrackWidget } from "./gps-track";
import { lapPanelWidget } from "./lap-panel";
import { alarmPanelWidget } from "./alarm-panel";
import { tireGridWidget } from "./tire-grid";
import { histogramWidget } from "./histogram";
import { xyPlotWidget } from "./xy-plot";
import { steeringWheelWidget } from "./steering-wheel";
import { channelReportWidget } from "./channel-report";
import { timeReportWidget } from "./time-report";
import { zoneStatsWidget } from "./zone-stats";
import { fftWidget } from "./fft";
import { lapDeltaWidget } from "./lap-delta";
import { sectorTableWidget } from "./sector-table";

class Registry {
  #widgets = new Map<string, Widget<unknown>>();

  register<C>(w: Widget<C>): void {
    if (this.#widgets.has(w.type)) {
      throw new Error(`widget type ${w.type} already registered`);
    }
    this.#widgets.set(w.type, w as unknown as Widget<unknown>);
  }

  get<C = unknown>(type: string): Widget<C> {
    const w = this.#widgets.get(type);
    if (!w) throw new Error(`unknown widget type ${type}`);
    return w as Widget<C>;
  }

  has(type: string): boolean { return this.#widgets.has(type); }
  list(): string[] { return Array.from(this.#widgets.keys()); }
}

export const widgetRegistry = new Registry();

/** Built-in widgets that ship with the desktop app. Registered eagerly on
 *  module load so consumers (Tile, ConfigPanel, workspace loaders) can do a
 *  single `widgetRegistry.get(type)` instead of maintaining a parallel map
 *  with ~32 `as unknown as Widget<unknown>` casts. */
const BUILTIN_WIDGETS: ReadonlyArray<Widget<unknown>> = [
  stripChartWidget     as unknown as Widget<unknown>,
  numericReadoutWidget as unknown as Widget<unknown>,
  roundGaugeWidget     as unknown as Widget<unknown>,
  barGaugeWidget       as unknown as Widget<unknown>,
  engineBarWidget      as unknown as Widget<unknown>,
  gpsTrackWidget       as unknown as Widget<unknown>,
  lapPanelWidget       as unknown as Widget<unknown>,
  alarmPanelWidget     as unknown as Widget<unknown>,
  tireGridWidget       as unknown as Widget<unknown>,
  histogramWidget      as unknown as Widget<unknown>,
  xyPlotWidget         as unknown as Widget<unknown>,
  steeringWheelWidget  as unknown as Widget<unknown>,
  channelReportWidget  as unknown as Widget<unknown>,
  timeReportWidget     as unknown as Widget<unknown>,
  zoneStatsWidget      as unknown as Widget<unknown>,
  fftWidget            as unknown as Widget<unknown>,
  lapDeltaWidget       as unknown as Widget<unknown>,
  sectorTableWidget    as unknown as Widget<unknown>,
];

for (const w of BUILTIN_WIDGETS) {
  if (!widgetRegistry.has(w.type)) widgetRegistry.register(w);
}

/** Stable, ordered list of every built-in widget type. Mirrors the
 *  registration order above so UI dropdowns (e.g. the type picker in the
 *  ConfigPanel) get a deterministic ordering. */
export const BUILTIN_WIDGET_TYPES: ReadonlyArray<string> =
  BUILTIN_WIDGETS.map((w) => w.type);
