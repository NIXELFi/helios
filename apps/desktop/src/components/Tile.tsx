import { stripChartWidget, numericReadoutWidget, type Widget } from "@helios/widgets";
import type { ChannelStore } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";
import type { TileSpec } from "../workspaces/overview-default";

const widgets: Record<string, Widget<unknown>> = {
  strip_chart: stripChartWidget as unknown as Widget<unknown>,
  numeric_readout: numericReadoutWidget as unknown as Widget<unknown>,
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
  const slice = store.slice(channels, { startUs: range.startUs, endUs: range.endUs });

  const RenderC = widget.Render;
  return (
    <div
      className="absolute border border-[#2A2C32]"
      style={{
        left: `${spec.x * 100}%`, top: `${spec.y * 100}%`,
        width: `${spec.w * 100}%`, height: `${spec.h * 100}%`,
      }}
    >
      <div className="bg-[#0E0E10] text-[#7B8088] text-[10px] uppercase tracking-wider px-2 py-1 border-b border-[#2A2C32]">
        {spec.id}
      </div>
      <div className="absolute inset-0 top-[20px]">
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
