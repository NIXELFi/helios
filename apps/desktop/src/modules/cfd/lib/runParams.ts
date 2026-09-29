// Client-side checks for CFD run-sizing inputs (rpm, max cycles, tolerance,
// min cycles). The number inputs' min/max attributes are advisory only — the
// onChange handlers store Number(value) — so without this a typed 1e9 "Max
// cycles" goes straight to the solver. Bounds mirror the Rust boundary check
// in crates/cfd-core/src/validate.rs; keep the two in sync.

export const RPM_MIN = 500;
export const RPM_MAX = 20000;
export const N_CYCLES_MAX = 200;
export const OPT_N_CYCLES_MAX = 50;
export const MIN_CYCLES_MAX = 50;

export interface FieldSpec {
  label: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
}

/** Error text for one field, or null when it is a finite value in [min, max]. */
export function fieldError({ label, value, min, max, integer }: FieldSpec): string | null {
  const ok =
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value));
  if (ok) return null;
  return `${label} must be ${integer ? "an integer" : "a number"} in [${min}, ${max}].`;
}

/** Every failing field's error text, in input order. */
export function fieldErrors(fields: FieldSpec[]): string[] {
  return fields.map(fieldError).filter((e): e is string => e !== null);
}

/** The shared max-cycles / tolerance / min-cycles trio. */
export function runSizingFields(
  nCyclesMax: number,
  tol: number,
  minCycles: number,
  nCyclesHi: number = N_CYCLES_MAX,
): FieldSpec[] {
  return [
    { label: "Max cycles", value: nCyclesMax, min: 1, max: nCyclesHi, integer: true },
    { label: "Convergence tol", value: tol, min: 0, max: 1 },
    { label: "Min cycles", value: minCycles, min: 0, max: MIN_CYCLES_MAX, integer: true },
  ];
}
