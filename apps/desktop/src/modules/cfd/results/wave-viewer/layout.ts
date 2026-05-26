// layout.ts
//
// Pure layout function for the schematic view. Airflow runs left → right:
//   plenum (left wide pipe) → runners (branch pipes) → cylinders (column)
//   → primaries (branch pipes) → secondaries (branch pipes) → collector (right wide pipe)
//
// "wide-pipe"     = single pipe spanning the tier's full height, drawn vertically
//                   (plenum, collector).
// "branch-pipes"  = multiple parallel pipes stacked vertically inside the tier,
//                   each drawn horizontally (runners, primaries, secondaries).
// "cyl-column"    = a vertical stack of cylinder squares.

import type { WaveFrameManifest, WavePipeMeta } from "../../state/types";

export interface Rect { x: number; y: number; w: number; h: number; }

export type SchematicTier =
  | { kind: "wide-pipe";     role: "plenum" | "collector";              bounds: Rect; pipe: WavePipeMeta; pipeRect: Rect }
  | { kind: "branch-pipes";  role: "runner" | "primary" | "secondary";  bounds: Rect; pipeRects: Rect[]; pipes: WavePipeMeta[] }
  | { kind: "cyl-column";    bounds: Rect };

export interface SchematicLayout {
  tiers: SchematicTier[];
  /** Y-center for each cylinder, top to bottom. Length === nCylinders. */
  cylinderCenters: number[];
  /** X-center of the cylinder column. */
  cylinderColumnX: number;
  /** Half-side of the cylinder bore square. */
  cylinderBaseR: number;
  width: number;
  height: number;
}

const PAD_X = 16;
const PAD_Y = 24;

type TierDef =
  | { kind: "wide-pipe"; pipe: WavePipeMeta; weight: number }
  | { kind: "branch-pipes"; pipes: WavePipeMeta[]; weight: number }
  | { kind: "cyl-column"; weight: number };

export function layoutSchematic(
  manifest: WaveFrameManifest,
  width: number,
  height: number,
): SchematicLayout {
  const by = groupByRole(manifest.pipes);
  const plenum = by.plenum[0];
  const collector = by.collector[0];
  const runners = by.runner;
  const primaries = by.primary;
  const secondaries = by.secondary;
  const nCyl = manifest.nCylinders;

  // Degenerate inputs → empty layout (caller skips draw).
  if (nCyl < 1 || width < 48 || height < 32) {
    return {
      tiers: [],
      cylinderCenters: [],
      cylinderColumnX: Math.max(0, width / 2),
      cylinderBaseR: 0,
      width,
      height,
    };
  }

  const tierDefs: TierDef[] = [];
  if (plenum)                  tierDefs.push({ kind: "wide-pipe",    pipe: plenum,                  weight: 1 });
  if (runners.length > 0)      tierDefs.push({ kind: "branch-pipes", pipes: runners,                weight: 2 });
                               tierDefs.push({ kind: "cyl-column",                                  weight: 1 });
  if (primaries.length > 0)    tierDefs.push({ kind: "branch-pipes", pipes: primaries,              weight: 2 });
  if (secondaries.length > 0)  tierDefs.push({ kind: "branch-pipes", pipes: secondaries,            weight: 2 });
  if (collector)               tierDefs.push({ kind: "wide-pipe",    pipe: collector,               weight: 1 });

  const totalWeight = tierDefs.reduce((s, t) => s + t.weight, 0);
  const innerH = height - 2 * PAD_Y;
  const innerW = width - 2 * PAD_X;

  // Cylinder Y centers: nCyl evenly-spaced rows across innerH.
  const rowH = innerH / nCyl;
  const cylinderCenters: number[] = [];
  for (let i = 0; i < nCyl; i++) {
    cylinderCenters.push(PAD_Y + rowH * (i + 0.5));
  }

  const tiers: SchematicTier[] = [];
  let xCursor = PAD_X;
  let cylinderColumnX = width / 2;
  let cylinderBaseR = 16;

  for (const def of tierDefs) {
    const tierW = innerW * (def.weight / totalWeight);
    const bounds: Rect = { x: xCursor, y: PAD_Y, w: tierW, h: innerH };

    if (def.kind === "wide-pipe") {
      // Vertical strip in the middle of the tier.
      const pipeW = Math.max(12, tierW * 0.6);
      const pipeRect: Rect = {
        x: xCursor + (tierW - pipeW) / 2,
        y: PAD_Y,
        w: pipeW,
        h: innerH,
      };
      const role = def.pipe.role as "plenum" | "collector";
      tiers.push({ kind: "wide-pipe", role, bounds, pipe: def.pipe, pipeRect });
    } else if (def.kind === "branch-pipes") {
      const role = def.pipes[0]!.role as "runner" | "primary" | "secondary";
      const pipeRects: Rect[] = [];
      if (role === "runner" || role === "primary") {
        // Align with cylinder rows.
        const stripH = Math.min(32, rowH * 0.4);
        for (let i = 0; i < def.pipes.length; i++) {
          const cy = cylinderCenters[i] ?? (PAD_Y + rowH * (i + 0.5));
          pipeRects.push({
            x: xCursor + tierW * 0.1,
            y: cy - stripH / 2,
            w: tierW * 0.8,
            h: stripH,
          });
        }
      } else {
        // Secondaries: evenly spaced across the column.
        const m = def.pipes.length;
        const stripH = Math.min(32, (innerH / m) * 0.35);
        for (let i = 0; i < m; i++) {
          const cy = PAD_Y + (innerH / m) * (i + 0.5);
          pipeRects.push({
            x: xCursor + tierW * 0.1,
            y: cy - stripH / 2,
            w: tierW * 0.8,
            h: stripH,
          });
        }
      }
      tiers.push({ kind: "branch-pipes", role, bounds, pipeRects, pipes: def.pipes });
    } else {
      // cyl-column tier
      cylinderColumnX = xCursor + tierW / 2;
      cylinderBaseR = Math.min(rowH * 0.35, tierW * 0.30, 48);
      tiers.push({ kind: "cyl-column", bounds });
    }
    xCursor += tierW;
  }

  return { tiers, cylinderCenters, cylinderColumnX, cylinderBaseR, width, height };
}

function groupByRole(pipes: WavePipeMeta[]): {
  plenum: WavePipeMeta[];
  runner: WavePipeMeta[];
  primary: WavePipeMeta[];
  secondary: WavePipeMeta[];
  collector: WavePipeMeta[];
} {
  const acc = { plenum: [] as WavePipeMeta[], runner: [] as WavePipeMeta[], primary: [] as WavePipeMeta[], secondary: [] as WavePipeMeta[], collector: [] as WavePipeMeta[] };
  for (const p of pipes) {
    acc[p.role].push(p);
  }
  return acc;
}
