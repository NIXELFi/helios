// layout.ts
//
// Pure layout function for the schematic view. Given a manifest +
// canvas size, produces tier-by-tier bounding rects and cylinder column
// X centers. Renderer reads this and draws cells inside each pipe rect.

import type { WaveFrameManifest, WavePipeMeta } from "../../state/types";

export interface Rect { x: number; y: number; w: number; h: number; }

export type SchematicTier =
  | { kind: "horiz-pipe";    role: "plenum" | "collector"; bounds: Rect; pipe: WavePipeMeta; pipeRect: Rect }
  | { kind: "vert-pipes";    role: "runner" | "primary" | "secondary"; bounds: Rect; pipeRects: Rect[]; pipes: WavePipeMeta[] }
  | { kind: "cyl-row";       bounds: Rect };

export interface SchematicLayout {
  tiers: SchematicTier[];
  /** X-center for each cylinder column. Length === nCylinders. */
  cylinderCenters: number[];
  cylinderRowY: number;
  cylinderBaseR: number;
  width: number;
  height: number;
}

const PAD_X = 24;
const PAD_Y = 16;

type TierDef =
  | { kind: "horiz-pipe"; pipe: WavePipeMeta; weight: number }
  | { kind: "vert-pipes"; pipes: WavePipeMeta[]; weight: number }
  | { kind: "cyl-row"; weight: number };

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

  const tierDefs: TierDef[] = [];
  if (plenum)                tierDefs.push({ kind: "horiz-pipe", pipe: plenum,     weight: 1 });
  if (runners.length > 0)    tierDefs.push({ kind: "vert-pipes", pipes: runners,   weight: 2 });
                             tierDefs.push({ kind: "cyl-row",                       weight: 1 });
  if (primaries.length > 0)  tierDefs.push({ kind: "vert-pipes", pipes: primaries, weight: 2 });
  if (secondaries.length > 0) tierDefs.push({ kind: "vert-pipes", pipes: secondaries, weight: 2 });
  if (collector)             tierDefs.push({ kind: "horiz-pipe", pipe: collector,  weight: 1 });

  const totalWeight = tierDefs.reduce((s, t) => s + t.weight, 0);
  const innerH = height - 2 * PAD_Y;
  const innerW = width - 2 * PAD_X;

  const colW = innerW / nCyl;
  const cylinderCenters: number[] = [];
  for (let i = 0; i < nCyl; i++) {
    cylinderCenters.push(PAD_X + colW * (i + 0.5));
  }

  const tiers: SchematicTier[] = [];
  let yCursor = PAD_Y;
  let cylinderRowY = height / 2;
  let cylinderBaseR = 16;

  for (const def of tierDefs) {
    const tierH = innerH * (def.weight / totalWeight);
    const bounds: Rect = { x: PAD_X, y: yCursor, w: innerW, h: tierH };

    if (def.kind === "horiz-pipe") {
      const pipeH = Math.max(12, tierH * 0.6);
      const pipeRect: Rect = {
        x: PAD_X, y: yCursor + (tierH - pipeH) / 2,
        w: innerW, h: pipeH,
      };
      const role = def.pipe.role as "plenum" | "collector";
      tiers.push({ kind: "horiz-pipe", role, bounds, pipe: def.pipe, pipeRect });
    } else if (def.kind === "vert-pipes") {
      const role = def.pipes[0]!.role as "runner" | "primary" | "secondary";
      const pipeRects: Rect[] = [];
      if (role === "runner" || role === "primary") {
        const stripW = Math.min(32, colW * 0.4);
        for (let i = 0; i < def.pipes.length; i++) {
          const cx = cylinderCenters[i] ?? (PAD_X + colW * (i + 0.5));
          pipeRects.push({
            x: cx - stripW / 2,
            y: yCursor + tierH * 0.1,
            w: stripW,
            h: tierH * 0.8,
          });
        }
      } else {
        const m = def.pipes.length;
        const stripW = Math.min(32, (innerW / m) * 0.35);
        for (let i = 0; i < m; i++) {
          const cx = PAD_X + (innerW / m) * (i + 0.5);
          pipeRects.push({
            x: cx - stripW / 2,
            y: yCursor + tierH * 0.1,
            w: stripW,
            h: tierH * 0.8,
          });
        }
      }
      tiers.push({ kind: "vert-pipes", role, bounds, pipeRects, pipes: def.pipes });
    } else {
      cylinderRowY = yCursor + tierH / 2;
      cylinderBaseR = Math.min(tierH * 0.35, colW * 0.30, 48);
      tiers.push({ kind: "cyl-row", bounds });
    }
    yCursor += tierH;
  }

  return { tiers, cylinderCenters, cylinderRowY, cylinderBaseR, width, height };
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
