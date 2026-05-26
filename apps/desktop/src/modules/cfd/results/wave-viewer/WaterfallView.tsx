// WaterfallView.tsx

import { useEffect, useMemo, useRef } from "react";

import { COLORMAPS } from "./colormaps";
import { computeMach, fieldRange, PIPE_FIELD_IDX, WAVE_FIELD_META } from "./fields";
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
      const u = packed.pipeArr[pipeIdx]![PIPE_FIELD_IDX.u]!;
      const T = packed.pipeArr[pipeIdx]![PIPE_FIELD_IDX.T]!;
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
      const idx = PIPE_FIELD_IDX[field as Exclude<WaveField, "Mach">];
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

  const pipeMeta = packed.manifest.pipes[pipeIdx]!;
  const fieldLabel = field === "p" ? "pressure"
                   : field === "u" ? "velocity"
                   : field === "T" ? "temperature"
                   : field === "rho" ? "density"
                   : "Mach";
  const lengthMm = (pipeMeta.lengthM * 1000).toFixed(0);
  const thetaStart = packed.manifest.thetaStartDeg.toFixed(0);
  const thetaEnd = packed.manifest.thetaEndDeg.toFixed(0);

  return (
    <div className="flex flex-col items-start gap-1 p-2 text-[10px] text-helios-dim">
      <div className="text-[12px] text-helios-text">
        <span className="font-mono">{pipeMeta.label}</span>
        <span className="ml-2">·</span>
        <span className="ml-2">{fieldLabel}</span>
      </div>
      <div className="flex gap-2">
        {/* Y-axis label */}
        <div className="flex flex-col justify-between text-right" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", lineHeight: "1" }}>
          <span>θ {thetaStart}°</span>
          <span>θ {thetaEnd}°</span>
        </div>
        {/* The two stacked canvases */}
        <div className="relative inline-block">
          <canvas ref={canvasRef} className="block" />
          <canvas
            ref={overlayRef}
            className="absolute inset-0 cursor-crosshair"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
              const y = e.clientY - rect.top;
              const t = Math.max(0, Math.min(1, y / rect.height));
              const idx = Math.round(t * (packed.manifest.frameCount - 1));
              onScrub(idx);
            }}
          />
        </div>
      </div>
      {/* X-axis label */}
      <div className="flex w-full justify-between" style={{ marginLeft: "2rem" }}>
        <span>0 mm</span>
        <span className="text-helios-text">position →</span>
        <span>{lengthMm} mm</span>
      </div>
    </div>
  );
}
