// SchematicView.tsx

import { useEffect, useRef } from "react";

import { sampleColormap } from "./colormaps";
import { computeMach, fieldRange, WAVE_FIELD_META } from "./fields";
import { layoutSchematic, type SchematicLayout } from "./layout";
import type {
  WaveCapturePacked,
  WaveCylField,
  WaveField,
  WaveSizeField,
} from "../../state/types";

interface Props {
  packed: WaveCapturePacked;
  frameIdx: number;
  field: WaveField;
  sizeField: WaveSizeField;
  cylField: WaveCylField;
}

const FIELD_IDX = { rho: 0, u: 1, p: 2, T: 3 } as const;
const CYL_FIELD_IDX = { V: 0, p: 1, T: 2, x_b: 3 } as const;

export function SchematicView({ packed, frameIdx, field, sizeField, cylField }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<SchematicLayout | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      ctx?.scale(dpr, dpr);
      layoutRef.current = layoutSchematic(packed.manifest, w, h);
    };
    resize();
    const parent = canvas.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [packed.manifest]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(ctx, layout, packed, frameIdx, field, sizeField, cylField);
  }, [packed, frameIdx, field, sizeField, cylField]);

  return (
    <div className="h-full w-full bg-[#0E0E10]">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  layout: SchematicLayout,
  packed: WaveCapturePacked,
  frameIdx: number,
  field: WaveField,
  sizeField: WaveSizeField,
  cylField: WaveCylField,
) {
  const { width, height, tiers, cylinderCenters, cylinderRowY, cylinderBaseR } = layout;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0E0E10";
  ctx.fillRect(0, 0, width, height);

  for (const tier of tiers) {
    if (tier.kind === "horiz-pipe") {
      drawHorizontalPipe(ctx, packed, frameIdx, tier.pipe.index, field, sizeField, tier.pipeRect);
    } else if (tier.kind === "vert-pipes") {
      for (let i = 0; i < tier.pipes.length; i++) {
        drawVerticalPipe(ctx, packed, frameIdx, tier.pipes[i]!.index, field, sizeField, tier.pipeRects[i]!);
      }
    }
  }

  for (let ci = 0; ci < packed.manifest.nCylinders; ci++) {
    drawCylinder(ctx, packed, frameIdx, ci, cylField, cylinderCenters[ci]!, cylinderRowY, cylinderBaseR);
  }
}

function fieldArr(packed: WaveCapturePacked, pipeIdx: number, field: WaveField): {
  read: (frameIdx: number, cellIdx: number) => number;
  range: { min: number; max: number };
  nCells: number;
} {
  const nCells = packed.manifest.pipes[pipeIdx]!.nCells;
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
    return {
      read: (f, c) => computeMach(u[f * nCells + c]!, T[f * nCells + c]!),
      range: { min: mn, max: mx },
      nCells,
    };
  }
  const idx = FIELD_IDX[field as Exclude<WaveField, "Mach">];
  const arr = packed.pipeArr[pipeIdx]![idx]!;
  return {
    read: (f, c) => arr[f * nCells + c]!,
    range: packed.pipeRange[pipeIdx]![idx]!,
    nCells,
  };
}

function drawHorizontalPipe(
  ctx: CanvasRenderingContext2D,
  packed: WaveCapturePacked,
  frameIdx: number,
  pipeIdx: number,
  field: WaveField,
  sizeField: WaveSizeField,
  rect: { x: number; y: number; w: number; h: number },
) {
  const colorF = fieldArr(packed, pipeIdx, field);
  const sizeF = fieldArr(packed, pipeIdx, sizeField);
  const cmapName = WAVE_FIELD_META[field].colormap;
  const colorRange = fieldRange(field, colorF.range);
  const sizeRange = fieldRange(sizeField, sizeF.range);
  const cellW = rect.w / colorF.nCells;
  const midY = rect.y + rect.h / 2;
  const baseH = rect.h * 0.30;
  const swing = rect.h * 0.55;

  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  for (let c = 0; c < colorF.nCells; c++) {
    const v = colorF.read(frameIdx, c);
    const s = sizeF.read(frameIdx, c);
    const tC = clamp01((v - colorRange.vmin) / (colorRange.vmax - colorRange.vmin || 1));
    const tS = clamp01((s - sizeRange.vmin) / (sizeRange.vmax - sizeRange.vmin || 1));
    const h = baseH + tS * swing;
    const [r, g, b] = sampleColormap(cmapName, tC);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(rect.x + c * cellW, midY - h / 2, cellW, h);
  }
}

function drawVerticalPipe(
  ctx: CanvasRenderingContext2D,
  packed: WaveCapturePacked,
  frameIdx: number,
  pipeIdx: number,
  field: WaveField,
  sizeField: WaveSizeField,
  rect: { x: number; y: number; w: number; h: number },
) {
  const colorF = fieldArr(packed, pipeIdx, field);
  const sizeF = fieldArr(packed, pipeIdx, sizeField);
  const cmapName = WAVE_FIELD_META[field].colormap;
  const colorRange = fieldRange(field, colorF.range);
  const sizeRange = fieldRange(sizeField, sizeF.range);
  const cellH = rect.h / colorF.nCells;
  const midX = rect.x + rect.w / 2;
  const baseW = rect.w * 0.30;
  const swing = rect.w * 0.55;

  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  for (let c = 0; c < colorF.nCells; c++) {
    const v = colorF.read(frameIdx, c);
    const s = sizeF.read(frameIdx, c);
    const tC = clamp01((v - colorRange.vmin) / (colorRange.vmax - colorRange.vmin || 1));
    const tS = clamp01((s - sizeRange.vmin) / (sizeRange.vmax - sizeRange.vmin || 1));
    const w = baseW + tS * swing;
    const [r, g, b] = sampleColormap(cmapName, tC);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(midX - w / 2, rect.y + c * cellH, w, cellH);
  }
}

function drawCylinder(
  ctx: CanvasRenderingContext2D,
  packed: WaveCapturePacked,
  frameIdx: number,
  ci: number,
  cylField: WaveCylField,
  cx: number,
  cy: number,
  baseR: number,
) {
  const fIdx = cylField === "x_b" ? CYL_FIELD_IDX.x_b
             : cylField === "p"   ? CYL_FIELD_IDX.p
             : CYL_FIELD_IDX.T;
  const pArr = packed.cylArr[ci]![CYL_FIELD_IDX.p]!;
  const pRange = packed.cylRange[ci]![CYL_FIELD_IDX.p]!;
  const fArr = packed.cylArr[ci]![fIdx]!;
  const fRangeObs = packed.cylRange[ci]![fIdx]!;

  const p = pArr[frameIdx]!;
  const f = fArr[frameIdx]!;

  const norm = clamp01((Math.log(Math.max(p, 1)) - Math.log(Math.max(pRange.min, 1))) /
                       Math.max(1e-9, Math.log(Math.max(pRange.max, 1)) - Math.log(Math.max(pRange.min, 1))));
  const r = baseR * (0.4 + 0.6 * norm);

  const cmapName =
    cylField === "x_b" ? "viridis" :
    cylField === "p"   ? "RdBu_r"  :
                         "inferno";
  const rangeStruct = fieldRange(
    cylField === "p" ? "p" : cylField === "T" ? "T" : "rho",
    fRangeObs,
  );
  const tC = clamp01((f - rangeStruct.vmin) / (rangeStruct.vmax - rangeStruct.vmin || 1));
  const [rr, gg, bb] = sampleColormap(cmapName, tC);
  ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
