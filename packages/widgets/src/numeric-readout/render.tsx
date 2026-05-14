import { useEffect, useRef, useState } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";

export interface NumericReadoutConfig {
  channelId: string;
  units: string;
  decimals: number;
  warn?: number;
  alarm?: number;
}

export function NumericReadoutRender(props: WidgetRenderProps<NumericReadoutConfig>) {
  const { config, slice, cursorEmitter } = props;
  const [value, setValue] = useState<number | null>(() => sampleAt(slice, config.channelId, cursorEmitter.get()));
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const v = sampleAt(slice, config.channelId, t);
      if (v !== valueRef.current) setValue(v);
    });
    return off;
  }, [slice, config.channelId, cursorEmitter]);

  const display = value === null ? "—" : value.toFixed(config.decimals);
  const color =
    value !== null && config.alarm !== undefined && value >= config.alarm ? "#EF5350" :
    value !== null && config.warn  !== undefined && value >= config.warn  ? "#FFB800" :
    "#D8DCE2";

  return (
    <div className="flex flex-col items-center justify-center h-full bg-[#16171B] p-4">
      <div className="text-xs uppercase tracking-wider text-[#9097A0]">{config.channelId}</div>
      <div className="font-mono-num text-5xl mt-1" style={{ color }}>{display}</div>
      <div className="text-xs text-[#9097A0] mt-1">{config.units}</div>
    </div>
  );
}
