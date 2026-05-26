import { describe, expect, it } from "vitest";
import { layoutSchematic, type SchematicLayout } from "../layout";
import type { WaveFrameManifest, WavePipeMeta } from "../../../state/types";

function makeManifest(pipes: WavePipeMeta[], nCylinders: number): WaveFrameManifest {
  return {
    jobId: "test",
    rpm: 8000,
    nPipes: pipes.length,
    pipes,
    nCylinders,
    stepStride: 200,
    fields: ["rho", "u", "p", "T"],
    frameCount: 600,
    thetaStartDeg: 0,
    thetaEndDeg: 720,
    capturedCycle: 1,
    incomplete: false,
  };
}

const SDM26_PIPES: WavePipeMeta[] = [
  { role: "plenum",    label: "plenum",      nCells: 60, lengthM: 0.30, index: 0 },
  { role: "runner",    label: "runner_1",    nCells: 20, lengthM: 0.10, index: 1 },
  { role: "runner",    label: "runner_2",    nCells: 20, lengthM: 0.10, index: 2 },
  { role: "runner",    label: "runner_3",    nCells: 20, lengthM: 0.10, index: 3 },
  { role: "runner",    label: "runner_4",    nCells: 20, lengthM: 0.10, index: 4 },
  { role: "primary",   label: "primary_1",   nCells: 30, lengthM: 0.25, index: 5 },
  { role: "primary",   label: "primary_2",   nCells: 30, lengthM: 0.25, index: 6 },
  { role: "primary",   label: "primary_3",   nCells: 30, lengthM: 0.25, index: 7 },
  { role: "primary",   label: "primary_4",   nCells: 30, lengthM: 0.25, index: 8 },
  { role: "secondary", label: "secondary_1", nCells: 30, lengthM: 0.30, index: 9 },
  { role: "secondary", label: "secondary_2", nCells: 30, lengthM: 0.30, index: 10 },
  { role: "collector", label: "collector",   nCells: 40, lengthM: 0.40, index: 11 },
];

describe("layoutSchematic", () => {
  it("produces 6 tiers for SDM26-style 4-2-1", () => {
    const layout = layoutSchematic(makeManifest(SDM26_PIPES, 4), 1600, 900);
    expect(layout.tiers).toHaveLength(6);
    expect(layout.cylinderCenters).toHaveLength(4);
  });

  it("aligns cylinder X-centers with runner and primary column centers", () => {
    const layout = layoutSchematic(makeManifest(SDM26_PIPES, 4), 1600, 900);
    const runnerTier = layout.tiers.find((t) => t.kind === "vert-pipes" && t.role === "runner")!;
    const primaryTier = layout.tiers.find((t) => t.kind === "vert-pipes" && t.role === "primary")!;
    expect(runnerTier).toBeDefined();
    expect(primaryTier).toBeDefined();
    if (runnerTier.kind !== "vert-pipes" || primaryTier.kind !== "vert-pipes") throw new Error();
    expect(runnerTier.pipeRects).toHaveLength(4);
    expect(primaryTier.pipeRects).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const runnerCx = runnerTier.pipeRects[i]!.x + runnerTier.pipeRects[i]!.w / 2;
      const primaryCx = primaryTier.pipeRects[i]!.x + primaryTier.pipeRects[i]!.w / 2;
      const cylCx = layout.cylinderCenters[i]!;
      expect(Math.abs(runnerCx - cylCx)).toBeLessThan(1);
      expect(Math.abs(primaryCx - cylCx)).toBeLessThan(1);
    }
  });

  it("collapses missing secondary tier for 1-cyl 1-1 engine", () => {
    const pipes: WavePipeMeta[] = [
      { role: "plenum",    label: "plenum",    nCells: 30, lengthM: 0.15, index: 0 },
      { role: "runner",    label: "runner_1",  nCells: 15, lengthM: 0.10, index: 1 },
      { role: "primary",   label: "primary_1", nCells: 25, lengthM: 0.20, index: 2 },
      { role: "collector", label: "collector", nCells: 25, lengthM: 0.30, index: 3 },
    ];
    const layout = layoutSchematic(makeManifest(pipes, 1), 1600, 900);
    expect(layout.tiers).toHaveLength(5);
    expect(layout.cylinderCenters).toHaveLength(1);
  });

  it("returns tier rects that don't overlap and fit in canvas", () => {
    const W = 1600, H = 900;
    const layout = layoutSchematic(makeManifest(SDM26_PIPES, 4), W, H);
    let prevBottom = 0;
    for (const t of layout.tiers) {
      expect(t.bounds.y).toBeGreaterThanOrEqual(prevBottom - 1e-6);
      expect(t.bounds.y + t.bounds.h).toBeLessThanOrEqual(H + 1e-6);
      expect(t.bounds.x).toBeGreaterThanOrEqual(0);
      expect(t.bounds.x + t.bounds.w).toBeLessThanOrEqual(W + 1e-6);
      prevBottom = t.bounds.y + t.bounds.h;
    }
  });
});
