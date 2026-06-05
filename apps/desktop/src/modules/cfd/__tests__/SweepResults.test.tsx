import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

import { CfdProvider } from "../state/CfdContext";
import { SweepResults } from "../results/SweepResults";
import { makeFakeBridge } from "./fakes/tauri";
import { makeSweepStudy, makeSweepPoint } from "./fakes/study";
import type { SweepStudy } from "../state/types";

// Mock the Tauri/clipboard seam. slugify + fileTimestamp must stay real so the
// export-action filename stems (built eagerly inside exportActionsFor) don't
// blow up; saveTextFile + copyText are spies the tests assert on.
vi.mock("../lib/export/io", async (importActual) => {
  const actual = await importActual<typeof import("../lib/export/io")>();
  return {
    ...actual,
    saveTextFile: vi.fn(async (name: string, ext: string) => `C:/out/${name}.${ext}`),
    copyText: vi.fn(async () => {}),
  };
});

import { copyText, saveTextFile } from "../lib/export/io";

const copyTextMock = vi.mocked(copyText);
const saveTextFileMock = vi.mocked(saveTextFile);

beforeEach(() => {
  copyTextMock.mockClear();
  saveTextFileMock.mockClear();
});

/** Render SweepResults inside a CfdProvider (so useCfd works). The study is
 *  passed via props; the provider's studies map stays empty (the screen reads
 *  its study from props and only touches the map for compare/overlay). */
function renderSweep(study: SweepStudy) {
  const fake = makeFakeBridge();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CfdProvider bridge={fake.bridge} skipRehydrate>{children}</CfdProvider>
  );
  return render(<SweepResults study={study} />, { wrapper });
}

describe("SweepResults — summary band", () => {
  it("shows the summary band with peaks (interpolated peaks marked '~') when ≥2 points", () => {
    // Default fixture: peaks land on the interior 10000-rpm point → parabolic
    // vertex moves them off the sample → all three peak rpms are interpolated.
    renderSweep(makeSweepStudy());
    const band = screen.getByLabelText("Sweep summary");
    expect(band).toBeInTheDocument();
    expect(within(band).getByText("Peak P")).toBeInTheDocument();
    expect(within(band).getByText("Peak τ")).toBeInTheDocument();
    expect(within(band).getByText("Peak VE")).toBeInTheDocument();
    expect(within(band).getByText("Powerband")).toBeInTheDocument();
    // Interior peaks are interpolated → rpm carries a leading "~".
    expect(band.textContent).toMatch(/Peak P.*kW @ ~/);
    expect(band.textContent).toMatch(/Peak τ.*Nm @ ~/);
    expect(band.textContent).toMatch(/Peak VE.*% @ ~/);
  });

  it("marks an edge peak WITHOUT '~' (sampled, not interpolated)", () => {
    // Monotonically rising power → peak is the last (edge) point → no parabola
    // → rpm reported as the raw sample, no "~".
    const study = makeSweepStudy({
      points: [
        makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 40, brakeTorqueNm: 30, veAtm: 0.80 } }),
        makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 55, brakeTorqueNm: 40, veAtm: 0.85 } }),
        makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 70, brakeTorqueNm: 50, veAtm: 0.92 } }),
      ],
    });
    renderSweep(study);
    const band = screen.getByLabelText("Sweep summary");
    // Edge peak at 12000 → "70.0 kW @ 12,000" with no tilde before the rpm.
    expect(band.textContent).toContain("70.0 kW @ 12,000");
    expect(band.textContent).not.toMatch(/kW @ ~/);
  });

  it("hides the summary band when fewer than 2 points", () => {
    const study = makeSweepStudy({
      points: [makeSweepPoint({ rpm: 9000, lastCycle: { brakePowerKW: 50 } })],
    });
    renderSweep(study);
    expect(screen.queryByLabelText("Sweep summary")).toBeNull();
  });

  it("Copy button copies the one-line summary via copyText", async () => {
    renderSweep(makeSweepStudy());
    const band = screen.getByLabelText("Sweep summary");
    fireEvent.click(within(band).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
    const copied = copyTextMock.mock.calls[0]![0] as string;
    expect(copied).toMatch(/Peak P .*kW/);
    expect(copied).toMatch(/Powerband/);
  });
});

describe("SweepResults — knock integral", () => {
  it("shows no KI chip, KI chart, or KI column without knockIntegral", () => {
    renderSweep(makeSweepStudy());
    expect(screen.queryByText(/KI max/)).toBeNull();
    expect(screen.queryByText("Knock integral vs RPM")).toBeNull();
    // Table header has no KI column.
    expect(screen.queryByRole("columnheader", { name: "KI" })).toBeNull();
  });

  it("shows the KI chip, KI chart, and KI column when ≥1 point carries knockIntegral", () => {
    const study = makeSweepStudy({
      points: [
        makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50, knockIntegral: 0.21 } }),
        makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64, knockIntegral: 0.41 } }),
        makeSweepPoint({ rpm: 12000, lastCycle: { brakePowerKW: 58, knockIntegral: 0.33 } }),
      ],
    });
    renderSweep(study);
    expect(screen.getByText(/KI max 0\.41/)).toBeInTheDocument();
    expect(screen.getByText("Knock integral vs RPM")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "KI" })).toBeInTheDocument();
  });
});

describe("SweepResults — charts", () => {
  it("renders the brake-torque-vs-RPM chart", () => {
    renderSweep(makeSweepStudy());
    expect(screen.getByText("Brake torque (Nm) vs RPM")).toBeInTheDocument();
  });
});

describe("SweepResults — export menu", () => {
  it("renders the Export menu with Per-RPM CSV, Study JSON, and Copy summary items", () => {
    renderSweep(makeSweepStudy());
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Per-RPM CSV" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Study JSON" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Copy summary" })).toBeInTheDocument();
  });

  it("Copy summary menu item calls copyText and shows a Copied! toast", async () => {
    renderSweep(makeSweepStudy());
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy summary" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied!"));
  });

  it("Per-RPM CSV menu item writes a file and shows an Exported toast", async () => {
    renderSweep(makeSweepStudy());
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Per-RPM CSV" }));
    await waitFor(() => expect(saveTextFileMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Exported →/));
  });
});

describe("SweepResults — table columns", () => {
  it("always renders a τ_brake column", () => {
    renderSweep(makeSweepStudy());
    expect(screen.getByRole("columnheader", { name: "τ_brake" })).toBeInTheDocument();
  });

  it("renders the brake-torque value in the per-RPM row", () => {
    const study = makeSweepStudy({
      points: [
        makeSweepPoint({ rpm: 8000, lastCycle: { brakePowerKW: 50, brakeTorqueNm: 59.7 } }),
        makeSweepPoint({ rpm: 10000, lastCycle: { brakePowerKW: 64, brakeTorqueNm: 61.12 } }),
      ],
    });
    renderSweep(study);
    expect(screen.getByText("61.12")).toBeInTheDocument();
  });
});

describe("SweepResults — preserved behavior", () => {
  it("keeps the compare picker strip", () => {
    renderSweep(makeSweepStudy());
    expect(screen.getByLabelText("Compare to")).toBeInTheDocument();
  });

  it("shows the empty-state when no RPM has completed", () => {
    renderSweep(makeSweepStudy({ points: [], status: "running" }));
    expect(screen.getByText(/Waiting for the first RPM/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Sweep summary")).toBeNull();
  });

  it("renders a Cancel button only while running", () => {
    const { rerender } = renderSweep(makeSweepStudy({ status: "running" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    rerender(<SweepResults study={makeSweepStudy({ status: "done" })} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
