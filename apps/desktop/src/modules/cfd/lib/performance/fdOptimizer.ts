// Final-drive (sprocket) optimizer: sweep the feasible chain-sprocket ratios
// for the loaded torque curve and score each with the SAME computeEvents path
// as everything else. Gap attribution showed final drive dominates endurance
// (FD 3.5 costs ~+2.4 s/lap vs 3.0 on the same car) while a sprocket swap is
// the cheapest real-world change the team can make — this puts "points vs FD,
// in real tooth counts" on screen.
//
// NOTE: callers must pass an EXPLICIT vehicle and override finalDrive on it —
// vehicleForCar() forces FD for known cars, so overriding must happen after
// identity resolution (don't fight the preset).

import { computeEvents, type EventScores } from "./events";
import type { ReferenceBaseline, VehicleConfig } from "./types";
import type { TorqueCurve } from "./torqueCurve";

/** 520-chain sprockets the team can realistically source. */
export const FRONT_TEETH = [12, 13, 14, 15, 16];
export const REAR_TEETH = Array.from({ length: 21 }, (_, i) => 36 + i); // 36–56

export interface SprocketCombo {
  front: number;
  rear: number;
}

export interface FdOption {
  fd: number;
  /** Every tooth pair that lands (within rounding) on this ratio. */
  combos: SprocketCombo[];
}

/** Unique feasible final-drive ratios in [fdMin, fdMax], each annotated with
 *  the real tooth combinations that produce it (e.g. 3.0 = 42/14 = 45/15). */
export function sprocketOptions(fdMin = 2.4, fdMax = 4.4): FdOption[] {
  const byRatio = new Map<string, FdOption>();
  for (const front of FRONT_TEETH) {
    for (const rear of REAR_TEETH) {
      const fd = rear / front;
      if (fd < fdMin || fd > fdMax) continue;
      const key = fd.toFixed(3);
      let opt = byRatio.get(key);
      if (!opt) {
        opt = { fd: Number(key), combos: [] };
        byRatio.set(key, opt);
      }
      opt.combos.push({ front, rear });
    }
  }
  return Array.from(byRatio.values()).sort((a, b) => a.fd - b.fd);
}

export function comboLabel(c: SprocketCombo): string {
  return `${c.rear}/${c.front}`;
}

export interface FdSweepRow extends FdOption {
  events: EventScores;
}

/** Score every FD option with the production event chain. ~3 ms per option
 *  (post vCorner-memo), so a full sprocket sweep is interactive. */
export function sweepFinalDrive(
  curve: TorqueCurve,
  vehicle: VehicleConfig,
  baseline: ReferenceBaseline,
  options: FdOption[] = sprocketOptions(),
): FdSweepRow[] {
  return options.map((opt) => ({
    ...opt,
    events: computeEvents(curve, { ...vehicle, finalDrive: opt.fd }, baseline),
  }));
}
