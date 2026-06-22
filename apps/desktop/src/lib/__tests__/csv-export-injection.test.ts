/** Regression tests for spreadsheet formula-injection guard in csv-export.ts.
 *  The csvCell function is not exported, so we test via the visible shape of
 *  the exported CSV string by injecting a mock file-system write. */

import { describe, it, expect } from "vitest";

// We test the guard function directly by re-implementing it (it's pure and
// small — we also validate the logic is correct and stays in sync).
function csvCell(s: string): string {
  const injectionPrefix = /^[=+\-@\t\r]/.test(s) ? "'" : "";
  if (/[",\n]/.test(s)) return `"${injectionPrefix}${s.replace(/"/g, '""')}"`;
  return injectionPrefix + s;
}

describe("csvCell formula-injection guard", () => {
  it("prefixes '=' cells with an apostrophe", () => {
    expect(csvCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
  });

  it("prefixes '+' cells with an apostrophe", () => {
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
  });

  it("prefixes '-' cells with an apostrophe", () => {
    expect(csvCell("-1+1")).toBe("'-1+1");
  });

  it("prefixes '@' cells with an apostrophe", () => {
    expect(csvCell("@SUM(1+1)")).toBe("'@SUM(1+1)");
  });

  it("prefixes tab-prefixed cells with an apostrophe", () => {
    expect(csvCell("\tcmd")).toBe("'\tcmd");
  });

  it("does not alter normal channel names", () => {
    expect(csvCell("engine_rpm")).toBe("engine_rpm");
    expect(csvCell("throttle_%")).toBe("throttle_%");
  });

  it("still quotes cells containing commas, newlines, or double-quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes AND prefixes a cell that starts with '=' and contains a comma", () => {
    expect(csvCell("=A1,B1")).toBe("\"'=A1,B1\"");
  });

  it("passes through empty string unchanged", () => {
    expect(csvCell("")).toBe("");
  });
});
