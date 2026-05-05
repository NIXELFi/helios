import type { WidgetConfigEditorProps } from "../types";
import type { TireGridConfig } from "./render";
import { ChannelPicker } from "../lib/channel-picker";

const CORNERS = ["lf", "rf", "lr", "rr"] as const;

export function TireGridConfigEditor({ config, onChange, availableChannels }: WidgetConfigEditorProps<TireGridConfig>) {
  const setTemp = (c: typeof CORNERS[number], v: string) =>
    onChange({ ...config, tempChannels: { ...config.tempChannels, [c]: v } });
  const setPressure = (c: typeof CORNERS[number], v: string) =>
    onChange({ ...config, pressureChannels: { ...config.pressureChannels, [c]: v } });
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      <div className="grid grid-cols-[auto_1fr_1fr] gap-1 items-center">
        <span className="text-[10px] uppercase text-[#7B8088]"></span>
        <span className="text-[10px] uppercase text-[#7B8088]">temp</span>
        <span className="text-[10px] uppercase text-[#7B8088]">pressure</span>
        {CORNERS.map((c) => (
          <div key={c} className="contents">
            <span className="font-mono-num">{c.toUpperCase()}</span>
            <ChannelPicker value={config.tempChannels[c]} onChange={(v) => setTemp(c, v)} channels={availableChannels} />
            <ChannelPicker value={config.pressureChannels[c]} onChange={(v) => setPressure(c, v)} channels={availableChannels} />
          </div>
        ))}
      </div>
      {(["tempMin", "tempMax", "tempCool", "tempHot"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-20"
            value={config[k]} onChange={(e) => onChange({ ...config, [k]: Number(e.target.value) })} />
        </label>
      ))}
    </div>
  );
}
