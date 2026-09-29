import { describe, expect, it } from "vitest";
import { isPlausibleIsoDate } from "../plausibleDate";

describe("isPlausibleIsoDate", () => {
  it("accepts real dates", () => {
    expect(isPlausibleIsoDate("2026-07-25")).toBe(true);
    expect(isPlausibleIsoDate("2000-01-01")).toBe(true);
    expect(isPlausibleIsoDate("2100-12-31")).toBe(true);
  });

  it("rejects the partial years a date input emits mid-typing", () => {
    for (const v of ["0002-08-18", "0020-08-18", "0202-08-18", "1999-12-31", "2101-01-01"]) {
      expect(isPlausibleIsoDate(v)).toBe(false);
    }
  });

  it("rejects empty and malformed values", () => {
    expect(isPlausibleIsoDate(null)).toBe(false);
    expect(isPlausibleIsoDate(undefined)).toBe(false);
    expect(isPlausibleIsoDate("")).toBe(false);
    expect(isPlausibleIsoDate("garbage")).toBe(false);
  });
});
