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
            <div className="flex gap-1 items-center min-w-0">
              {/* min-w-0 + flex-1 lets long channel names shrink the picker
                  rather than push the trailing color/×-button off the right
                  edge of the ConfigPanel. */}
              <div className="flex-1 min-w-0">
                <ChannelPicker
                  className="w-full"
                  value={c.id}
                  onChange={(v) => {
                    const next = [...config.channels];
                    next[i] = { ...c, id: v };
                    onChange({ ...config, channels: next });
                  }}
                  channels={availableChannels}
                />
              </div>
              {/* Visible color swatch with the native color input layered on
                  top (transparent). Native <input type="color"> renders as a
                  small OS-styled button on WebKit and at 28×24 the actual
                  color was nearly invisible — looked black. The swatch div
                  shows the bound color directly. */}
              <label
                className="relative w-6 h-6 shrink-0 rounded-sm border border-[#2A2C32] cursor-pointer overflow-hidden"
                style={{ background: c.color }}
                title={`Color: ${c.color}`}
              >
                <input
                  type="color"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  value={c.color}
                  onChange={(e) => {
                    const next = [...config.channels];
                    next[i] = { ...c, color: e.target.value };
                    onChange({ ...config, channels: next });
                  }}
                />
              </label>
              <button
                aria-label="Remove channel"
                className="shrink-0 w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#EF5350] hover:bg-[#16171B] rounded-sm leading-none text-base"
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
