import { describe, it, expect } from "vitest";
import { planRecentsBoot, MAX_AUTO_REOPEN } from "../boot-order";

const none = () => false;
const all = () => true;

describe("planRecentsBoot", () => {
  it("returns nothing to load for an empty recents list", () => {
    expect(planRecentsBoot([], none)).toEqual({ first: null, rest: [] });
  });

  it("loads the first recent before paint and the others behind it", () => {
    expect(planRecentsBoot(["a", "b", "c"], none)).toEqual({
      first: "a",
      rest: ["b", "c"],
    });
  });

  it("skips hidden sessions when picking the one to show first", () => {
    const hidden = (p: string) => p === "a" || p === "b";
    expect(planRecentsBoot(["a", "b", "c", "d"], hidden)).toEqual({
      first: "c",
      rest: ["a", "b", "d"],
    });
  });

  it("falls back to the newest recent when every session is hidden", () => {
    expect(planRecentsBoot(["a", "b", "c"], all)).toEqual({
      first: "a",
      rest: ["b", "c"],
    });
  });

  it("caps the total number of auto-reopened sessions", () => {
    const recents = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const { first, rest } = planRecentsBoot(recents, none);
    expect(first).toBe("s0");
    expect(rest).toHaveLength(MAX_AUTO_REOPEN - 1);
    expect(rest[0]).toBe("s1");
    expect(rest.at(-1)).toBe(`s${MAX_AUTO_REOPEN - 1}`);
  });

  it("keeps the recents order in the background list", () => {
    const hidden = (p: string) => p === "b";
    expect(planRecentsBoot(["a", "b", "c"], hidden).rest).toEqual(["b", "c"]);
  });

  it("never repeats the first session in the background list", () => {
    const { first, rest } = planRecentsBoot(["a", "b", "a"], (p) => p === "a");
    expect(first).toBe("b");
    expect(rest).toEqual(["a", "a"]);
  });
});
