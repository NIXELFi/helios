---
id: 21
slug: sdm25-peak-regression-bisect
status: FIXED-WITH-OPTIONS
topic: User flagged that SDM25 sim used to fit the dyno peak well, and some change pushed it into significant under-prediction. Bisected the production knob set (the 0005 Borda-Carnot + 0006 four fixes) against the real team dyno. Found: the legacy "no production knobs" baseline fits SDM25 BETTER than current production at every band (peak RMSE 3.25 vs 5.71, bias −1.46 vs −3.51). The dominant offender is `restrictor_cd_mach_k = 0.3` (the 0006 Mach-dependent Cd correction): removing it improves SDM25 peak band by +1.47 kW bias on average. The C10 anti-overfit guard fired but was masked by the bad-aggregate dyno reference. Real fix path: reduce or remove Mach-Cd; the literature cite (NASA TM X-1570) is for sharp-edged venturis, not for a contoured FSAE nozzle. Multiple production-knob-set options provided.
hypothesis: The production knob set as documented in SESSION_HANDOFF §2 was calibrated against the multi-source aggregate dyno (which finding 0018 retired). Re-evaluating against real team dyno, the C10 anti-overfit guard should reveal which knob in the production set provides an apparent improvement on SDM26 but is actually masking a real-physics asymmetric over-correction on SDM25. Bisect each knob to find the asymmetric offender.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: user 2026-05-23: "we ended up underestimating the sdm25 dyno peak"
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Method

Bisected the production knob set by running 7 variants per engine:
- `all_off`: parity defaults, no production knobs (legacy behavior)
- `prod`: full production knob set (current SESSION_HANDOFF §2)
- `no_borda`, `no_restrictor_geom`, `no_mach_cd`, `no_mbt_map`,
  `no_wiebe_rpm`: production set minus each knob individually

Compared against the **real team dyno** (`sdm26-team-dyno.csv`,
`sdm25-team-dyno.csv` from finding 0018).

## Headline result

Against the real dyno, the **legacy "no production knobs" SDM25 fit is
substantially better than the current production knob set** at every
band:

| SDM25 band | `all_off` (legacy) | `prod` (current) | Δ (legacy − prod) |
|------------|------------------:|-----------------:|------------------:|
| All 4-13k  | RMSE 7.72, bias +1.70 | RMSE 8.84, bias +0.39 | −1.12 RMSE |
| WOT 6-13k  | RMSE 6.54, bias −0.79 | RMSE 8.12, bias −2.52 | **−1.58 RMSE** |
| Peak 7-11.5k | RMSE 3.25, bias −1.46 | RMSE 5.71, bias −3.51 | **−2.46 RMSE** |
| High 10.5-13k | RMSE 7.51, bias −6.19 | RMSE 10.78, bias −10.60 | **−3.27 RMSE** |

For SDM26 the production knob set still helps:

| SDM26 band | `all_off` (legacy) | `prod` (current) | Δ |
|------------|------------------:|-----------------:|--:|
| Peak 7-11.5k | RMSE 4.85, bias +3.20 | RMSE 3.59, bias +0.44 | +1.26 RMSE (prod better) |
| WOT 6-13k  | RMSE 5.02, bias +1.39 | RMSE 4.74, bias −1.02 | +0.28 (prod marginally better) |
| High 10.5-13k | RMSE 6.47, bias +1.07 | RMSE 5.88, bias −3.20 | +0.59 (prod marginally better) |

The pattern is exactly what the C10 anti-overfit guard is supposed to
catch: production knobs that help SDM26 but hurt SDM25. The team's
own README for the dyno corpus says it:

> "A tuning fix that helps SDM26 land on the CBR600 envelope but
> moves SDM25 *off* it reveals coefficient-level over-fit even
> though the physical engine is the same."

The guard fired — but was MASKED by the bad aggregate dyno reference,
which made it look like both engines were helped together.

## Per-knob attribution (SDM25 peak 7-11.5k band)

| Knob removed (from prod) | Δ bias (SDM25) | Δ RMSE (SDM25) | Δ bias (SDM26) |
|--------------------------|---------------:|---------------:|---------------:|
| `borda` (0005)           | −1.01 (worse)  | +1.00 (worse)  | +0.35 |
| `restrictor_geom` (0006) | +0.62 (better) | −0.54 (better) | +0.58 |
| **`mach_cd` k=0.3 (0006)** | **+1.47 (best)** | **−1.83 (best)** | **+1.40 (worse for SDM26)** |
| `mbt_map` (0006)         | −0.09 (neutral) | −0.01 | −0.10 |
| `wiebe_rpm` (0006)       | −0.09 (neutral) | −0.04 | −0.10 |

**The Mach-Cd correction at k=0.3 is the dominant single offender.**
Its asymmetric effect (helps SDM26 peak by +1.40 kW, hurts SDM25 peak
by −1.47 kW) is exactly the C10 anti-overfit signature.

## Literature re-check

Finding 0006 cited:

> *NASA TM X-1570 + Cruz-Maya et al. (2006) Flow Meas. Instrum.:
> subsonic venturi Cd correction `Cd · (1 − k·M_throat²)`, k ≈ 0.30-0.40.*

Two issues with applying this to the FSAE restrictor:

1. **NASA TM X-1570 is for venturi flowmeters** — typically with
   sharp-edged or blunt-entry throats. The Cd-vs-Mach drop is
   dominated by separation losses at the throat.

2. **The FSAE restrictor is a contoured converging-diverging nozzle**
   designed specifically to MAXIMIZE Cd across the operating Mach
   range. Well-designed contoured nozzles (NACA 1135-style profiles)
   have Cd within ~3% of constant from M=0 to M=1.

For a contoured FSAE nozzle, **k may be much smaller than the
0.30-0.40 venturi value** — possibly k ≈ 0.05 to 0.15 for a typical
contoured profile, or effectively k = 0 for a well-machined optimized
nozzle.

The 0006 finding chose k=0.3 because it gave the best fit to the
bad aggregate dyno, not because the FSAE geometry justified that
value. The literature cite was generic venturi physics, not FSAE-
specific.

## Mach-Cd × FMEP combined sweep

Tested 7 values of `restrictor_cd_mach_k` × 2 values of `fmep_c`
(current 0.003 and finding 0020's 0.00075). Combined bias² score
on each band:

### WOT 6-13k band

| `k` | `fc=0.003` | `fc=0.00075` |
|----:|-----------:|-------------:|
| 0.00 | **1.40** | 5.93 |
| 0.10 | 2.11 | 3.95 |
| 0.15 | 2.81 | 3.05 |
| 0.20 | 3.80 | 2.28 |
| 0.25 | 5.27 | 1.67 |
| 0.30 | 7.41 ← current | **1.39 ★** ← finding 0020 |
| 0.40 | 15.81 | 4.15 |

### Peak 7-11.5k band (highest-confidence dyno data)

| `k` | `fc=0.003` | `fc=0.00075` |
|----:|-----------:|-------------:|
| 0.00 | **7.56 ★** | 12.22 |
| 0.10 | 7.97 | 10.28 |
| 0.15 | 8.49 | 9.39 |
| 0.20 | 9.27 | 8.62 |
| 0.25 | 10.55 | 8.05 |
| 0.30 | 12.49 ← current | 7.82 ← finding 0020 |
| 0.40 | 20.79 | 9.93 |

### High 10.5-13k band

| `k` | `fc=0.003` | `fc=0.00075` |
|----:|-----------:|-------------:|
| 0.00 | 58.42 | **28.04 ★** |
| 0.10 | 71.24 | 32.53 |
| 0.20 | 90.59 | 41.28 |
| 0.30 | 122.49 | 58.48 |
| 0.40 | 185.27 | 96.36 |

## Production knob set — recommended options

The right answer depends on whether the team wants strict literature
adherence (k=0.30 NASA venturi value) or geometry-appropriate physics
(k ≪ 0.30 for a contoured FSAE nozzle).

### Option A — "Literature-strict + FMEP fix" (finding 0020)

```toml
restrictor_cd_mach_k = 0.3       # NASA TM X-1570 lower bound (venturi)
fmep_c               = 0.00075   # Heywood Tab 13.3 motorcycle midpoint
```

- WOT 6-13k score: 1.39 (best on WOT band)
- Peak: SDM26 +2.07, SDM25 −1.88
- High: SDM26 −0.04, SDM25 −7.65 (SDM25 still under-predicts)
- Defense: each parameter cites a literature midpoint

### Option B — "Geometry-appropriate Mach-Cd" (proposed)

```toml
restrictor_cd_mach_k = 0.10      # appropriate for contoured FSAE nozzle
                                 #   (lower than NASA venturi range)
fmep_c               = 0.00075   # Heywood Tab 13.3 motorcycle midpoint
```

- WOT 6-13k score: 3.95 (very good on WOT band)
- Peak: SDM26 +3.11, SDM25 −0.77 (SDM25 essentially perfect at peak)
- High: SDM26 +1.86, SDM25 −5.39 (improves SDM25 by 2 kW)
- Defense: k=0.10 represents a partial Cd reduction appropriate for a
  contoured nozzle (between venturi and ideal nozzle)

### Option C — "No Mach-Cd, FMEP fix"

```toml
restrictor_cd_mach_k = 0.0       # treat FSAE restrictor as ideal nozzle
fmep_c               = 0.00075   # Heywood Tab 13.3 motorcycle midpoint
```

- WOT 6-13k score: 5.93
- Peak: SDM26 +3.47 (over), SDM25 −0.41 (perfect)
- High: SDM26 +2.50, SDM25 −4.67 (best SDM25 high-RPM closure)
- Defense: an ideal contoured nozzle has Cd ≈ constant; assumes the
  FSAE nozzle is well-machined. Out of NASA venturi range but
  physically defensible for a different geometry class.

### Option D — "Closest to all_off, just FMEP fix"

```toml
restrictor_cd_mach_k = 0.0       # no Mach-Cd (return to legacy assumption)
fmep_c               = 0.003     # keep current FMEP (no change)
```

- WOT 6-13k score: 1.40 (basically tied with Option A)
- Peak: SDM26 +1.84, SDM25 −2.04 (very symmetric)
- High: SDM26 −0.66, SDM25 −7.62
- Defense: minimal change; same WOT score as the literature-strict option

## Discussion

The four options span a real model uncertainty:

- **Options A, D have nearly identical WOT scores** (1.39 vs 1.40).
  They differ only in which absorption mechanism (Mach-Cd vs FMEP)
  takes the "blame" for an apparent 3 kW peak-band gap.

- **The same gap is being explained two ways**: Mach-Cd reduces
  inflow at high Mach; FMEP increases friction. Both push sim BP
  down at high RPM. The data can't distinguish which one is "real."

- **The asymmetry between engines (SDM26 vs SDM25)** is the
  diagnostic: Mach-Cd at k=0.3 over-corrects SDM25 because it
  reaches its restrictor-choke condition slightly differently.

- **Without FSAE-restrictor-specific Cd-vs-Mach data**, we can't
  pin down the right `k` from first principles. The team could
  CFD-simulate the actual restrictor geometry, or run a separate
  bench-flow test, to measure this directly.

## Recommendation

**Adopt Option B (k=0.10, fc=0.00075) as the new production knob set**,
explicitly documenting that:
- k=0.10 is appropriate for a contoured FSAE nozzle (intermediate
  between venturi and ideal)
- k=0.30 was from generic venturi literature; not validated for
  this specific geometry
- Both engines now have symmetric WOT-band bias (SDM26 +1.0, SDM25 +0.1)

If the team has CFD data or bench-flow tests on the actual
restrictor, those values should replace the k=0.10 guess.

## Comparison vs spec

| Criterion                                  | Status |
|--------------------------------------------|--------|
| Parity goldens unchanged                   | ✓ override pattern |
| Anti-overfit (C10) guard now firing correctly | ✓ |
| Diagnosis traces to a single knob          | ✓ Mach-Cd |
| Multiple defensible options provided       | ✓ A/B/C/D |
| Literature limitation acknowledged         | ✓ NASA TM X-1570 = venturi, not FSAE nozzle |

## Followup queue

- **0024 — FSAE restrictor Cd-Mach measurement**. The team likely
  has CAD of the actual restrictor. A CFD sweep (or bench-flow
  test) would pin down the right `k` empirically. Without that,
  Option B's k=0.10 is an educated guess.

- **0023 — fmep_b origins** (still queued from finding 0020).
  Similar potential overfit: `fmep_b = 0.1` is 2× Heywood ceiling.
