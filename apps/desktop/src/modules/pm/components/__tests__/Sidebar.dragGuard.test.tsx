import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableViewItem } from "@pm/components/Sidebar";
import { PmRouterProvider } from "@pm/lib/router";

// Regression guard for the "reordering Views reloads the whole app to the logs
// screen" bug. Root cause: the sortable row is a native <a href>, and dnd-kit's
// PointerSensor only handles pointer events — so Chromium starts a parallel
// native HTML5 link-drag whose drop, in the Tauri webview, navigates the whole
// document back to the default module. The fix disables the anchor's native
// drag (draggable={false} + an onDragStart that preventDefaults). jsdom can't
// reproduce the webview navigation itself, but it CAN verify the guard that
// prevents the native drag from ever starting.
function renderRow() {
  return render(
    <PmRouterProvider initialPath="/table">
      <DndContext>
        <SortableContext items={["table"]}>
          <SortableViewItem view="table" href="/table" active={false} />
        </SortableContext>
      </DndContext>
    </PmRouterProvider>,
  );
}

describe("SortableViewItem native-drag guard", () => {
  test("the row anchor is not natively draggable", () => {
    renderRow();
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("draggable", "false");
  });

  test("a native dragstart on the row is cancelled (no link-drag → no nav)", () => {
    renderRow();
    // fireEvent returns false when the event was cancelled (preventDefault ran).
    const notCancelled = fireEvent.dragStart(screen.getByRole("button", { name: "Table" }));
    expect(notCancelled).toBe(false);
  });
});
