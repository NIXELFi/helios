import { describe, it, expect } from "vitest";
import { datumNearPx } from "../src/strip-chart/hit-test";

// Backs the alt+click "remove the datum under the pointer" gesture. The chart
// supplies uPlot's valToPos as `toPx`; here a linear stand-in: 1 px per 10 ms,
// i.e. a datum at 1_000_000 us sits at x = 100 px.
const toPx = (timeUs: number) => timeUs / 10_000;

describe("datumNearPx", () => {
  it("returns null when there are no datums", () => {
    expect(datumNearPx([], toPx, 100, 6)).toBeNull();
  });

  it("matches a datum directly under the pointer", () => {
    expect(datumNearPx([1_000_000], toPx, 100, 6)).toBe(1_000_000);
  });

  it("matches a near miss inside the radius and rejects one outside it", () => {
    // Datum at 100 px; pointer 5 px away is a hit, 7 px away is not.
    expect(datumNearPx([1_000_000], toPx, 105, 6)).toBe(1_000_000);
    expect(datumNearPx([1_000_000], toPx, 107, 6)).toBeNull();
  });

  it("treats the radius as inclusive", () => {
    expect(datumNearPx([1_000_000], toPx, 106, 6)).toBe(1_000_000);
  });

  it("picks the closest datum when several are in range", () => {
    // 100 px, 104 px, 108 px; pointer at 105 px → the 104 px one wins.
    const datums = [1_000_000, 1_040_000, 1_080_000];
    expect(datumNearPx(datums, toPx, 105, 6)).toBe(1_040_000);
  });

  it("resolves an exact tie to the earlier datum", () => {
    // Pointer exactly between two datums 4 px apart. Stable ordering matters
    // so repeated alt+clicks remove them predictably one at a time.
    expect(datumNearPx([1_000_000, 1_040_000], toPx, 102, 6)).toBe(1_000_000);
  });

  it("skips datums that project to a non-finite position", () => {
    // A datum outside the current x-scale can project to NaN; it must not
    // win the comparison or poison the search.
    const projection = (timeUs: number) => (timeUs === 5_000_000 ? NaN : toPx(timeUs));
    expect(datumNearPx([5_000_000, 1_000_000], projection, 100, 6)).toBe(1_000_000);
    expect(datumNearPx([5_000_000], projection, 100, 6)).toBeNull();
  });

  it("returns null for a non-finite pointer position", () => {
    expect(datumNearPx([1_000_000], toPx, NaN, 6)).toBeNull();
  });
});
