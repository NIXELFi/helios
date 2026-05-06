import type { WidgetConfigEditorProps } from "../types";
import type { XyPlotConfig } from "./types";
import { ChannelPicker } from "../lib/channel-picker";

/* Minimal editor — exposes only the simple-mode fields for now. Filter,
 * group-by, and overlay list are added in a later task. The mode toggle
 * is in the schema (defaults to "simple") and the render-side gating
 * already works for both modes; UI for switching ships in Task 19. */
export function XyPlotConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<XyPlotConfig>) {
  const set = <K extends keyof XyPlotConfig>(k: K, v: XyPlotConfig[K]) =>
    onChange({ ...config, [k]: v });
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
    </div>
  );
}
