// fetchAllRows: a superseded pull stops paging (2026-11-16 upload-throughput fix).
import { describe, it, expect } from "vitest";
import { fetchAllRows } from "../paginate";

function source(total: number, pageCap = 1000) {
  const calls: Array<[number, number]> = [];
  const build = () => ({
    range: async (from: number, to: number) => {
      calls.push([from, to]);
      const end = Math.min(total, to + 1, from + pageCap);
      return { data: Array.from({ length: Math.max(0, end - from) }, (_, i) => from + i), error: null };
    },
  });
  return { calls, build };
}

describe("fetchAllRows isCancelled", () => {
  it("pages to the end when never cancelled", async () => {
    const s = source(3500);
    const { rows } = await fetchAllRows<number>(s.build);
    expect(rows.length).toBe(3500);
    expect(s.calls.length).toBe(4);
  });

  it("stops before the next page once cancelled", async () => {
    const s = source(3500);
    let cancelled = false;
    const p = fetchAllRows<number>(() => {
      const q = s.build();
      return { range: async (a: number, b: number) => { const r = await q.range(a, b); cancelled = true; return r; } };
    }, () => cancelled);
    const { rows } = await p;
    expect(s.calls.length).toBe(1);
    expect(rows.length).toBe(1000);
  });
});
