// uPlot wrapper for cycle-indexed charts. Title + legend are rendered
// outside the uPlot canvas (in matching Helios chrome) so axis labels
// don't fight the chart's own gutter. ResizeObserver keeps the canvas
// sized to its parent — same pattern as @helios/widgets strip-chart.

import { useEffect, useLayoutEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { CycleStats } from "../../state/types";

export interface CycleSeries {
  label: string;
  field: keyof CycleStats;
  color?: string;
  axis?: "y" | "y2";
}

interface CycleChartProps {
  title: string;
  cycles: CycleStats[];
  series: CycleSeries[];
  yLabel?: string;
  y2Label?: string;
  yLog?: boolean;
  height?: number;
}

const DEFAULT_COLORS = ["#FFC627", "#4FC3F7", "#A5D6A7", "#F48FB1", "#CE93D8", "#FF8A65"];

export function CycleChart({
  title,
  cycles,
  series,
  yLabel,
  y2Label,
  yLog = false,
  height = 220,
}: CycleChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const plotHostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Stable identity for the structural deps below. Recomputing in deps:
  // the field names + colors describe the chart shape; the cycles array
  // is the data and is handled by a separate setData effect.
  const fieldKey = series.map((s) => `${String(s.field)}:${s.color ?? ""}:${s.axis ?? "y"}`).join("|");

  // Build / rebuild the plot on structural changes only.
  useLayoutEffect(() => {
    if (!plotHostRef.current) return;
    const usesY2 = series.some((s) => s.axis === "y2");

    const xs = cycles.map((c, i) => c.cycle || i + 1);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) => cycles.map((c) => Number(c[s.field]))),
    ];

    const axisStroke = "#5A5F66";
    const gridStroke = "#23252B";
    const labelFont = "10px ui-sans-serif, system-ui, sans-serif";
    const valueFont = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

    const baseAxis: Partial<uPlot.Axis> = {
      stroke: axisStroke,
      grid: { stroke: gridStroke },
      ticks: { stroke: gridStroke, size: 4 },
      font: valueFont,
      labelFont,
      size: 30,
      labelGap: 2,
    };

    const opts: uPlot.Options = {
      width: plotHostRef.current.clientWidth || 400,
      height: Math.max(height - 28 /* title strip */, 80),
      pxAlign: 0,
      scales: {
        x: { time: false },
        y: { auto: true, distr: yLog ? 3 : 1 },
        ...(usesY2 ? { y2: { auto: true } } : {}),
      },
      axes: [
        { ...baseAxis, label: "cycle", size: 24 } as uPlot.Axis,
        { ...baseAxis, label: yLabel ?? "", size: 44 } as uPlot.Axis,
        ...(usesY2
          ? [{ ...baseAxis, label: y2Label ?? "", scale: "y2", side: 1, size: 44, grid: { show: false, stroke: "" } } as uPlot.Axis]
          : []),
      ],
      series: [
        { label: "cycle" },
        ...series.map((s, i): uPlot.Series => ({
          label: s.label,
          stroke: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
          width: 1.5,
          points: { show: cycles.length < 40, size: 5 },
          scale: s.axis === "y2" ? "y2" : "y",
        })),
      ],
      legend: { show: false },
      cursor: {
        drag: { x: false, y: false },
        points: { show: true, size: 5 },
      },
      padding: [10, 12, 4, 4],
    };

    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, plotHostRef.current);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, yLabel, y2Label, yLog, height]);

  // Cheap data updates.
  useEffect(() => {
    if (!plotRef.current) return;
    const xs = cycles.map((c, i) => c.cycle || i + 1);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) => cycles.map((c) => Number(c[s.field]))),
    ];
    plotRef.current.setData(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycles]);

  // Resize: re-size the canvas to its parent on every container change.
  useEffect(() => {
    const host = plotHostRef.current;
    if (!host) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        plotRef.current?.setSize({ width: Math.max(cr.width, 80), height: Math.max(cr.height, 80) });
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">{title}</div>
        <div className="flex items-center gap-2">
          {series.map((s, i) => (
            <span key={String(s.field)} className="flex items-center gap-1 text-[10px] text-[#5A5F66]">
              <span
                className="inline-block h-[2px] w-3"
                style={{ background: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length] }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div ref={plotHostRef} className="flex-1 min-h-0" />
    </div>
  );
}
