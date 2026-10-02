import { describe, expect, it } from "vitest";
import { inRange, rangeBounds, rangeSize, summarize } from "../cellRange";

describe("cell range", () => {
  it("is the same rectangle whichever corner the drag started from", () => {
    const r = { a: [5, 4] as [number, number], b: [2, 3] as [number, number] };
    expect(rangeBounds(r)).toEqual({ r0: 2, r1: 5, c0: 3, c1: 4 });
    expect(rangeSize(r)).toBe(8);
    expect(inRange(r, 3, 4)).toBe(true);
    expect(inRange(r, 6, 4)).toBe(false);
    expect(inRange(null, 0, 0)).toBe(false);
  });

  it("sums dollars and plain numbers separately and counts non-empty cells", () => {
    expect(summarize([{ money: 1250 }, { money: 4999 }, { number: 3 }, { number: 2 }, { text: "Mouser" }, { text: " " }, null]))
      .toEqual({ count: 5, moneyCount: 2, moneySum: 6249, numberCount: 2, numberSum: 5 });
  });
});
