import { describe, it, expect, afterEach, vi } from "vitest";
import { gzipBytes, gunzipIfNeeded, isGzipped } from "../compression";

/** Deterministic pseudo-random filler — incompressible enough to exercise the
 *  real codec path (a run of zeroes would gzip to nothing and prove little). */
function noisyBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = 0x2f6e2b1 >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gzip fallback (no CompressionStream)", () => {
  it("round-trips a 1 MB payload byte-for-byte", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    vi.stubGlobal("DecompressionStream", undefined);
    const original = noisyBytes(1024 * 1024);

    const gz = await gzipBytes(original);
    expect(isGzipped(gz)).toBe(true);

    const back = await gunzipIfNeeded(gz);
    expect(back.length).toBe(original.length);
    expect(back).toEqual(original);
  });

  it("falls back when the native codec throws", async () => {
    class ExplodingStream {
      constructor() { throw new Error("no codec here"); }
    }
    vi.stubGlobal("CompressionStream", ExplodingStream);
    vi.stubGlobal("DecompressionStream", ExplodingStream);
    const original = noisyBytes(4096);

    const gz = await gzipBytes(original);
    expect(isGzipped(gz)).toBe(true);
    expect(await gunzipIfNeeded(gz)).toEqual(original);
  });

  it("passes legacy uncompressed bytes straight through", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    vi.stubGlobal("DecompressionStream", undefined);
    const raw = new TextEncoder().encode("time,rpm\n0,900\n");
    expect(isGzipped(raw)).toBe(false);
    expect(await gunzipIfNeeded(raw)).toBe(raw);
  });
});
