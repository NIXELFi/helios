import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useScrollMemory, resetScrollMemory } from "../useScrollMemory";

function Scroller({ memKey }: { memKey: string }) {
  const ref = useScrollMemory(memKey);
  return (
    <div data-testid="scroller" ref={ref} style={{ overflow: "auto", height: 100 }}>
      <div style={{ height: 1000 }} />
    </div>
  );
}

beforeEach(() => resetScrollMemory());

describe("useScrollMemory", () => {
  test("restores the saved position when the container remounts under the same key", () => {
    const first = render(<Scroller memKey="table:__project__" />);
    const el = first.getByTestId("scroller");
    el.scrollTop = 420;
    fireEvent.scroll(el);
    first.unmount();

    const second = render(<Scroller memKey="table:__project__" />);
    expect(second.getByTestId("scroller").scrollTop).toBe(420);
  });

  test("keys are independent — another view/scope starts at the top", () => {
    const first = render(<Scroller memKey="table:__project__" />);
    const el = first.getByTestId("scroller");
    el.scrollTop = 300;
    fireEvent.scroll(el);
    first.unmount();

    const other = render(<Scroller memKey="board:__project__" />);
    expect(other.getByTestId("scroller").scrollTop).toBe(0);
  });

  test("key change on a mounted container restores that key's position", () => {
    // Save 250 under team scope.
    const a = render(<Scroller memKey="table:aero" />);
    const elA = a.getByTestId("scroller");
    elA.scrollTop = 250;
    fireEvent.scroll(elA);
    a.unmount();

    // Mount at project scope (0), then switch the SAME component to team scope.
    const b = render(<Scroller memKey="table:__project__" />);
    const elB = b.getByTestId("scroller");
    expect(elB.scrollTop).toBe(0);
    b.rerender(<Scroller memKey="table:aero" />);
    expect(elB.scrollTop).toBe(250);
  });
});
