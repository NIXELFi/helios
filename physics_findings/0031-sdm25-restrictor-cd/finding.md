---
id: 31
slug: sdm25-restrictor-cd
status: SHIPPED
topic: SDM25's high-band under-read (bias -2.41 kW at 10.5-13.5k after 0028) traced to its restrictor_cd = 0.92, a value with no provenance. Raising Cd lifts ONLY the choked region above ~10k (curves identical below) — exactly the under-read zone. Nick confirmed the two cars ran DIFFERENT restrictor designs and directed best-fit: SDM25 ships Cd 0.967 (high-band bias -0.89, peak matched at 11.5k, WOT RMSE 4.54 -> 4.35); SDM26 stays 0.95 because its top end already fits and its 10.5-12k excess is tune-attributed (finding 0030) — fitting Cd to it would bake the tune defect into geometry.
hypothesis: The unprovenanced Cd 0.92 under-states SDM25's restrictor flow; the high-band deficit is a config error, not model physics.
opened: 2026-06-10
closed: 2026-06-10
owner: physics-investigator
spawned_by: Nick 2026-06-10 "anything we can do to fix the overcorrection on SDM25?"
commit_hash: ~
baseline_fingerprint: feat/physics-accuracy-0028 @ 6aa3ded
revalidation_count: 0
acceptance_approved_at: 2026-06-10 (Nick: "different designs, pick whatever fits the dyno best for both")
---

## Evidence (fig_cd_hypothesis.png)

SDM25, 0028 calibration, restrictor_cd swept {0.92 config, 0.95, 0.967}:

| Cd | WOT 6k+ RMSE (kW) | high 10.5k+ RMSE / bias (kW) | torque high RMSE/bias (Nm) |
|----|------------------:|----------------------------:|---------------------------:|
| 0.92 | 4.54 | 3.08 / -2.41 | 2.90 / -2.22 |
| 0.95 | 4.40 | 2.55 / -1.42 | 2.44 / -1.41 |
| **0.967** | **4.35** | **2.39 / -0.89** | **2.28 / -0.97** |

Shape check: sub-10k curves are pixel-identical across Cd (unchoked flow
doesn't see the Cd) — the change cannot disturb the mid-range fit, and the
graph confirms no overshoot anywhere on the trusted band.

## Decision

- `apps/desktop/src-tauri/resources/cfd/configs/sdm25.json`
  discharge_coefficient 0.92 -> 0.967 (Nick-approved best-fit; the two
  cars ran different restrictor designs, so per-engine Cd is as-built
  fact, not coefficient overfit — C10 does not apply to geometry).
- SDM26 unchanged at 0.95.
- Residual SDM25 error after this is mid-range shape (8.5-10k slight
  under-read) + the sub-7k dyno artifact band; both parked with the tune
  question (finding 0030).
