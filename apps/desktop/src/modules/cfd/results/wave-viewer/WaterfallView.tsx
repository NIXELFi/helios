// WaterfallView.tsx

import { useCallback, useEffect, useRef } from "react";

import { COLORMAPS } from "./colormaps";
import { computeMach, fieldRange, PIPE_FIELD_IDX, WAVE_FIELD_META } from "./fields";
import type {
  WaveCapturePacked,
  WaveField,
} from "../../state/types";

interface Props {
  packed: WaveCapturePacked;
  field: WaveField;
  /** Reports the FIRST tile's canvas element (for PNG capture in the parent
   *  modal). Called with the element on mount and null on unmount, alongside
   *  the internal ref assignment — no rendering behavior changes. */
  onCanvasRef?: (el: HTMLCanvasElement | null) => void;
}

interface TileProps {
  packed: WaveCapturePacked;
  pipeIdx: number;
  field: WaveField;
  onCanvasRef?: (el: HTMLCanvasElement | null) => void;
}

function WaterfallTile({ packed, pipeIdx, field, onCanvasRef }: TileProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const meta = packed.manifest.pipes[pipeIdx]!;

  // Combined callback-ref: keep the internal ref wired for the draw effect AND
  // surface the element to the parent (only the first tile passes onCanvasRef).
  // useCallback keeps the ref identity stable so React doesn't detach/reattach
  // (null → el) on every re-render of the tile.
  const setCanvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      canvasRef.current = el;
      onCanvasRef?.(el);
    },
    [onCanvasRef],
  );

  // Render heatmap on (packed, pipeIdx, field) change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = Math.max(40, wrap.clientWidth);
    const H = Math.max(40, wrap.clientHeight);
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const nCells = meta.nCells;
    const nFrames = packed.manifest.frameCount;

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

    for (let py = 0; py < H; py++) {
      const f = Math.floor((py / Math.max(1, H - 1)) * (nFrames - 1));
      for (let px = 0; px < W; px++) {
        const c = Math.floor((px / Math.max(1, W - 1)) * (nCells - 1));
        const v = valueAt(f, c);
        const t = Math.max(0, Math.min(1, (v - range.vmin) / span));
        const lutIdx = Math.min(255, Math.max(0, Math.round(t * 255)));
        const [r, g, b] = lut[lutIdx]!;
        const o = (py * W + px) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [packed, pipeIdx, field, meta.nCells]);

  const lengthMm = (meta.lengthM * 1000).toFixed(0);
  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-0.5 font-mono text-[9px] text-helios-dim">
        {meta.label} <span className="text-[#5A5F66]">[{meta.nCells} cells · {lengthMm} mm]</span>
      </div>
      <div ref={wrapRef} className="relative min-h-[60px] flex-1 bg-helios-base">
        <canvas ref={setCanvas} className="absolute inset-0" />
      </div>
    </div>
  );
}

export function WaterfallView({ packed, field, onCanvasRef }: Props) {
  // Group pipes by role for grid layout.
  const byRole: Record<string, number[]> = { plenum: [], runner: [], primary: [], secondary: [], collector: [] };
  packed.manifest.pipes.forEach((p, i) => {
    if (byRole[p.role]) byRole[p.role]!.push(i);
  });

  // The FIRST tile in render order (rows are emitted plenum→collector, so the
  // first non-empty role's first pipe is the first canvas painted). Only that
  // tile reports its canvas up to the parent for PNG capture.
  const firstPipeIdx = [
    ...byRole.plenum!,
    ...byRole.runner!,
    ...byRole.primary!,
    ...byRole.secondary!,
    ...byRole.collector!,
  ][0];

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-auto p-2">
      {byRole.plenum!.length > 0 && (
        <div className="grid grid-cols-1 gap-1" style={{ height: "12%" }}>
          {byRole.plenum!.map((i) => (
            <WaterfallTile key={i} packed={packed} pipeIdx={i} field={field} onCanvasRef={i === firstPipeIdx ? onCanvasRef : undefined} />
          ))}
        </div>
      )}
      {byRole.runner!.length > 0 && (
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${byRole.runner!.length}, minmax(0, 1fr))`, height: "20%" }}
        >
          {byRole.runner!.map((i) => (
            <WaterfallTile key={i} packed={packed} pipeIdx={i} field={field} onCanvasRef={i === firstPipeIdx ? onCanvasRef : undefined} />
          ))}
        </div>
      )}
      {byRole.primary!.length > 0 && (
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${byRole.primary!.length}, minmax(0, 1fr))`, height: "20%" }}
        >
          {byRole.primary!.map((i) => (
            <WaterfallTile key={i} packed={packed} pipeIdx={i} field={field} onCanvasRef={i === firstPipeIdx ? onCanvasRef : undefined} />
          ))}
        </div>
      )}
      {byRole.secondary!.length > 0 && (
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${byRole.secondary!.length}, minmax(0, 1fr))`, height: "20%" }}
        >
          {byRole.secondary!.map((i) => (
            <WaterfallTile key={i} packed={packed} pipeIdx={i} field={field} onCanvasRef={i === firstPipeIdx ? onCanvasRef : undefined} />
          ))}
        </div>
      )}
      {byRole.collector!.length > 0 && (
        <div className="grid grid-cols-1 gap-1" style={{ height: "12%" }}>
          {byRole.collector!.map((i) => (
            <WaterfallTile key={i} packed={packed} pipeIdx={i} field={field} onCanvasRef={i === firstPipeIdx ? onCanvasRef : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
