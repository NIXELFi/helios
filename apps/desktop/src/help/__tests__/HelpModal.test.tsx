import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HelpModal } from "../HelpModal";

describe("HelpModal", () => {
  it("shows the home page once it has been fetched", async () => {
    render(<HelpModal open onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("Helios Wiki", { selector: "h1" })).toBeTruthy(),
    );
  });

  it("keeps the current page on screen while the next one loads", async () => {
    render(<HelpModal open onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("Helios Wiki", { selector: "h1" })).toBeTruthy(),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Getting started" }));
    // Synchronously after navigating, the previous page is STILL rendered —
    // the pane must never flash empty while the next page is fetched.
    expect(screen.getByText("Helios Wiki", { selector: "h1" })).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByText("Getting started", { selector: "h1" })).toBeTruthy(),
    );
  });
});
