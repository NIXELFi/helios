import type { WidgetConfigEditorProps } from "../types";
import { ChannelPicker } from "../lib/channel-picker";
import type { FftConfig } from "./render";

export function FftConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<FftConfig>) {
  function set<K extends keyof FftConfig>(k: K, v: FftConfig[K]) {
    onChange({ ...config, [k]: v });
  }
  return (
    <div className="p-2 text-xs text-[#D8DCE2] flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088] w-20">channel</span>
        <ChannelPicker channels={availableChannels} value={config.channelId} onChange={(v) => set("channelId", v)} />
      </label>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.windowed} onChange={(e) => set("windowed", e.target.checked)} className="accent-[#FFC627]" />
        Hanning window
      </label>
      <label className="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" checked={config.useZoomRange} onChange={(e) => set("useZoomRange", e.target.checked)} className="accent-[#FFC627]" />
        Restrict to current zoom range
      </label>
      <label className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088] w-20">y scale</span>
        <select value={config.scale} onChange={(e) => set("scale", e.target.value as FftConfig["scale"])}
                className="bg-[#0E0E10] border border-[#2A2C32] px-1 py-0.5">
          <option value="linear">Linear</option>
          <option value="db">dB (20·log10)</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088] w-20">freq scale</span>
        <select value={config.freqScale} onChange={(e) => set("freqScale", e.target.value as FftConfig["freqScale"])}
                className="bg-[#0E0E10] border border-[#2A2C32] px-1 py-0.5">
          <option value="linear">Linear</option>
          <option value="log">Log</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[#7B8088] w-20">f max</span>
        <input type="number" min={0} value={config.fmaxHz}
               onChange={(e) => set("fmaxHz", Math.max(0, Number(e.target.value)))}
               className="w-20 bg-[#0E0E10] border border-[#2A2C32] px-1 py-0.5" />
        <span className="text-[10px] text-[#7B8088]">Hz (0 = auto)</span>
      </label>
    </div>
  );
}
