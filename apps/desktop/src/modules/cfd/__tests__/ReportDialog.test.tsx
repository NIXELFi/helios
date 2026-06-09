// Report composer: default selection, picking, and that Print→PDF builds a
// report scoped to exactly the checked studies.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeSweepStudy, makeOptimizationStudy } from "./fakes/study";

const sweepA = makeSweepStudy({ id: "swA", name: "alpha sweep", startedAt: 2 });
const sweepB = makeSweepStudy({ id: "swB", name: "beta sweep", startedAt: 1 });
const opt = makeOptimizationStudy({ id: "opt1", startedAt: 3 });

vi.mock("../state/CfdContext", () => ({
  useCfd: () => ({
    state: {
      studies: { swA: sweepA, swB: sweepB, opt1: opt },
      vehicleConfig: null,
      referenceBaseline: { enduranceTMin: null },
    },
  }),
}));

const printHtml = vi.fn(async (_html: string) => {});
vi.mock("../lib/export/printReport", () => ({
  printHtml: (html: string) => printHtml(html),
}));
vi.mock("../lib/export/io", () => ({
  saveTextFile: vi.fn(async () => "/tmp/x.html"),
  fileTimestamp: () => "t",
}));

import { ReportDialog } from "../components/ReportDialog";

beforeEach(() => printHtml.mockClear());

describe("ReportDialog", () => {
  it("pre-checks defaultSelected and prints a report scoped to the picked studies", async () => {
    render(<ReportDialog open onClose={() => {}} defaultSelected={["swA"]} />);
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /print → pdf/i }));
    await waitFor(() => expect(printHtml).toHaveBeenCalledTimes(1));
    const html = printHtml.mock.calls[0]![0] as string;
    expect(html).toContain("alpha sweep");
    expect(html).not.toContain("beta sweep");
  });

  it("comparison covers exactly the picked designs once two are checked", async () => {
    render(<ReportDialog open onClose={() => {}} defaultSelected={["swA"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /beta sweep/i }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /print → pdf/i }));
    await waitFor(() => expect(printHtml).toHaveBeenCalledTimes(1));
    const html = printHtml.mock.calls[0]![0] as string;
    expect(html).toContain("Design comparison");
    expect(html).toContain("alpha sweep");
    expect(html).toContain("beta sweep");
    expect(html).not.toContain("Optimization —"); // opt1 stayed unchecked
  });

  it("disables export with nothing selected", () => {
    render(<ReportDialog open onClose={() => {}} defaultSelected={[]} />);
    expect((screen.getByRole("button", { name: /print → pdf/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
