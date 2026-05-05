import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import type { WidgetRenderProps } from "../types";

export interface StripChartChannel { id: string; color: string; }
export interface StripChartConfig {
  channels: StripChartChannel[];
  yMin: number;
  yMax: number;
}

export function StripChartRender(props: WidgetRenderProps<StripChartConfig>) {
  const { config, slice, cursorEmitter, timeRange } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const N = slice.time.length;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Number(slice.time[i]) / 1_000_000;

    const ys: Float64Array[] = config.channels.map((c) => {
      const arr = slice.data.get(c.id);
      return arr ?? new Float64Array(N);
    });

    const data: AlignedData = [x, ...ys];

    const opts: Options = {
      width: containerRef.current.clientWidth || 600,
      height: containerRef.current.clientHeight || 200,
      pxAlign: 0,
      cursor: { show: false, drag: { x: true, y: false }, sync: undefined, points: { show: false } },
      scales: { x: {}, y: { range: [config.yMin, config.yMax] } },
      axes: [
        { stroke: "#5A5F66", grid: { stroke: "#23252B" } },
        { stroke: "#5A5F66", grid: { stroke: "#23252B" } },
      ],
      series: [
        {},
        ...config.channels.map((c) => ({ stroke: c.color, width: 1 })),
      ],
    };

    try {
      plotRef.current?.destroy();
      plotRef.current = new uPlot(opts, data, containerRef.current);
    } catch (_e) {
      // jsdom canvas may not support 2d context; ignore in test environments
    }

    return () => { plotRef.current?.destroy(); plotRef.current = null; };
  }, [slice, config, timeRange]);

  useEffect(() => {
    const off = cursorEmitter.subscribe((tUs) => {
      const u = plotRef.current; if (!u) return;
      const tS = tUs / 1_000_000;
      // valToPos with canvasPixels=false returns CSS pixels in u.over's coord
      // space — same as uPlot's own cursor — so attaching the line to u.over
      // keeps the two perfectly aligned regardless of axis padding.
      const left = u.valToPos(tS, "x", false);
      const over = u.over;
      let line = over.querySelector<HTMLDivElement>(".helios-cursor");
      if (!line) {
        line = document.createElement("div");
        line.className = "helios-cursor";
        line.style.position = "absolute";
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = "1px";
        line.style.background = "#FFC627";
        line.style.pointerEvents = "none";
        over.appendChild(line);
      }
      line.style.left = `${left}px`;
    });
    return off;
  }, [cursorEmitter]);

  return <div ref={containerRef} className="w-full h-full bg-[#16171B]" />;
}
