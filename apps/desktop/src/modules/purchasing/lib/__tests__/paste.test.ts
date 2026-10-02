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

  it("leaves out cells the server would refuse, and says so on the row", () => {
    const rows = toRows([["Bolt", "0", "-1.00", "2/30/26"]], ["title", "quantity", "unit_price", "needed_by"]);
    expect(rows[0]).toMatchObject({ title: "Bolt" });
    expect(rows[0]!.quantity).toBeUndefined();
    expect(rows[0]!.unit_price_cents).toBeUndefined();
    expect(rows[0]!.needed_by).toBeUndefined();
    expect(rows[0]!.notes).toMatch(/quantity 0, unit price -1.00 left out/);
  });

  it("parses money the way people type it", () => {
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("(3.00)")).toBe(-300);
    expect(parseCents("2.57CR")).toBe(-257);
    expect(parseCents("")).toBeNull();
    expect(parseCents("\u221212.50")).toBe(-1250);   // typographic minus from a PDF
    expect(parseCents("5.00-")).toBe(-500);
    expect(parseCents("abc")).toBeNull();
    expect(fmtCents(4497)).toBe("$44.97");
  });

  it("reads the team's Airtable export: DATE NEEDED is kept as written, and drifting headers still match", () => {
    const header = ["Item Name", "Sub-System", "Priority", "Status", "Quantity", "Cost per Unit", "Tax + Shipping", "Total Cost",
      "Funding Source", "Date Ordered", "DATE NEEDED", "Vendor", "LINK", "Notes"];
    expect(mapHeaders(header)).toEqual(["title", null, "priority", "status", "quantity", "unit_price", "tax_shipping", "total",
      "funding_source", null, "date_needed_raw", "vendor", "product_url", "notes"]);
    const rows = toRows([["ADC", "", "HIGH", "Ordered", "2", "9.26", "", "18.52", "Chase Account", "", "9/11/2026", "Mouser", "", ""]], mapHeaders(header));
    expect(rows[0]).toMatchObject({ title: "ADC", status: "ORDERED", date_needed_raw: "9/11/2026", funding_source: "Chase Account" });
    expect(rows[0]!.needed_by).toBeUndefined();
    expect(mapHeaders(["Item Name (short)", "Unit Cost ($)", "Qty.", "Needed by"])).toEqual(["title", "unit_price", "quantity", "needed_by"]);
  });
});
