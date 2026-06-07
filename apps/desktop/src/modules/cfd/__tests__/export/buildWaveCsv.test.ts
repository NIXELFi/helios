// buildWaveFrameCsv: assert the current-frame-ONLY guard (a 2-frame capture
// exports 1 frame's worth of rows), the derived x_m column formula
// ((cell+0.5)/nCells × lengthM), the fixed column order, and out-of-range
// frame clamping. Inline-build a tiny WaveCapturePacked so we don't pull in the
// loader.

import { describe, expect, it } from "vitest";
import type { WaveCapturePacked, WaveFrameManifest } from "../../state/types";
import { buildWaveFrameCsv } from "../../lib/export/buildWaveCsv";

// One pipe, 2 cells, 2 frames. pipeArr[pipe][field] is Float32Array(frame*cell)
// row-major [frame][cell]; field order 0=rho,1=u,2=p,3=T.
function packed(): WaveCapturePacked {
  const manifest: WaveFrameManifest = {
    jobId: "j1", rpm: 8000, nPipes: 1,
    pipes: [{ role: "runner", label: "runner-0", nCells: 2, lengthM: 0.4, index: 0 }],
    nCylinders: 0, stepStride: 100, fields: ["rho", "u", "p", "T"],
    frameCount: 2, thetaStartDeg: 0, thetaEndDeg: 720, capturedCycle: 1, incomplete: false,
  };
  // frame 0 cells -> rho [1,2], u [3,4], p [5,6], T [7,8]
  // frame 1 cells -> rho [9,10] ... distinguishable from frame 0
  const f = (a: number, b: number, c: number, d: number) => new Float32Array([a, b, c, d]);
  const pipeArr = [[
    f(1, 2, 9, 10),  // rho: frame0=[1,2] frame1=[9,10]
    f(3, 4, 11, 12), // u
    f(5, 6, 13, 14), // p
    f(7, 8, 15, 16), // T
  ]];
  return {
    manifest,
    theta: new Float32Array([0, 360]),
    tMs: new Float32Array([0, 7.5]),
    pipeArr,
    cylArr: [],
    pipeRange: [[{ min: 0, max: 1 }, { min: 0, max: 1 }, { min: 0, max: 1 }, { min: 0, max: 1 }]],
    cylRange: [],
  };
}

const lines = (csv: string) => csv.split("\n");

describe("buildWaveFrameCsv", () => {
  it("exports ONE frame only: 2 header rows + nCells data rows", () => {
    const out = lines(buildWaveFrameCsv(packed(), 0));
    expect(out.length).toBe(4); // 2 header + 2 cells (single frame, not both)
    const header = out[0]!.split(",");
    expect(header).toEqual([
      "pipe_index", "pipe_label", "role", "cell", "x_m_derived", "rho", "u", "p", "T",
    ]);
    expect(out[1]).not.toBe(out[0]); // units row
  });

  it("reads the requested frame's values, not frame 0", () => {
    const out = lines(buildWaveFrameCsv(packed(), 1));
    const header = out[0]!.split(",");
    const rhoCol = header.indexOf("rho");
    // frame 1 rho cell 0 = 9
    expect(out[2]!.split(",")[rhoCol]).toBe("9.000000");
  });

  it("derives x_m as (cell+0.5)/nCells × lengthM", () => {
    const out = lines(buildWaveFrameCsv(packed(), 0));
    const header = out[0]!.split(",");
    const xCol = header.indexOf("x_m_derived");
    // nCells=2, lengthM=0.4 -> cell0: 0.5/2*0.4=0.1, cell1: 1.5/2*0.4=0.3
    expect(out[2]!.split(",")[xCol]).toBe("0.100000");
    expect(out[3]!.split(",")[xCol]).toBe("0.300000");
  });

  it("clamps an out-of-range frame index into bounds", () => {
    const high = lines(buildWaveFrameCsv(packed(), 99));
    const low = lines(buildWaveFrameCsv(packed(), -5));
    const header = high[0]!.split(",");
    const rhoCol = header.indexOf("rho");
    // 99 clamps to last frame (1) -> rho 9; -5 clamps to frame 0 -> rho 1
    expect(high[2]!.split(",")[rhoCol]).toBe("9.000000");
    expect(low[2]!.split(",")[rhoCol]).toBe("1.000000");
  });
});
