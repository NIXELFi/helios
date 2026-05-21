// Editable per-pipe rows for intake_pipes / exhaust_primaries /
// exhaust_secondaries. Each row has inline editors for L (mm),
// Ø in (mm), Ø out (mm, optional), N cells (int), T wall (K).
// Actions per row: duplicate, remove. Footer: "Add pipe".

import { useEffect, useState } from "react";

export interface PipeRow {
  name?: string;
  length: number;
  diameter: number;
  diameter_out: number | null;
  n_points: number;
  wall_temperature: number;
  roughness?: number;
  [extra: string]: unknown;
}

interface Props {
  title: string;
  rows: ReadonlyArray<PipeRow>;
  onChange: (next: PipeRow[]) => void;
  onAdd: () => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  minRows?: number;
}

export function PipeArrayField({
  title, rows, onChange, onAdd, onDuplicate, onRemove, minRows = 1,
}: Props) {
  return (
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
      <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[11px]">
          <thead className="bg-[#0B0B0D] text-[10px] uppercase tracking-wider text-[#5A5F66]">
            <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
              <th className="text-right">#</th>
              <th>Name</th>
              <th className="text-right">L (mm)</th>
              <th className="text-right">Ø in (mm)</th>
              <th className="text-right">Ø out (mm)</th>
              <th className="text-right">N cells</th>
              <th className="text-right">T wall (K)</th>
              <th className="text-right"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <Row
                key={i}
                index={i}
                row={row}
                onCommit={(nr) => {
                  const next = rows.map((r, idx) => (idx === i ? nr : r));
                  onChange(next);
                }}
                onDuplicate={() => onDuplicate(i)}
                onRemove={rows.length > minRows ? () => onRemove(i) : null}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-[#2A2C32] px-2 py-1">
        <span className="text-[10px] text-[#5A5F66]">{rows.length} pipe{rows.length === 1 ? "" : "s"}</span>
        <button
          type="button"
          className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
          onClick={onAdd}
        >
          + Pipe
        </button>
      </div>
    </section>
  );
}

const cellInput =
  "w-full rounded-sm border border-[#2A2C32] bg-[#0B0B0D] px-1.5 py-0.5 text-right font-mono text-[11px] text-[#D8DCE2] focus:outline-none focus:border-[#FFC627]";
const cellInputLeft = cellInput.replace("text-right", "text-left");

function Row({
  index, row, onCommit, onDuplicate, onRemove,
}: {
  index: number;
  row: PipeRow;
  onCommit: (next: PipeRow) => void;
  onDuplicate: () => void;
  onRemove: (() => void) | null;
}) {
  const [name, setName] = useState(row.name ?? "");
  const [lengthMm, setLengthMm] = useState(formatMm(row.length));
  const [dIn, setDIn] = useState(formatMm(row.diameter));
  const [dOut, setDOut] = useState(row.diameter_out == null ? "" : formatMm(row.diameter_out));
  const [nPts, setNPts] = useState(String(row.n_points));
  const [tw, setTw] = useState(String(row.wall_temperature));
  useEffect(() => {
    setName(row.name ?? "");
    setLengthMm(formatMm(row.length));
    setDIn(formatMm(row.diameter));
    setDOut(row.diameter_out == null ? "" : formatMm(row.diameter_out));
    setNPts(String(row.n_points));
    setTw(String(row.wall_temperature));
  }, [row]);

  function commit() {
    const next: PipeRow = {
      ...row,
      name,
      length: parseMm(lengthMm) ?? row.length,
      diameter: parseMm(dIn) ?? row.diameter,
      diameter_out: dOut.trim() === "" ? null : parseMm(dOut),
      n_points: Number.isFinite(Number(nPts)) ? Math.round(Number(nPts)) : row.n_points,
      wall_temperature: Number.isFinite(Number(tw)) ? Number(tw) : row.wall_temperature,
    };
    onCommit(next);
  }

  return (
    <tr className="border-t border-[#16171B]">
      <td className="px-2 py-1 text-right text-[#5A5F66]">{index + 1}</td>
      <td className="px-2 py-1">
        <input
          type="text"
          aria-label={`Pipe ${index + 1} name`}
          className={cellInputLeft}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Pipe ${index + 1} length`}
          className={cellInput}
          value={lengthMm}
          onChange={(e) => setLengthMm(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Pipe ${index + 1} diameter`}
          className={cellInput}
          value={dIn}
          onChange={(e) => setDIn(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Pipe ${index + 1} diameter_out`}
          className={cellInput}
          placeholder="—"
          value={dOut}
          onChange={(e) => setDOut(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="numeric"
          aria-label={`Pipe ${index + 1} n_points`}
          className={cellInput}
          value={nPts}
          onChange={(e) => setNPts(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="px-2 py-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Pipe ${index + 1} wall_temperature`}
          className={cellInput}
          value={tw}
          onChange={(e) => setTw(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="px-2 py-1 text-right">
        <button
          type="button"
          className="text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-[#FFC627]"
          aria-label={`Duplicate pipe ${index + 1}`}
          onClick={onDuplicate}
        >
          dup
        </button>
        {onRemove && (
          <button
            type="button"
            className="ml-2 text-[10px] uppercase tracking-wider text-[#5A5F66] hover:text-red-300"
            aria-label={`Remove pipe ${index + 1}`}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </td>
    </tr>
  );
}

function formatMm(siMeters: number): string {
  if (!Number.isFinite(siMeters)) return "";
  return (siMeters * 1000).toFixed(1);
}
function parseMm(s: string): number | null {
  const t = s.trim();
  if (t === "" || t === "—") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n / 1000;
}
