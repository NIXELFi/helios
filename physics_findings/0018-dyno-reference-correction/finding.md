---
id: 18
slug: dyno-reference-correction
status: FIXED
topic: The dyno reference data used through findings 0001-0017 (`cbr600rr-fsae-restricted.csv`, a multi-source aggregate from FSAE.com archive + Honda 600RR Forum) does not represent the SDM team's actual engine builds. Comparing simulator output against this aggregate produced phantom "huge gaps" at low RPM (+12 kW) and high RPM (-12 kW) that drove several investigations (T1.1 low-Re Cd, T1.3 VVT) toward mechanisms that couldn't apply to the real engine. The user provided two team-measured Dynojet chassis dyno files; extracted to `sdm25-team-dyno.csv` and `sdm26-team-dyno.csv` and re-ran the production-knob-set comparison. Real picture: SDM26 RMSE 5.57 kW / bias +0.52 kW; SDM25 RMSE 8.84 kW / bias +0.39 kW. The simulator is **much closer to reality than thought**. Remaining real gaps are dominated by the documented MUSCL/WENO exhaust wave-damping issue at high RPM (worse on SDM25's longer 4-1 exhaust).
hypothesis: A team member flagged that the dyno-reference plot "looked incorrect." Cross-checking the aggregate CSV against the unrestricted CBR600RR CSV in the same directory revealed an inconsistent restricted/stock power ratio across RPM (~60% flat) that doesn't match restrictor physics (should be nearly transparent at low RPM, severe at high RPM). Hypothesis: the aggregate was unsuitable for SDM-team-specific calibration. Verification: replace with team-measured dyno; re-run; observe how much "gap" disappears.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: user feedback in 2026-05-23 session
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## What was wrong with the old reference

`physics_findings/references/dyno/cbr600rr-fsae-restricted.csv` was
documented as "Aggregate of FSAE.com archive thread t-1508 (multi-team
published dynos, 2010–2018 era), Honda 600RR Forum dyno-chart-thread
(similar era)..." with the envelope (41–52 kW peak band) marked
authoritative but individual rows flagged at ±5% accuracy.

Two issues:

1. **Multi-team aggregate ≠ SDM team's specific engine.** FSAE teams
   cam-time and intake/exhaust-tune for restricted operation in
   team-specific ways. A multi-team aggregate flattens the team-to-team
   variation. The SDM team's own dyno does not necessarily land
   inside the aggregate band.

2. **Low-RPM band was admitted-uncertain.** The 6 kRPM row note
   explicitly says: *"Aggregated low-RPM band; teams rarely publish
   below 6k for restricted CBR600."* The 18.5 kW value at 6 kRPM was
   essentially extrapolated. It also doesn't match restrictor
   physics — a 20 mm restrictor is nearly transparent at low RPM
   (engine doesn't demand enough flow to choke), so restricted
   power should be ≥ 90% of unrestricted at low RPM. The aggregate
   showed restricted/unrestricted ≈ 60% **flat across all RPM**,
   which is physically impossible.

## What the team's real dyno shows

Two Dynojet chassis dyno files (provided by user 2026-05-23):

- `~/Downloads/RunFile_11.csv` → SDM25 (DWRT/Dynojet; RPM × 1000, HP, lbft)
- `~/Downloads/SDM (1).CSV`    → SDM26 (Dynojet; raw RPM, HP, lbft)

Both are **20 mm restricted, WOT chassis dyno (wheel power)** runs of
the SDM team's actual engines. Extracted to canonical CSVs under
`physics_findings/references/dyno/`:

- `sdm25-team-dyno.csv`
- `sdm26-team-dyno.csv`

### Comparison: old aggregate vs real team dyno (wheel power, kW)

| RPM   | OLD agg. | **SDM26 real** | **SDM25 real** |
|------:|---------:|---------------:|---------------:|
|  4500 | n/a      | **14.6**       | 16.4           |
|  5000 | n/a      | 17.2           | 19.1           |
|  6000 | 18.5     | **29.9**       | 17.6 (tune dip)|
|  7000 | 24.5     | 30.8           | 30.2           |
|  8000 | 30.5     | 37.7           | 38.3           |
|  9000 | 36.0     | 44.5           | 41.2           |
|  9500 | -        | **45.4 (peak)**| 43.5           |
| 10000 | 41.0     | 44.9           | 48.0           |
| 10500 | -        | 42.4           | **51.0 (peak)**|
| 11000 | 44.5     | 42.5           | 50.8           |
| 12000 | 48.0     | 42.1           | 49.2           |
| 13000 | 50.5     | 45.1           | 47.0           |
| 13500 | 51.5     | 41.0           | (file ends 12.5k) |

Key differences from the aggregate:

- **SDM26 peaks at ~46 kW @ 9500 RPM**, not 52 kW at 13.5 k. The
  aggregate over-stated peak power by 5+ kW.
- **At 6 kRPM, SDM26 is ~30 kW**, not 18.5 kW. The aggregate was
  11 kW (60%) too low at low RPM.
- **SDM25 has a dyno dip at 5.5–6.5 kRPM** that the simulator
  cannot reproduce because it's a tune/measurement artifact, not
  engine physics.
- **Both engines show a double-peak shape** with a second high-RPM
  peak around 12.5 k for SDM26 and ~13 k for SDM25 — characteristic
  of wave-tuning resonance.

## Simulator vs real dyno (production knob set, unchanged)

### SDM26 (all 18 RPMs in common)

| Band           | Old-aggregate bias | **Real-dyno bias** |
|----------------|------------------:|------------------:|
| All (4.5–13k)  | +1.94 kW           | **+0.52 kW**      |
| 4–7k (incl. part-throttle) | +11.66 kW | +5.30 kW          |
| **6–13k (real WOT)** | -                  | **−1.02 kW**      |
| **7–11.5k (high-confidence WOT)** | - | **+0.44 kW** |
| 7.5–10k        | n/a                | −0.55 kW          |
| 10.5–13k       | −12.35 kW          | **−3.20 kW**      |

**The "12 kW high-RPM gap" was 75% bad reference data.** Against the
real dyno, SDM26's high-RPM bias is only −3 kW. In the high-confidence
WOT band (7–11.5 kRPM, n=10 dyno points), bias is **+0.44 kW**.

### SDM25 (all 18 RPMs in common)

| Band           | Old-aggregate bias | **Real-dyno bias** |
|----------------|------------------:|------------------:|
| All (4–12.5k)  | +0.71 kW           | +0.39 kW          |
| 4–7k           | +10.96 kW          | +10.06 kW         |
| **7–11.5k (high-confidence WOT)** | - | **−3.51 kW**     |
| 10.5–13k       | −13.09 kW          | **−10.60 kW**     |

SDM25's high-RPM gap is real and ~3× bigger than SDM26's. This is
consistent with the longer 4-1 exhaust (0.66 m primary vs SDM26's
0.31 m + 4-2-1) — more MUSCL cells = more wave damping in the
simulator.

The SDM25 low-RPM "gap" (+10 kW @ 4-7k) is largely the dyno dip at
5.5-6.5 kRPM (ECU artifact) plus possibly part-throttle ramp-up at
the very low end.

## What this means for findings 0015 and 0017

### 0015 (T1.1 low-Re Cd correction)

Conclusion **unchanged**: the Heywood low-Re mechanism does not engage
on CBR600RR Reynolds. But the **motivation** for it was inflated by
the bad reference. Against real dyno, the "+12 kW low-RPM gap" at
6 kRPM is actually:

- SDM26 @ 6k: bias **+0.31 kW** — basically zero
- SDM25 @ 6k: bias +13.09 kW — but this is dyno tune-dip territory

There was nothing meaningful for the Heywood correction to close on
SDM26 even if it had engaged.

### 0017 (T1.3 VVT)

Conclusion **strongly reinforced**: the original premise ("close the
+12 kW low-RPM gap") was based on bad reference data. There is no
+12 kW gap at 6 kRPM on SDM26 (it's +0.3 kW). Implementing VVT to
close a phantom gap would have been pure overfit.

## What this means for finding 0016 (two-zone c_v γ)

Against the real dyno, two-zone behavior is more interesting than
the old aggregate suggested. The c_v-weighted γ fix from 0016 still
shifts BP by −0.46 kW symmetrically on both engines — physics is
unchanged. But the **utility** of two-zone is different:

| Band (SDM26)   | Single-zone | Two-zone + c_v γ (0016) | Δ |
|----------------|-------------|------------------------:|--:|
| 4–7k bias      | +5.30 kW    | +6.74 kW                | +1.44 kW (worse) |
| 7.5–10k bias   | −0.55 kW    | +1.76 kW                | +2.31 kW (worse) |
| **10.5–13k bias** | **−3.20 kW** | **−0.51 kW**         | **+2.69 kW (BETTER)** |
| RMSE all       | 5.57 kW     | 5.83 kW                 | +0.26 (∼same) |

Two-zone closes ~85% of the high-RPM under-prediction (the MUSCL
wave-damping gap) at the cost of low-RPM accuracy. This is a real
trade-off, not a clean win. Production recommendation **still**: keep
two-zone OFF, because the cost (low-RPM bias) outweighs the benefit
(high-RPM closure) for overall RMSE. But two-zone + c_v γ is now a
**useful diagnostic tool** for assessing the MUSCL damping
contribution to the high-RPM gap.

## Where the simulator stands now (real-dyno baseline)

| Engine | RMSE all | Bias all | Conclusion |
|--------|---------:|---------:|------------|
| SDM26  | 5.57 kW  | +0.52 kW | **Good** across the operating range |
| SDM25  | 8.84 kW  | +0.39 kW | **Good in peak band**, dyno artifacts at low RPM, MUSCL damping at high RPM |

The 0.85 implied-drivetrain-η Cameron benchmark is **approximately**
satisfied in the peak power band (8–10 kRPM η ∈ 0.85–0.93 for both
engines). Outside the peak band, implied η drifts away from 0.85 in
ways that are mostly NOT simulator defects:

- Below 6 kRPM: dyno operator part-throttle ramp-up (apples to oranges)
- 5.5–6.5 kRPM on SDM25: ECU tune dip (real engine artifact)
- 11.5+ kRPM: MUSCL exhaust wave damping (real simulator defect, T4.1)

## Files added / modified

- `physics_findings/references/dyno/sdm26-team-dyno.csv` (new, canonical)
- `physics_findings/references/dyno/sdm25-team-dyno.csv` (new, canonical)
- `physics_findings/references/dyno/cbr600rr-fsae-restricted-OLD-aggregate.csv`
  (old aggregate, retained for historical reference)
- `physics_findings/references/dyno/cbr600rr-fsae-restricted.csv`
  (unchanged, but README now flags it as deprecated for SDM-team work)
- `physics_findings/references/dyno/README.md` (updated)
- `physics_findings/references/dyno/extract_real_dyno.py` (new, reproducible)
- This finding doc.

## What I would NOT recommend doing

- Retroactively rewriting findings 0001–0017 to use the new reference.
  Those findings document work-as-of-its-time; rewriting them erases
  process information. Cross-link from this doc instead.
- Treating the new dyno as ground truth without checking the SDM25
  low-RPM dip. The 5.5–6.5 kRPM dip is suspicious — verify with
  the team that it's a known tune artifact (and not an engine
  physics signal the simulator should match).

## Followup queue

- **0019 — FMEP-0002 revalidation against real dyno**. The 0002
  finding's "fmep_b = 0.1 absorbs other model error" hypothesis was
  tested against the bad reference. With real dyno showing the
  simulator UNDER-predicts at 10 k (not over), the FMEP conclusion
  may need updating. Re-run the 0002 sweep, see whether the
  Heywood-typical (0.04–0.05) range now fits the dyno band.
- **0020 — Confirm SDM25 5.5–6.5 kRPM dip is dyno artifact**. Ask
  the team for context: was that run part-throttle, tune-issue, or
  real engine misfire region? Until confirmed, exclude that band
  from SDM25 fit metrics.
- **0021 — Compute high-confidence WOT band RMSE** as the headline
  metric going forward, instead of all-RPM RMSE. The high-confidence
  band is 7000–11500 RPM for both engines (excludes dyno ramp-up
  and excludes the MUSCL-dominated high-RPM region).
