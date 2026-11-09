import { beforeEach, describe, expect, it, vi } from "vitest";

// Each sw_flip_readonly_batch call is held open until the test releases it,
// standing in for the native command that resolves when the helper exits.
type Call = {
  paths: string[];
  readonly: boolean;
  reload: boolean;
  release: (statuses?: Record<string, string>) => void;
  fail: (e: Error) => void;
  done?: boolean;
};
const calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { paths: string[]; readonly: boolean; reload?: boolean }) => {
    if (cmd !== "sw_flip_readonly_batch") return Promise.resolve(null);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      calls.push({
        paths: args.paths,
        readonly: args.readonly,
        reload: args.reload === true,
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

  it("splits a batch by intent: in place, reload, read-only", async () => {
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/ro.sldprt", true);
    flipSwReadonly("/v/rwr.sldprt", false, { reload: true });
    flipSwReadonly("/v/rw.sldprt", false);
    await drainAll();
    expect(calls.slice(1).map((c) => [c.readonly, c.reload, c.paths])).toEqual([
      [false, false, ["/v/rw.sldprt"]],
      [false, true, ["/v/rwr.sldprt"]],
      [true, false, ["/v/ro.sldprt"]],
    ]);
  });

  it("never downgrades a queued reload to an in-place flip", async () => {
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/a.sldprt", false, { reload: true });
    flipSwReadonly("/v/a.sldprt", false); // later plain check-out: still stale in SW
    await drainAll();
    const withA = calls.filter((c) => c.paths.includes("/v/a.sldprt"));
    expect(withA.map((c) => [c.readonly, c.reload])).toEqual([[false, true]]);
  });

  it("lets read-only supersede a queued reload, but a later check-out still reloads", async () => {
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/a.sldprt", false, { reload: true });
    flipSwReadonly("/v/a.sldprt", true);
    await drainAll();
    expect(calls.filter((c) => c.paths.includes("/v/a.sldprt")).map((c) => [c.readonly, c.reload])).toEqual([[true, false]]);

    calls.length = 0;
    flipSwReadonly("/v/first.sldprt", false); // dispatched immediately
    flipSwReadonly("/v/b.sldprt", false, { reload: true });
    flipSwReadonly("/v/b.sldprt", true);
    flipSwReadonly("/v/b.sldprt", false);
    await drainAll();
    expect(calls.filter((c) => c.paths.includes("/v/b.sldprt")).map((c) => [c.readonly, c.reload])).toEqual([[false, true]]);
  });

  it("a check-out queued while that file's reload is in flight carries the reload", async () => {
    flipSwReadonly("/v/a.sldprt", false, { reload: true }); // dispatched immediately
    await tick();
    flipSwReadonly("/v/a.sldprt", false); // its result will skip the in-flight one's
    await drainAll({ "/v/a.sldprt": "stale-dirty" });
    expect(calls.map((c) => [c.readonly, c.reload])).toEqual([[false, true], [false, true]]);
    // Only the second (deciding) result is surfaced.
    expect(toast).toHaveBeenCalledTimes(1);
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

  it("tells the user when a reload was refused over unsaved changes", async () => {
    flipSwReadonly("C:\\vault\\frame.sldprt", false, { reload: true });
    await drainAll({ "C:\\vault\\frame.sldprt": "stale-dirty" });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toMatch(/older copy of frame\.sldprt with unsaved changes/);
    expect(toast.mock.calls[0]![1]).toBe("error");
  });

  it("tells the user their unsaved SOLIDWORKS edits weren't checked in", async () => {
    flipSwReadonly("/v/a.sldprt", true);
    flipSwReadonly("/v/b.sldprt", true, { reason: "cancel" });
    await drainAll({ "/v/a.sldprt": "flipped-dirty", "/v/b.sldprt": "flipped-dirty" });
    const msgs = toast.mock.calls.map((c) => c[0] as string);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBe(
      "Your unsaved SOLIDWORKS changes to a.sldprt were not checked in (Helios checked in the saved file). a.sldprt is now read-only.",
    );
    expect(msgs[1]).toMatch(/Undo check-out/);
  });

  it("is quiet when the file isn't open or flipped fine", async () => {
    flipSwReadonly("/v/a.sldprt", false);
    flipSwReadonly("/v/b.sldprt", false);
    flipSwReadonly("/v/c.sldprt", true);
    flipSwReadonly("/v/d.sldprt", false, { reload: true });
    await drainAll({ "/v/b.sldprt": "flipped", "/v/c.sldprt": "flipped", "/v/d.sldprt": "not-open" });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("swFlipMessage", () => {
  it("covers the check-out failures with an action to take", () => {
    expect(swFlipMessage("/v/a.sldprt", "rw", "failed-dirty")?.message).toMatch(/Save As a copy/);
    expect(swFlipMessage("/v/a.sldprt", "rw", "ambiguous")?.tone).toBe("error");
    expect(swFlipMessage("/v/a.sldprt", "rw", "ambiguous")?.message).toMatch(/open more than once/);
    expect(swFlipMessage("/v/a.sldprt", "rw", "reloaded")?.tone).toBe("success");
    expect(swFlipMessage("/v/a.sldprt", "rw", "flipped")).toBeNull();
    expect(swFlipMessage("/v/a.sldprt", "rw", "not-open")).toBeNull();
  });
  it("covers a check-out that reloads the newer version", () => {
    expect(swFlipMessage("/v/a.sldprt", "rwr", "reloaded")).toEqual({
      message: "Reloaded a.sldprt in SOLIDWORKS with the latest version so you can edit it.",
      tone: "success",
    });
    const dirty = swFlipMessage("/v/a.sldprt", "rwr", "stale-dirty");
    expect(dirty?.tone).toBe("error");
    expect(dirty?.message).toMatch(/older copy of a\.sldprt with unsaved changes/);
    expect(dirty?.message).toMatch(/Save a copy/);
    expect(dirty?.message).toMatch(/close a\.sldprt and open it again/);
    expect(swFlipMessage("/v/a.sldprt", "rwr", "failed")?.message).toMatch(/older copy/);
    expect(swFlipMessage("/v/a.sldprt", "rwr", "ambiguous")?.tone).toBe("error");
    expect(swFlipMessage("/v/a.sldprt", "rwr", "not-open")).toBeNull();
  });
  it("warns when a checked-in file stays editable or had unsaved edits", () => {
    expect(swFlipMessage("/v/a.sldprt", "ro", "failed")?.message).toMatch(/still editable/);
    expect(swFlipMessage("/v/a.sldprt", "ro", "flipped")).toBeNull();
    expect(swFlipMessage("/v/a.sldprt", "ro", "flipped-dirty")?.message).toBe(
      "Your unsaved SOLIDWORKS changes to a.sldprt were not checked in (Helios checked in the saved file). a.sldprt is now read-only.",
    );
    expect(swFlipMessage("/v/a.sldprt", "ro", "flipped-dirty", "cancel")?.message).toMatch(/Undo check-out/);
  });
});
