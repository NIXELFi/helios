import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { CfdProvider } from "../state/CfdContext";
import { EditorProvider } from "../editor/state/editor-context";
import { ConfigScreen } from "../screens/ConfigScreen";
import { makeFakeBridge } from "./fakes/tauri";

function wrap() {
  const fake = makeFakeBridge();
  fake.setListExamples(async () => []);
  const ui = (
    <CfdProvider bridge={fake.bridge} skipRehydrate>
      <EditorProvider>
        <ConfigScreen />
      </EditorProvider>
    </CfdProvider>
  );
  return { fake, ui };
}

describe("ConfigScreen + editor", () => {
  it("clicking 'New from template…' on the empty state opens the template picker modal", async () => {
    const { ui } = wrap();
    render(ui);
    // Empty state CTA
    const newBtn = screen.getByRole("button", { name: /New from template/i });
    expect(newBtn).toBeInTheDocument();
    fireEvent.click(newBtn);
    // The picker modal mounts with the title "New from template" and three rows.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/SDM26 — Honda/i)).toBeInTheDocument();
    expect(screen.getByText(/Blank engine/i)).toBeInTheDocument();
  });

  it("clicking the header 'New…' button also opens the template picker", async () => {
    const { ui } = wrap();
    render(ui);
    const headerBtn = screen.getByRole("button", { name: /^New…$/i });
    fireEvent.click(headerBtn);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("picking the Blank template loads it into the editor (shows form, no longer empty state)", async () => {
    const { ui } = wrap();
    render(ui);
    fireEvent.click(screen.getByRole("button", { name: /New from template/i }));
    const blankRow = await screen.findByRole("button", { name: /Blank engine/i });
    fireEvent.click(blankRow);
    // Editor form should now be visible — pick a known field of the form
    // (Bore is in the Engine group) and assert its input is present.
    expect(await screen.findByLabelText(/Bore/i)).toBeInTheDocument();
    // The empty-state "New from template…" CTA card is gone (the header
    // "New…" button still exists but the bigger CTA isn't rendered).
    expect(screen.queryByText(/Open a config to get started/i)).not.toBeInTheDocument();
  });
});
