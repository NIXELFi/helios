// useWaveCapture.ts

import { useEffect, useRef, useState } from "react";

import type {
  RawWaveFrame,
  WaveCapturePacked,
  WaveFrameManifest,
} from "../../state/types";

interface Bridge {
  loadWaves(
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
  ): Promise<unknown>;
}

type LoadState = "idle" | "loading" | "ready" | "error";

interface LoaderResult {
  state: LoadState;
  data: WaveCapturePacked | null;
  error: string | null;
}

export function useWaveCapture(
  bridge: Bridge,
  jobId: string,
  studyKind: "single-rpm" | "sweep",
  rpmInt: number,
): LoaderResult {
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<WaveCapturePacked | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lastEffectId = useRef(0);

  useEffect(() => {
    const myId = ++lastEffectId.current;
    setState("loading");
    setData(null);
    setError(null);

    bridge.loadWaves(jobId, studyKind, rpmInt)
      .then((raw) => {
        if (myId !== lastEffectId.current) return;
        const packed = packResponse(raw);
        setData(packed);
        setState("ready");
      })
      .catch((err) => {
        if (myId !== lastEffectId.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      });
  }, [bridge, jobId, studyKind, rpmInt]);

  return { state, data, error };
}

function packResponse(raw: unknown): WaveCapturePacked {
  const obj = raw as { manifest: WaveFrameManifest; frames: RawWaveFrame[] };
  const m = obj.manifest;
  const nFrames = obj.frames.length;
  if (nFrames !== m.frameCount) {
    throw new Error(`frame count mismatch in client: manifest=${m.frameCount}, payload=${nFrames}`);
  }

  const theta = new Float32Array(nFrames);
  const tMs = new Float32Array(nFrames);
  const pipeArr: Float32Array[][] = m.pipes.map((p) =>
    Array.from({ length: 4 }, () => new Float32Array(nFrames * p.nCells)),
  );
  const cylArr: Float32Array[][] = Array.from({ length: m.nCylinders }, () =>
    Array.from({ length: 4 }, () => new Float32Array(nFrames)),
  );
  const pipeRange = m.pipes.map(() =>
    Array.from({ length: 4 }, () => ({ min: Infinity, max: -Infinity })),
  );
  const cylRange = Array.from({ length: m.nCylinders }, () =>
    Array.from({ length: 4 }, () => ({ min: Infinity, max: -Infinity })),
  );

  for (let f = 0; f < nFrames; f++) {
    const fr = obj.frames[f]!;
    theta[f] = fr.theta;
    tMs[f] = fr.t_ms;

    for (let pi = 0; pi < m.pipes.length; pi++) {
      const meta = m.pipes[pi]!;
      const pipeFrame = fr.pipes[pi]!;
      for (let field = 0; field < 4; field++) {
        const dest = pipeArr[pi]![field]!;
        const src = pipeFrame[field]!;
        const offset = f * meta.nCells;
        for (let c = 0; c < meta.nCells; c++) {
          const v = src[c]!;
          dest[offset + c] = v;
          const range = pipeRange[pi]![field]!;
          if (v < range.min) range.min = v;
          if (v > range.max) range.max = v;
        }
      }
    }

    for (let ci = 0; ci < m.nCylinders; ci++) {
      const c = fr.cyl[ci]!;
      const vals = [c.v, c.p, c.t, c.x_b];
      for (let field = 0; field < 4; field++) {
        cylArr[ci]![field]![f] = vals[field]!;
        const range = cylRange[ci]![field]!;
        if (vals[field]! < range.min) range.min = vals[field]!;
        if (vals[field]! > range.max) range.max = vals[field]!;
      }
    }
  }

  for (const pr of pipeRange) {
    for (const r of pr) {
      if (!Number.isFinite(r.min)) r.min = 0;
      if (!Number.isFinite(r.max)) r.max = 1;
    }
  }
  for (const cr of cylRange) {
    for (const r of cr) {
      if (!Number.isFinite(r.min)) r.min = 0;
      if (!Number.isFinite(r.max)) r.max = 1;
    }
  }

  return { manifest: m, theta, tMs, pipeArr, cylArr, pipeRange, cylRange };
}
