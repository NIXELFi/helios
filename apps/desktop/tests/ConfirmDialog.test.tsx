import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog (confirm mode)", () => {
  function setup(overrides = {}) {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Delete it?"
        body="This cannot be undone."
        confirmLabel="Delete"
        confirmTone="danger"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onClose={onClose}
        {...overrides}
      />,
    );
    return { onConfirm, onClose };
  }

  it("renders title and body", () => {
    setup();
    expect(screen.getByText("Delete it?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("clicking confirm fires onConfirm", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clicking confirm also self-closes (onClose after onConfirm)", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still closes even when onConfirm throws", () => {
    const onConfirm = vi.fn(() => { throw new Error("boom"); });
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Delete it?"
        body="x"
        confirmLabel="Delete"
        confirmTone="danger"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    // React (dev) catches a thrown handler error and re-dispatches it onto
    // window rather than rethrowing from fireEvent; swallow the expected one so
    // it doesn't surface as an unhandled test-file error.
    const onErr = (e: ErrorEvent) => { if (e.message.includes("boom")) e.preventDefault(); };
    window.addEventListener("error", onErr);
    try {
      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    } finally {
      window.removeEventListener("error", onErr);
    }
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // try/finally in handleConfirm guarantees onClose still runs after the throw.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("danger tone focuses the Cancel button on open (not the destructive confirm)", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /cancel/i }));
  });

  it("default tone focuses the confirm button on open", () => {
    setup({ confirmTone: "default", confirmLabel: "Save" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /save/i }));
  });

  it("clicking cancel fires onClose only", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape fires onClose", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── MODAL-ESC: Escape must NOT cascade to sibling window listeners ─────
  // ConfirmDialog is shared app-wide; its Escape now uses
  // stopImmediatePropagation so a background window keydown underneath (e.g.
  // BrowseScreen's selection-clear) doesn't ALSO fire on the same keypress.
  it("Escape does not fire a sibling window keydown listener (stopImmediatePropagation)", () => {
    const { onClose } = setup();
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

  it("danger tone applies a red-styled confirm button", () => {
    setup();
    const btn = screen.getByRole("button", { name: /delete/i });
    expect(btn.className).toMatch(/EF5350|red|danger/i);
  });
});

describe("ConfirmDialog (alert mode — no cancelLabel)", () => {
  it("renders only the confirm button", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Could not import"
        body="Not a Helios workspace file."
        confirmLabel="OK"
        confirmTone="default"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^ok$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
