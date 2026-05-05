import type { WidgetConfigEditorProps } from "../types";
import type { RoundGaugeConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

const numericFields: Array<[keyof RoundGaugeConfig, string]> = [
  ["min", "Min"], ["max", "Max"],
  ["warn", "Warn"], ["alarm", "Alarm"],
  ["decimals", "Decimals"],
];

export function RoundGaugeConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<RoundGaugeConfig>) {
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center gap-2">
        <span>Channel</span>
        <ChannelPicker className="w-40" value={config.channelId} onChange={(v) => onChange({ ...config, channelId: v })} channels={availableChannels} />
      </label>
      <label className="flex justify-between gap-2">
        <span>Units</span>
        <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
          value={config.units}
          onChange={(e) => onChange({ ...config, units: e.target.value })} />
      </label>
      {numericFields.map(([k, label]) => (
        <label key={k} className="flex justify-between gap-2">
          <span>{label}</span>
          <input
            type="number"
            className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : String(config[k])}
            onChange={(e) => {
              const raw = e.target.value;
              const v = raw === "" ? undefined : Number(raw);
              onChange({ ...config, [k]: v } as RoundGaugeConfig);
            }}
          />
        </label>
      ))}
    </div>
  );
}
