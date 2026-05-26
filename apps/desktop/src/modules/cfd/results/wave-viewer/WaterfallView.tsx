// WaterfallView.tsx

import { useEffect, useMemo, useRef } from "react";

import { COLORMAPS } from "./colormaps";
import { computeMach, fieldRange, WAVE_FIELD_META } from "./fields";
import type {
  WaveCapturePacked,
  WaveField,
} from "../../state/types";

interface Props {
  packed: WaveCapturePacked;
  pipeIdx: number;
  field: WaveField;
  /** Current schematic playhead, 0..frameCount-1. */
  frameIdx: number;
  onScrub(newFrameIdx: number): void;
}

const FIELD_IDX = { rho: 0, u: 1, p: 2, T: 3 } as const;

export function WaterfallView({ packed, pipeIdx, field, frameIdx, onScrub }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const meta = useMemo(() => packed.manifest.pipes[pipeIdx]!, [packed, pipeIdx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nCells = meta.nCells;
    const nFrames = packed.manifest.frameCount;

    const targetW = 800;
    const targetH = 600;
    const cellPx = Math.max(1, Math.floor(targetW / nCells));
    const framePx = Math.max(1, Math.floor(targetH / nFrames));
    const W = cellPx * nCells;
    const H = framePx * nFrames;
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const cmapName = WAVE_FIELD_META[field].colormap;
    const lut = COLORMAPS[cmapName];

    let valueAt: (f: number, c: number) => number;
    let range: { vmin: number; vmax: number };
    if (field === "Mach") {
      const u = packed.pipeArr[pipeIdx]![FIELD_IDX.u]!;
      const T = packed.pipeArr[pipeIdx]![FIELD_IDX.T]!;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < u.length; i++) {
        const m = computeMach(u[i]!, T[i]!);
        if (m < mn) mn = m;
        if (m > mx) mx = m;
      }
      if (!Number.isFinite(mn)) mn = 0;
      if (!Number.isFinite(mx)) mx = 1;
      range = fieldRange("Mach", { min: mn, max: mx });
      valueAt = (f, c) => computeMach(u[f * nCells + c]!, T[f * nCells + c]!);
    } else {
      const idx = FIELD_IDX[field as Exclude<WaveField, "Mach">];
      const arr = packed.pipeArr[pipeIdx]![idx]!;
      range = fieldRange(field, packed.pipeRange[pipeIdx]![idx]!);
      valueAt = (f, c) => arr[f * nCells + c]!;
    }

    const img = ctx.createImageData(W, H);
    const span = range.vmax - range.vmin || 1;

    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < nCells; c++) {
        const v = valueAt(f, c);
        const t = Math.max(0, Math.min(1, (v - range.vmin) / span));
        const lutIdx = Math.min(255, Math.max(0, Math.round(t * 255)));
        const [r, g, b] = lut[lutIdx]!;
        for (let dy = 0; dy < framePx; dy++) {
          for (let dx = 0; dx < cellPx; dx++) {
            const px = (c * cellPx + dx) + (f * framePx + dy) * W;
            const o = px * 4;
            img.data[o] = r;
            img.data[o + 1] = g;
            img.data[o + 2] = b;
            img.data[o + 3] = 255;
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [packed, pipeIdx, field, meta.nCells]);

  useEffect(() => {
    const canvas = overlayRef.current;
    const base = canvasRef.current;
    if (!canvas || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    canvas.style.width = base.style.width;
    canvas.style.height = base.style.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nFrames = packed.manifest.frameCount;
    const y = (frameIdx / Math.max(1, nFrames - 1)) * canvas.height;
    ctx.fillStyle = "rgba(255, 198, 39, 0.85)";
    ctx.fillRect(0, y - 1, canvas.width, 2);
  }, [packed.manifest.frameCount, frameIdx]);

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="block" />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 cursor-crosshair"
        onClick={(e) => {
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const y = e.clientY - rect.top;
          const t = Math.max(0, Math.min(1, y / rect.height));
          const idx = Math.round(t * (packed.manifest.frameCount - 1));
          onScrub(idx);
        }}
      />
    </div>
  );
}
