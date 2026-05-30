import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UpdatesPill } from "../src/components/UpdatesPill";
import type { UpdaterAvailable, UpdaterState } from "../src/lib/use-updater";

afterEach(cleanup);

const update: UpdaterAvailable = {
  version: "3.8.0",
  currentVersion: "3.7.0",
  notes: null,
  date: null,
  _handle: {} as UpdaterAvailable["_handle"],
};

describe("<UpdatesPill>", () => {
  it("is a real (non-submit) button", () => {
    render(<UpdatesPill state={{ kind: "up_to_date", current: "3.7.0" }} onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<UpdatesPill state={{ kind: "checking" }} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // S9: aria-label mirrors the state so screen readers get more than the
  // terse visual glyph ("✓ v3.7.0").
  it("has an aria-label mirroring each state (S9)", () => {
    const cases: Array<[UpdaterState, RegExp]> = [
      [{ kind: "checking" }, /checking/i],
      [{ kind: "up_to_date", current: "3.7.0" }, /latest/i],
      [{ kind: "available", update }, /update available/i],
      [{ kind: "downloading", update, downloaded: 10, total: 100 }, /downloading/i],
      [{ kind: "installing", update }, /installing/i],
      [{ kind: "offline", error: "no net" }, /failed|offline/i],
    ];
    for (const [state, re] of cases) {
      const { unmount } = render(<UpdatesPill state={state} onClick={() => {}} />);
      expect(screen.getByRole("button")).toHaveAccessibleName(re);
      unmount();
    }
  });
});
