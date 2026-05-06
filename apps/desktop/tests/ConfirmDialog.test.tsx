import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  // --- confirm mode ---

  it("renders the heading and body", () => {
    render(
      <ConfirmDialog
        heading="Delete workspace?"
        body="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete workspace?")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        heading="Confirm"
        body="Are you sure?"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        heading="Confirm"
        body="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the backdrop is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        heading="Confirm"
        body="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-backdrop"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("uses yellow confirm button for default tone", () => {
    render(
      <ConfirmDialog
        heading="Confirm"
        body="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /confirm/i });
    expect(btn.className).toMatch(/FFC627|yellow/i);
  });

  it("uses red confirm button for danger tone", () => {
    render(
      <ConfirmDialog
        heading="Confirm"
        body="Are you sure?"
        tone="danger"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /confirm/i });
    expect(btn.className).toMatch(/EF5350|red|danger/i);
  });
});
