import {
  stripChartWidget, numericReadoutWidget, roundGaugeWidget, barGaugeWidget,
  engineBarWidget, gpsTrackWidget, lapPanelWidget, alarmPanelWidget,
  tireGridWidget, histogramWidget, xyPlotWidget,
  type Widget,
} from "@helios/widgets";
import type { ChannelStore } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";
import type { TileSpec } from "../workspaces/overview-default";

const widgets: Record<string, Widget<unknown>> = {
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
};

interface Props {
  spec: TileSpec;
  store: ChannelStore;
  cursorEmitter: CursorEmitter;
}

export function Tile({ spec, store, cursorEmitter }: Props) {
  const widget = widgets[spec.widgetType]!;
  const channels = widget.requiredChannels(spec.config);
  const range = store.extentUs();

  // Filter out channels that don't exist in the store, so unknown channels
  // (e.g. tire temps that the synthetic CSV doesn't carry) don't throw and
  // the widget can render its empty state.
  const known = channels.filter((id) => store.get(id) !== undefined);
  const slice = store.slice(known, { startUs: range.startUs, endUs: range.endUs });

  const RenderC = widget.Render;
  return (
    <div
      className="absolute"
      style={{
        left: `${spec.x * 100}%`, top: `${spec.y * 100}%`,
        width: `${spec.w * 100}%`, height: `${spec.h * 100}%`,
      }}
    >
      <div className="bg-[#0E0E10] text-[#7B8088] text-[10px] uppercase tracking-wider px-2 py-1 border-b border-[#2A2C32]">
        {spec.id}
      </div>
      <div className="absolute inset-0 top-[20px] border border-[#2A2C32] border-t-0">
        <RenderC
          config={spec.config}
          slice={slice}
          cursorEmitter={cursorEmitter}
          timeRange={{ startUs: range.startUs, endUs: range.endUs }}
        />
      </div>
    </div>
  );
}
