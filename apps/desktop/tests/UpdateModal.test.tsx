import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UpdateModal } from "../src/components/UpdateModal";
import type { UpdaterAvailable, UpdaterState } from "../src/lib/use-updater";

afterEach(cleanup);

const update: UpdaterAvailable = {
  version: "3.8.0",
  currentVersion: "3.7.0",
  notes: "Bug fixes.",
  date: "2026-05-20",
  // The Tauri Update handle isn't exercised by the modal.
  _handle: {} as UpdaterAvailable["_handle"],
};

const availableState: UpdaterState = { kind: "available", update };
const downloadingState: UpdaterState = { kind: "downloading", update, downloaded: 10, total: 100 };
const installingState: UpdaterState = { kind: "installing", update };

function setup(state: UpdaterState, overrides: Partial<{ playbackBlocked: boolean }> = {}) {
  const onInstall = vi.fn();
  const onClose = vi.fn();
  render(
    <UpdateModal
      state={state}
      playbackBlocked={overrides.playbackBlocked ?? false}
      onInstall={onInstall}
      onClose={onClose}
    />,
  );
  return { onInstall, onClose };
}

describe("<UpdateModal>", () => {
  it("renders the available version and current version", () => {
    setup(availableState);
    expect(screen.getByText(/Helios v3\.8\.0/)).toBeInTheDocument();
    expect(screen.getByText(/you're on v3\.7\.0/)).toBeInTheDocument();
  });

  it("clicking the backdrop closes when idle (available)", () => {
    const { onClose } = setup(availableState);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // S8(b): the backdrop must NOT close the modal mid-download/-install — a
  // restart is imminent and an accidental backdrop click shouldn't dismiss it.
  it("clicking the backdrop does NOT close while downloading (S8)", () => {
    const { onClose } = setup(downloadingState);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking the backdrop does NOT close while installing (S8)", () => {
    const { onClose } = setup(installingState);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  // S8(c): Escape closes when idle.
  it("Escape closes when idle (available)", () => {
    const { onClose } = setup(availableState);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape does NOT close while installing (S8)", () => {
    const { onClose } = setup(installingState);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the close (×) button closes when idle", () => {
    const { onClose } = setup(availableState);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Install and restart fires onInstall", () => {
    const { onInstall } = setup(availableState);
    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("every button is type=button (no implicit submit)", () => {
    setup(availableState);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveAttribute("type", "button");
    }
  });

  it("Tab from the last focusable wraps to the first (focus-trap, S8)", () => {
    setup(availableState);
    const buttons = screen.getAllByRole("button");
    const last = buttons[buttons.length - 1];
    last.focus();
    expect(last).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    // Focus cycled back to the first focusable control (the × close button).
    expect(buttons[0]).toHaveFocus();
  });

  it("renders nothing for non-update states", () => {
    const { container } = render(
      <UpdateModal
        state={{ kind: "up_to_date", current: "3.7.0" }}
        playbackBlocked={false}
        onInstall={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
