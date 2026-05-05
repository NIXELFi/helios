import type { WidgetConfigEditorProps } from "../types";
import type { HistogramConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function HistogramConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<HistogramConfig>) {
  const set = (k: keyof HistogramConfig, v: unknown) => onChange({ ...config, [k]: v } as HistogramConfig);
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <label className="flex justify-between items-center"><span>channelId</span>
        <ChannelPicker className="w-40" value={config.channelId} onChange={(v) => set("channelId", v)} channels={availableChannels} /></label>
      <label className="flex justify-between"><span>bins</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.bins} onChange={(e) => set("bins", Number(e.target.value))} /></label>
      <label className="flex justify-between"><span>min</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.min ?? ""} onChange={(e) => set("min", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
      <label className="flex justify-between"><span>max</span>
        <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.max ?? ""} onChange={(e) => set("max", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
      <label className="flex justify-between"><span>color</span>
        <input type="color" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32" value={config.color} onChange={(e) => set("color", e.target.value)} /></label>
    </div>
  );
}
