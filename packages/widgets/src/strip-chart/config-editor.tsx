import type { WidgetConfigEditorProps } from "../types";
import type { StripChartConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

export function StripChartConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<StripChartConfig>) {
  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      <div>
        <div className="mb-1 text-[#7B8088] uppercase text-[10px] tracking-wider">Channels</div>
        {config.channels.map((c, i) => (
          <div key={i} className="flex flex-col gap-1 mt-1 mb-2 p-1 border border-[#2A2C32] rounded-sm">
            <div className="flex gap-1 items-center">
              <ChannelPicker
                className="flex-1"
                value={c.id}
                onChange={(v) => {
                  const next = [...config.channels];
                  next[i] = { ...c, id: v };
                  onChange({ ...config, channels: next });
                }}
                channels={availableChannels}
              />
              <input
                type="color"
                className="w-7 h-6 bg-[#0E0E10] border border-[#2A2C32]"
                value={c.color}
                onChange={(e) => {
                  const next = [...config.channels];
                  next[i] = { ...c, color: e.target.value };
                  onChange({ ...config, channels: next });
                }}
              />
              <button
                aria-label="Remove channel"
                className="px-1 text-[#7B8088] hover:text-[#EF5350]"
                onClick={() => onChange({ ...config, channels: config.channels.filter((_, j) => j !== i) })}
              >×</button>
            </div>
            <div className="flex gap-1 items-center text-[10px] text-[#7B8088]">
              <span>Y</span>
              <input
                type="number"
                placeholder={String(config.yMin)}
                className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1 text-[#D8DCE2]"
                value={c.yMin === undefined ? "" : c.yMin}
                onChange={(e) => {
                  const next = [...config.channels];
                  next[i] = { ...c, yMin: e.target.value === "" ? undefined : Number(e.target.value) };
                  onChange({ ...config, channels: next });
                }}
              />
              <span>…</span>
              <input
                type="number"
                placeholder={String(config.yMax)}
                className="w-16 bg-[#0E0E10] border border-[#2A2C32] px-1 text-[#D8DCE2]"
                value={c.yMax === undefined ? "" : c.yMax}
                onChange={(e) => {
                  const next = [...config.channels];
                  next[i] = { ...c, yMax: e.target.value === "" ? undefined : Number(e.target.value) };
                  onChange({ ...config, channels: next });
                }}
              />
              <span className="text-[#5A5F66]">(blank = chart default)</span>
            </div>
          </div>
        ))}
        <button
          className="mt-1 text-[#FFC627]"
          onClick={() => onChange({ ...config, channels: [...config.channels, { id: "", color: "#FFB800" }] })}
        >+ add channel</button>
      </div>
      <div className="border-t border-[#2A2C32] pt-2">
        <div className="mb-1 text-[#7B8088] uppercase text-[10px] tracking-wider">Chart default Y range</div>
        <div className="text-[10px] text-[#5A5F66] mb-1">Used for any channel that doesn't set its own range above.</div>
        <label className="flex items-center gap-2">
          <span className="w-10">Y min</span>
          <input type="number" className="w-20 bg-[#0E0E10] border border-[#2A2C32] px-1"
            value={config.yMin}
            onChange={(e) => onChange({ ...config, yMin: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2 mt-1">
          <span className="w-10">Y max</span>
          <input type="number" className="w-20 bg-[#0E0E10] border border-[#2A2C32] px-1"
            value={config.yMax}
            onChange={(e) => onChange({ ...config, yMax: Number(e.target.value) })} />
        </label>
      </div>
    </div>
  );
}
