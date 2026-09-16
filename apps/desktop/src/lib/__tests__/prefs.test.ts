import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  isQuietNow,
  notificationAllowed,
  readPrefs,
  usePrefs,
} from "../prefs";

beforeEach(() => {
  localStorage.clear();
  usePrefs.setState({ prefs: DEFAULT_PREFS });
});

describe("readPrefs", () => {
  it("returns defaults when nothing is stored or the blob is garbage", () => {
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    localStorage.setItem(PREFS_KEY, "{not json");
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("deep-merges a partial stored blob over the defaults", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, landing: "logs", notifications: { vault: false } }));
    const p = readPrefs();
    expect(p.landing).toBe("logs");
    expect(p.notifications.vault).toBe(false);
    expect(p.notifications.updates).toBe(true);
    expect(p.notifications.quiet).toEqual(DEFAULT_PREFS.notifications.quiet);
  });

  it("ignores values outside the allowed set", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, landing: "vault", closeToTray: "yes" }));
    const p = readPrefs();
    expect(p.landing).toBe(DEFAULT_PREFS.landing);
    expect(p.closeToTray).toBe(true);
  });

  it("auto-update defaults on and round-trips", () => {
    expect(readPrefs().autoUpdate).toBe(true);
    usePrefs.getState().update({ autoUpdate: false });
    expect(readPrefs().autoUpdate).toBe(false);
  });
});

describe("usePrefs store", () => {
  it("update() merges and persists", () => {
    usePrefs.getState().update({ landing: "last" });
    usePrefs.getState().update({ notifications: { enabled: false } });
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    expect(stored.landing).toBe("last");
    expect(stored.notifications.enabled).toBe(false);
    expect(stored.notifications.vault).toBe(true);
    expect(usePrefs.getState().prefs.notifications.enabled).toBe(false);
  });
});

describe("isQuietNow", () => {
  const quiet = { enabled: true, start: "22:00", end: "07:00" };
  const at = (h: number, m = 0) => new Date(2026, 8, 16, h, m);
  it("handles a window that wraps midnight", () => {
    expect(isQuietNow(quiet, at(23))).toBe(true);
    expect(isQuietNow(quiet, at(3))).toBe(true);
    expect(isQuietNow(quiet, at(6, 59))).toBe(true);
    expect(isQuietNow(quiet, at(7))).toBe(false);
    expect(isQuietNow(quiet, at(12))).toBe(false);
    expect(isQuietNow(quiet, at(21, 59))).toBe(false);
  });
  it("handles a same-day window", () => {
    const q = { enabled: true, start: "12:00", end: "13:30" };
    expect(isQuietNow(q, at(12, 30))).toBe(true);
    expect(isQuietNow(q, at(14))).toBe(false);
  });
  it("is never quiet when disabled or when start equals end", () => {
    expect(isQuietNow({ ...quiet, enabled: false }, at(23))).toBe(false);
    expect(isQuietNow({ enabled: true, start: "09:00", end: "09:00" }, at(9))).toBe(false);
  });
});

describe("notificationAllowed", () => {
  it("respects the master switch, the per-source switch and quiet hours", () => {
    const p = DEFAULT_PREFS;
    const day = new Date(2026, 8, 16, 12);
    expect(notificationAllowed("vault", p, day)).toBe(true);
    expect(notificationAllowed("vault", { ...p, notifications: { ...p.notifications, enabled: false } }, day)).toBe(false);
    expect(notificationAllowed("vault", { ...p, notifications: { ...p.notifications, vault: false } }, day)).toBe(false);
    expect(notificationAllowed("updates", { ...p, notifications: { ...p.notifications, vault: false } }, day)).toBe(true);
    const night = new Date(2026, 8, 16, 23);
    const quietOn = { ...p, notifications: { ...p.notifications, quiet: { enabled: true, start: "22:00", end: "07:00" } } };
    expect(notificationAllowed("vault", quietOn, night)).toBe(false);
    expect(notificationAllowed("vault", quietOn, day)).toBe(true);
  });
});
