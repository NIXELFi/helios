import type { WidgetConfigEditorProps } from "../types";
import type { BarGaugeConfig } from "./render";

export function BarGaugeConfigEditor({ config, onChange }: WidgetConfigEditorProps<BarGaugeConfig>) {
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {(["channelId", "units"] as const).map((k) => (
        <label key={k} className="flex justify-between">
          <span>{k}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k]} onChange={(e) => onChange({ ...config, [k]: e.target.value })} />
        </label>
      ))}
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
