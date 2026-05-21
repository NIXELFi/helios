// Per-field client-side validators. Runs on every change to keep the
// editor responsive. Operates on the *stored SI value* — display-unit
// conversion is the field component's responsibility.

import { getAt } from "../lib/path-helpers";
import type { FieldMeta } from "../../lib/sdm26Schema";

export type ValidationResult = { ok: true } | { ok: false; message: string };

export function validateField(meta: FieldMeta, value: unknown): ValidationResult {
  // Required check first.
  const empty = value == null || value === "" || (typeof value === "number" && Number.isNaN(value));
  if (empty) {
    if (meta.required) return { ok: false, message: `${meta.label} is required` };
    // Allow null on optional fields without further checks.
    return { ok: true };
  }

  if (meta.type === "number" || meta.type === "integer") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return { ok: false, message: `${meta.label} must be a number` };
    if (meta.type === "integer" && !Number.isInteger(n)) {
      return { ok: false, message: `${meta.label} must be a whole number` };
    }
    if (meta.min != null && n < meta.min) {
      const display = meta.format ? meta.format(meta.min) : String(meta.min);
      return { ok: false, message: `${meta.label} below minimum (${display}${meta.unit ? " " + meta.unit : ""})` };
    }
    if (meta.max != null && n > meta.max) {
      const display = meta.format ? meta.format(meta.max) : String(meta.max);
      return { ok: false, message: `${meta.label} above maximum (${display}${meta.unit ? " " + meta.unit : ""})` };
    }
  }

  if (meta.type === "select" && meta.options) {
    const ok = meta.options.some((o) => o.value === value);
    if (!ok) {
      return {
        ok: false,
        message: `${meta.label} must be one of: ${meta.options.map((o) => o.value).join(", ")}`,
      };
    }
  }

  return { ok: true };
}

/// Run every applicable validator over `raw`, returning a map of
/// dot-path → error message for failing fields. Synthetic keys
/// (starting with `__`) are skipped.
export function validateAll(
  metas: ReadonlyArray<FieldMeta>,
  raw: Record<string, unknown>,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const m of metas) {
    if (m.key.startsWith("__")) continue;
    const v = getAt(raw, m.key);
    const r = validateField(m, v);
    if (!r.ok) errs[m.key] = r.message;
  }
  return errs;
}

/// Validate firing_order: must contain exactly n_cylinders unique
/// integers in [1, n_cylinders].
export function validateFiringOrder(value: unknown, nCylinders: number): ValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, message: "Firing order must be a list" };
  }
  if (value.length !== nCylinders) {
    return { ok: false, message: `Firing order needs exactly ${nCylinders} entries` };
  }
  const seen = new Set<number>();
  for (const x of value) {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > nCylinders) {
      return { ok: false, message: `Firing order entries must be integers 1..${nCylinders}` };
    }
    if (seen.has(x)) {
      return { ok: false, message: `Firing order has duplicate entry ${x}` };
    }
    seen.add(x);
  }
  return { ok: true };
}

/// Cd-table monotonicity check (advisory — does not block save).
/// Returns null when monotonic-ish; otherwise a warning message.
export function checkCdMonotonic(rows: ReadonlyArray<readonly [number, number]>): string | null {
  if (rows.length < 2) return null;
  let prevCd = rows[0]![1];
  let prevLd = rows[0]![0];
  for (let i = 1; i < rows.length; i++) {
    const ld = rows[i]![0];
    const cd = rows[i]![1];
    if (ld <= prevLd) return `Cd-table is not sorted by L/D (row ${i + 1}: ${ld} ≤ ${prevLd})`;
    if (cd < prevCd - 0.05) {
      return `Cd-table dips at L/D=${ld.toFixed(3)} (Cd=${cd.toFixed(3)} after ${prevCd.toFixed(3)})`;
    }
    prevCd = cd;
    prevLd = ld;
  }
  return null;
}
