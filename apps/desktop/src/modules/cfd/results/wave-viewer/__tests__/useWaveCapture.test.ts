import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWaveCapture } from "../useWaveCapture";

function makeRawResponse() {
  const manifest = {
    jobId: "test", rpm: 8000, nPipes: 2, pipes: [
      { role: "plenum", label: "plenum", nCells: 3, lengthM: 0.2, index: 0 },
      { role: "collector", label: "collector", nCells: 3, lengthM: 0.3, index: 1 },
    ], nCylinders: 1, stepStride: 100,
    fields: ["rho", "u", "p", "T"], frameCount: 2,
    thetaStartDeg: 0, thetaEndDeg: 720, capturedCycle: 1, incomplete: false,
  };
  const frames = [
    {
      theta: 0, t_ms: 0,
      pipes: [
        [[1.0,1.0,1.0],[0.0,0.0,0.0],[101325,101325,101325],[300,300,300]],
        [[1.0,1.0,1.0],[0.0,0.0,0.0],[101325,101325,101325],[800,800,800]],
      ],
      cyl: [{ v: 5e-5, p: 101325, t: 300, x_b: 0 }],
    },
    {
      theta: 360, t_ms: 7.5,
      pipes: [
        [[1.2,1.1,1.0],[5.0,4.0,3.0],[110000,108000,105000],[320,315,310]],
        [[0.9,0.95,1.0],[-2.0,-1.0,0.0],[99000,100000,101000],[820,810,800]],
      ],
      cyl: [{ v: 4e-5, p: 250000, t: 1200, x_b: 0.5 }],
    },
  ];
  return { manifest, frames };
}

describe("useWaveCapture", () => {
  it("packs frames into typed arrays with correct ranges", async () => {
    const bridge = {
      loadWaves: vi.fn().mockResolvedValue(makeRawResponse()),
    } as any;

    const { result } = renderHook(() => useWaveCapture(bridge, "test", "single-rpm", 8000));

    await waitFor(() => expect(result.current.state).toBe("ready"));
    const d = result.current.data!;
    expect(d.manifest.frameCount).toBe(2);
    expect(d.theta).toBeInstanceOf(Float32Array);
    expect(d.theta).toHaveLength(2);
    expect(d.theta[0]).toBeCloseTo(0);
    expect(d.theta[1]).toBeCloseTo(360);
    expect(d.pipeArr[0]![2]!).toHaveLength(6);
    expect(d.pipeArr[0]![2]![0]).toBeCloseTo(101325);
    expect(d.pipeArr[0]![2]![5]).toBeCloseTo(105000);
    expect(d.pipeRange[0]![2]!.min).toBeCloseTo(101325);
    expect(d.pipeRange[0]![2]!.max).toBeCloseTo(110000);
    expect(d.cylArr[0]![1]!).toHaveLength(2);
    expect(d.cylArr[0]![1]![1]).toBeCloseTo(250000);
  });

  it("surfaces bridge errors", async () => {
    const bridge = {
      loadWaves: vi.fn().mockRejectedValue(new Error("boom")),
    } as any;
    const { result } = renderHook(() => useWaveCapture(bridge, "x", "single-rpm", 8000));
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toContain("boom");
  });

  it("re-loads when (jobId, studyKind, rpmInt) changes", async () => {
    const bridge = {
      loadWaves: vi.fn().mockResolvedValue(makeRawResponse()),
    } as any;
    const { result, rerender } = renderHook(
      ({ rpm }: { rpm: number }) => useWaveCapture(bridge, "test", "single-rpm", rpm),
      { initialProps: { rpm: 8000 } },
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    rerender({ rpm: 10000 });
    await waitFor(() => expect(bridge.loadWaves).toHaveBeenCalledTimes(2));
  });

  it("ignores results that arrived after a re-render", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstPromise = new Promise<unknown>((r) => { resolveFirst = r; });
    const bridge = {
      loadWaves: vi.fn()
        .mockImplementationOnce(() => firstPromise)
        .mockResolvedValueOnce(makeRawResponse()),
    } as any;
    const { result, rerender } = renderHook(
      ({ rpm }: { rpm: number }) => useWaveCapture(bridge, "test", "single-rpm", rpm),
      { initialProps: { rpm: 8000 } },
    );
    rerender({ rpm: 10000 });
    resolveFirst({ manifest: { ...makeRawResponse().manifest, rpm: 9999 }, frames: [] });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.data?.manifest.rpm).toBe(8000);
  });

  it("transitions to error state when the bridge returns a malformed payload (frame count mismatch)", async () => {
    const malformed = {
      manifest: { ...makeRawResponse().manifest, frameCount: 10 },
      frames: makeRawResponse().frames, // only 2 frames, but manifest says 10
    };
    const bridge = {
      loadWaves: vi.fn().mockResolvedValue(malformed),
    } as any;
    const { result } = renderHook(() => useWaveCapture(bridge, "test", "single-rpm", 8000));
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toContain("frame count mismatch");
  });
});
