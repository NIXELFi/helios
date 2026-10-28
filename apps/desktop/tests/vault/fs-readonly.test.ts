import { beforeEach, describe, expect, it, vi } from "vitest";

// Each sw_flip_readonly call is held open until the test releases it, standing
// in for the native command that resolves when the helper process exits.
type Call = { path: string; readonly: boolean; release: () => void; fail: (e: Error) => void };
const calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { path: string; readonly: boolean }) => {
    if (cmd !== "sw_flip_readonly") return Promise.resolve(null);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve, reject) => {
      calls.push({
        path: args.path,
        readonly: args.readonly,
        release: () => { inFlight--; resolve(); },
        fail: (e) => { inFlight--; reject(e); },
      });
    });
  },
}));

import { flipSwReadonly } from "../../src/modules/vault/data/fs-readonly";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Release calls one at a time until the queue is empty. */
async function drainAll(): Promise<void> {
  for (let guard = 0; guard < 1000; guard++) {
    await tick();
    const next = calls.find((c) => (c as Call & { done?: boolean }).done !== true);
    if (!next) return;
    (next as Call & { done?: boolean }).done = true;
    next.release();
  }
}

describe("flipSwReadonly serial queue", () => {
  beforeEach(async () => {
    await drainAll();
    calls.length = 0;
    inFlight = 0;
    maxInFlight = 0;
  });

  it("keeps at most one helper call in flight across a burst", async () => {
    for (let i = 0; i < 50; i++) flipSwReadonly(`/v/f${i}.sldprt`, i % 2 === 0);
    await tick();
    expect(calls).toHaveLength(1); // only the first is dispatched
    await drainAll();
    expect(calls).toHaveLength(50); // all eventually run, in order
    expect(calls.map((c) => c.path)).toEqual(Array.from({ length: 50 }, (_, i) => `/v/f${i}.sldprt`));
    expect(maxInFlight).toBe(1);
  });

  it("dedupes a queued path, keeping the latest desired state", async () => {
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/a.sldprt", false);
    flipSwReadonly("/v/a.sldprt", true); // supersedes the queued rw
    flipSwReadonly("/v/b.sldprt", true);
    await drainAll();
    const a = calls.filter((c) => c.path === "/v/a.sldprt");
    expect(a).toHaveLength(1);
    expect(a[0]!.readonly).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/v/first.sldprt", "/v/a.sldprt", "/v/b.sldprt"]);
  });

  it("keeps draining after a failed call and never throws", async () => {
    flipSwReadonly("/v/bad.sldprt", false);
    flipSwReadonly("/v/good.sldprt", false);
    await tick();
    expect(() => calls[0]!.fail(new Error("helper crashed"))).not.toThrow();
    await tick();
    expect(calls.map((c) => c.path)).toEqual(["/v/bad.sldprt", "/v/good.sldprt"]);
    await drainAll();
  });

  it("restarts the drain after the queue empties", async () => {
    flipSwReadonly("/v/one.sldprt", true);
    await drainAll();
    flipSwReadonly("/v/two.sldprt", true);
    await tick();
    expect(calls.map((c) => c.path)).toEqual(["/v/one.sldprt", "/v/two.sldprt"]);
    await drainAll();
  });
});
