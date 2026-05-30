import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

// AddTileModal pulls in @helios/widgets, whose GPS widget imports maplibre-gl;
// maplibre's module init calls window.URL.createObjectURL, which jsdom lacks.
// Stub it before the component (and therefore the widget barrel) is imported.
vi.hoisted(() => {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:stub";
    URL.revokeObjectURL = () => {};
  }
});

import { AddTileModal } from "../src/components/AddTileModal";

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof AddTileModal>[0]> = {}) {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(
    <AddTileModal
      existingIds={[]}
      onAdd={onAdd}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onAdd, onClose };
}

describe("AddTileModal", () => {
  it("renders a button for each palette entry", () => {
    setup();
    expect(screen.getByRole("button", { name: /strip chart/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /round gauge/i })).toBeInTheDocument();
  });

  it("clicking a tile fires onAdd once and closes", () => {
    const { onAdd, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /strip chart/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rapid double-click on the same tile adds only once (no colliding id)", () => {
    const { onAdd } = setup();
    const btn = screen.getByRole("button", { name: /strip chart/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("a second add (even a different tile) after the first is ignored", () => {
    const { onAdd } = setup();
    fireEvent.click(screen.getByRole("button", { name: /strip chart/i }));
    fireEvent.click(screen.getByRole("button", { name: /round gauge/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the modal", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes the modal", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the X button closes the modal", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
