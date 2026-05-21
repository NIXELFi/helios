import { describe, expect, it } from "vitest";
import { parseRpmList, formatRpmList } from "../lib/rpmList";

describe("parseRpmList", () => {
  it("parses a comma-separated list", () => {
    const r = parseRpmList("4000, 6000, 8000");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rpms).toEqual([4000, 6000, 8000]);
  });

  it("parses a start:stop:step range inclusive", () => {
    const r = parseRpmList("4000:8000:1000");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rpms).toEqual([4000, 5000, 6000, 7000, 8000]);
  });

  it("supports mixed ranges + singles, dedupes and sorts", () => {
    const r = parseRpmList("8000, 4000:6000:1000, 10000, 5000");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rpms).toEqual([4000, 5000, 6000, 8000, 10000]);
  });

  it("rejects empty input", () => {
    const r = parseRpmList("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects non-positive step", () => {
    const r = parseRpmList("4000:6000:0");
    expect(r.ok).toBe(false);
  });

  it("rejects stop below start", () => {
    const r = parseRpmList("8000:4000:1000");
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range RPMs", () => {
    const r = parseRpmList("100, 5000");
    expect(r.ok).toBe(false);
    const r2 = parseRpmList("5000, 50000");
    expect(r2.ok).toBe(false);
  });

  it("rejects malformed range fragments", () => {
    const r = parseRpmList("4000:6000");
    expect(r.ok).toBe(false);
    const r2 = parseRpmList("a:b:c");
    expect(r2.ok).toBe(false);
  });

  it("rejects non-numeric segments", () => {
    const r = parseRpmList("4000, abc, 6000");
    expect(r.ok).toBe(false);
  });

  it("rejects too many RPMs", () => {
    // Use a range that produces > MAX_COUNT (2000) values.
    // 500..15000 step 5 = 2901 points → over the cap.
    const r = parseRpmList("500:15000:5");
    expect(r.ok).toBe(false);
  });

  it("accepts up to ~2000 RPM range for dense sweeps", () => {
    // 500..15000 step 50 = 291 points
    const r = parseRpmList("500:15000:50");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rpms.length).toBe(291);
  });

  it("formatRpmList round-trips a parsed list", () => {
    const r = parseRpmList("4000, 6000, 8000");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = formatRpmList(r.rpms);
      const back = parseRpmList(text);
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.rpms).toEqual(r.rpms);
    }
  });
});
