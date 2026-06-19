import { describe, expect, test } from "vitest";
import { parseMassGrams, aggregateMass, formatMass } from "../massStats";
import type { VaultFile } from "../../data/types";
import type { SwProperty } from "../../data/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal VaultFile with the given top-level folder and Mass property. */
function fileWithMass(
  name: string,
  opts: {
    folder_id?: string | null;
    massValue?: string | null; // null = no Mass property at all
    extraProps?: SwProperty[];
  } = {},
): VaultFile {
  const { folder_id = null, massValue = null, extraProps = [] } = opts;
  const properties: SwProperty[] = massValue !== null
    ? [{ name: "Mass", value: massValue }, ...extraProps]
    : extraProps;

  return {
    id: `file-${name}`,
    vault_id: "v1",
    folder_id,
    name,
    latest_version_id: `ver-${name}`,
    created_at: "2026-01-15T00:00:00Z",
    latest: {
      id: `ver-${name}`,
      file_id: `file-${name}`,
      version_num: 1,
      sha256: "x",
      size_bytes: 100,
      author_id: null,
      comment: null,
      parent_version_id: null,
      revision: null,
      // Note: EmbeddedLatest = Omit<Version, "properties">, so we store
      // properties separately on the FileMassRow type used by aggregateMass.
      created_at: "2026-01-15T00:00:00Z",
    },
    // We store properties as a top-level field on the augmented type.
    // aggregateMass accepts FileMassRow which adds an optional properties array.
    _properties: properties.length > 0 ? properties : null,
  } as VaultFile & { _properties: SwProperty[] | null };
}

// ---------------------------------------------------------------------------
// parseMassGrams
// ---------------------------------------------------------------------------

describe("parseMassGrams", () => {
  test('parses grams with "g" suffix', () => {
    expect(parseMassGrams("785.0 g")).toBeCloseTo(785.0);
    expect(parseMassGrams("100g")).toBeCloseTo(100);
    expect(parseMassGrams("0.5 g")).toBeCloseTo(0.5);
  });

  test('parses kilograms with "kg" suffix', () => {
    expect(parseMassGrams("1.2 kg")).toBeCloseTo(1200);
    expect(parseMassGrams("2.5kg")).toBeCloseTo(2500);
    expect(parseMassGrams("0.785 kg")).toBeCloseTo(785);
  });

  test('parses pounds with "lb" and "lbs" suffixes', () => {
    expect(parseMassGrams("2.5 lb")).toBeCloseTo(2.5 * 453.592, 1);
    expect(parseMassGrams("1 lbs")).toBeCloseTo(453.592, 1);
    expect(parseMassGrams("5.0lbs")).toBeCloseTo(5.0 * 453.592, 1);
  });

  test("parses bare numbers (assumes grams)", () => {
    expect(parseMassGrams("500")).toBeCloseTo(500);
    expect(parseMassGrams("1000.0")).toBeCloseTo(1000);
  });

  test("parses numbers with comma thousand-separators", () => {
    expect(parseMassGrams("1,500 g")).toBeCloseTo(1500);
    expect(parseMassGrams("2,500.75 g")).toBeCloseTo(2500.75);
    expect(parseMassGrams("1,200 kg")).toBeCloseTo(1_200_000);
  });

  test("returns null for garbage / unparseable strings", () => {
    expect(parseMassGrams("")).toBeNull();
    expect(parseMassGrams("N/A")).toBeNull();
    expect(parseMassGrams("--")).toBeNull();
    expect(parseMassGrams("unknown")).toBeNull();
    expect(parseMassGrams("not a number g")).toBeNull();
  });

  test("returns null for negative mass (physically invalid)", () => {
    expect(parseMassGrams("-5 g")).toBeNull();
  });

  test("is case-insensitive for unit suffixes", () => {
    expect(parseMassGrams("1.0 KG")).toBeCloseTo(1000);
    expect(parseMassGrams("2 LB")).toBeCloseTo(2 * 453.592, 1);
    expect(parseMassGrams("500 G")).toBeCloseTo(500);
  });
});

// ---------------------------------------------------------------------------
// aggregateMass
// ---------------------------------------------------------------------------

describe("aggregateMass", () => {
  const f1 = fileWithMass("Chassis_Main.SLDASM", { folder_id: "chassis", massValue: "1,200 g" });
  const f2 = fileWithMass("Engine_Block.SLDPRT", { folder_id: "engine", massValue: "3.5 kg" }); // 3500 g
  const f3 = fileWithMass("Rotor.SLDPRT", { folder_id: "chassis", massValue: "300 g" });
  const f4 = fileWithMass("README.md", { folder_id: null, massValue: null }); // no mass
  const f5 = fileWithMass("Wheel.SLDPRT", { folder_id: "suspension", massValue: "bad data" }); // unparseable

  // folder_id → folder name mapping passed to aggregateMass
  const folderNames = new Map([
    ["chassis", "Chassis"],
    ["engine", "Engine"],
    ["suspension", "Suspension"],
  ]);

  const result = aggregateMass(
    [f1, f2, f3, f4, f5] as any,
    folderNames,
  );

  test("totals grams across all parseable parts", () => {
    // f1: 1200g, f2: 3500g, f3: 300g → 5000g
    expect(result.totalGrams).toBeCloseTo(5000);
  });

  test("counts parts with mass and without", () => {
    // f1, f2, f3 have parseable mass → 3
    expect(result.withMassCount).toBe(3);
    // f4 (no Mass prop) + f5 (bad data) → 2
    expect(result.missingCount).toBe(2);
  });

  test("ranks heaviest parts in descending order", () => {
    const labels = result.heaviest.map((b) => b.label);
    // Engine_Block (3500g) > Chassis_Main (1200g) > Rotor (300g)
    expect(labels[0]).toBe("Engine_Block.SLDPRT");
    expect(labels[1]).toBe("Chassis_Main.SLDASM");
    expect(labels[2]).toBe("Rotor.SLDPRT");
  });

  test("heaviest values are in grams", () => {
    expect(result.heaviest[0]!.value).toBeCloseTo(3500);
    expect(result.heaviest[1]!.value).toBeCloseTo(1200);
  });

  test("groups mass by subsystem (top-level folder name)", () => {
    const chassis = result.bySubsystem.find((b) => b.label === "Chassis");
    const engine = result.bySubsystem.find((b) => b.label === "Engine");
    // f1 + f3 = 1200 + 300 = 1500g
    expect(chassis?.value).toBeCloseTo(1500);
    // f2 = 3500g
    expect(engine?.value).toBeCloseTo(3500);
  });

  test("subsystem bars are sorted heaviest-first", () => {
    const values = result.bySubsystem.map((b) => b.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });

  test("files at vault root (no folder) appear as (root) subsystem", () => {
    // f4 has no mass, f5 has bad mass; neither appear. But if a root file has mass:
    const rootFile = fileWithMass("TopAssembly.SLDASM", { folder_id: null, massValue: "50 g" });
    const r = aggregateMass([rootFile] as any, new Map());
    expect(r.bySubsystem.find((b) => b.label === "(root)")?.value).toBeCloseTo(50);
  });

  test("empty file list returns zeroed result", () => {
    const empty = aggregateMass([], new Map());
    expect(empty.totalGrams).toBe(0);
    expect(empty.withMassCount).toBe(0);
    expect(empty.missingCount).toBe(0);
    expect(empty.heaviest).toEqual([]);
    expect(empty.bySubsystem).toEqual([]);
  });

  test("all files missing mass returns zero totalGrams and full missingCount", () => {
    const noMass = [
      fileWithMass("A.SLDPRT", { massValue: null }),
      fileWithMass("B.SLDPRT", { massValue: "garbage" }),
    ];
    const r = aggregateMass(noMass as any, new Map());
    expect(r.totalGrams).toBe(0);
    expect(r.withMassCount).toBe(0);
    expect(r.missingCount).toBe(2);
    expect(r.heaviest).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatMass
// ---------------------------------------------------------------------------

describe("formatMass", () => {
  test("formats sub-1000g as grams with integer display", () => {
    expect(formatMass(785)).toBe("785 g");
    expect(formatMass(0)).toBe("0 g");
    expect(formatMass(999)).toBe("999 g");
  });

  test("formats 1000g and above as kilograms", () => {
    expect(formatMass(1000)).toBe("1.00 kg");
    expect(formatMass(1500)).toBe("1.50 kg");
    expect(formatMass(10000)).toBe("10.00 kg");
  });

  test("rounds grams to nearest integer", () => {
    expect(formatMass(785.6)).toBe("786 g");
    expect(formatMass(785.4)).toBe("785 g");
  });

  test("rounds kg to 2 decimal places", () => {
    expect(formatMass(1234)).toBe("1.23 kg");
    expect(formatMass(1235)).toBe("1.24 kg"); // 1235/1000 = 1.235 → rounds to 1.24
    expect(formatMass(5678)).toBe("5.68 kg");
  });
});
