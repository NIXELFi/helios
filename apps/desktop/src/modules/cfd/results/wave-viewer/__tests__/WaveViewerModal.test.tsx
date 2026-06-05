import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the Tauri-touching io seam so export interactions stay in jsdom.
// saveTextFile/savePngFile resolve to a fake path (a chosen save dialog),
// fileTimestamp is pinned for deterministic filenames.
vi.mock("../../../lib/export/io", () => ({
  saveTextFile: vi.fn().mockResolvedValue("/tmp/out.csv"),
  savePngFile: vi.fn().mockResolvedValue("/tmp/out.png"),
  fileTimestamp: vi.fn(() => "20260605-120000"),
}));

import { saveTextFile, savePngFile } from "../../../lib/export/io";
import { buildWaveFrameCsv } from "../../../lib/export/buildWaveCsv";
import { WaveViewerModal } from "../WaveViewerModal";
import { SchematicView } from "../SchematicView";

function makeBridge(loadWaves = vi.fn()) {
  return { loadWaves } as any;
}

const dummyResponse = {
  manifest: {
    jobId: "j1", rpm: 8000, nPipes: 1,
    pipes: [{ role: "plenum", label: "plenum", nCells: 3, lengthM: 0.2, index: 0 }],
    nCylinders: 1, stepStride: 100,
    fields: ["rho", "u", "p", "T"], frameCount: 2,
    thetaStartDeg: 0, thetaEndDeg: 720, capturedCycle: 1, incomplete: false,
  },
  frames: [
    { theta: 0, t_ms: 0, pipes: [[[1,1,1],[0,0,0],[101325,101325,101325],[300,300,300]]], cyl: [{ v: 5e-5, p: 101325, t: 300, x_b: 0 }] },
    { theta: 360, t_ms: 7.5, pipes: [[[1,1,1],[0,0,0],[101325,101325,101325],[300,300,300]]], cyl: [{ v: 5e-5, p: 101325, t: 300, x_b: 0 }] },
  ],
};

describe("WaveViewerModal", () => {
  beforeEach(() => {
    vi.mocked(saveTextFile).mockClear();
    vi.mocked(savePngFile).mockClear();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(),
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
      scale: vi.fn(), setTransform: vi.fn(), createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(0) })),
      putImageData: vi.fn(), fillText: vi.fn(),
      fillStyle: "", strokeStyle: "", lineWidth: 1,
      font: "", textAlign: "start", textBaseline: "alphabetic",
    })) as any;
  });

  it("renders nothing when closed", () => {
    render(
      <WaveViewerModal open={false} bridge={makeBridge()} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads waves on open and renders Schematic by default", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalledWith("j1", "single-rpm", 8000));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/schematic/i)).toBeInTheDocument();
  });

  it("switches to Waterfall view on tab click and shows all pipes", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /waterfall/i }));
    // The waterfall view renders all pipes. With dummyResponse having a single
    // "plenum" pipe, that label should appear in the document.
    expect(screen.getByText(/plenum/i)).toBeInTheDocument();
  });

  it("calls onClose on close-button click", async () => {
    const onClose = vi.fn();
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={onClose} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders RPM dropdown for sweep studies and triggers re-load on change", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="sweep" rpmInt={8000} sweepCapturedRpms={[6000, 8000, 10000]} onClose={() => {}} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalledTimes(1));
    // The SelectField helper renders the label as a span without a trailing
    // colon (the visual treatment dropped the colon for the uppercase
    // tracking-wider chip style), so match on the bare label text.
    fireEvent.change(screen.getByLabelText(/rpm/i), { target: { value: "10000" } });
    await waitFor(() => expect(loadWaves).toHaveBeenCalledWith("j1", "sweep", 10000));
  });

  it("renders PNG + CSV export buttons once frames are ready", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /export png/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export csv frame/i })).toBeInTheDocument();
  });

  it("disables export buttons while frames are still loading", () => {
    // A never-resolving bridge keeps the modal in the loading state, so no
    // packed data exists and both export buttons must be disabled.
    const loadWaves = vi.fn(() => new Promise(() => {}));
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    expect(screen.getByRole("button", { name: /export png/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /export csv frame/i })).toBeDisabled();
  });

  it("CSV (frame) export calls saveTextFile with the builder output for the current frame", async () => {
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());

    const csvBtn = await screen.findByRole("button", { name: /export csv frame/i });
    await waitFor(() => expect(csvBtn).not.toBeDisabled());
    fireEvent.click(csvBtn);

    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    const [name, ext, contents] = vi.mocked(saveTextFile).mock.calls[0]!;
    expect(ext).toBe("csv");
    expect(String(name)).toContain("cfd-wave-8000rpm-f0-p-");
    // Contents must exactly match the pure builder for frame 0 (current frame).
    const packedFromBridge = packDummy(dummyResponse);
    expect(contents).toBe(buildWaveFrameCsv(packedFromBridge, 0));
    // Success feedback surfaces inline.
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("PNG export is enabled once the schematic canvas mounts and reports the canvas via onCanvasRef", async () => {
    // toBlob exists in our mocked canvas path → button stays enabled and a
    // real capture would proceed. We assert the button is enabled (proving the
    // onCanvasRef callback fired with a non-null canvas element, flipping
    // hasCanvas true).
    const loadWaves = vi.fn().mockResolvedValue(dummyResponse);
    render(
      <WaveViewerModal open bridge={makeBridge(loadWaves)} jobId="j1" studyKind="single-rpm" rpmInt={8000} onClose={() => {}} />
    );
    await waitFor(() => expect(loadWaves).toHaveBeenCalled());
    const pngBtn = await screen.findByRole("button", { name: /export png/i });
    await waitFor(() => expect(pngBtn).not.toBeDisabled());
  });

  it("onCanvasRef is fired with a canvas element when SchematicView mounts", () => {
    // Direct unit assertion on the plumbing: mount SchematicView and confirm the
    // callback receives an actual <canvas> element (the modal relies on this to
    // capture PNGs of the active view).
    const onCanvasRef = vi.fn();
    render(
      <SchematicView
        packed={packDummy(dummyResponse)}
        frameIdx={0}
        field="p"
        sizeField="p"
        cylField="p"
        onCanvasRef={onCanvasRef}
      />
    );
    expect(onCanvasRef).toHaveBeenCalled();
    const el = onCanvasRef.mock.calls.find((c) => c[0] != null)?.[0];
    expect(el).toBeInstanceOf(HTMLCanvasElement);
  });
});

// Minimal client-side re-pack of the dummy bridge response, mirroring
// useWaveCapture's packResponse so tests can assert against the same packed
// shape the modal feeds to buildWaveFrameCsv. Only the pipe rho/u/p/T arrays
// (used by the wave-frame CSV builder) need to be faithful here.
function packDummy(resp: typeof dummyResponse) {
  const m = resp.manifest;
  const nFrames = resp.frames.length;
  const pipeArr = m.pipes.map((p) =>
    Array.from({ length: 4 }, () => new Float32Array(nFrames * p.nCells)),
  );
  const cylArr = Array.from({ length: m.nCylinders }, () =>
    Array.from({ length: 4 }, () => new Float32Array(nFrames)),
  );
  const pipeRange = m.pipes.map(() =>
    Array.from({ length: 4 }, () => ({ min: 0, max: 1 })),
  );
  const cylRange = Array.from({ length: m.nCylinders }, () =>
    Array.from({ length: 4 }, () => ({ min: 0, max: 1 })),
  );
  const theta = new Float32Array(nFrames);
  const tMs = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const fr = resp.frames[f]!;
    theta[f] = fr.theta;
    tMs[f] = fr.t_ms;
    for (let pi = 0; pi < m.pipes.length; pi++) {
      const meta = m.pipes[pi]!;
      const pipeFrame = fr.pipes[pi]!;
      for (let field = 0; field < 4; field++) {
        const dest = pipeArr[pi]![field]!;
        const src = pipeFrame[field]!;
        const offset = f * meta.nCells;
        for (let c = 0; c < meta.nCells; c++) dest[offset + c] = src[c]!;
      }
    }
  }
  return { manifest: m, theta, tMs, pipeArr, cylArr, pipeRange, cylRange } as any;
}
