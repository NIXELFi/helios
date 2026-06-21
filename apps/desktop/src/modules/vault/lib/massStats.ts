// Pure aggregation for the vehicle Mass / Weight-Budget dashboard.
// Kept free of React + Supabase so it can be unit-tested directly.
// See __tests__/massStats.test.ts.

import type { SwProperty } from "../data/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A file row augmented with its latest-version properties (fetched separately
 *  because FILE_WITH_LATEST_SELECT intentionally omits properties for bulk perf). */
export interface FileMassRow {
  id: string;
  name: string;
  folder_id: string | null;
  /** Properties from the latest version, or null if not yet parsed. */
  _properties: SwProperty[] | null;
}

export interface MassAggregation {
  /** Sum of all parseable Mass values in grams. */
  totalGrams: number;
  /** Number of files whose Mass property parsed successfully. */
  withMassCount: number;
  /** Number of files with no Mass property OR an unparseable value. */
  missingCount: number;
  /** Top-N heaviest individual parts, sorted descending by grams. */
  heaviest: MassBar[];
  /** Per-subsystem (top-level folder name) mass totals, sorted descending. */
  bySubsystem: MassBar[];
}

export interface MassBar {
  label: string;
  value: number; // grams
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LB_TO_G = 453.592;
const TOP_N = 10;

// ---------------------------------------------------------------------------
// parseMassGrams
// ---------------------------------------------------------------------------

/**
 * Parse a SolidWorks Mass property value string into grams.
 *
 * Handles:
 *   "785.0 g"  → 785.0 g
 *   "1.2 kg"   → 1200 g
 *   "2.5 lb"   → ~1133.98 g
 *   "5.0 lbs"  → ~2267.96 g
 *   "500"      → 500 g (bare number, assumes grams)
 *   "1,500 g"  → 1500 g (comma thousand separators)
 *
 * Returns null for empty strings, non-numeric content, or negative values.
 */
export function parseMassGrams(value: string): number | null {
  if (!value || !value.trim()) return null;

  // Strip comma thousand-separators before parsing
  const cleaned = value.trim().replace(/,/g, "");

  // Match optional numeric part + optional unit
  const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s*(g|kg|lb|lbs)?$/i);
  if (!match) return null;

  const num = parseFloat(match[1]!);
  if (!Number.isFinite(num) || num < 0) return null;

  const unit = (match[2] ?? "g").toLowerCase();

  if (unit === "kg") return num * 1000;
  if (unit === "lb" || unit === "lbs") return num * LB_TO_G;
  // "g" or bare number → grams
  return num;
}

// ---------------------------------------------------------------------------
// aggregateMass
// ---------------------------------------------------------------------------

/**
 * Compute vehicle mass statistics across all live files.
 *
 * @param files  - Files with their `_properties` array attached
 * @param folderNames - Map of folder_id → top-level folder name
 *                      (pass in the already-resolved top-level names; the caller
 *                      is responsible for walking the folder hierarchy if needed)
 */
export function aggregateMass(
  files: FileMassRow[],
  folderNames: Map<string, string>,
): MassAggregation {
  let totalGrams = 0;
  let withMassCount = 0;
  let missingCount = 0;

  // folder subsystem totals
  const subsystemGrams = new Map<string, number>();
  // individual part weights for Top-N ranking
  const partWeights: MassBar[] = [];

  for (const file of files) {
    const massGrams = extractMassGrams(file._properties);

    if (massGrams === null) {
      missingCount += 1;
      continue;
    }

    withMassCount += 1;
    totalGrams += massGrams;

    partWeights.push({ label: file.name, value: massGrams });

    const subsystem = file.folder_id
      ? (folderNames.get(file.folder_id) ?? "(unknown)")
      : "(root)";
    subsystemGrams.set(subsystem, (subsystemGrams.get(subsystem) ?? 0) + massGrams);
  }

  // Sort parts heaviest-first, take Top-N
  const heaviest: MassBar[] = partWeights
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_N);

  // Sort subsystems heaviest-first
  const bySubsystem: MassBar[] = [...subsystemGrams.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));

  return { totalGrams, withMassCount, missingCount, heaviest, bySubsystem };
}

/** Pull the "Mass" property from a properties array and parse it. */
function extractMassGrams(props: SwProperty[] | null): number | null {
  if (!props) return null;
  const massProp = props.find((p) => p.name.toLowerCase() === "mass");
  if (!massProp) return null;
  return parseMassGrams(massProp.value);
}

// ---------------------------------------------------------------------------
// formatMass
// ---------------------------------------------------------------------------

/**
 * Human-readable mass: grams below 1 kg, kilograms (2 decimal places) above.
 *
 *   formatMass(785)   → "785 g"
 *   formatMass(1500)  → "1.50 kg"
 */
export function formatMass(grams: number): string {
  if (grams < 1000) {
    return `${Math.round(grams)} g`;
  }
  return `${(grams / 1000).toFixed(2)} kg`;
}
