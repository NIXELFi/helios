// Pure CSV builder for a single wave-viewer frame. Hard rule: ONE frame only —
// the in-memory packed capture holds the whole cycle, but a full dump would be
// huge and the viewer only ever exports what's on screen. x_m_derived is the
// cell-center position reconstructed from index ((cell+0.5)/nCells × lengthM)
// and is NAMED "derived" so nobody mistakes it for a solver-emitted coordinate.

import type { WaveCapturePacked } from "../../state/types";

// pipeArr field index order, fixed by the packer: 0=rho, 1=u, 2=p, 3=T.
const RHO = 0;
const U = 1;
const P = 2;
const T = 3;

function csvCell(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function num(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return "";
  return v.toFixed(Math.max(0, Math.min(8, decimals)));
}

/** Build a CSV of every pipe cell at frame `frameIdx`. Frame index is clamped
 *  into range defensively (a caller passing the live frame should already be in
 *  bounds, but we never want an out-of-range read to emit garbage). */
export function buildWaveFrameCsv(packed: WaveCapturePacked, frameIdx: number): string {
  const { manifest, pipeArr } = packed;
  const f = Math.max(0, Math.min(manifest.frameCount - 1, Math.trunc(frameIdx)));

  const header = ["pipe_index", "pipe_label", "role", "cell", "x_m_derived", "rho", "u", "p", "T"];
  const units = ["-", "-", "-", "-", "m", "kg/m^3", "m/s", "Pa", "K"];
  const lines: string[] = [];
  lines.push(header.map(csvCell).join(","));
  lines.push(units.map(csvCell).join(","));

  for (let pi = 0; pi < manifest.pipes.length; pi++) {
    const meta = manifest.pipes[pi]!;
    const nCells = meta.nCells;
    const offset = f * nCells;
    const rho = pipeArr[pi]![RHO]!;
    const u = pipeArr[pi]![U]!;
    const p = pipeArr[pi]![P]!;
    const t = pipeArr[pi]![T]!;
    for (let c = 0; c < nCells; c++) {
      const xM = ((c + 0.5) / nCells) * meta.lengthM;
      const cells = [
        String(meta.index),
        csvCell(meta.label),
        csvCell(meta.role),
        String(c),
        num(xM, 6),
        num(rho[offset + c]!, 6),
        num(u[offset + c]!, 4),
        num(p[offset + c]!, 2),
        num(t[offset + c]!, 3),
      ];
      lines.push(cells.join(","));
    }
  }
  return lines.join("\n");
}
