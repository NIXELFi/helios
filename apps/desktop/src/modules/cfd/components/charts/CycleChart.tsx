// uPlot wrapper for cycle-indexed charts. Generic over which fields
// of CycleStats to plot. Updates via setData on prop change.

import { useEffect, useRef } from "react";
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

const DEFAULT_COLORS = ["#4FC3F7", "#FFB300", "#A5D6A7", "#F48FB1", "#CE93D8", "#FF8A65"];

export function CycleChart({
  title,
  cycles,
  series,
  yLabel,
  y2Label,
  yLog = false,
  height = 220,
}: CycleChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const xs = cycles.map((c, i) => i + 1);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) => cycles.map((c) => Number(c[s.field]))),
    ];
    const usesY2 = series.some((s) => s.axis === "y2");
    const opts: uPlot.Options = {
      title,
      width: containerRef.current.clientWidth || 400,
      height,
      scales: {
        x: { time: false },
        y: { auto: true, distr: yLog ? 3 : 1 },
        ...(usesY2 ? { y2: { auto: true } } : {}),
      },
      axes: [
        { label: "cycle", stroke: "#9aa0a6" },
        { label: yLabel ?? "", stroke: "#9aa0a6" },
        ...(usesY2 ? [{ label: y2Label ?? "", scale: "y2", side: 1, stroke: "#9aa0a6" } as uPlot.Axis] : []),
      ],
      series: [
        { label: "cycle" },
        ...series.map((s, i) => ({
          label: s.label,
          stroke: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
          width: 2,
          points: { show: cycles.length < 50 },
          scale: s.axis === "y2" ? "y2" : "y",
        })),
      ],
      legend: { show: true },
      cursor: { points: { size: 6 } },
    };
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, containerRef.current);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, yLabel, y2Label, yLog, height, series.map((s) => s.field).join(",")]);

  // Cheap data updates when only cycles change.
  useEffect(() => {
    if (!plotRef.current) return;
    const xs = cycles.map((c, i) => i + 1);
    const data: uPlot.AlignedData = [
      xs,
      ...series.map((s) => cycles.map((c) => Number(c[s.field]))),
    ];
    plotRef.current.setData(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycles]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
