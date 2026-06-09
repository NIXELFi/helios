// Sequential color ramp for channel-colored displays (track map, traces).
// Blue (slow/low) → cyan → green → yellow → red (fast/high), matching the
// module's chart palette. Pure math, no deps — unit-testable.

export interface RampStop {
  t: number;
  rgb: [number, number, number];
}

/** The module's channel ramp: cold blue → hot red. */
const RAMP: RampStop[] = [
  { t: 0.0, rgb: [63, 81, 181] }, // indigo (low)
  { t: 0.25, rgb: [79, 195, 247] }, // cyan
  { t: 0.5, rgb: [165, 214, 167] }, // green
  { t: 0.75, rgb: [255, 198, 39] }, // ASU gold
  { t: 1.0, rgb: [255, 82, 82] }, // red (high)
];

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/** Color at t ∈ [0,1] on the channel ramp (clamped; NaN → mid). */
export function rampColor(t: number): string {
  const x = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.5;
  let i = 0;
  while (i < RAMP.length - 2 && x > RAMP[i + 1]!.t) i++;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  const f = b.t === a.t ? 0 : (x - a.t) / (b.t - a.t);
  const [r, g, bl] = [0, 1, 2].map((k) => a.rgb[k]! + f * (b.rgb[k]! - a.rgb[k]!)) as [
    number,
    number,
    number,
  ];
  return `#${hex2(r)}${hex2(g)}${hex2(bl)}`;
}

/** Normalize `values` to [0,1] over their finite min..max and map through the
 *  ramp. A constant (or empty/non-finite) series maps to the mid color. */
export function rampColors(values: number[]): { colors: string[]; min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  const span = max - min;
  const colors = values.map((v) => rampColor(span > 0 ? (v - min) / span : 0.5));
  return { colors, min, max };
}
