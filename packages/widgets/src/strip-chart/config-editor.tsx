import type { WidgetConfigEditorProps } from "../types";
import type { StripChartConfig } from "./render";

export function StripChartConfigEditor({ config, onChange }: WidgetConfigEditorProps<StripChartConfig>) {
  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      <div>Channels:
        {config.channels.map((c, i) => (
          <div key={i} className="flex gap-1 mt-1">
            <input
              className="bg-[#0E0E10] border border-[#2A2C32] px-1 flex-1"
              value={c.id}
              onChange={(e) => {
                const next = [...config.channels];
                next[i] = { ...c, id: e.target.value };
                onChange({ ...config, channels: next });
              }}
            />
            <input
              type="color"
              value={c.color}
              onChange={(e) => {
                const next = [...config.channels];
                next[i] = { ...c, color: e.target.value };
                onChange({ ...config, channels: next });
              }}
            />
          </div>
        ))}
        <button
          className="mt-1 text-[#FFC627]"
          onClick={() => onChange({ ...config, channels: [...config.channels, { id: "", color: "#FFB800" }] })}
        >+ add</button>
      </div>
      <label>Y min
        <input type="number" className="ml-2 w-20 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.yMin}
          onChange={(e) => onChange({ ...config, yMin: Number(e.target.value) })} />
      </label>
      <label>Y max
        <input type="number" className="ml-2 w-20 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.yMax}
          onChange={(e) => onChange({ ...config, yMax: Number(e.target.value) })} />
      </label>
    </div>
  );
}
