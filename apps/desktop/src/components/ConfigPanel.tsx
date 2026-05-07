import {
  stripChartWidget, numericReadoutWidget, roundGaugeWidget, barGaugeWidget,
  engineBarWidget, gpsTrackWidget, lapPanelWidget, alarmPanelWidget,
  tireGridWidget, histogramWidget, xyPlotWidget, steeringWheelWidget,
  channelReportWidget, timeReportWidget, zoneStatsWidget, fftWidget,
  type Widget,
} from "@helios/widgets";
import type { ChannelMeta } from "@helios/store";
import type { TileSpec, WidgetType } from "../workspaces/types";

const editors: Record<WidgetType, Widget<unknown>> = {
  strip_chart:     stripChartWidget     as unknown as Widget<unknown>,
  numeric_readout: numericReadoutWidget as unknown as Widget<unknown>,
  round_gauge:     roundGaugeWidget     as unknown as Widget<unknown>,
  bar_gauge:       barGaugeWidget       as unknown as Widget<unknown>,
  engine_bar:      engineBarWidget      as unknown as Widget<unknown>,
  gps_track:       gpsTrackWidget       as unknown as Widget<unknown>,
  lap_panel:       lapPanelWidget       as unknown as Widget<unknown>,
  alarm_panel:     alarmPanelWidget     as unknown as Widget<unknown>,
  tire_grid:       tireGridWidget       as unknown as Widget<unknown>,
  histogram:       histogramWidget      as unknown as Widget<unknown>,
  xy_plot:         xyPlotWidget         as unknown as Widget<unknown>,
  steering_wheel:  steeringWheelWidget  as unknown as Widget<unknown>,
  channel_report:  channelReportWidget  as unknown as Widget<unknown>,
  time_report:     timeReportWidget     as unknown as Widget<unknown>,
  zone_stats:      zoneStatsWidget      as unknown as Widget<unknown>,
  fft:             fftWidget            as unknown as Widget<unknown>,
};

const WIDGET_LABELS: Record<WidgetType, string> = {
  strip_chart:     "Strip Chart",
  numeric_readout: "Numeric Readout",
  round_gauge:     "Round Gauge",
  bar_gauge:       "Bar Gauge",
  engine_bar:      "Engine Bar",
  gps_track:       "GPS Track",
  lap_panel:       "Lap Panel",
  alarm_panel:     "Alarm Panel",
  tire_grid:       "Tire Grid",
  histogram:       "Histogram",
  xy_plot:         "XY Plot",
  steering_wheel:  "Steering Wheel",
  channel_report:  "Channel Report",
  time_report:     "Time Report",
  zone_stats:      "Zone Stats",
  fft:             "FFT / Spectrum",
};

const WIDGET_TYPES = Object.keys(editors) as WidgetType[];

interface Props {
  tile: TileSpec;
  onChange: (next: TileSpec) => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  availableChannels: ChannelMeta[];
}

export function ConfigPanel({ tile, onChange, onClose, onDuplicate, onDelete, availableChannels }: Props) {
  const widget = editors[tile.widgetType];
  const Editor = widget.ConfigEditor;

  return (
    <aside className="w-72 flex-shrink-0 border-l border-[#2A2C32] bg-[#0E0E10] flex flex-col">
      <div className="h-8 flex items-center justify-between px-2 border-b border-[#2A2C32]">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088]">Configure</span>
        <div className="flex items-center gap-1">
          <button
            aria-label="Duplicate tile"
            onClick={onDuplicate}
            title="Duplicate this tile"
            className="px-1.5 h-5 text-[10px] uppercase tracking-wider text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >
            duplicate
          </button>
          <button
            aria-label="Delete tile"
            onClick={onDelete}
            title="Delete this tile"
            className="px-1.5 h-5 text-[10px] uppercase tracking-wider text-[#7B8088] hover:text-[#EF5350] hover:bg-[#16171B] rounded-sm"
          >
            delete
          </button>
          <button
            aria-label="Close config"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>
      <div className="px-2 py-1.5 border-b border-[#2A2C32] flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088] flex-shrink-0">type</span>
        <select
          value={tile.widgetType}
          onChange={(e) => {
            const nextType = e.target.value as WidgetType;
            if (nextType === tile.widgetType) return;
            const nextWidget = editors[nextType];
            if (!confirm(
              `Convert "${tile.id}" from ${WIDGET_LABELS[tile.widgetType]} to ${WIDGET_LABELS[nextType]}?\n\n`
              + `Position and size are kept; the widget's config will reset to its default channels and ranges.`
            )) return;
            onChange({
              ...tile,
              widgetType: nextType,
              config: nextWidget.defaultConfig as TileSpec["config"],
            });
          }}
          className="flex-1 bg-[#16171B] text-[#FFC627] border border-[#2A2C32] rounded-sm px-1 py-0.5 text-xs focus:outline-none focus:border-[#FFC627] cursor-pointer"
        >
          {WIDGET_TYPES.map((t) => (
            <option key={t} value={t}>{WIDGET_LABELS[t]}</option>
          ))}
        </select>
      </div>
      <div className="px-2 py-1 border-b border-[#2A2C32] text-[10px] uppercase tracking-wider text-[#7B8088]">
        id · <span className="text-[#D8DCE2] normal-case">{tile.id}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Editor
          config={tile.config}
          onChange={(nextConfig) => onChange({ ...tile, config: nextConfig as TileSpec["config"] })}
          availableChannels={availableChannels}
        />
      </div>
      <div className="px-2 py-2 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
        Changes save automatically.
      </div>
    </aside>
  );
}
