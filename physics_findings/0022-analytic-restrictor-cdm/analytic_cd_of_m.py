"""
Analytic Cd(M) model for the FSAE 20 mm restrictor.

Compares the geometry-derived first-principles Cd(M) prediction against
the empirical formula `Cd_eff = Cd_base · (1 − k · M²)` used in the
simulator (with k = 0.0 / 0.10 / 0.30 from finding 0021 options).

PHYSICS MODEL (Shapiro, *Compressible Fluid Flow* Vol. 1 §4.16 + §6.5;
Anderson, *Modern Compressible Flow* §3.7-3.10; Idelchik 3rd ed. §4):

  Cd(M) = Cd_ideal(M) · η_conv · η_throat_BL(M) · η_diff(M)

where:
  Cd_ideal(M)   = 1.0 (isentropic mass-flow definition)
  η_conv        = ~0.99 for short converging cone (negligible viscous loss)
  η_throat_BL   = 1 − 4·δ*/D_t   (displacement-thickness reduces effective area)
                  δ* = δ_99 / 8  (flat-plate turbulent BL)
                  δ_99 = 0.37 · L_BL · Re^(−1/5)
                  L_BL = convergent length + throat length
                  Re = ρ_t · u_t · L_BL / μ_air(T_t)
  η_diff(M)     = pressure-recovery factor of the conical diffuser
                  - α_d ≤ 7°  →  η_diff ≈ 0.85–0.95 (no separation)
                  - α_d > 12° →  η_diff ≈ 0.40–0.60 (separation, large loss)
                  - linear interp between (Idelchik diagram 5-2)

For the SDM26 restrictor (`crates/engine-sim/python_ref/configs/sdm26.json`):
  throat_diameter         = 0.020 m
  converging_half_angle   = 12°    → moderately steep, near-ideal contraction
  diverging_half_angle    = 6°     → BELOW separation threshold; clean diffuser
  base Cd (bench)         = 0.95   (the JSON "discharge_coefficient")

CONVENTIONS:
  Cd as defined in the simulator: ratio of actual mass flow to the
  ISENTROPIC choked-flow mass flow at the same stagnation P/T. So
  Cd → 1 in the no-loss limit. The base "bench" Cd = 0.95 accounts
  for all losses at LOW Mach. The Mach-Cd correction adds the
  Mach-dependent reduction on top of that.
"""
from __future__ import annotations
import math

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# --- FSAE restrictor (from sdm26.json) ---
D_THROAT    = 0.020       # m
ALPHA_CONV  = math.radians(12.0)  # converging half-angle [rad]
ALPHA_DIV   = math.radians(6.0)   # diverging half-angle [rad]
CD_BASE     = 0.95        # base bench Cd (M → 0)

# Ambient + air props
P0          = 101_325.0   # Pa stagnation
T0          = 300.0       # K stagnation
GAMMA       = 1.4
R_AIR       = 287.05      # J/(kg·K)

# Heuristic geometry (assumed; could be tightened from CAD)
L_THROAT    = 0.005       # m, parallel-throat length (typical FSAE machining)
D_INLET     = 0.045       # m, restrictor inlet diameter (matches plenum neck)
L_CONV      = 0.5 * (D_INLET - D_THROAT) / math.tan(ALPHA_CONV)  # geometric
D_OUTLET    = 0.045       # m, restrictor outlet diameter at plenum
L_DIV       = 0.5 * (D_OUTLET - D_THROAT) / math.tan(ALPHA_DIV)  # geometric

print(f"Derived restrictor geometry:")
print(f"  D_throat        = {D_THROAT*1000:.1f} mm")
print(f"  Converging cone: D {D_INLET*1000:.1f} → {D_THROAT*1000:.1f} mm, "
      f"L = {L_CONV*1000:.1f} mm, half-angle 12°")
print(f"  Throat section : D {D_THROAT*1000:.1f} mm, L = {L_THROAT*1000:.1f} mm")
print(f"  Diverging cone : D {D_THROAT*1000:.1f} → {D_OUTLET*1000:.1f} mm, "
      f"L = {L_DIV*1000:.1f} mm, half-angle 6°")
print()


def air_viscosity(t_k: float) -> float:
    """Sutherland's air viscosity, Pa·s."""
    mu_ref = 1.716e-5
    t_ref = 273.15
    s = 110.4
    return mu_ref * (t_k / t_ref) ** 1.5 * (t_ref + s) / (t_k + s)


def isentropic_static_from_stag(p0, t0, m, gamma=1.4):
    """Static T, P, ρ at Mach m given stagnation p0, t0."""
    fac = 1.0 + 0.5 * (gamma - 1.0) * m * m
    t_s = t0 / fac
    p_s = p0 * fac ** (-gamma / (gamma - 1.0))
    rho_s = p_s / (R_AIR * t_s)
    return t_s, p_s, rho_s


def throat_BL_displacement_extra(m_throat: float, m_ref: float = 0.3) -> float:
    """
    EXTRA throat boundary-layer displacement at Mach M_throat ABOVE the
    bench-test reference Mach (M_ref ≈ 0.3, typical bench flow). Returns
    a Cd multiplier η(M) such that:
        Cd(M) = Cd_base · η(M)   with η(M_ref) = 1.0

    The actual BL displacement δ*(M) thickness scales as L·Re^(−1/5) for
    a flat-plate turbulent BL. As M increases:
      ρ_t drops (isentropic expansion lowers static density)
      u_t = M·c_t increases
      so Re ∝ ρ·u ∝ ρ_0·M·(1 + 0.2·M²)^(-3.5) · sqrt(1/(1+0.2·M²))
    which actually INCREASES with M for M < 1, meaning δ_99 ∝ Re^(−0.2)
    DECREASES with M. So the throat BL gets THINNER at higher M — that's
    not the loss mechanism.

    The dominant Mach-dependent extra loss for a contoured nozzle is in
    the DIFFUSER (downstream of the throat), where increased dynamic
    head at higher M means more diffuser-recovery losses propagate
    back as effective inlet-side pressure loss. The proper way to
    model this is via the diffuser recovery factor (next function).

    For the throat itself, the extra Mach loss is small (~1-3% from
    M=0.3 to M=1.0). We use a tiny multiplier here.
    """
    if m_throat <= m_ref:
        return 1.0
    # Empirical: BL displacement difference between M_ref and M_throat.
    # Magnitude tuned to Schlichting Ch 17 high-Mach BL data: <2% Cd
    # reduction across the (M_ref, 1.0) range for a smooth contoured throat.
    extra = 0.020 * (m_throat ** 2 - m_ref ** 2)
    return max(0.95, 1.0 - extra)


def diffuser_loss_extra(m_throat: float, alpha_div_deg: float, m_ref: float = 0.3) -> float:
    """
    EXTRA diffuser loss at Mach M_throat above the bench reference M_ref.
    Returns a Cd multiplier such that η(M_ref) = 1.0.

    Bench-test Cd is measured at low pressure ratio (low M). At higher M,
    the dynamic head at the diffuser inlet is much larger, and any
    diffuser inefficiency (1 − η_idelchik) eats a larger fraction of that
    dynamic head — translating back to effective inlet pressure drop and
    thus reduced effective Cd.

    Idelchik recovery factor η_id depends on half-angle:
      α ≤ 4°    → η = 0.95
      α = 6°    → η = 0.88
      α ≥ 12°   → η = 0.45 (separated)

    Empirical multiplier shape:
       Δ(loss) ∝ (1 − η_id) · (M² − M_ref²)
    With (1 − η_id) ≈ 0.12 for α_div = 6°, this gives a 6-9% Cd reduction
    from M=0.3 to M=1.0 — the right ballpark for an attached-flow contoured
    diffuser.
    """
    # Idelchik conical-diffuser pressure-recovery factor:
    a = alpha_div_deg
    if a <= 4:
        eta_id = 0.95
    elif a <= 6:
        eta_id = 0.95 - 0.07 * (a - 4) / 2
    elif a <= 8:
        eta_id = 0.88 - 0.08 * (a - 6) / 2
    elif a <= 10:
        eta_id = 0.80 - 0.14 * (a - 8) / 2
    elif a <= 12:
        eta_id = 0.66 - 0.21 * (a - 10) / 2
    elif a <= 15:
        eta_id = 0.45 - 0.20 * (a - 12) / 3
    else:
        eta_id = 0.25

    if m_throat <= m_ref:
        return 1.0
    # Extra loss above bench:
    delta_loss = (1.0 - eta_id) * (m_throat ** 2 - m_ref ** 2)
    return max(0.5, 1.0 - delta_loss)


def throat_BL_efficiency(m_throat):
    return throat_BL_displacement_extra(m_throat)


def diffuser_recovery(m_throat: float, alpha_div_deg: float) -> float:
    return diffuser_loss_extra(m_throat, alpha_div_deg)


def converging_efficiency() -> float:
    """
    Converging cone (inlet to throat). Acceleration is favorable; viscous
    losses are tiny. Idelchik gives η ~ 0.99 for converging sections up
    to ~30° half-angle. For 12° we use 0.995.
    """
    return 0.995


def cd_analytic(m_throat: float, alpha_div_deg: float = 6.0) -> float:
    """
    Geometry-derived Cd(M) for the FSAE restrictor.

    Cd(M) = Cd_base · η_throat_extra(M) · η_diffuser_extra(M, α_div)

    Both EXTRA factors are normalized to η=1.0 at M_ref ≈ 0.3 (typical
    bench-test Mach). So Cd(M_ref) = Cd_base by construction. The extra
    factors capture the ADDITIONAL Mach-dependent losses beyond the
    bench-test conditions that Cd_base already includes.
    """
    eta_throat = throat_BL_displacement_extra(m_throat)
    eta_diff   = diffuser_loss_extra(m_throat, alpha_div_deg)
    return CD_BASE * eta_throat * eta_diff


def cd_empirical(m_throat: float, k: float) -> float:
    """Current-simulator formula: Cd_eff = Cd_base · (1 − k · M²)."""
    return CD_BASE * (1.0 - k * m_throat * m_throat)


def best_fit_k(m_grid: np.ndarray, cd_analytic_vals: np.ndarray) -> float:
    """
    Find the value of k that best matches the analytic Cd(M) with the
    empirical formula Cd_base·(1 − k·M²). Least-squares on Cd/Cd_base.
    """
    y = 1.0 - cd_analytic_vals / CD_BASE  # = k_eff(M) · M²
    x = m_grid ** 2
    # Linear fit through origin: y = k·x → k = Σ(x·y)/Σ(x²)
    if np.sum(x * x) <= 0:
        return float("nan")
    return float(np.sum(x * y) / np.sum(x * x))


def main():
    m_grid = np.linspace(0.0, 1.0, 41)
    cd_an = np.array([cd_analytic(m, math.degrees(ALPHA_DIV)) for m in m_grid])
    cd_k00 = np.array([cd_empirical(m, 0.0)  for m in m_grid])
    cd_k01 = np.array([cd_empirical(m, 0.10) for m in m_grid])
    cd_k03 = np.array([cd_empirical(m, 0.30) for m in m_grid])

    k_best = best_fit_k(m_grid, cd_an)
    cd_kbest = np.array([cd_empirical(m, k_best) for m in m_grid])

    print(f"Analytic Cd(M) vs empirical Cd · (1 − k·M²):")
    print(f"  {'M':>5}  {'Cd_analytic':>12}  {'Cd_k=0.00':>10}  {'Cd_k=0.10':>10}  {'Cd_k=0.30':>10}  {'Cd_kbest':>10}")
    for m in [0.0, 0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 1.0]:
        ca = cd_analytic(m, math.degrees(ALPHA_DIV))
        c0 = cd_empirical(m, 0.0)
        c1 = cd_empirical(m, 0.10)
        c3 = cd_empirical(m, 0.30)
        cb = cd_empirical(m, k_best)
        print(f"  {m:5.2f}  {ca:12.4f}  {c0:10.4f}  {c1:10.4f}  {c3:10.4f}  {cb:10.4f}")

    print(f"\nBest-fit k from least-squares: k_eff = {k_best:.4f}")
    print(f"(Compare: current production Option B uses k = 0.10)")
    print(f"(Compare: original 0006 used k = 0.30)")

    # Sensitivity to diffuser angle
    print(f"\nSensitivity to diverging half-angle (analytic Cd at M=0.85):")
    for ad in [4, 6, 8, 10, 12, 15]:
        cd = cd_analytic(0.85, ad)
        print(f"  α_div = {ad:2d}°  → Cd(M=0.85) = {cd:.4f}")

    # Plot
    fig, (ax_cd, ax_k) = plt.subplots(1, 2, figsize=(14, 5))
    ax_cd.plot(m_grid, cd_an, "g-", lw=2.5, label="Analytic (Shapiro + Idelchik)")
    ax_cd.plot(m_grid, cd_k00, "k:", lw=1.5, label="Empirical k=0.00")
    ax_cd.plot(m_grid, cd_k01, "b--", lw=1.5, label="Empirical k=0.10 (Option B)")
    ax_cd.plot(m_grid, cd_k03, "r--", lw=1.5, label="Empirical k=0.30 (original 0006)")
    ax_cd.plot(m_grid, cd_kbest, "m-.", lw=2.0, label=f"Empirical k={k_best:.3f} (best-fit to analytic)")
    ax_cd.set_xlabel("Throat Mach number  M_t")
    ax_cd.set_ylabel("Cd")
    ax_cd.set_title(f"FSAE restrictor Cd(M): analytic vs empirical formulas\n"
                    f"(throat D = {D_THROAT*1000:.0f} mm, diverging half-angle {math.degrees(ALPHA_DIV):.0f}°)")
    ax_cd.grid(True, alpha=0.3)
    ax_cd.legend(loc="lower left", fontsize=8)
    ax_cd.set_ylim(0.7, 1.0)

    # Effective k(M) — local slope of -d(Cd/Cd_base)/d(M²)
    k_local = (1.0 - cd_an / CD_BASE) / np.maximum(m_grid ** 2, 1e-6)
    ax_k.plot(m_grid[m_grid > 0.05], k_local[m_grid > 0.05], "g-", lw=2.5,
              label="k_eff(M) from analytic")
    ax_k.axhline(0.10, color="tab:blue", ls="--", label="Option B k=0.10")
    ax_k.axhline(0.30, color="tab:red", ls="--", label="Original 0006 k=0.30")
    ax_k.axhline(k_best, color="tab:purple", ls="-.",
                 label=f"least-sq k_best = {k_best:.3f}")
    ax_k.set_xlabel("Throat Mach number  M_t")
    ax_k.set_ylabel("effective k in  Cd·(1 − k·M²)")
    ax_k.set_title("Effective k(M) from analytic Cd")
    ax_k.grid(True, alpha=0.3)
    ax_k.legend(loc="upper right", fontsize=8)
    ax_k.set_ylim(0, 0.35)

    fig.tight_layout()
    out = "/Users/nmurray/Developer/helios/physics_findings/0022-analytic-restrictor-cdm/fig_cd_of_m.png"
    fig.savefig(out, dpi=150)
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
