import type { WidgetConfigEditorProps } from "../types";
import type { SteeringWheelConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function SteeringWheelConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<SteeringWheelConfig>) {
  const set = <K extends keyof SteeringWheelConfig>(k: K, v: SteeringWheelConfig[K]) =>
    onChange({ ...config, [k]: v });
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center"><span>channelId</span>
        <ChannelPicker className="w-40" value={config.channelId} onChange={(v) => set("channelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>units</span>
        <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40"
          value={config.units} onChange={(e) => set("units", e.target.value)} />
      </label>
      <label className="flex justify-between items-center"><span>maxAngle</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-40"
          value={config.maxAngle} onChange={(e) => set("maxAngle", Number(e.target.value))} />
      </label>
      <label className="flex justify-between items-center"><span>invert</span>
        <input type="checkbox" checked={config.invert}
          onChange={(e) => set("invert", e.target.checked)} />
      </label>
    </div>
  );
}
