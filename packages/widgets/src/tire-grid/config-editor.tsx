import type { WidgetConfigEditorProps } from "../types";
import type { TireGridConfig } from "./render";

const CORNERS = ["lf", "rf", "lr", "rr"] as const;

export function TireGridConfigEditor({ config, onChange }: WidgetConfigEditorProps<TireGridConfig>) {
  const setTemp = (c: typeof CORNERS[number], v: string) =>
    onChange({ ...config, tempChannels: { ...config.tempChannels, [c]: v } });
  const setPressure = (c: typeof CORNERS[number], v: string) =>
    onChange({ ...config, pressureChannels: { ...config.pressureChannels, [c]: v } });
  return (
    <div className="flex flex-col gap-1 p-2 text-xs text-[#D8DCE2]">
      {CORNERS.map((c) => (
        <div key={c} className="grid grid-cols-3 gap-1">
          <span>{c.toUpperCase()}</span>
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1" placeholder="temp"
            value={config.tempChannels[c]} onChange={(e) => setTemp(c, e.target.value)} />
          <input className="bg-[#0E0E10] border border-[#2A2C32] px-1" placeholder="pressure"
            value={config.pressureChannels[c]} onChange={(e) => setPressure(c, e.target.value)} />
        </div>
      ))}
      {(["tempMin", "tempMax", "tempCool", "tempHot"] as const).map((k) => (
        <label key={k} className="flex justify-between"><span>{k}</span>
          <input type="number" className="bg-[#0E0E10] border border-[#2A2C32] px-1 w-20"
            value={config[k]} onChange={(e) => onChange({ ...config, [k]: Number(e.target.value) })} />
        </label>
      ))}
    </div>
  );
}
