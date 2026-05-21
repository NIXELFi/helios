// Cd-table editor. Rows of (L/D, Cd) above a live uPlot curve.
// Auto-sorts by L/D on every edit. Monotonicity check (advisory).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { checkCdMonotonic } from "../validation/client-rules";

export type CdRow = [number, number]; // [L/D, Cd]

interface Props {
  value: ReadonlyArray<CdRow>;
  onChange: (next: CdRow[]) => void;
}

const MIN_ROWS = 2;

export function CdTableField({ value, onChange }: Props) {
  const warning = checkCdMonotonic(value);
  return (
    <div className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
        Cd table
      </div>

      <CdCurvePlot rows={value} />

      <table className="w-full font-mono text-[11px]">
        <thead className="bg-[#0B0B0D] text-[10px] uppercase tracking-wider text-[#5A5F66]">
          <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
            <th className="text-right">#</th>
            <th className="text-right">L/D</th>
            <th className="text-right">Cd</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <CdRowEditor
              key={i}
              row={row}
              onChange={(nr) => {
                const next = value.map((r, idx) => (idx === i ? nr : r)) as CdRow[];
                next.sort((a, b) => a[0] - b[0]);
                onChange(next);
              }}
              onRemove={
                value.length > MIN_ROWS
                  ? () => onChange(value.filter((_, idx) => idx !== i) as CdRow[])
                  : null
              }
              index={i}
            />
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between border-t border-[#2A2C32] px-2 py-1">
        {warning ? (
          <span className="text-[10px] text-amber-300">⚠ {warning}</span>
        ) : (
          <span className="text-[10px] text-[#5A5F66]">{value.length} rows · monotonic</span>
        )}
        <button
          type="button"
          className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
          onClick={() => {
            const last = value[value.length - 1];
            const newRow: CdRow = last
              ? [Math.round((last[0] + 0.05) * 1000) / 1000, last[1]]
              : [0.05, 0.5];
            onChange([...value, newRow] as CdRow[]);
          }}
        >
          + Row
        </button>
      </div>
    </div>
  );
}

function CdRowEditor({
  row, onChange, onRemove, index,
}: {
  row: CdRow;
  onChange: (next: CdRow) => void;
  onRemove: (() => void) | null;
  index: number;
}) {
  const [ld, setLd] = useState(String(row[0]));
  const [cd, setCd] = useState(String(row[1]));
  useEffect(() => { setLd(String(row[0])); setCd(String(row[1])); }, [row]);

  function commit(nextLd: string, nextCd: string) {
    const ldn = Number(nextLd);
    const cdn = Number(nextCd);
    if (!Number.isFinite(ldn) || !Number.isFinite(cdn)) return;
    onChange([ldn, cdn]);
  }

  const inputCls =
    "w-full rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1.5 py-0.5 text-right font-mono text-[11px] text-[#D8DCE2] focus:outline-none focus:border-[#FFC627]";

  return (
    <tr className="border-t border-[#16171B] text-[#D8DCE2]">
      <td className="px-2 py-1 text-right text-[#5A5F66]">{index + 1}</td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          className={inputCls}
          aria-label={`L/D row ${index + 1}`}
          value={ld}
          onChange={(e) => setLd(e.target.value)}
          onBlur={() => commit(ld, cd)}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(ld, cd); (e.target as HTMLInputElement).blur(); } }}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          className={inputCls}
          aria-label={`Cd row ${index + 1}`}
          value={cd}
          onChange={(e) => setCd(e.target.value)}
          onBlur={() => commit(ld, cd)}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(ld, cd); (e.target as HTMLInputElement).blur(); } }}
        />
      </td>
      <td className="px-2 py-1 text-right">
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove row ${index + 1}`}
            className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-red-300"
            onClick={onRemove}
          >
            ×
          </button>
        ) : (
          <span className="text-[10px] text-[#3A3D43]" title={`Minimum ${MIN_ROWS} rows`}>—</span>
        )}
      </td>
    </tr>
  );
}

function CdCurvePlot({ rows }: { rows: ReadonlyArray<CdRow> }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const xs = rows.map((r) => r[0]);
    const ys = rows.map((r) => r[1]);
    const opts: uPlot.Options = {
      width: hostRef.current.clientWidth || 320,
      height: 100,
      pxAlign: 0,
      scales: { x: { time: false }, y: { range: [0, 1] } },
      axes: [
        { stroke: "#5A5F66", grid: { stroke: "#23252B" }, font: "10px ui-monospace, monospace", size: 22 },
        { stroke: "#5A5F66", grid: { stroke: "#23252B" }, font: "10px ui-monospace, monospace", size: 30 },
      ],
      series: [
        { label: "L/D" },
        { label: "Cd", stroke: "#FFC627", width: 1.5, points: { show: true, size: 5, stroke: "#FFC627", fill: "#FFC627" } },
      ],
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      padding: [6, 8, 0, 4],
    };
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, [xs, ys], hostRef.current);
    return () => { plotRef.current?.destroy(); plotRef.current = null; };
  }, []);

  useEffect(() => {
    if (!plotRef.current) return;
    const xs = rows.map((r) => r[0]);
    const ys = rows.map((r) => r[1]);
    plotRef.current.setData([xs, ys]);
  }, [rows]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        plotRef.current?.setSize({ width: Math.max(e.contentRect.width, 80), height: 100 });
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return <div ref={hostRef} style={{ height: 100 }} />;
}
