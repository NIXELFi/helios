// Screen tests for SingleRpmResults — the summary card, KI/conv/CoV gating,
// the collapsible convergence panel, and the header ExportMenu. The export
// io seam is mocked so copy/save interactions never touch a real clipboard or
// Tauri dialog; the screen is rendered inside a CfdProvider with a fake bridge
// (default params keep all capture panels off, so PvLoopView / WaveViewerModal
// never mount).

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

import { CfdProvider } from "../state/CfdContext";
import { SingleRpmResults } from "../results/SingleRpmResults";
import { makeFakeBridge } from "./fakes/tauri";
import { makeStudy, makeCycleStats } from "./fakes/study";
import type { SingleRpmDoneSummary, SingleRpmStudy } from "../state/types";

// SingleRpmDoneSummary fixture (NOT the ConfigSummary makeSummary helper).
function doneSummary(overrides: Partial<SingleRpmDoneSummary> = {}): SingleRpmDoneSummary {
  return { convergedCycle: -1, nCyclesRun: 6, stepCount: 1000, ...overrides };
}

// Mock the ONLY Tauri-touching export file so copy + save never escape jsdom.
const copyText = vi.fn<(text: string) => Promise<void>>(async () => {});
const saveTextFile = vi.fn<
  (defaultName: string, ext: string, contents: string) => Promise<string | null>
>(async () => "C:/out/cfd-single.csv");
vi.mock("../lib/export/io", async () => {
  const actual = await vi.importActual<typeof import("../lib/export/io")>("../lib/export/io");
  return {
    ...actual,
    copyText: (text: string) => copyText(text),
    saveTextFile: (defaultName: string, ext: string, contents: string) =>
      saveTextFile(defaultName, ext, contents),
  };
});

function renderScreen(study: SingleRpmStudy) {
  const { bridge } = makeFakeBridge();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CfdProvider bridge={bridge} skipRehydrate>{children}</CfdProvider>
  );
  return render(<SingleRpmResults study={study} />, { wrapper });
}

// A done single-rpm study with `n` cycles. The last cycle's metrics are
// overridable for assertions; earlier cycles vary IMEP so deltas are non-zero.
function doneStudy(
  n: number,
  lastOverrides: Partial<ReturnType<typeof makeCycleStats>> = {},
  studyOverrides: Partial<SingleRpmStudy> = {},
): SingleRpmStudy {
  const cycles = Array.from({ length: n }, (_, i) =>
    makeCycleStats(
      i === n - 1
        ? { cycle: i + 1, imepBar: 11.92, veAtm: 0.964, brakePowerKW: 64.2, brakeTorqueNm: 58.1, egtMean: 985, ...lastOverrides }
        : { cycle: i + 1, imepBar: 10 + i * 0.4 },
    ),
  );
  return makeStudy({
    status: "done",
    cycles,
    summary: doneSummary({ nCyclesRun: n }),
    ...studyOverrides,
  });
}

beforeEach(() => {
  copyText.mockClear();
  saveTextFile.mockClear();
});

describe("SingleRpmResults summary card", () => {
  it("shows final-cycle IMEP / VE / P_brake / τ_brake / EGT", () => {
    renderScreen(doneStudy(6));
    // Scope to the summary card so identical values in the cycle table /
    // footer don't collide with these assertions.
    const card = within(screen.getByRole("region", { name: /run summary/i }));
    expect(card.getByText("11.920")).toBeInTheDocument(); // IMEP bar
    expect(card.getByText("96.40")).toBeInTheDocument(); // VE %
    expect(card.getByText("64.20")).toBeInTheDocument(); // P_brake kW
    expect(card.getByText("58.10")).toBeInTheDocument(); // τ_brake Nm
    expect(card.getByText("985")).toBeInTheDocument(); // EGT K
  });

  it("does not render a summary card when there are zero cycles", () => {
    renderScreen(makeStudy({ status: "done", cycles: [] }));
    expect(screen.getByText(/no cycles to display/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy line/i })).toBeNull();
  });

  it("shows the KI max chip when a cycle carries knockIntegral", () => {
    renderScreen(doneStudy(6, { knockIntegral: 0.41 }));
    expect(screen.getByText(/KI max 0\.410/)).toBeInTheDocument();
  });

  it("omits the KI max chip when no cycle carries knockIntegral", () => {
    renderScreen(doneStudy(6));
    expect(screen.queryByText(/KI max/)).toBeNull();
  });

  it("shows 'conv @ N' only when the backend summary reports convergedCycle >= 0", () => {
    // No converged verdict from backend (-1) → no conv chip in the summary card.
    renderScreen(doneStudy(6));
    expect(screen.queryByText(/^conv @/)).toBeNull();
  });

  it("shows 'conv @ N' from the backend verdict when present", () => {
    const study = doneStudy(6, {}, { summary: doneSummary({ convergedCycle: 4 }) });
    renderScreen(study);
    expect(screen.getByText(/conv @ 4/)).toBeInTheDocument();
  });

  it("shows CoV(IMEP, last 5) as a percentage when computable (>=5 cycles)", () => {
    renderScreen(doneStudy(6));
    expect(screen.getByText(/CoV\(IMEP, last 5\)/)).toBeInTheDocument();
  });

  it("omits CoV(IMEP, last 5) when there are fewer than 5 cycles", () => {
    renderScreen(doneStudy(3));
    expect(screen.queryByText(/CoV\(IMEP, last 5\)/)).toBeNull();
  });

  it("copies the one-line summary via copyText when Copy line is clicked", async () => {
    renderScreen(doneStudy(6, { knockIntegral: 0.41 }));
    fireEvent.click(screen.getByRole("button", { name: /copy line/i }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const line = copyText.mock.calls[0]![0];
    expect(line).toContain("IMEP 11.920 bar");
    expect(line).toContain("VE 96.40%");
    expect(line).toContain("P_brake 64.20 kW");
    expect(line).toContain("τ_brake 58.10 Nm");
    expect(line).toContain("KI max 0.410");
  });
});

describe("SingleRpmResults convergence panel", () => {
  it("is collapsed by default and expands to show both series on toggle", () => {
    renderScreen(doneStudy(6));
    const toggle = screen.getByRole("button", { name: /show convergence/i });
    // Collapsed: chart series legend labels not present yet.
    expect(screen.queryByText("|ΔIMEP|%")).toBeNull();
    expect(screen.queryByText("tol")).toBeNull();

    fireEvent.click(toggle);
    // Expanded: delta series + the constant tolerance reference series.
    expect(screen.getByText("|ΔIMEP|%")).toBeInTheDocument();
    expect(screen.getByText("tol")).toBeInTheDocument();
    // Toggle flips back to a hide label.
    expect(screen.getByRole("button", { name: /hide convergence/i })).toBeInTheDocument();
  });

  it("notes the backend convergedCycle in the panel header when present", () => {
    const study = doneStudy(6, {}, { summary: doneSummary({ convergedCycle: 4 }) });
    renderScreen(study);
    expect(screen.getByText(/backend converged @ cycle 4/i)).toBeInTheDocument();
  });
});

describe("SingleRpmResults export menu", () => {
  it("renders the export menu with Cycles CSV, Study JSON, and Copy summary", () => {
    renderScreen(doneStudy(6));
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByRole("menuitem", { name: "Cycles CSV" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Study JSON" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy summary" })).toBeInTheDocument();
  });

  it("runs the Cycles CSV export through saveTextFile and toasts the basename", async () => {
    renderScreen(doneStudy(6));
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cycles CSV" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Exported → cfd-single.csv"),
    );
  });

  it("copies the summary via the Copy summary export item", async () => {
    renderScreen(doneStudy(6));
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy summary" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied!"));
  });
});

describe("SingleRpmResults regression", () => {
  it("renders a persisted study with no knockIntegral and no summary", () => {
    const study = makeStudy({
      status: "done",
      cycles: [makeCycleStats({ cycle: 1 }), makeCycleStats({ cycle: 2, imepBar: 10.2 })],
    });
    renderScreen(study);
    // No summary → no conv chip / no KI chip, but the card and table render.
    expect(screen.queryByText(/KI max/)).toBeNull();
    expect(screen.queryByText(/conv @/)).toBeNull();
    expect(screen.getByText(/cycle stats/i)).toBeInTheDocument();
  });
});
