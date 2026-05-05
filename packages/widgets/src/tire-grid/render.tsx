import { useEffect, useState } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";

type Corner = "lf" | "rf" | "lr" | "rr";
const CORNERS: Corner[] = ["lf", "rf", "lr", "rr"];

export interface TireGridConfig {
  tempChannels:     Record<Corner, string>;
  pressureChannels: Record<Corner, string>;
  wearChannels?:    Record<Corner, string>;
  tempMin: number;
  tempMax: number;
  tempCool: number;
  tempHot: number;
}

export function TireGridRender(props: WidgetRenderProps<TireGridConfig>) {
  const { config, slice, cursorEmitter } = props;
  const [tick, setTick] = useState(0);
  useEffect(() => cursorEmitter.subscribe(() => setTick((x) => x + 1)), [cursorEmitter]);
  const t = cursorEmitter.get();
  const data = (() => {
    const out: Record<Corner, { temp: number | null; pressure: number | null; wear: number | null }> = {} as never;
    for (const c of CORNERS) {
      out[c] = {
        temp: sampleAt(slice, config.tempChannels[c], t),
        pressure: sampleAt(slice, config.pressureChannels[c], t),
        wear: config.wearChannels ? sampleAt(slice, config.wearChannels[c], t) : null,
      };
    }
    return out;
  })();
  void tick;

  function tempColor(temp: number | null): string {
    if (temp === null) return "#23252B";
    if (temp < config.tempCool) return "#4FC3F7";
    if (temp > config.tempHot) return "#EF5350";
    const t = (temp - config.tempCool) / Math.max(1e-9, config.tempHot - config.tempCool);
    return t < 0.5 ? "#26A69A" : "#FFB800";
  }

  function corner(c: Corner) {
    const d = data[c];
    return (
      <div className="flex flex-col bg-[#0E0E10] border border-[#2A2C32] m-1 p-2 flex-1">
        <div className="text-[10px] uppercase text-[#7B8088]">{c.toUpperCase()}</div>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full h-2 rounded-sm" style={{ background: tempColor(d.temp) }} />
        </div>
        <div className="font-mono-num text-lg text-[#D8DCE2] text-center">
          {d.temp === null ? "—" : `${d.temp.toFixed(0)}°`}
        </div>
        <div className="font-mono-num text-xs text-[#7B8088] text-center">
          {d.pressure === null ? "—" : `${d.pressure.toFixed(1)} psi`}
        </div>
        {config.wearChannels && (
          <div className="mt-1 h-1 bg-[#2A2C32] relative">
            <div className="absolute inset-y-0 left-0 bg-[#FFB800]"
                 style={{ width: `${Math.max(0, Math.min(100, ((d.wear ?? 0) * 100)))}%` }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-[#16171B] grid grid-cols-2 grid-rows-2">
      {corner("lf")}{corner("rf")}{corner("lr")}{corner("rr")}
    </div>
  );
}
