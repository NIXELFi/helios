/**
 * useVaultProperties — incremental property cache (2026-11-16).
 *
 * The old hook re-pulled every file's properties (a request per 300 files)
 * on each catalog change and never stopped a superseded pull, so one added
 * file into a 3,000-file vault cost ~10 property requests × 4–6 overlapping
 * copies. These tests pin the incremental behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const inCalls: string[][] = [];
const PROPS: Record<string, unknown[] | null> = {};
const client = {
  from: (_t: string) => ({
    select: (_s: string) => ({
      in: async (_c: string, ids: string[]) => {
        inCalls.push(ids);
        return {
          data: ids.map((id) => ({ id, file_id: `f-${id}`, properties: PROPS[id] ?? null })),
          error: null,
        };
      },
    }),
  }),
};
vi.mock("@helios/auth", () => ({ useSupabaseClient: () => client }));

import {
  useVaultProperties,
  versionIdsToFetch,
  buildPropertiesMap,
  DEBOUNCE_MS,
  type CachedVersionProps,
} from "../useVaultProperties";

const file = (id: string, vid: string | null, name = `${id}.csv`) =>
  ({ id, latest_version_id: vid, name }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  inCalls.length = 0;
  for (const k of Object.keys(PROPS)) delete PROPS[k];
});
afterEach(() => vi.useRealTimers());

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
  });
}

describe("pure helpers", () => {
  it("fetches uncached ids, and re-checks only SOLIDWORKS files cached as empty", () => {
    const cache = new Map<string, CachedVersionProps>([
      ["v1", { fileId: "a", properties: null }],
      ["v2", { fileId: "b", properties: null }],
      ["v3", { fileId: "c", properties: [{ name: "Material", value: "Al" } as never] }],
    ]);
    const out = versionIdsToFetch(
      [file("a", "v1", "a.csv"), file("b", "v2", "b.SLDPRT"), file("c", "v3"), file("d", "v4"), file("e", null)],
      cache,
    );
    expect(out).toEqual(["v2", "v4"]);
  });

  it("builds the map keyed by the current file id, skipping empty rows", () => {
    const p = [{ name: "Material", value: "Al" }] as never;
    const cache = new Map<string, CachedVersionProps>([
      ["v1", { fileId: "old", properties: p }],
      ["v2", { fileId: "b", properties: null }],
    ]);
    const map = buildPropertiesMap([file("a", "v1"), file("b", "v2")], cache);
    expect([...map.keys()]).toEqual(["a"]);
  });
});

describe("useVaultProperties", () => {
  it("only fetches the new file's version after an add", async () => {
    PROPS.v1 = [{ name: "Material", value: "Al" }];
    const { result, rerender } = renderHook(
      (p: { files: never[] }) => useVaultProperties("vault" as never, p.files),
      { initialProps: { files: [file("a", "v1", "a.sldprt"), file("b", "v2")] } },
    );
    await flush();
    expect(inCalls).toEqual([["v1", "v2"]]);
    expect(result.current?.get("a")).toEqual(PROPS.v1);

    inCalls.length = 0;
    rerender({ files: [file("a", "v1", "a.sldprt"), file("b", "v2"), file("c", "v3")] });
    await flush();
    expect(inCalls).toEqual([["v3"]]);
    // The old map stays visible (not reset to null) through the refresh.
    expect(result.current?.get("a")).toEqual(PROPS.v1);
  });

  it("coalesces a burst of catalog changes into one fetch", async () => {
    const { rerender } = renderHook(
      (p: { files: never[] }) => useVaultProperties("vault" as never, p.files),
      { initialProps: { files: [file("a", "v1")] } },
    );
    rerender({ files: [file("a", "v1"), file("b", "v2")] });
    rerender({ files: [file("a", "v1"), file("b", "v2"), file("c", "v3")] });
    await flush();
    expect(inCalls).toEqual([["v1", "v2", "v3"]]);
  });

  it("resets on a vault switch", async () => {
    PROPS.v1 = [{ name: "Material", value: "Al" }];
    const { result, rerender } = renderHook(
      (p: { vault: string; files: never[] }) => useVaultProperties(p.vault as never, p.files),
      { initialProps: { vault: "A", files: [file("a", "v1")] } },
    );
    await flush();
    expect(result.current?.size).toBe(1);
    rerender({ vault: "B", files: [file("x", "v9")] });
    expect(result.current).toBeNull();
    await flush();
    expect(result.current?.size).toBe(0);
    expect(inCalls.at(-1)).toEqual(["v9"]);
  });
});
