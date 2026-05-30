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

  // MODAL-ESC: Escape must not cascade to a sibling window keydown listener.
  it("Escape does not fire a sibling window keydown listener when idle (stopImmediatePropagation)", () => {
    const { onClose } = setup(availableState);
    const sibling = vi.fn();
    window.addEventListener("keydown", sibling);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", sibling);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sibling).not.toHaveBeenCalled();
  });

  // install-fail-silent: a failed install flips the updater to `offline`.
  // Without installAttempted the modal would unmount silently; with it the
  // modal stays open and surfaces the error + a retry.
  it("renders nothing for `offline` when no install was attempted", () => {
    const { container } = render(
      <UpdateModal
        state={{ kind: "offline", error: "network down" }}
        playbackBlocked={false}
        onInstall={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps an error + retry visible when offline was reached via an install attempt (install-fail-silent)", () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();
    render(
      <UpdateModal
        state={{ kind: "offline", error: "install bundle verification failed" }}
        playbackBlocked={false}
        installAttempted
        onInstall={() => {}}
        onRetry={onRetry}
        onClose={onClose}
      />,
    );
    // The modal is still on screen (not silently unmounted).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/update failed/i)).toBeInTheDocument();
    // The actual error is surfaced.
    expect(screen.getByRole("alert")).toHaveTextContent(/install bundle verification failed/i);
    // A retry affordance is present and wired.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // formatReleaseDate: a YYYY-MM-DD date must render as that LOCAL calendar
  // day, not shift back a day west of UTC (the old `new Date("YYYY-MM-DD")`
  // parsed as UTC midnight then rendered local).
  it("renders the release date as the local calendar day (no UTC off-by-one)", () => {
    setup({ kind: "available", update: { ...update, date: "2026-05-20" } });
    // Expected = the date built from explicit local components, formatted the
    // same way the modal does. This is timezone-independent and pins the fix.
    const expected = new Date(2026, 4, 20).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
    expect(screen.getByText(`Released ${expected}`)).toBeInTheDocument();
  });
});
