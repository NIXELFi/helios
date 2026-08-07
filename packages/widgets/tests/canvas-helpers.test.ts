import { describe, it, expect } from "vitest";
import { thresholdColor } from "../src/lib/canvas-helpers";

const NORMAL = "#D8DCE2";
const WARN = "#FFB800";
const ALARM = "#EF5350";
const NO_DATA = "#7B8088";

describe("thresholdColor", () => {
  it("returns the no-data color for a null value", () => {
    expect(thresholdColor(null)).toBe(NO_DATA);
    expect(thresholdColor(null, 10, 20, 5, 2)).toBe(NO_DATA);
  });

  it("returns the normal color when no thresholds are configured", () => {
    expect(thresholdColor(0)).toBe(NORMAL);
    expect(thresholdColor(-9999)).toBe(NORMAL);
    expect(thresholdColor(9999)).toBe(NORMAL);
  });

  describe("high side only", () => {
    it("stays normal below warn", () => {
      expect(thresholdColor(9.9, 10, 20)).toBe(NORMAL);
    });
    it("warns at and above warn", () => {
      expect(thresholdColor(10, 10, 20)).toBe(WARN);
      expect(thresholdColor(15, 10, 20)).toBe(WARN);
    });
    it("alarms at and above alarm", () => {
      expect(thresholdColor(20, 10, 20)).toBe(ALARM);
      expect(thresholdColor(1000, 10, 20)).toBe(ALARM);
    });
    it("honours a warn with no alarm configured", () => {
      expect(thresholdColor(1000, 10, undefined)).toBe(WARN);
    });
    it("honours an alarm with no warn configured", () => {
      expect(thresholdColor(9, undefined, 20)).toBe(NORMAL);
      expect(thresholdColor(20, undefined, 20)).toBe(ALARM);
    });
  });

  describe("low side only", () => {
    // e.g. oil pressure: warn below 40 psi, alarm below 25 psi.
    const lo = (v: number) => thresholdColor(v, undefined, undefined, 40, 25);

    it("stays normal above warnLow", () => {
      expect(lo(40.1)).toBe(NORMAL);
      expect(lo(90)).toBe(NORMAL);
    });
    it("warns at and below warnLow", () => {
      expect(lo(40)).toBe(WARN);
      expect(lo(30)).toBe(WARN);
    });
    it("alarms at and below alarmLow", () => {
      expect(lo(25)).toBe(ALARM);
      expect(lo(0)).toBe(ALARM);
      expect(lo(-5)).toBe(ALARM);
    });
    it("honours a warnLow with no alarmLow configured", () => {
      expect(thresholdColor(-1000, undefined, undefined, 40)).toBe(WARN);
    });
    it("honours an alarmLow with no warnLow configured", () => {
      expect(thresholdColor(30, undefined, undefined, undefined, 25)).toBe(NORMAL);
      expect(thresholdColor(25, undefined, undefined, undefined, 25)).toBe(ALARM);
    });
  });

  describe("both sides configured", () => {
    // A target window: normal between 60 and 90, e.g. coolant temperature.
    const win = (v: number) => thresholdColor(v, 90, 105, 60, 50);

    it("is normal inside the window", () => {
      expect(win(60.1)).toBe(NORMAL);
      expect(win(75)).toBe(NORMAL);
      expect(win(89.9)).toBe(NORMAL);
    });
    it("warns on either shoulder", () => {
      expect(win(60)).toBe(WARN);
      expect(win(55)).toBe(WARN);
      expect(win(90)).toBe(WARN);
      expect(win(100)).toBe(WARN);
    });
    it("alarms on either extreme", () => {
      expect(win(50)).toBe(ALARM);
      expect(win(10)).toBe(ALARM);
      expect(win(105)).toBe(ALARM);
      expect(win(200)).toBe(ALARM);
    });
  });

  describe("severity precedence", () => {
    // Severity, not side, decides: any alarm outranks any warn even when the
    // bands are configured to overlap.
    it("a high alarm beats a low warn", () => {
      // v is >= alarm (20) and also <= warnLow (100).
      expect(thresholdColor(50, 10, 20, 100, 5)).toBe(ALARM);
    });
    it("a low alarm beats a high warn", () => {
      // v is >= warn (10) and also <= alarmLow (50).
      expect(thresholdColor(30, 10, undefined, undefined, 50)).toBe(ALARM);
    });
    it("both sides warning still yields warn", () => {
      // v is >= warn (10) and <= warnLow (100), with no alarm bound crossed.
      expect(thresholdColor(50, 10, 200, 100, 5)).toBe(WARN);
    });
    it("both sides alarming still yields alarm", () => {
      expect(thresholdColor(50, 10, 20, 100, 60)).toBe(ALARM);
    });
  });

  describe("boundary equality", () => {
    it("treats every bound as inclusive", () => {
      expect(thresholdColor(10, 10)).toBe(WARN);
      expect(thresholdColor(20, undefined, 20)).toBe(ALARM);
      expect(thresholdColor(40, undefined, undefined, 40)).toBe(WARN);
      expect(thresholdColor(25, undefined, undefined, undefined, 25)).toBe(ALARM);
    });
    it("prefers alarm when warn and alarm sit on the same value", () => {
      expect(thresholdColor(10, 10, 10)).toBe(ALARM);
      expect(thresholdColor(40, undefined, undefined, 40, 40)).toBe(ALARM);
    });
    it("handles zero as a real bound, not a missing one", () => {
      expect(thresholdColor(0, undefined, undefined, 0)).toBe(WARN);
      expect(thresholdColor(0, 0)).toBe(WARN);
      expect(thresholdColor(-1, undefined, undefined, 0)).toBe(WARN);
      expect(thresholdColor(1, undefined, undefined, 0)).toBe(NORMAL);
    });
  });
});
