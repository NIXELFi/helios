import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { WaveViewerModal } from "../WaveViewerModal";

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
    fireEvent.change(screen.getByLabelText(/rpm:/i), { target: { value: "10000" } });
    await waitFor(() => expect(loadWaves).toHaveBeenCalledWith("j1", "sweep", 10000));
  });
});
