// Scatter plot, hand-rolled SVG (NOT uPlot). Each point is one trial;
// axes are scaled to the visible data extent. Neutral points sit under
// rank-colored points (#1 gold / #2 silver / #3 bronze), the selected id
// gets a white ring on top, and an optional right-angle "step" polyline
// traces the running-best line. Click bubbles `id` via onPointClick.
// Mirrors ParallelCoordsPlot's idioms: useMemo scales, padding, axis
// lines/labels with toPrecision(3) extents, role="img" aria-label.

import { useMemo, useRef } from "react";

import { useElementWidth } from "./useElementWidth";

export interface ScatterPt {
  id: number;
  x: number;
  y: number;
  rank?: number | null;
  inFlight?: boolean;
}

interface Props {
  title: string;
  points: ScatterPt[];
  xLabel: string;
  yLabel: string;
  /** Right-angle step line (e.g. running-best); drawn under the points. */
  stepLine?: { x: number; y: number }[];
  selectedId?: number | null;
  onPointClick?: (id: number) => void;
  height?: number;
}

// Rank styling — kept here so tests can assert exact fills.
const RANK_FILL: Record<number, string> = { 1: "#fbbf24", 2: "#C0C7D1", 3: "#CD7F32" };
const RANK_R: Record<number, number> = { 1: 5, 2: 4.5, 3: 4.5 };

export function ScatterPlot({
  title,
  points,
  xLabel,
  yLabel,
  stepLine,
  selectedId,
  onPointClick,
  height = 340,
}: Props) {
  // Fill the container width (responsive) rather than a hard-coded pixel width,
  // so the chart never overflows into its own horizontal scrollbar. Falls back
  // to 600 until measured (and under jsdom, where layout is absent).
  const hostRef = useRef<HTMLDivElement | null>(null);
  const width = Math.max(useElementWidth(hostRef, 600), 200);
  const padLeft = 44;
  const padRight = 20;
  const padTop = 16;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  // Axis extents from the data (include stepLine vertices so the line
  // always fits). Degenerate (0/1 point or min === max) must not produce
  // NaN coordinates — we center instead.
  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    const consider = (x: number, y: number) => {
      if (Number.isFinite(x)) { if (x < xlo) xlo = x; if (x > xhi) xhi = x; }
      if (Number.isFinite(y)) { if (y < ylo) ylo = y; if (y > yhi) yhi = y; }
    };
    for (const p of points) consider(p.x, p.y);
    for (const s of stepLine ?? []) consider(s.x, s.y);
    if (!Number.isFinite(xlo)) { xlo = 0; xhi = 1; }
    if (!Number.isFinite(ylo)) { ylo = 0; yhi = 1; }
    return { xMin: xlo, xMax: xhi, yMin: ylo, yMax: yhi };
  }, [points, stepLine]);

  // Safe-divide scales: when an axis is degenerate (min === max), pin the
  // value to the plot center so we never divide by zero -> NaN.
  const xOf = (x: number) => {
    if (xMax === xMin || !Number.isFinite(x)) return padLeft + plotW / 2;
    return padLeft + (plotW * (x - xMin)) / (xMax - xMin);
  };
  const yOf = (y: number) => {
    if (yMax === yMin || !Number.isFinite(y)) return padTop + plotH / 2;
    const t = (y - yMin) / (yMax - yMin);
    return padTop + plotH * (1 - t);
  };

  // Right-angle step polyline: for consecutive (x1,y1)->(x2,y2) emit the
  // intermediate corner (x2,y1) so the line only ever moves orthogonally.
  const stepPoints = useMemo(() => {
    const line = stepLine ?? [];
    if (line.length === 0) return "";
    const out: string[] = [];
    let prev = line[0]!;
    out.push(`${xOf(prev.x)},${yOf(prev.y)}`);
    for (let i = 1; i < line.length; i++) {
      const cur = line[i]!;
      out.push(`${xOf(cur.x)},${yOf(prev.y)}`); // intermediate corner
      out.push(`${xOf(cur.x)},${yOf(cur.y)}`);
      prev = cur;
    }
    return out.join(" ");
    // width feeds xOf() via plotW — must be a dep now that it's responsive
    // (was the constant 600 before), else the step line stays at the old
    // width on resize while the points reflow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepLine, xMin, xMax, yMin, yMax, width]);

  // Neutral (un-ranked) points first; ranked points drawn after so they
  // sit on top.
  const neutral = points.filter((p) => !(p.rank && RANK_FILL[p.rank]));
  const ranked = points.filter((p) => p.rank && RANK_FILL[p.rank]);
  const selected = selectedId == null ? null : points.find((p) => p.id === selectedId);

  const cursor = onPointClick ? "pointer" : "default";

  return (
    <div ref={hostRef} className="flex h-full w-full flex-col" style={{ minHeight: height }}>
      {/* Title strip — identical chrome to LinePlot. */}
      <div className="flex items-center justify-between border-b border-[#2A2C32] px-2 py-1">
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0]">{title}</div>
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${title} scatter plot`}
        className="block overflow-visible"
      >
        {/* Axes */}
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + plotH} stroke="#3f3f46" />
        <line
          x1={padLeft}
          y1={padTop + plotH}
          x2={padLeft + plotW}
          y2={padTop + plotH}
          stroke="#3f3f46"
        />
        {/* Y axis labels (max top, min bottom). */}
        <text x={padLeft - 4} y={padTop + 4} fontSize="9" fill="#71717a" textAnchor="end">
          {Number.isFinite(yMax) ? yMax.toPrecision(3) : "—"}
        </text>
        <text x={padLeft - 4} y={padTop + plotH} fontSize="9" fill="#71717a" textAnchor="end">
          {Number.isFinite(yMin) ? yMin.toPrecision(3) : "—"}
        </text>
        <text
          x={6}
          y={padTop + plotH / 2}
          fontSize="10"
          fill="#D8DCE2"
          textAnchor="middle"
          transform={`rotate(-90 6 ${padTop + plotH / 2})`}
        >
          {yLabel}
        </text>
        {/* X axis labels (min left, max right). */}
        <text x={padLeft} y={padTop + plotH + 12} fontSize="9" fill="#71717a" textAnchor="start">
          {Number.isFinite(xMin) ? xMin.toPrecision(3) : "—"}
        </text>
        <text
          x={padLeft + plotW}
          y={padTop + plotH + 12}
          fontSize="9"
          fill="#71717a"
          textAnchor="end"
        >
          {Number.isFinite(xMax) ? xMax.toPrecision(3) : "—"}
        </text>
        <text
          x={padLeft + plotW / 2}
          y={padTop + plotH + 24}
          fontSize="10"
          fill="#D8DCE2"
          textAnchor="middle"
        >
          {xLabel}
        </text>

        {/* Running-best step line, under the points. */}
        {stepPoints && (
          <polyline
            points={stepPoints}
            fill="none"
            stroke="#FFC627"
            strokeWidth={1.5}
            opacity={0.9}
          />
        )}

        {/* Neutral points first (under everything). */}
        {neutral.map((p) =>
          p.inFlight ? (
            <circle
              key={p.id}
              cx={xOf(p.x)}
              cy={yOf(p.y)}
              r={3}
              fill="none"
              stroke="#4FC3F7"
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.55}
              style={{ cursor }}
              onClick={() => onPointClick?.(p.id)}
            />
          ) : (
            <circle
              key={p.id}
              cx={xOf(p.x)}
              cy={yOf(p.y)}
              r={3}
              fill="#4FC3F7"
              opacity={0.55}
              style={{ cursor }}
              onClick={() => onPointClick?.(p.id)}
            />
          ),
        )}

        {/* Ranked points on top (full opacity). */}
        {ranked.map((p) => {
          const rank = p.rank as number;
          return (
            <circle
              key={p.id}
              cx={xOf(p.x)}
              cy={yOf(p.y)}
              r={RANK_R[rank] ?? 4.5}
              fill={p.inFlight ? "none" : RANK_FILL[rank]}
              stroke={p.inFlight ? RANK_FILL[rank] : "none"}
              strokeWidth={p.inFlight ? 1 : 0}
              strokeDasharray={p.inFlight ? "2 2" : undefined}
              style={{ cursor }}
              onClick={() => onPointClick?.(p.id)}
            />
          );
        })}

        {/* Selected id gets a white ring on very top. */}
        {selected && (
          <circle
            cx={xOf(selected.x)}
            cy={yOf(selected.y)}
            r={(RANK_R[selected.rank ?? 0] ?? 3) + 2.5}
            fill="none"
            stroke="#fafafa"
            strokeWidth={1.5}
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  );
}
