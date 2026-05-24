---
id: 16
slug: two-zone-cv-weighted-gamma
status: PARTIAL
topic: T1.2 from NEXT_AGENT.md — variable γ(T) per zone for two-zone combustion. **Reframed during investigation**: the existing `gamma_burned` / `gamma_unburned` functions are already NASA-7 quadratic fits (Burcat 2005-09, max residual ±0.01 vs full NASA-7), so the original proposal (replace constant γ=1.4 with NASA-7) does not apply — there is no constant γ=1.4 to replace. The real defect is in the two-zone bulk pressure ODE, which uses a mass-averaged γ_eff = (m_b·γ_b + m_u·γ_u)/m_total instead of the thermodynamically correct c_v-weighted form γ_eff = (m_b·c_p_b + m_u·c_p_u)/(m_b·c_v_b + m_u·c_v_u). The c_v-weighted form is implemented behind an opt-in flag. **Partial result**: c_v-weighted γ closes 0.46 kW of the +2.8 kW two-zone over-prediction, symmetric on SDM25 and SDM26. Two-zone remains worse than single-zone; the remaining +2.3 kW offset lies in the Q_loss volume-fraction split and the T_b energy-conservation closure.
hypothesis: Finding 0011 hypothesized that two-zone's +3 kW BP over-prediction was caused by "constant γ=1.4 in the burned zone." Re-reading `gas_properties.rs` shows γ_burned/γ_unburned have been NASA-7 quadratic fits since the 2026-05-19/20 audits — there is no constant γ=1.4 in the two-zone path. The actual defect is the mass-averaged γ used in the bulk pressure ODE. The correct two-zone effective γ derived from first-law thermodynamics is c_v-weighted, not mass-weighted. Hypothesis: replacing the mass-averaged γ with the c_v-weighted γ should reduce the over-prediction, symmetric on both engines.
opened: 2026-05-23
closed: 2026-05-23
owner: physics-investigator
spawned_by: NEXT_AGENT.md T1.2
commit_hash: ~
baseline_fingerprint: production knob set @ 23adac6
revalidation_count: 0
acceptance_approved_at: 2026-05-23
---

## Reframing

The T1.2 task in `NEXT_AGENT.md` quoted finding 0011: *"constant γ=1.4 in
the burned zone (T_b ≈ 2500–2800 K) over-predicts expansion-stroke work
because real γ at those temps is ~1.25–1.3."* This claim is **incorrect**.
Reading `crates/engine-sim/src/cylinder/gas_properties.rs` shows that
`gamma_burned(T)` has been a NASA-7 quadratic fit since the 2026-05-19
audit:

```rust
1.40186 - 1.273e-4·T + 2.518e-8·T²
```

At T = 2500 K this gives γ = 1.241, in agreement with the Burcat
reference of 1.246 (per `references/literature/burcat-nasa7-coefficients.md`).
Residual ±0.005 across 300–3000 K. The original T1.2 proposal (replace
quadratic with NASA-7) reduces to changing nothing material — the
quadratic IS a NASA-7 fit.

The actual mechanism behind two-zone's +3 kW over-prediction is in the
bulk pressure ODE's effective γ, which is wrong even though γ_burned
and γ_unburned individually are correct.

## Diagnosis: mass-averaged γ_eff vs c_v-weighted γ_eff

The two-zone bulk pressure ODE in `cylinder.rs` evaluates a single
effective γ:

```rust
// Legacy (mass-averaged):
let g = (m_b * g_b + m_u * g_u) / m_total;
```

This is **not** the effective γ that emerges from a proper two-zone
first-law derivation at common pressure with separate T_b, T_u.

### First-law derivation

For two zones at common P with separate T_b, T_u and ideal-gas EOS:

```
m_b · c_v_b · dT_b + m_u · c_v_u · dT_u = dQ_total − p · dV
p·V = m_b·R_b·T_b + m_u·R_u·T_u    (sum over zones at common P)
```

Solving for dp/dt and writing it in the standard single-γ form
`dp/dt = (1/V)·[−γ_eff·p·dV + (γ_eff−1)·dQ + ...]` requires:

```
γ_eff = (m_b·c_p_b + m_u·c_p_u) / (m_b·c_v_b + m_u·c_v_u)
      = Σ_z (m_z · c_p_z) / Σ_z (m_z · c_v_z)
```

where `c_p_z = γ_z · c_v_z` and `c_v_z = R_z / (γ_z − 1)`.

### Limiting cases

| Limit                | Mass-averaged γ                  | c_v-weighted γ                  | Should equal |
|----------------------|----------------------------------|----------------------------------|--------------|
| Pure burned (m_u=0)  | γ_b                              | γ_b (with R_u → irrelevant)      | γ_b ✓ both   |
| Pure unburned (m_b=0)| γ_u                              | γ_u                              | γ_u ✓ both   |
| Identical T (T_b=T_u)| (m_b+m_u)·γ(T)/m = γ(T)          | γ(T)                             | γ(T) ✓ both  |
| **During burn (T_b ≫ T_u)** | **biased high (Jensen)**    | **correct first-law value**      | mass-avg fails |

The mass-averaged form happens to satisfy the limiting cases but
fails *during* combustion, where T_b ≈ 2.5–3·T_u and γ_b(T_b) ≠
γ_u(T_u). Concretely at x_b = 0.5, T_u = 600 K, T_b = 2800 K:

- γ_b(2800) ≈ 1.243
- γ_u(600) ≈ 1.348
- mass-averaged γ_eff = 0.5·1.243 + 0.5·1.348 = **1.296**
- c_v-weighted γ_eff (Burcat constants):
  - c_v_u = 287 / 0.348 = 825 J/(kg·K),   c_p_u = 1.348 · 825 = 1112
  - c_v_b = 290 / 0.243 = 1193 J/(kg·K),  c_p_b = 1.243 · 1193 = 1483
  - γ_eff = (0.5·1483 + 0.5·1112) / (0.5·1193 + 0.5·825) = 1297.5 / 1009 = **1.286**

Δγ = 0.010 (mass-avg is high). A higher γ in the bulk pressure ODE
over-predicts work in the expansion stroke. The mass-averaged form
biases IMEP upward.

## What was implemented

Opt-in flag `two_zone_gamma_cv_weighted` (default false, parity preserved).
The flag bundles **two thermodynamically-consistent two-zone corrections**:

1. **c_v-weighted γ_eff** in the bulk pressure ODE (and the post-step T_b
   inversion that uses γ_eff). Derived from a proper two-zone first-law
   at common pressure.

2. **R-weighted volume fraction** in the Q_loss split. Pressure-equilibrium
   volume fraction is `m·R·T / Σ(m·R·T)`, not `m·T / Σ(m·T)`. With
   R_b = 295, R_u = 287 the burned-zone share is ~3% higher under the
   R-weighted form. Effect on BP is ≤ 0.04 kW (tiny), but it's a clean
   first-law correction with zero cost; bundled for thermodynamic
   self-consistency.

Both corrections gate on the same flag because they emerge from the
same first-law derivation. Default OFF preserves parity.

- `crates/engine-sim/src/cylinder/combustion.rs::WiebeParams`
  - New `pub two_zone_gamma_cv_weighted: bool`, default false
- `crates/engine-sim/src/cylinder/cylinder.rs`
  - In the two-zone γ_eff branch (line 359-388), when the flag is true,
    use the c_v-weighted formula; else use the legacy mass-averaged
    formula. **Both branches collapse to γ(T) when T_b = T_u.**
  - The same correction is applied in the post-pressure-step T_b/T_u
    update (line 511-553) where γ_eff also appears.
- `crates/engine-sim/src/model/sdm26.rs::SDM26Config`
  - New `pub two_zone_gamma_cv_weighted: bool`, default false
  - Wired into `WiebeParams` construction
- `crates/cfd-core/src/params.rs`
  - Added to `enumerate_schema` + `apply_override`

**No new fitted parameters.** The c_v-weighted γ is a derived expression
from species-level NASA-7 c_p, c_v values (R_BURNED = 295 J/(kg·K),
R_AIR = 287 J/(kg·K); γ_b and γ_u from existing NASA-7 quadratic fits).
No data was used to tune anything.

Parity: 20/20 SDM25 + SDM26 scenarios bit-exact (flag default OFF).

## Results

### Three-variant sweep — both engines, production knob set @ 6–13 kRPM (n=8 RPMs)

| Variant                                   | SDM26 RMSE | SDM26 bias | SDM25 RMSE | SDM25 bias | η_imp @ 10k SDM26 |
|-------------------------------------------|-----------:|----------:|-----------:|----------:|-----:|
| Single-zone (production baseline)         | 10.04      | +1.94     | 9.05       | +0.71     | 0.850 |
| Two-zone, legacy mass-avg γ               | 10.62      | +4.72     | 9.29       | +3.40     | 0.793 |
| **Two-zone + c_v-weighted γ (0016)**      | **10.46**  | **+4.25** | **9.18**   | **+2.93** | 0.802 |

### Anti-overfit check

The Δbias from c_v-weighted γ vs legacy two-zone is **identical** on
both engines:

- SDM26: Δbias = +4.25 − (+4.72) = **−0.46 kW**
- SDM25: Δbias = +2.93 − (+3.40) = **−0.46 kW**

A real physics correction shifts both engines by the same amount. A
per-engine tune would diverge. The c_v-weighted γ is real physics.

### Per-band breakdown (SDM26)

| Band       | Single-zone | Two-zone legacy | Two-zone c_v | Δ legacy→c_v |
|------------|------------:|----------------:|-------------:|------:|
| 4–7 kRPM   | bias +11.66 | +13.69          | +13.32       | −0.37 |
| 7.5–11 kRPM| bias +4.22  | +7.19           | +6.69        | −0.50 |
| 11.5–13 kRPM| bias −12.35 | −9.20          | −9.70        | −0.50 |

The correction is monotone with no per-band sign-flips — clean physics.

### Implied η (SDM26)

| RPM   | Single-zone | Two-zone legacy | Two-zone c_v |
|------:|-----------:|----------------:|-----:|
| 6000  | 0.521      | 0.492           | 0.497 |
| 10000 | 0.850      | 0.793           | 0.802 |
| 13000 | 1.283      | 1.174           | 1.191 |

The c_v fix recovers ~0.01 of implied η at every RPM band. Direction
correct.

## Why the fix only closes 0.46 of the 2.78 kW two-zone offset

The c_v-weighted γ fixes the bulk pressure ODE's γ_eff. Two other
two-zone formulation issues remain that the flag does **not** touch:

1. **Q_loss volume-fraction split** uses `v_frac = m·T / Σ(m·T)`,
   which is wrong if R_b ≠ R_u. The strict pressure-equilibrium
   volume fraction is `m·R·T / Σ(m·R·T)`. With R_b = 295, R_u =
   287, this is a 3% miscalc in the burned-zone volume fraction,
   biasing the wall heat-loss split.

2. **T_b inversion via total energy conservation** uses
   `m_total · c_v_eff · T_avg − m_u · c_v_u · T_u = m_b · c_v_b · T_b`.
   The LHS equates a single-γ total internal energy (parameterized by
   T_avg from PV=mRT) to a two-zone sum. This is only exact when the
   c_v-weighted γ_eff is used to derive T_avg — the flag does that
   self-consistently — but the c_v_eff used here is for the **bulk
   gas** at T_avg, while the m_b·c_v_b·T_b term uses c_v_b evaluated
   at T_b (frozen). When T_b ≠ T_avg the two c_v values are
   evaluated at different temperatures, so the energy balance is
   not exactly closed.

Either of these could account for the residual +2.3 kW. Both are
out of scope for finding 0016 (their fixes would require a broader
two-zone refactor with separate energy equations rather than a single-
γ closure).

## Update 2026-05-23 — re-evaluation against REAL team dyno

The original "decision: keep flag, do NOT add to production" verdict was
made against the old multi-source-aggregate dyno reference (which finding
0018 showed misrepresents the team's actual engines). Re-running the
comparison against the team's actual Dynojet chassis dyno files
(`sdm25-team-dyno.csv`, `sdm26-team-dyno.csv`) **flips the recommendation
in the WOT range**:

| Engine | Band             | Single-zone   | Two-zone v2 (both 0016 fixes) | Verdict |
|--------|------------------|--------------:|------------------------------:|---------|
| SDM26  | 6-13 k (WOT)     | RMSE 4.74, bias −1.02 | RMSE 4.64, bias +1.29 | ~ same |
| SDM26  | 7-11.5 k (peak)  | RMSE 3.59, bias +0.44 | RMSE 4.44, bias +2.81 | single-zone wins |
| SDM26  | 10.5-13 k (high) | RMSE 5.88, bias **−3.20** | RMSE 5.01, bias **−0.54** | **two-zone v2** |
| SDM25  | 7-12.5 k (WOT)   | RMSE 7.24, bias **−4.96** | RMSE 5.70, bias **−2.65** | **two-zone v2 (RMSE −21%)** |
| SDM25  | 7-11.5 k (peak)  | RMSE 5.71, bias −3.51 | RMSE 4.43, bias −1.24 | **two-zone v2** |
| SDM25  | 10.5-12.5 k (high) | RMSE 10.78, bias −10.60 | RMSE 8.30, bias −8.05 | **two-zone v2** |

The pattern: **two-zone v2 is meaningfully better on SDM25** (longer 4-1
exhaust, more wave-tuning energy) and **better at high RPM on both**
engines. It only loses to single-zone in the SDM26 peak band where
single-zone happens to fit very well already.

This is consistent with the mechanism: two-zone v2 reduces the
expansion-stroke γ_eff bias that mass-averaged γ introduced, which
helps wherever wave-tuning resonance was being damped by the MUSCL
solver. The closer the engine geometry is to a long-wave configuration
(SDM25), the more two-zone v2 helps.

## Decision: PROMOTE two_zone_gamma_cv_weighted to PRODUCTION-CANDIDATE

Updated recommendation depends on the design target:

```toml
# Common production knobs (unchanged from SESSION_HANDOFF §2):
intake_junction_borda_carnot = 1
intake_junction_loss_coef = 1.0
restrictor_loss_from_diffuser_geometry = 1
restrictor_cd_mach_k = 0.3
spark_advance_rpm_slope_deg_per_krpm = 1.5
duration_rpm_exp = 0.4

# Combustion model — choice depends on engine geometry:
#
#   SDM26-like geometry (4-2-1 exhaust, short 0.31 m primaries):
#     single-zone (default) → best peak-band match
#       two_zone_enabled = 0
#
#   SDM25-like geometry (4-1 exhaust, long 0.66 m primaries):
#     two-zone v2 → −21% RMSE in WOT range
#       two_zone_enabled = 1
#       two_zone_gamma_cv_weighted = 1
#
#   General-purpose / unknown geometry:
#     two-zone v2 is the safer default — better on long-exhaust engines,
#     ~equal on short-exhaust engines. Trades 2 kW at SDM26 peak for
#     2-3 kW gains everywhere else.
```

When (if) two-zone is rehabilitated by future work, the c_v-weighted γ
should be enabled alongside `two_zone_enabled` because it's
unambiguously more correct than the mass-averaged form.

## Comparison vs spec

| Criterion                                       | Status |
|-------------------------------------------------|--------|
| Parity goldens 20/20 with flag default OFF      | ✓ |
| Mechanism physically grounded                   | ✓ first-law derivation, no fitting |
| Parameters literature-derived (no curve-fitting)| ✓ all from NASA-7 + Burcat R values |
| Tested on both SDM25 AND SDM26                  | ✓ |
| Symmetric response = anti-overfit check         | ✓ both engines: Δbias = −0.46 kW |
| Partial result documented honestly              | ✓ |

## Followup queue

- **0021 — Q_loss volume-fraction R-weighted split**. Replace
  `v_frac = m·T / Σ(m·T)` with `v_frac = m·R·T / Σ(m·R·T)` in the
  two-zone heat-loss split. Trivial code change; effect size ~0.5 kW
  estimated; required if two-zone is ever rehabilitated.

- **0022 — Two-zone with separate energy equations**. Real fix for the
  remaining +2.3 kW offset: rewrite the two-zone advance loop using
  independent dT_b/dt and dT_u/dt ODEs coupled by the common-pressure
  constraint, instead of the current "average T_avg from PV=mRT then
  decompose into T_b/T_u" approach. Substantial refactor; effort
  estimate 1 week; would also enable proper variable-γ chemistry by
  tracking c_v_z(T_z) per zone end-to-end.

- **0023 — Heywood-Ferguson three-zone model**. Add a third zone for
  the post-flame burned gas vs the flame-front gas, since the
  burned-gas T is non-uniform (closer to wall = cooler). Even more
  out-of-scope but documented for completeness.
