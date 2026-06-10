# 61 — Lap sim: per-axle roll-balance cornering limit (ARB/RSD data)

Nick supplied the team's ARB calculator (SDM26) and measured RSD test sheet
(SDM25, 2025-11-23). The two cross-validate: the SDM25 sheet's measured
CG-to-roll-axis arm (10.34 in) matches what the SDM26 calculator's roll-center
heights + CG imply to the millimeter (262.6 mm).

## Model

`VehicleConfig.roll` (RSD front share, roll arm, RC heights, aero split) turns
the cornering limit per-axle: lateral load transfer splits by roll-stiffness
distribution + roll-center geometry (Milliken Ch 18 simplified), each axle's
capacity is the load-weighted μ(Fz) of its outer + inner tires (.tir fit or
power-law fallback), and the car saturates at whichever axle gives up first.
Without `roll`, the legacy lumped-χ model is unchanged.

- SDM26 preset: rsdFront 0.512 (with-tire no-ARB baseline; ARB combos span
  0.376–0.605), arm 0.2626 m, RC 18.6/25.1 mm, aero 53% front.
- SDM25 preset: rsdFront 0.36 (as RSD-tested: no front bar, rear ARB stiff).
- New telemetry: `pctFrontLimited` — of corner-limited time, how often the
  FRONT axle binds. Surfaced as a push/neutral/loose **balance readout** on
  the lap-telemetry cards. First result: SDM26 models as rear-limited
  (~0–2% front) at the limit.
- Sensitivity panel gains **ARB balance ±3% front** levers — the lap sim as
  an ARB-tuning tool.
- Vehicle setup gains an editable roll-balance row.

## Re-anchoring

Per-axle is less pessimistic than lumped χ (transfer split across two pairs
degrades μ less), so both grip anchors re-trimmed against SDM26's real
42.922 s autocross: default `muLat` 1.55 → 1.50 (AX 42.881 s) and .tir
default lateral scale 0.625 → 0.62 (AX 42.934 s). Accel and endurance
anchors unaffected.

## Open item

The ARB calculator's total mass (615 lb = 279.5 kg) disagrees with the
vehicle preset (267 kg = 199 kg car + 68 kg driver) — different driver/fuel
assumption? Worth reconciling with the suspension team.
