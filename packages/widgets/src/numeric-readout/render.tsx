import { useEffect, useRef, useState } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { thresholdColor } from "../lib/canvas-helpers";

export interface NumericReadoutConfig {
  channelId: string;
  units: string;
  decimals: number;
  warn?: number;
  alarm?: number;
  /** Low-side bounds, for channels that alarm on the way down (oil pressure,
   *  fuel pressure, battery voltage). Independent of the high-side pair. */
  warnLow?: number;
  alarmLow?: number;
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
  // Shared with the canvas gauges so every readout in a workspace agrees on
  // what amber and red mean — and so low-side bounds work here too.
  const color = thresholdColor(value, config.warn, config.alarm, config.warnLow, config.alarmLow);

  return (
    <div className="flex flex-col items-center justify-center h-full bg-[#16171B] p-4">
      <div className="text-xs uppercase tracking-wider text-[#9097A0]">{config.channelId}</div>
      <div className="font-mono-num text-5xl mt-1" style={{ color }}>{display}</div>
      <div className="text-xs text-[#9097A0] mt-1">{config.units}</div>
    </div>
  );
}
