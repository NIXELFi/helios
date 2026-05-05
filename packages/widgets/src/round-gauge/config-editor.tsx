import type { WidgetConfigEditorProps } from "../types";
import type { RoundGaugeConfig } from "./render";

const labels: Array<[keyof RoundGaugeConfig, string]> = [
  ["channelId", "Channel"], ["units", "Units"],
  ["min", "Min"], ["max", "Max"],
  ["warn", "Warn"], ["alarm", "Alarm"],
  ["decimals", "Decimals"],
];

export function RoundGaugeConfigEditor({ config, onChange }: WidgetConfigEditorProps<RoundGaugeConfig>) {
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {labels.map(([k, label]) => (
        <label key={k} className="flex justify-between gap-2">
          <span>{label}</span>
          <input
            className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : String(config[k])}
            onChange={(e) => {
              const raw = e.target.value;
              const v = k === "channelId" || k === "units" ? raw : raw === "" ? undefined : Number(raw);
              onChange({ ...config, [k]: v } as RoundGaugeConfig);
            }}
          />
        </label>
      ))}
    </div>
  );
}
