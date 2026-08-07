import type { WidgetConfigEditorProps } from "../types";
import type { BarGaugeConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

// Labels are spelled out for the low-side bounds because "warnLow" alone
// reads as "a low warning" rather than "warn when the value drops below this".
const numericFields: Array<[keyof BarGaugeConfig, string]> = [
  ["min", "min"], ["max", "max"],
  ["warn", "warn above"], ["alarm", "alarm above"],
  ["warnLow", "warn below"], ["alarmLow", "alarm below"],
  ["decimals", "decimals"],
];

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
      {numericFields.map(([k, label]) => (
        <label key={k} className="flex justify-between">
          <span>{label}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : String(config[k])}
            onChange={(e) => onChange({ ...config, [k]: e.target.value === "" ? undefined : Number(e.target.value) } as BarGaugeConfig)} />
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
