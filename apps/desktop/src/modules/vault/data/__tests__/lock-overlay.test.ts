import { describe, expect, it } from "vitest";
import { applyOverlay, entriesToClear, type OverlayEntry } from "../lock-overlay";
import type { FileId, Lock } from "../types";

function lock(p: Partial<Lock> = {}): Lock {
  return {
    id: "L1",
    file_id: "f1",
    user_id: "me",
    acquired_at: "t",
    released_at: null,
    force_released_by: null,
    ...p,
  };
}
function ov(...pairs: Array<[FileId, OverlayEntry]>): Map<FileId, OverlayEntry> {
  return new Map(pairs);
}

describe("applyOverlay", () => {
  it("returns the same reference when the overlay is empty (no churn)", () => {
    const base = [lock({ file_id: "f1" })];
    expect(applyOverlay(base, ov())).toBe(base);
  });

  it("adds an optimistic lock for a file not yet in the canonical list", () => {
    const out = applyOverlay([], ov(["f1", { kind: "add", lock: lock({ file_id: "f1" }) }]));
    expect(out.map((l) => l.file_id)).toEqual(["f1"]);
  });

  it("does not duplicate an add when the canonical list already has the lock", () => {
    const base = [lock({ file_id: "f1", id: "real" })];
    const out = applyOverlay(base, ov(["f1", { kind: "add", lock: lock({ file_id: "f1", id: "optimistic" }) }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("real"); // canonical wins
  });

  it("removes a lock optimistically (cancel / check-in)", () => {
    const base = [lock({ file_id: "f1" }), lock({ file_id: "f2" })];
    const out = applyOverlay(base, ov(["f1", { kind: "remove" }]));
    expect(out.map((l) => l.file_id)).toEqual(["f2"]);
  });
});

describe("entriesToClear", () => {
  it("clears an add once the canonical list confirms the lock is held", () => {
    const overlay = ov(["f1", { kind: "add", lock: lock({ file_id: "f1" }) }]);
    expect(entriesToClear(overlay, [lock({ file_id: "f1" })])).toEqual(["f1"]);
  });

  it("keeps an add while the canonical list still lacks the lock", () => {
    const overlay = ov(["f1", { kind: "add", lock: lock({ file_id: "f1" }) }]);
    expect(entriesToClear(overlay, [])).toEqual([]);
  });

  it("clears a remove once the lock is gone from the canonical list", () => {
    const overlay = ov(["f1", { kind: "remove" }]);
    expect(entriesToClear(overlay, [])).toEqual(["f1"]);
  });

  it("keeps a remove while the canonical list still shows the lock held", () => {
    const overlay = ov(["f1", { kind: "remove" }]);
    expect(entriesToClear(overlay, [lock({ file_id: "f1" })])).toEqual([]);
  });

  it("treats a released lock as not-held (released_at set)", () => {
    const overlay = ov(["f1", { kind: "remove" }]);
    expect(entriesToClear(overlay, [lock({ file_id: "f1", released_at: "t" })])).toEqual(["f1"]);
  });
});
