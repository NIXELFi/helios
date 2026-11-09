import { describe, expect, it } from "vitest";
import {
  failedDownloadKey,
  failedRetryDelayMs,
  nextRetryInMs,
  recordDownloadOutcome,
  type FailedDownloads,
} from "../useAutoSync";

describe("auto-sync per-file failure backoff", () => {
  it("doubles from 30 s and caps at 30 min", () => {
    expect(failedRetryDelayMs(1)).toBe(30_000);
    expect(failedRetryDelayMs(2)).toBe(60_000);
    expect(failedRetryDelayMs(3)).toBe(120_000);
    expect(failedRetryDelayMs(7)).toBe(30 * 60_000);
    expect(failedRetryDelayMs(500)).toBe(30 * 60_000);
  });

  it("records failures, clears on success, and reports the earliest retry", () => {
    const m: FailedDownloads = new Map();
    const a = failedDownloadKey("ABC", "C:/v/a.sldprt");
    const b = failedDownloadKey("def", "C:/v/b.sldprt");
    expect(a).toBe("abc|C:/v/a.sldprt");
    expect(nextRetryInMs(m, 0)).toBeNull();
    recordDownloadOutcome(m, a, false, 0);
    recordDownloadOutcome(m, a, false, 0);
    recordDownloadOutcome(m, b, false, 10_000);
    expect(m.get(a)).toEqual({ failures: 2, nextAttemptAt: 60_000 });
    expect(nextRetryInMs(m, 0)).toBe(40_000); // b: 10 s + 30 s
    recordDownloadOutcome(m, b, true, 20_000);
    expect(m.has(b)).toBe(false);
    expect(nextRetryInMs(m, 70_000)).toBe(0);
  });
});
