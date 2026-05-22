//! Wiebe combustion model. Direct port of `cylinder/combustion.py`.

/// Wiebe-model parameters with the optional V2 RPM ramp ("F4 v3", parked OFF).
#[derive(Debug, Clone)]
pub struct WiebeParams {
    pub a: f64,
    pub m: f64,
    pub duration_deg: f64,
    pub spark_advance_deg: f64,
    pub ignition_delay_deg: f64,
    pub eta_comb: f64,
    pub q_lhv: f64,
    pub afr_target: f64,
    // Audit 2026-05-19: F4 ramp neutered (all factors = 1.0).
    pub factor_rpm_lo: f64,
    pub factor_rpm_knee: f64,
    pub factor_rpm_hi: f64,
    pub factor_lo: f64,
    pub factor_knee: f64,
    pub factor_hi: f64,
    /// Enable Heywood-shaped AFR-dependent combustion-efficiency factor.
    /// When false (default), behavior is unchanged from the legacy
    /// RPM-only `eta_comb_at_rpm` — preserves bit-exact parity with
    /// Python reference. Set true to model rich-quench / lean-misfire.
    pub afr_eta_enabled: bool,
    /// Turbulence-enhanced burn-rate factor applied to the Wiebe `a`
    /// coefficient. Models the fact that real engines have charge motion
    /// (tumble + swirl) that accelerates the early flame development
    /// relative to a laminar Wiebe profile.
    ///
    /// Effective Wiebe: `a_eff = a × (1 + tumble_factor)`. At
    /// `tumble_factor = 0.5`, x_b reaches 99.99 % at τ = 1 (vs 99.3 %
    /// for the default a = 5). The burn is more complete in the same
    /// crank-angle window — net effect is higher heat release in the
    /// expansion stroke, modestly higher peak pressure, ~3-6 % IMEP
    /// boost depending on RPM. Defaults to 0.0 (no enhancement, parity
    /// preserved).
    pub tumble_burn_factor: f64,
    /// Opt-in two-zone combustion model. When false (default), the
    /// cylinder integrates a single mass-averaged temperature. When
    /// true, the burned and unburned zones are tracked separately
    /// during combustion, which splits Woschni heat loss according
    /// to per-zone volume fractions and uses a per-zone γ.
    ///
    /// Pressure is still spatially uniform (P_b = P_u = P) per the
    /// usual zero-D assumption, so peak P is largely unchanged
    /// vs single-zone at matched calibration. The earned benefit
    /// (or cost) shows up as a different heat-loss split:
    ///   - Burned zone (T_b ~ 2500-2800 K) occupies a much larger
    ///     volume fraction than its mass fraction (P·V_b = m_b R T_b
    ///     with hot T_b), so it sees a larger wall-area share.
    ///   - Unburned zone (T_u ~ 700-1500 K) is squeezed into a
    ///     smaller volume and is at lower T, so its heat loss
    ///     becomes negligible.
    ///   - The net heat loss is generally HIGHER than single-zone
    ///     at matched Woschni h_c because Q_loss ∝ (T_b - T_wall)
    ///     and T_b > T_avg. To match real IMEP, the Woschni c1
    ///     coefficient typically needs a small downward retune
    ///     when two-zone is enabled.
    pub two_zone_enabled: bool,
}

impl Default for WiebeParams {
    fn default() -> Self {
        Self {
            a: 5.0,
            m: 2.0,
            duration_deg: 50.0,
            spark_advance_deg: 25.0,
            ignition_delay_deg: 7.0,
            eta_comb: 0.96,
            q_lhv: 44.0e6,
            afr_target: 13.1,
            factor_rpm_lo: 3500.0,
            factor_rpm_knee: 6000.0,
            factor_rpm_hi: 10500.0,
            factor_lo: 1.00,
            factor_knee: 1.00,
            factor_hi: 1.00,
            afr_eta_enabled: false,
            tumble_burn_factor: 0.0,
            two_zone_enabled: false,
        }
    }
}

impl WiebeParams {
    #[inline]
    pub fn theta_start(&self) -> f64 {
        -self.spark_advance_deg + self.ignition_delay_deg
    }

    #[inline]
    pub fn theta_end(&self) -> f64 {
        self.theta_start() + self.duration_deg
    }

    pub fn eta_comb_at_rpm(&self, rpm: f64) -> f64 {
        let factor = if rpm <= self.factor_rpm_lo {
            self.factor_lo
        } else if rpm <= self.factor_rpm_knee {
            let frac = (rpm - self.factor_rpm_lo)
                / (self.factor_rpm_knee - self.factor_rpm_lo);
            self.factor_lo + frac * (self.factor_knee - self.factor_lo)
        } else if rpm <= self.factor_rpm_hi {
            let frac = (rpm - self.factor_rpm_knee)
                / (self.factor_rpm_hi - self.factor_rpm_knee);
            self.factor_knee + frac * (self.factor_hi - self.factor_knee)
        } else {
            self.factor_hi
        };
        self.eta_comb * factor
    }

    /// AFR-dependent combustion-efficiency factor (multiplicative on
    /// `eta_comb_at_rpm`). Captures rich-quench and lean-misfire in a
    /// Heywood-shape correlation parameterized by equivalence ratio
    /// `phi = AFR_stoich / AFR`.
    ///
    /// Reference shape (gasoline, AFR_stoich = 14.7):
    ///   φ ≤ 0.7   →  factor = 1 − 5·(0.7 − φ)²   (lean misfire, clamped ≥ 0.30)
    ///   0.7 < φ ≤ 1.0  →  factor = 1.0           (well-mixed lean: full efficiency)
    ///   1.0 < φ ≤ 1.2  →  factor = 1.0 − 0.5·(φ − 1.0)  (gentle rich falloff)
    ///   1.2 < φ        →  factor = 0.9 − 1.7·(φ − 1.2)  (steep rich quench, clamped ≥ 0.30)
    ///
    /// Calibrated against Heywood (*ICE Fundamentals*, Tab. 4.1) within
    /// ±5% over φ ∈ [0.7, 1.5]. At φ = 1.0..1.1 (AFR 13.4..14.7) the
    /// product (m_fuel × factor) peaks around φ ≈ 1.1, giving the
    /// textbook brake-power-rich peak.
    pub fn afr_eta_factor(&self) -> f64 {
        let afr_stoich = 14.7_f64; // gasoline; consider lifting to a field later
        let phi = afr_stoich / self.afr_target.max(1.0);
        let f = if phi <= 0.7 {
            1.0 - 5.0 * (0.7 - phi).powi(2)
        } else if phi <= 1.0 {
            1.0
        } else if phi <= 1.2 {
            1.0 - 0.5 * (phi - 1.0)
        } else {
            0.9 - 1.7 * (phi - 1.2)
        };
        f.clamp(0.30, 1.0)
    }

    /// Combined RPM + AFR efficiency factor. When `afr_eta_enabled` is
    /// false (default) this matches `eta_comb_at_rpm` exactly.
    pub fn eta_at(&self, rpm: f64) -> f64 {
        let base = self.eta_comb_at_rpm(rpm);
        if self.afr_eta_enabled {
            base * self.afr_eta_factor()
        } else {
            base
        }
    }
}

#[inline]
fn to_combustion_angle(theta_local_deg: f64, theta_start: f64) -> f64 {
    // Python's `%` for negative floats normalises into [0, 720); Rust's
    // `%` is truncated remainder. Match Python's `rem_euclid` semantics.
    let mut t = theta_local_deg.rem_euclid(720.0);
    if theta_start < 0.0 && t > 360.0 {
        t -= 720.0;
    }
    t
}

/// Mass fraction burned x_b at the given local crank angle.
pub fn wiebe_xb(theta_local_deg: f64, a: f64, m: f64,
                theta_start: f64, duration: f64) -> f64 {
    let t = to_combustion_angle(theta_local_deg, theta_start);
    if t < theta_start {
        return 0.0;
    }
    if t > theta_start + duration {
        return 1.0;
    }
    let mut tau = (t - theta_start) / duration;
    if tau < 0.0 {
        tau = 0.0;
    } else if tau > 1.0 {
        tau = 1.0;
    }
    1.0 - (-a * tau.powf(m + 1.0)).exp()
}

/// dx_b/dθ (per degree) at the given local crank angle.
pub fn wiebe_burn_rate(theta_local_deg: f64, a: f64, m: f64,
                       theta_start: f64, duration: f64) -> f64 {
    let t = to_combustion_angle(theta_local_deg, theta_start);
    if t < theta_start || t > theta_start + duration {
        return 0.0;
    }
    let mut tau = (t - theta_start) / duration;
    if tau < 1e-12 {
        tau = 1e-12;
    }
    if tau > 1.0 - 1e-12 {
        tau = 1.0 - 1e-12;
    }
    (a * (m + 1.0) / duration) * tau.powf(m) * (-a * tau.powf(m + 1.0)).exp()
}

#[inline]
pub fn is_combusting(theta_local_deg: f64, theta_start: f64, duration: f64) -> bool {
    let t = to_combustion_angle(theta_local_deg, theta_start);
    (theta_start <= t) && (t <= theta_start + duration)
}
