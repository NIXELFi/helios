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
      <label className="flex justify-between" title="Split the distribution at this value (e.g. 0 for shock pot rebound vs compression). Empty = off.">
        <span>split at</span>
        <input
          type="number"
          step="any"
          placeholder="off"
          className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-32"
          value={config.splitAt ?? ""}
          onChange={(e) => set("splitAt", e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </label>
      <label
        className={`flex justify-between ${config.splitAt === undefined ? "opacity-40" : ""}`}
        title="Mirror the range around the split point so each side has equal width and bin count. Shorter side just shows empty space at its outer edge."
      >
        <span>symmetric</span>
        <input
          type="checkbox"
          className="w-32 accent-[#4FC3F7]"
          checked={config.splitSymmetric ?? false}
          disabled={config.splitAt === undefined}
          onChange={(e) => set("splitSymmetric", e.target.checked || undefined)}
        />
      </label>
    </div>
  );
}
