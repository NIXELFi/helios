import type { WidgetConfigEditorProps } from "../types";
import type { BarGaugeConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function BarGaugeConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<BarGaugeConfig>) {
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center">
        <span>channelId</span>
        <ChannelPicker
          className="w-40"
          value={config.channelId}
          onChange={(v) => onChange({ ...config, channelId: v })}
          channels={availableChannels}
        />
      </label>
      <label className="flex justify-between">
        <span>units</span>
        <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
          value={config.units} onChange={(e) => onChange({ ...config, units: e.target.value })} />
      </label>
      {(["min", "max", "warn", "alarm", "decimals"] as const).map((k) => (
        <label key={k} className="flex justify-between">
          <span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => onChange({ ...config, [k]: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
      ))}
      <label className="flex justify-between">
        <span>orientation</span>
        <select className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
          value={config.orientation}
          onChange={(e) => onChange({ ...config, orientation: e.target.value as BarGaugeConfig["orientation"] })}>
          <option value="vertical">vertical</option>
          <option value="horizontal">horizontal</option>
        </select>
      </label>
    </div>
  );
}
