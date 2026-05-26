// SchematicView.tsx

import { useEffect, useRef, useState } from "react";

import { sampleColormap } from "./colormaps";
import { computeMach, CYL_FIELD_IDX, fieldRange, PIPE_FIELD_IDX, WAVE_FIELD_META } from "./fields";
import { layoutSchematic, type SchematicLayout } from "./layout";
import type {
  WaveCapturePacked,
  WaveCylField,
  WaveField,
  WaveFrameManifest,
  WavePipeMeta,
  WaveSizeField,
} from "../../state/types";

interface Props {
  packed: WaveCapturePacked;
  frameIdx: number;
  field: WaveField;
  sizeField: WaveSizeField;
  cylField: WaveCylField;
}

export function SchematicView({ packed, frameIdx, field, sizeField, cylField }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [layout, setLayout] = useState<SchematicLayout | null>(null);

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
      // setTransform is idempotent; scale() is cumulative. Use setTransform so
      // any future code that doesn't reassign canvas.width can't accidentally
      // double-scale.
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      setLayout(layoutSchematic(packed.manifest, w, h));
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
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(ctx, layout, packed, frameIdx, field, sizeField, cylField);
  }, [packed, frameIdx, field, sizeField, cylField, layout]);

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
  const { width, height, tiers, cylinderCenters, cylinderColumnX, cylinderBaseR } = layout;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0E0E10";
  ctx.fillRect(0, 0, width, height);

  // Draw connection paths between tiers FIRST so pipes/cylinders sit on top.
  drawConnections(ctx, layout, packed.manifest);

  for (const tier of tiers) {
    if (tier.kind === "wide-pipe") {
      drawWidePipe(ctx, packed, frameIdx, tier.pipe.index, field, sizeField, tier.pipeRect);
    } else if (tier.kind === "branch-pipes") {
      for (let i = 0; i < tier.pipes.length; i++) {
        drawBranchPipe(ctx, packed, frameIdx, tier.pipes[i]!.index, field, sizeField, tier.pipeRects[i]!);
      }
    }
  }

  for (let ci = 0; ci < packed.manifest.nCylinders; ci++) {
    drawCylinder(ctx, packed, frameIdx, ci, cylField, cylinderColumnX, cylinderCenters[ci]!, cylinderBaseR);
  }

  // INTAKE on left side (vertical text), EXHAUST on right side.
  ctx.fillStyle = "#5A5F66";
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.save();
  ctx.translate(10, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("INTAKE", 0, 0);
  ctx.restore();
  ctx.save();
  ctx.translate(width - 10, height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillText("EXHAUST", 0, 0);
  ctx.restore();
}

function drawConnections(
  ctx: CanvasRenderingContext2D,
  layout: SchematicLayout,
  _manifest: WaveFrameManifest,
) {
  ctx.strokeStyle = "#3A3F47";
  ctx.lineWidth = 1.5;

  const wide = (role: "plenum" | "collector") =>
    layout.tiers.find((t) => t.kind === "wide-pipe" && t.role === role);
  const branch = (role: "runner" | "primary" | "secondary") =>
    layout.tiers.find((t) => t.kind === "branch-pipes" && t.role === role);

  const plenum = wide("plenum");
  const runners = branch("runner");
  const primaries = branch("primary");
  const secondaries = branch("secondary");
  const collector = wide("collector");

  // Plenum → Runners: horizontal segments from plenum's right edge to each runner's left edge.
  if (plenum && plenum.kind === "wide-pipe" && runners && runners.kind === "branch-pipes") {
    const plenumRight = plenum.pipeRect.x + plenum.pipeRect.w;
    for (const r of runners.pipeRects) {
      const cy = r.y + r.h / 2;
      ctx.beginPath();
      ctx.moveTo(plenumRight, cy);
      ctx.lineTo(r.x, cy);
      ctx.stroke();
    }
  }

  // Runners → Cylinders: horizontal segments from runner right → cylinder left edge.
  if (runners && runners.kind === "branch-pipes") {
    for (let i = 0; i < runners.pipeRects.length; i++) {
      const r = runners.pipeRects[i]!;
      const cy = r.y + r.h / 2;
      const cylLeft = layout.cylinderColumnX - layout.cylinderBaseR;
      ctx.beginPath();
      ctx.moveTo(r.x + r.w, cy);
      ctx.lineTo(cylLeft, cy);
      ctx.stroke();
    }
  }

  // Cylinders → Primaries: horizontal segments from cylinder right → primary left.
  if (primaries && primaries.kind === "branch-pipes") {
    for (let i = 0; i < primaries.pipeRects.length; i++) {
      const p = primaries.pipeRects[i]!;
      const cy = p.y + p.h / 2;
      const cylRight = layout.cylinderColumnX + layout.cylinderBaseR;
      ctx.beginPath();
      ctx.moveTo(cylRight, cy);
      ctx.lineTo(p.x, cy);
      ctx.stroke();
    }
  }

  // Primaries → Secondaries (4-2-1 angled) OR Primaries → Collector (4-1).
  if (primaries && primaries.kind === "branch-pipes") {
    const has421 =
      secondaries && secondaries.kind === "branch-pipes" &&
      primaries.pipeRects.length === 4 && secondaries.pipeRects.length === 2;
    if (has421 && secondaries && secondaries.kind === "branch-pipes") {
      // TODO: read pairing from manifest. For SDM26 4-cyl
      // (crates/engine-sim/src/model/sdm26.rs:686-699):
      //   primary[0] + primary[3] → secondary[0]
      //   primary[1] + primary[2] → secondary[1]
      const pairing: Array<[number, number]> = [[0, 0], [1, 1], [2, 1], [3, 0]];
      for (const [pi, si] of pairing) {
        const p = primaries.pipeRects[pi]!;
        const s = secondaries.pipeRects[si]!;
        const startX = p.x + p.w;
        const startY = p.y + p.h / 2;
        const endX = s.x;
        const endY = s.y + s.h / 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
    } else if (collector && collector.kind === "wide-pipe") {
      for (const p of primaries.pipeRects) {
        const cy = p.y + p.h / 2;
        ctx.beginPath();
        ctx.moveTo(p.x + p.w, cy);
        ctx.lineTo(collector.pipeRect.x, cy);
        ctx.stroke();
      }
    }
  }

  // Secondaries → Collector: horizontal segments.
  if (secondaries && secondaries.kind === "branch-pipes" && collector && collector.kind === "wide-pipe") {
    for (const s of secondaries.pipeRects) {
      const cy = s.y + s.h / 2;
      ctx.beginPath();
      ctx.moveTo(s.x + s.w, cy);
      ctx.lineTo(collector.pipeRect.x, cy);
      ctx.stroke();
    }
  }
}

function labelForPipe(meta: WavePipeMeta): string {
  // Compact display: "plenum", "R1", "P3", "S2", "collector"
  const m = meta.label.match(/^(runner|primary|secondary)_(\d+)$/);
  if (m) {
    const tag = m[1]!.charAt(0).toUpperCase();
    return `${tag}${m[2]}`;
  }
  return meta.label;
}

function fieldArr(packed: WaveCapturePacked, pipeIdx: number, field: WaveField): {
  read: (frameIdx: number, cellIdx: number) => number;
  range: { min: number; max: number };
  nCells: number;
} {
  const nCells = packed.manifest.pipes[pipeIdx]!.nCells;
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
    return {
      read: (f, c) => computeMach(u[f * nCells + c]!, T[f * nCells + c]!),
      range: { min: mn, max: mx },
      nCells,
    };
  }
  const idx = PIPE_FIELD_IDX[field as Exclude<WaveField, "Mach">];
  const arr = packed.pipeArr[pipeIdx]![idx]!;
  return {
    read: (f, c) => arr[f * nCells + c]!,
    range: packed.pipeRange[pipeIdx]![idx]!,
    nCells,
  };
}

// "Wide" pipe (plenum/collector) — vertical strip; cells stack down Y; size bulges in X.
function drawWidePipe(
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
  // Label centered above the pipe.
  ctx.fillStyle = "#9097A0";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(labelForPipe(packed.manifest.pipes[pipeIdx]!), midX, rect.y - 2);
}

// "Branch" pipe (runner/primary/secondary) — horizontal strip; cells along X; size bulges in Y.
function drawBranchPipe(
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
  // Label above the strip (centered horizontally).
  ctx.fillStyle = "#9097A0";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(labelForPipe(packed.manifest.pipes[pipeIdx]!), rect.x + rect.w / 2, rect.y - 2);
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
  const boreSide = baseR * 2;
  const boreX = cx - boreSide / 2;
  const boreY = cy - boreSide / 2;

  // Read cylinder volume to position piston.
  const vArr = packed.cylArr[ci]![CYL_FIELD_IDX.V]!;
  const vRange = packed.cylRange[ci]![CYL_FIELD_IDX.V]!;
  const V = vArr[frameIdx]!;
  const vSpan = (vRange.max - vRange.min) || 1;
  const vNorm = clamp01((V - vRange.min) / vSpan);

  // Piston geometry: top of bore at vNorm=0 (TDC), bottom at vNorm=1 (BDC).
  const pistonH = boreSide * 0.12;
  const pistonInset = boreSide * 0.06;
  const pistonX = boreX + pistonInset;
  const pistonW = boreSide - 2 * pistonInset;
  const pistonRange = boreSide - pistonH; // distance piston can travel
  const pistonY = boreY + vNorm * pistonRange;

  // Cyl-field color for chamber.
  // Pipe pressures swing ±10 kPa around atm → diverging RdBu_r works.
  // Cylinder pressure swings 1→50 atm (asymmetric) → use sequential
  // inferno over the observed range, not diverging-around-atm.
  // For p specifically, take log so the chamber isn't black 90% of the
  // cycle (linear would map most frames to "near min").
  const fIdx = cylField === "x_b" ? CYL_FIELD_IDX.x_b
             : cylField === "p"   ? CYL_FIELD_IDX.p
             : CYL_FIELD_IDX.T;
  const fArr = packed.cylArr[ci]![fIdx]!;
  const fRangeObs = packed.cylRange[ci]![fIdx]!;
  const f = fArr[frameIdx]!;
  const cmapName =
    cylField === "x_b" ? "viridis" : "inferno";
  let tC: number;
  if (cylField === "x_b") {
    tC = clamp01(f);
  } else if (cylField === "p") {
    const logMin = Math.log(Math.max(fRangeObs.min, 1));
    const logMax = Math.log(Math.max(fRangeObs.max, 1));
    const logSpan = logMax - logMin || 1;
    tC = clamp01((Math.log(Math.max(f, 1)) - logMin) / logSpan);
  } else {
    tC = clamp01((f - fRangeObs.min) / (fRangeObs.max - fRangeObs.min || 1));
  }
  const [rr, gg, bb] = sampleColormap(cmapName, tC);

  // Stroke detection. Key insight: x_b absolute value is misleading at
  // stroke boundaries because residual burned gas stays at x_b ≈ 1
  // through the entire exhaust stroke AND into the start of intake
  // (until fresh air dilutes it). So "x_b > 0.5 + V rising" is NOT
  // power — it's frequently early intake.
  //
  // Reliable approach: use d(x_b)/dt as the primary signal.
  //   d(x_b)/dt > +eps  → combustion in progress  → POWER
  //   d(x_b)/dt < -eps  → fresh-charge refill     → INTAKE
  // When |d(x_b)/dt| is small (x_b stable), fall back to V-direction +
  // x_b magnitude:
  //   V rising  + x_b high → POWER (after combustion peak)
  //   V rising  + x_b low  → INTAKE (after refill completed)
  //   V falling + x_b high → EXHAUST
  //   V falling + x_b low  → COMPRESSION
  const xbArr = packed.cylArr[ci]![CYL_FIELD_IDX.x_b]!;
  const xbNow = xbArr[frameIdx]!;
  const back = Math.max(0, frameIdx - 10);
  const dV = V - vArr[back]!;
  const dxb = xbNow - xbArr[back]!;
  const dxbEps = 0.02;
  let stroke: "INTAKE" | "COMPRESSION" | "POWER" | "EXHAUST";
  if (dxb > dxbEps) {
    stroke = "POWER";
  } else if (dxb < -dxbEps) {
    stroke = "INTAKE";
  } else if (dV >= 0) {
    stroke = xbNow > 0.5 ? "POWER" : "INTAKE";
  } else {
    stroke = xbNow > 0.5 ? "EXHAUST" : "COMPRESSION";
  }
  const strokeColor =
    stroke === "INTAKE"      ? "#4FC3F7" :
    stroke === "COMPRESSION" ? "#9097A0" :
    stroke === "POWER"       ? "#FFAB40" :
                               "#FF8A65";

  // Bore background (crankcase / below-piston region) — match canvas bg.
  ctx.fillStyle = "#0E0E10";
  ctx.fillRect(boreX, boreY, boreSide, boreSide);

  // Chamber above piston, colored by cylField.
  ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
  ctx.fillRect(boreX + pistonInset, boreY, pistonW, pistonY - boreY);

  // Piston body.
  ctx.fillStyle = "#9097A0";
  ctx.fillRect(pistonX, pistonY, pistonW, pistonH);
  ctx.strokeStyle = "#2A2C32";
  ctx.lineWidth = 1;
  ctx.strokeRect(pistonX, pistonY, pistonW, pistonH);

  // Bore outline.
  ctx.strokeStyle = "#5A5F66";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(boreX, boreY, boreSide, boreSide);

  // Cylinder number above bore.
  ctx.fillStyle = "#9097A0";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`C${ci + 1}`, cx, boreY - 4);

  // Stroke label below bore, color-coded so it pops at a glance.
  ctx.fillStyle = strokeColor;
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(stroke, cx, boreY + boreSide + 4);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
