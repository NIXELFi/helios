import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function XyPlotConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = (k: keyof XyPlotConfig, v: unknown) => onChange({ ...config, [k]: v } as XyPlotConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center"><span>xChannelId</span>
        <ChannelPicker className="w-40" value={config.xChannelId} onChange={(v) => set("xChannelId", v)} channels={availableChannels} />
      </label>
      <label className="flex justify-between items-center"><span>yChannelId</span>
        <ChannelPicker className="w-40" value={config.yChannelId} onChange={(v) => set("yChannelId", v)} channels={availableChannels} />
      </label>
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
