import { describe, expect, it } from "vitest";
import { fmtCents, parseCents } from "../money";
import { looksLikeHeader, mapHeaders, parseTsv, toRows } from "../paste";

describe("purchasing paste", () => {
  it("reads a Mouser cart with its header, preferring the manufacturer part number", () => {
    const text =
      "Mouser #\tMfr. #\tDescription\tQuantity\tUnit Price (USD)\tExt. Price (USD)\n" +
      "595-ADC128S102CIMT\tADC128S102CIMTX/NOPB\tAnalog to Digital Converters 8-Ch 12-bit\t2\t$9.26\t$18.52\n" +
      "576-AQ1003-01LTG\tAQ1003-01LTG\tTVS Diodes 3.3V\t16\t$0.305\t$4.88\n";
    const m = parseTsv(text);
    const header = m[0] ?? [];
    expect(looksLikeHeader(header)).toBe(true);
    const mapping = mapHeaders(header);
    expect(mapping).toEqual([null, "part_number", "title", "quantity", "unit_price", "total"]);
    const rows = toRows(m.slice(1), mapping, "Mouser");
    expect(rows).toEqual([
      { title: "Analog to Digital Converters 8-Ch 12-bit", quantity: 2, unit_price_cents: 926, total_estimate_cents: 1852, vendor: "Mouser", part_number: "ADC128S102CIMTX/NOPB" },
      { title: "TVS Diodes 3.3V", quantity: 16, unit_price_cents: 31, total_estimate_cents: 488, vendor: "Mouser", part_number: "AQ1003-01LTG" },
    ]);
  });

  it("keeps newlines inside quoted Excel cells and drops rows with no name", () => {
    const m = parseTsv('"Two\nline name"\t3\n\t5\n');
    expect(m).toEqual([["Two\nline name", "3"], ["", "5"]]);
    expect(toRows(m, ["title", "quantity"])).toHaveLength(1);
  });

  it("parses money the way people type it", () => {
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("(3.00)")).toBe(-300);
    expect(parseCents("2.57CR")).toBe(-257);
    expect(parseCents("")).toBeNull();
    expect(fmtCents(4497)).toBe("$44.97");
  });
});
