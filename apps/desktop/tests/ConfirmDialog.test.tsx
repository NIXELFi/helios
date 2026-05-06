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
