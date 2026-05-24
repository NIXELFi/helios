---
id: 17
slug: vvt-deferred-cbr600rr-fixed-cam
status: DEFERRED
topic: T1.3 from NEXT_AGENT.md — variable valve timing model. **Deferred without implementation**. The task as written assumed real CBR600RR has VVT/VTEC and that mismatched overlap at low RPM contributes to the +12 kW over-prediction. Both premises are wrong: every CBR600RR (2007-2020) has fixed cams, NOT VTEC (Honda VTEC is only on VFR800 in motorcycle inline-4s). Implementing VVT in the simulator would not be a calibration fix for SDM26 — it would model a feature the real engine doesn't have. As a future-engine design knob, VVT introduces 4-6 cam-angle parameters that are extremely tempting to data-fit, violating the spec's no-overfit constraint without strong physical grounding.
hypothesis: T1.3 hypothesized that adding RPM-dependent valve open/close angles (low-RPM cam vs high-RPM cam, interpolated by RPM) would reduce excessive intake/exhaust overlap at low RPM, lowering simulator BP at 6 kRPM by ~2-3 kW. Falsification (and the reason for deferral): real CBR600RR does not have VVT, so the proposed mechanism does not represent reality. Calibrating to dyno data via four invented cam angles would be pure overfit.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: NEXT_AGENT.md T1.3
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## What was proposed

`NEXT_AGENT.md` T1.3: implement VVT as four new SDM26Config fields:

```rust
intake_valve_open_angle_low_rpm
intake_valve_close_angle_low_rpm
exhaust_valve_open_angle_low_rpm
exhaust_valve_close_angle_low_rpm
```

interpolated to the existing high-RPM values across a transition RPM.
Motivation: real CBR600RR has VTEC and the simulator's fixed cam
over-fills the cylinder at low RPM due to excessive overlap.

## Factual finding: CBR600RR has fixed cams

Honda CBR600RR across all model years 2007–2020 uses **conventional
fixed camshafts** and does **not** have VTEC, VVT, or any variable
cam timing. Confirmed via:

- 600RR.net forum threads (multiple users + Honda service docs):
  https://www.600rr.net/threads/vtec.374217/
- Honda Info Center i-VTEC vehicle list (CBR600RR not present):
  https://www.hondainfocenter.com/Terms-and-Technologies/_content/...
- CBRForum confirmation thread:
  https://cbrforum.com/forum/cbr-600rr-12/we-blessed-vtec-75119/
- HRC performance cam specs sheet: single fixed-profile variants
  (no switched profiles).

The only Honda motorcycle with VTEC is the VFR800, which is a V4, not
a CBR600RR-class inline-4.

The SDM26 JSON config matches the factory CBR600RR specification:

```json
"intake":  { "open_angle": 350.0, "close_angle": 585.0 },
"exhaust": { "open_angle": 140.0, "close_angle": 365.0 }
```

These are the actual fixed cam angles for the 2007-2020 CBR600RR.

## Implication

Implementing VVT in the simulator under these conditions would:

1. **Not improve the SDM26 fit** to its source dyno data, because the
   feature doesn't exist on the engine being modeled.
2. **Introduce 4 free parameters** (low-RPM versions of the four
   existing angles) with no literature source to constrain them.
3. **Be extremely tempting to data-fit** — the four angles together
   give enough degrees of freedom to absorb the +12 kW low-RPM gap
   without any physical justification. This is exactly the C10
   anti-overfit guard the spec is supposed to catch.

The +12 kW gap at 6 kRPM is a real physics gap (it appears identically
on SDM25 and SDM26), but its cause is **not** valve overlap. The
mechanism would have to come from one of the candidates documented in
finding 0015 §"Implication for the +12 kW low-RPM gap":

- Wave-dynamics mismatch off-design RPM (requires WENO; T4.1)
- Friction model uncertainty within Heywood Tab 13.3
- Fuel-vaporization charge cooling (currently unmodeled)
- Dyno provenance (low-RPM aggregate uncertainty)

## Recommendation: DEFER T1.3 indefinitely

Do not implement VVT for SDM26 calibration. If a future engine
(e.g., an SDM27 candidate with VVT or an entirely different engine
family) requires the feature, implement it then with:

- **Cam-angle parameters from manufacturer service data** for the
  specific engine (not invented to fit a curve).
- **A strict no-tuning policy**: angles must be cited from a literature
  source. If no source exists, the feature should not be added.

For the SDM26 production knob set, the existing fixed cam angles are
correct and unchanged.

## Comparison vs spec

| Criterion                                  | Status |
|--------------------------------------------|--------|
| Reality check completed before implementing | ✓ CBR600RR fixed-cam confirmed |
| Code modified                              | ✗ (intentionally — wrong fix) |
| Overfit risk identified                    | ✓ |
| Negative finding documented                | ✓ |
| Alternative paths documented (finding 0015) | ✓ |

## Followup queue

VVT is parked. The active queue for the +12 kW low-RPM gap remains in
finding 0015's followup section.
