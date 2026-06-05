import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ExportMenu } from "../components/ExportMenu";
import type { ExportMenuItem } from "../components/ExportMenu";

function item(
  id: string,
  label: string,
  result: { ok: boolean; message: string } = { ok: true, message: "Exported → file.csv" },
  delayMs = 0,
): ExportMenuItem {
  return {
    id,
    label,
    run: () =>
      delayMs > 0
        ? new Promise((res) => setTimeout(() => res(result), delayMs))
        : Promise.resolve(result),
  };
}

describe("ExportMenu", () => {
  it("opens the popover when the trigger is clicked", () => {
    render(<ExportMenu items={[item("a", "CSV"), item("b", "JSON")]} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "CSV" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "JSON" })).toBeInTheDocument();
  });

  it("runs an item and shows a success toast", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, message: "Exported → recipe.csv" });
    render(<ExportMenu items={[{ id: "a", label: "CSV", run }]} />);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "CSV" }));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Exported → recipe.csv"));
  });

  it("shows a per-item busy state and disables items while running", async () => {
    let resolve!: (v: { ok: boolean; message: string }) => void;
    const run = vi.fn(() => new Promise<{ ok: boolean; message: string }>((r) => { resolve = r; }));
    render(<ExportMenu items={[{ id: "a", label: "CSV", run }]} />);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^CSV/ }));
    // Busy label uses an ellipsis suffix; item is disabled mid-run.
    const busyItem = screen.getByRole("menuitem", { name: /CSV…/ });
    expect(busyItem).toBeDisabled();
    resolve({ ok: true, message: "done" });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
  });

  it("shows an error toast when run rejects", async () => {
    const run = vi.fn().mockRejectedValue(new Error("disk full"));
    render(<ExportMenu items={[{ id: "a", label: "CSV", run }]} />);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "CSV" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("disk full"));
  });

  it("closes on Escape", () => {
    render(<ExportMenu items={[item("a", "CSV")]} />);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on outside click", () => {
    render(
      <div>
        <ExportMenu items={[item("a", "CSV")]} />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
