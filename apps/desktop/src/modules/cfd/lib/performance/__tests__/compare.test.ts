import { describe, it, expect } from "vitest";

import type { VehicleConfig } from "../types";
import type { TorqueCurve } from "../torqueCurve";
import { attributeGap, stepDeltas } from "../compare";
import { computeEvents } from "../events";
import { SDM25_VEHICLE, SDM26_VEHICLE, REFERENCE_2026 } from "../vehicle";

const flat = (t: number): TorqueCurve => [
  { rpm: 0, torqueNm: t },
  { rpm: 20000, torqueNm: t },
];

// A bumpy curve so the engine step has something to attribute.
const BUMPY: TorqueCurve = [
  { rpm: 4000, torqueNm: 58 },
  { rpm: 8000, torqueNm: 63 },
  { rpm: 11000, torqueNm: 49 },
  { rpm: 14500, torqueNm: 22 },
];

describe("attributeGap", () => {
  const a = { label: "A", curve: BUMPY, vehicle: SDM26_VEHICLE };
  const b = { label: "B", curve: flat(55), vehicle: SDM25_VEHICLE };
  const steps = attributeGap(a, b, REFERENCE_2026);

  it("first step IS design A, last step IS design B (verbatim computeEvents)", () => {
    const ea = computeEvents(a.curve, a.vehicle, REFERENCE_2026);
    const eb = computeEvents(b.curve, b.vehicle, REFERENCE_2026);
    expect(steps[0]!.events.autocross.lapTimeS).toBeCloseTo(ea.autocross.lapTimeS, 12);
    expect(steps[0]!.events.totalPoints!).toBeCloseTo(ea.totalPoints!, 12);
    const last = steps[steps.length - 1]!;
    expect(last.events.autocross.lapTimeS).toBeCloseTo(eb.autocross.lapTimeS, 12);
    expect(last.events.endurance.lapTimeS).toBeCloseTo(eb.endurance.lapTimeS, 12);
    expect(last.events.totalPoints!).toBeCloseTo(eb.totalPoints!, 12);
  });

  it("step deltas telescope: they sum exactly to B − A on every metric", () => {
    for (const get of [
      (e: ReturnType<typeof computeEvents>) => e.autocross.lapTimeS,
      (e: ReturnType<typeof computeEvents>) => e.endurance.lapTimeS,
      (e: ReturnType<typeof computeEvents>) => e.totalPoints,
    ]) {
      const deltas = stepDeltas(steps, get);
      const sum = deltas.slice(1).reduce((s: number, d) => s + (d ?? 0), 0);
      expect(sum).toBeCloseTo(get(steps[steps.length - 1]!.events)! - get(steps[0]!.events)!, 9);
    }
  });

  it("orders steps baseline → engine → mass → gearing → chassis", () => {
    expect(steps.map((s) => s.key)).toEqual(["baseline", "engine", "mass", "gearing", "chassis"]);
  });

  it("identical designs attribute zero everywhere", () => {
    const same = attributeGap(a, { ...a, label: "A2" }, REFERENCE_2026);
    const deltas = stepDeltas(same, (e) => e.totalPoints);
    for (const d of deltas.slice(1)) expect(Math.abs(d!)).toBeLessThan(1e-9);
  });

  it("a mass-only difference lands entirely on the mass step", () => {
    const heavy: VehicleConfig = { ...SDM26_VEHICLE, massKg: SDM26_VEHICLE.massKg + 20 };
    const s = attributeGap(a, { label: "H", curve: BUMPY, vehicle: heavy }, REFERENCE_2026);
    const deltas = stepDeltas(s, (e) => e.autocross.lapTimeS);
    expect(Math.abs(deltas[1]!)).toBeLessThan(1e-9); // engine: same curve
    expect(deltas[2]!).toBeGreaterThan(0); // mass: heavier = slower
    expect(Math.abs(deltas[3]!)).toBeLessThan(1e-9); // gearing unchanged
    expect(Math.abs(deltas[4]!)).toBeLessThan(1e-9); // chassis unchanged
  });
});
