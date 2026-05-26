// fields.ts
//
// Per-field metadata + derived-field math for the wave viewer.

import type { WaveField } from "../../state/types";
import type { ColormapName } from "./colormaps";

export const GAMMA_AIR = 1.4;
export const R_AIR = 287.0;
export const P_ATM = 101325.0;

export interface WaveFieldMeta {
  label: string;
  unit: string;
  colormap: ColormapName;
  /** If non-null, the colormap is centered on this value (RdBu_r-style). */
  centerOn: number | null;
  /** For derived fields like Mach, marks them so the loader knows. */
  derived?: boolean;
}

export const WAVE_FIELD_META: Record<WaveField, WaveFieldMeta> = {
  p:    { label: "pressure",    unit: "Pa",    colormap: "RdBu_r",  centerOn: P_ATM },
  u:    { label: "velocity",    unit: "m/s",   colormap: "RdBu_r",  centerOn: 0 },
  T:    { label: "temperature", unit: "K",     colormap: "inferno", centerOn: null },
  rho:  { label: "density",     unit: "kg/m³", colormap: "viridis", centerOn: null },
  Mach: { label: "Mach",        unit: "-",     colormap: "viridis", centerOn: null, derived: true },
};

/**
 * Mach number from cell-local velocity and temperature.
 * Returns 0 for T ≤ 0 (sentinel) to avoid NaN from sqrt of non-positive T.
 */
export function computeMach(u: number, T: number): number {
  if (T <= 0) return 0;
  return u / Math.sqrt(GAMMA_AIR * R_AIR * T);
}

export function fieldRange(
  field: WaveField,
  observed: { min: number; max: number },
): { vmin: number; vmax: number } {
  if (field === "Mach") {
    return { vmin: 0, vmax: observed.max };
  }
  const meta = WAVE_FIELD_META[field];
  if (meta.centerOn != null) {
    const c = meta.centerOn;
    const half = Math.max(Math.abs(observed.min - c), Math.abs(observed.max - c));
    return { vmin: c - half, vmax: c + half };
  }
  return { vmin: observed.min, vmax: observed.max };
}
