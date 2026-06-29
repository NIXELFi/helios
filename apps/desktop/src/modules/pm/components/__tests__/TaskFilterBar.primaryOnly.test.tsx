import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Subteam } from "@helios/pm-ui";
import { TaskFilterBar } from "../TaskFilterBar";
import { EMPTY_FILTERS } from "@pm/lib/filters";

afterEach(cleanup);

const SUBTEAMS: Subteam[] = [
  { id: "st1", name: "Aero", code: "AE", slug: "aero", color: null },
  { id: "st2", name: "Chassis", code: "CH", slug: "chassis", color: null },
];

function renderBar(props: Partial<React.ComponentProps<typeof TaskFilterBar>> = {}) {
  return render(
    <TaskFilterBar
      filters={EMPTY_FILTERS}
      subteams={SUBTEAMS}
      users={[]}
      active={false}
      scopedToTeam
      onPatch={() => {}}
      onClear={() => {}}
      {...props}
    />,
  );
}

describe("TaskFilterBar — Primary only toggle gating", () => {
  it("shows the toggle when scoped to a subteam and a handler is provided", () => {
    renderBar({ primaryOnly: false, onPrimaryOnlyChange: () => {} });
    expect(screen.getByRole("button", { name: /primary only/i })).toBeTruthy();
  });

  it("hides the toggle in the project-wide (all subteams) scope", () => {
    renderBar({ scopedToTeam: false, primaryOnly: false, onPrimaryOnlyChange: () => {} });
    expect(screen.queryByRole("button", { name: /primary only/i })).toBeNull();
    // The subteam chips appear instead when not scoped.
    expect(screen.getByRole("button", { name: /AE/ })).toBeTruthy();
  });

  it("hides the toggle when no change handler is wired", () => {
    renderBar({ primaryOnly: false });
    expect(screen.queryByRole("button", { name: /primary only/i })).toBeNull();
  });

  it("invokes the handler with the negated value on click", () => {
    const onChange = vi.fn();
    renderBar({ primaryOnly: false, onPrimaryOnlyChange: onChange });
    fireEvent.click(screen.getByRole("button", { name: /primary only/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
