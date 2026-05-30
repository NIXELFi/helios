import { describe, it, expect } from "vitest";
import { fetchAllRows } from "../../src/modules/vault/data/paginate";

/**
 * Builds a fake query whose .range(from, to) returns a slice of `total` rows,
 * but never more than `serverCap` rows per response (simulating PostgREST's
 * db-max-rows). Records each (from, to) requested so we can assert paging.
 */
function makeSource(total: number, serverCap: number) {
  const allRows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const ranges: Array<[number, number]> = [];
  let requests = 0;
  const build = () => ({
    range: (from: number, to: number) => {
      requests++;
      ranges.push([from, to]);
      const span = to - from + 1;
      const take = Math.min(span, serverCap);
      const slice = allRows.slice(from, from + take);
      return Promise.resolve({ data: slice, error: null });
    },
  });
  return { build, ranges, get requests() { return requests; } };
}

describe("fetchAllRows", () => {
  it("returns every row when server cap >= PAGE (normal case), no truncation", async () => {
    // 2500 rows, server honors full 1000-row pages.
    const src = makeSource(2500, 1000);
    const { rows, error } = await fetchAllRows<{ id: number }>(src.build);
    expect(error).toBeNull();
    expect(rows.length).toBe(2500);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
  });

  it("returns every row when the server caps pages BELOW PAGE (db-max-rows < 1000)", async () => {
    // This is the H11 bug: a 500-row server cap made every full page look
    // 'partial' (< 1000), so the loop stopped after the first page and
    // silently truncated. With effective-page-size detection it must page
    // through all 1200 rows.
    const src = makeSource(1200, 500);
    const { rows, error } = await fetchAllRows<{ id: number }>(src.build);
    expect(error).toBeNull();
    expect(rows.length).toBe(1200);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
  });

  it("handles a total that is an exact multiple of the (capped) page size", async () => {
    const src = makeSource(1000, 500);
    const { rows, error } = await fetchAllRows<{ id: number }>(src.build);
    expect(error).toBeNull();
    expect(rows.length).toBe(1000);
  });

  it("returns an empty result without looping when there are no rows", async () => {
    const src = makeSource(0, 1000);
    const { rows, error } = await fetchAllRows<{ id: number }>(src.build);
    expect(error).toBeNull();
    expect(rows.length).toBe(0);
    // Exactly one request — must not spin on a zero-width page.
    expect(src.requests).toBe(1);
  });

  it("surfaces a query error and returns rows accumulated so far", async () => {
    const build = () => ({
      range: (_from: number, _to: number) =>
        Promise.resolve({ data: null, error: { message: "boom" } }),
    });
    const { rows, error } = await fetchAllRows<{ id: number }>(build);
    expect(rows).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("boom");
  });

  it("does NOT duplicate rows when a later page returns MORE rows than the probe", async () => {
    // PAGINATE-ADVANCE (H11 follow-up): the probe (first response) sets the
    // effective page size, but the loop advanced `from` by that PROBE size
    // rather than by the actual rows received. If a later response comes back
    // LARGER than the probe (e.g. a server that ignores the requested range
    // upper bound, or a cap that lifts mid-scan), advancing by the smaller
    // probe re-requests rows already collected → duplicate rows.
    //
    // Source: response N starts at `from` and returns however many rows it
    // likes, ignoring `to`. Page 0 returns 3 (the probe); page 1 returns 5;
    // page 2 returns the final 2. Total 10 distinct rows. The fix must advance
    // by each page's real length so the result is 0..9 with no repeats.
    const allRows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const lengths = [3, 5, 2];
    let call = 0;
    const build = () => ({
      // Deliberately ignore `to` to model a source whose page size exceeds the
      // probe — the exact condition that made `from += probe` over-read.
      range: (from: number, _to: number) => {
        const take = lengths[call] ?? 0;
        call++;
        const slice = allRows.slice(from, from + take);
        return Promise.resolve({ data: slice, error: null });
      },
    });
    const { rows, error } = await fetchAllRows<{ id: number }>(build);
    expect(error).toBeNull();
    // Every distinct id exactly once, in order — no duplicates from re-fetch.
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it("throws a clear runaway-guard error if a malicious/buggy source never terminates", async () => {
    // A source that always returns a full page would loop forever without a
    // hard cap. The guard must throw an explicit error instead of hanging.
    let calls = 0;
    const build = () => ({
      // Always returns a full page of distinct rows, never shrinking.
      range: (from: number, to: number) => {
        calls++;
        const span = to - from + 1;
        const slice = Array.from({ length: span }, (_, i) => ({ id: from + i }));
        return Promise.resolve({ data: slice, error: null });
      },
    });
    await expect(fetchAllRows<{ id: number }>(build)).rejects.toThrow(/cap|runaway|too many/i);
    // The guard must have fired in bounded time, not spun unboundedly.
    expect(calls).toBeLessThan(100000);
  });
});
