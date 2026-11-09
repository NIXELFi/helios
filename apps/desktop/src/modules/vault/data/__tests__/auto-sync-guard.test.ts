import { beforeEach, describe, expect, it } from "vitest";
import {
  REPEAT_LIMIT,
  continueSyncingToday,
  dailyBudgetBytes,
  isOverBudget,
  isRepeatBlocked,
  loadGuard,
  recordFetch,
  recordSuccessfulFetch,
  saveGuard,
  today,
} from "../auto-sync-guard";

beforeEach(() => localStorage.clear());

describe("auto-sync circuit breaker", () => {
  it("stops a file after REPEAT_LIMIT fetches in a day", () => {
    const g = loadGuard("v1");
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) recordFetch(g, "k", 1);
    expect(isRepeatBlocked(g, "k")).toBe(false);
    recordFetch(g, "k", 1);
    expect(isRepeatBlocked(g, "k")).toBe(true);
    expect(isRepeatBlocked(g, "other")).toBe(false);
  });

  it("a brand-new full sync never trips the budget; a runaway day does", () => {
    const vault = 25e9; // SDM25
    const g = loadGuard("v1");
    recordFetch(g, "full-sync", vault);
    expect(isOverBudget(g, vault)).toBe(false);
    recordFetch(g, "loop", dailyBudgetBytes(vault) - vault);
    expect(isOverBudget(g, vault)).toBe(true);
  });

  it("persists per vault and resets on a new day", () => {
    const g = loadGuard("v1", "2026-11-03");
    recordFetch(g, "k", 5);
    saveGuard("v1", g);
    expect(loadGuard("v1", "2026-11-03").fetches.k).toBe(1);
    expect(loadGuard("v2", "2026-11-03").bytes).toBe(0);
    expect(loadGuard("v1", "2026-11-04").bytes).toBe(0);
  });

  it("Continue syncing lifts today's pause", () => {
    const g = loadGuard("v1");
    recordFetch(g, "k", 1e12);
    saveGuard("v1", g);
    expect(isOverBudget(loadGuard("v1"), 1e9)).toBe(true);
    continueSyncingToday("v1");
    expect(isOverBudget(loadGuard("v1"), 1e9)).toBe(false);
    expect(loadGuard("v1").day).toBe(today());
  });

  it("records straight into storage, so overlapping passes don't lose counts", () => {
    const passA = loadGuard("v1"); // a pass that loaded before the next one counted
    recordSuccessfulFetch("v1", "k", 10);
    recordSuccessfulFetch("v1", "k", 10);
    expect(passA.fetches.k).toBeUndefined();
    const now = loadGuard("v1");
    expect(now.fetches.k).toBe(2);
    expect(now.bytes).toBe(20);
  });
});
