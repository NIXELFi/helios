import { beforeEach, describe, expect, it, vi } from "vitest";

// Each sw_flip_readonly_batch call is held open until the test releases it,
// standing in for the native command that resolves when the helper exits.
type Call = {
  paths: string[];
  readonly: boolean;
  release: (statuses?: Record<string, string>) => void;
  fail: (e: Error) => void;
  done?: boolean;
};
const calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { paths: string[]; readonly: boolean }) => {
    if (cmd !== "sw_flip_readonly_batch") return Promise.resolve(null);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      calls.push({
        paths: args.paths,
        readonly: args.readonly,
        release: (statuses = {}) => {
          inFlight--;
          resolve({
            swRunning: true,
            results: args.paths.map((path) => ({ path, status: statuses[path] ?? "not-open" })),
          });
        },
        fail: (e) => { inFlight--; reject(e); },
      });
    });
  },
}));

const toast = vi.fn();
vi.mock("../../src/modules/vault/data/toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

import { flipSwReadonly, swFlipMessage } from "../../src/modules/vault/data/fs-readonly";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Release calls one at a time until the queue is empty. */
async function drainAll(statuses: Record<string, string> = {}): Promise<void> {
  for (let guard = 0; guard < 1000; guard++) {
    await tick();
    const next = calls.find((c) => c.done !== true);
    if (!next) return;
    next.done = true;
    next.release(statuses);
  }
}

describe("flipSwReadonly batched queue", () => {
  beforeEach(async () => {
    await drainAll();
    calls.length = 0;
    inFlight = 0;
    maxInFlight = 0;
    toast.mockClear();
  });

  it("sends a burst as a few batches, never one helper per file, one at a time", async () => {
    for (let i = 0; i < 50; i++) flipSwReadonly(`/v/f${i}.sldprt`, false);
    await drainAll();
    // The first call goes out at once; everything queued behind it is ONE batch.
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.flatMap((c) => c.paths)).toEqual(Array.from({ length: 50 }, (_, i) => `/v/f${i}.sldprt`));
    expect(maxInFlight).toBe(1);
  });

  it("splits a batch by desired state", async () => {
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/a.sldprt", false);
    flipSwReadonly("/v/b.sldprt", true);
    await drainAll();
    const rest = calls.slice(1);
    expect(rest.map((c) => [c.readonly, c.paths])).toEqual([
      [false, ["/v/a.sldprt"]],
      [true, ["/v/b.sldprt"]],
    ]);
  });

  it("dedupes a queued path, keeping the latest desired state", async () => {
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/a.sldprt", false);
    flipSwReadonly("/v/a.sldprt", true); // supersedes the queued rw
    await drainAll();
    const withA = calls.filter((c) => c.paths.includes("/v/a.sldprt"));
    expect(withA).toHaveLength(1);
    expect(withA[0]!.readonly).toBe(true);
  });

  it("keeps draining after a failed call and never throws", async () => {
    flipSwReadonly("/v/bad.sldprt", false);
    flipSwReadonly("/v/good.sldprt", false);
    await tick();
    expect(() => calls[0]!.fail(new Error("helper crashed"))).not.toThrow();
    calls[0]!.done = true;
    await drainAll();
    expect(calls.flatMap((c) => c.paths)).toEqual(["/v/bad.sldprt", "/v/good.sldprt"]);
  });

  it("tells the user when SOLIDWORKS kept a checked-out file read-only", async () => {
    flipSwReadonly("C:\\vault\\Chassis\\frame.sldprt", false);
    await drainAll({ "C:\\vault\\Chassis\\frame.sldprt": "failed" });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toContain("frame.sldprt");
    expect(toast.mock.calls[0]![1]).toBe("error");
  });

  it("is quiet when the file isn't open or flipped fine", async () => {
    flipSwReadonly("/v/a.sldprt", false);
    flipSwReadonly("/v/b.sldprt", false);
    await drainAll({ "/v/b.sldprt": "flipped" });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("swFlipMessage", () => {
  it("covers the check-out failures with an action to take", () => {
    expect(swFlipMessage("/v/a.sldprt", false, "failed-dirty")?.message).toMatch(/Save As a copy/);
    expect(swFlipMessage("/v/a.sldprt", false, "ambiguous")?.tone).toBe("error");
    expect(swFlipMessage("/v/a.sldprt", false, "reloaded")?.tone).toBe("success");
    expect(swFlipMessage("/v/a.sldprt", false, "flipped")).toBeNull();
  });
  it("warns when a checked-in file stays editable", () => {
    expect(swFlipMessage("/v/a.sldprt", true, "failed")?.message).toMatch(/still editable/);
    expect(swFlipMessage("/v/a.sldprt", true, "flipped")).toBeNull();
  });
});
