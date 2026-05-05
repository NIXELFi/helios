import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig } from "./render";

export function XyPlotConfigEditor({ config, onChange }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = (k: keyof XyPlotConfig, v: unknown) => onChange({ ...config, [k]: v } as XyPlotConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {(["xChannelId", "yChannelId"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config[k]} onChange={(e) => set(k, e.target.value)} />
        </label>
      ))}
      {(["xMin", "xMax", "yMin", "yMax"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
            value={config[k] === undefined ? "" : config[k]}
            onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
        </label>
      ))}
      <label className="flex justify-between"><span>color</span>
        <input type="color" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.color} onChange={(e) => set("color", e.target.value)} /></label>
      <label className="flex justify-between"><span>trail</span>
        <input type="checkbox" checked={config.trail} onChange={(e) => set("trail", e.target.checked)} /></label>
    </div>
  );
}
