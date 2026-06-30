// FSAE 2026 dynamic-event point formulas (§D.9–D.13). All are field-relative
// (depend on the fastest team's time Tmin), so projecting points needs a
// reference baseline. P1 implements Acceleration; the rest land in P2.

/** Acceleration §D.9.4: Tmax = 1.5·Tmin;
 *  score = 95.5·[(Tmax/Ty − 1)/(Tmax/Tmin − 1)] + 4.5; floor 4.5, ceiling 100. */
export function accelPoints(tYourS: number, tMinS: number): number {
  if (!(tMinS > 0) || !(tYourS > 0)) return 0;
  const tMax = 1.5 * tMinS;
  if (tYourS >= tMax) return 4.5;
  const score = 95.5 * ((tMax / tYourS - 1) / (tMax / tMinS - 1)) + 4.5;
  return Math.min(100, Math.max(4.5, score));
}

/** Autocross §D.11.4: Tmax = 1.45·Tmin;
 *  118.5·[(Tmax/Ty − 1)/(Tmax/Tmin − 1)] + 6.5; floor 6.5, ceiling 125. */
export function autocrossPoints(tYourS: number, tMinS: number): number {
  if (!(tMinS > 0) || !(tYourS > 0)) return 0;
  const tMax = 1.45 * tMinS;
  if (tYourS >= tMax) return 6.5;
  return Math.min(125, 118.5 * ((tMax / tYourS - 1) / (tMax / tMinS - 1)) + 6.5);
}

/** Endurance TIME score §D.12.13.2: Tmax = 1.45·Tmin;
 *  250·[(Tmax/Ty − 1)/(Tmax/Tmin − 1)]; 0 if Ty ≥ Tmax. (Laps score is separate.) */
export function enduranceTimePoints(tYourS: number, tMinS: number): number {
  if (!(tMinS > 0) || !(tYourS > 0)) return 0;
  const tMax = 1.45 * tMinS;
  if (tYourS >= tMax) return 0;
  return Math.min(250, 250 * ((tMax / tYourS - 1) / (tMax / tMinS - 1)));
}

/** Efficiency factor §D.13.4.4 (per-lap form, equal lap counts):
 *  (Tmin/Ty)·(CO₂min/CO₂you). Higher is better; 1.0 = matches the field best. */
export function efficiencyFactor(
  tYourS: number,
  co2YouKg: number,
  tMinS: number,
  co2MinKg: number,
): number {
  if (!(tYourS > 0) || !(co2YouKg > 0) || !(tMinS > 0) || !(co2MinKg > 0)) return 0;
  return (tMinS / tYourS) * (co2MinKg / co2YouKg);
}

/** Efficiency score §D.13.4.6: 100·(EF − EFmin)/(EFmax − EFmin), clamped 0–100. */
export function efficiencyPoints(effYou: number, effMin: number, effMax: number): number {
  if (!(effMax > effMin)) return 0;
  return Math.min(100, Math.max(0, (100 * (effYou - effMin)) / (effMax - effMin)));
}
