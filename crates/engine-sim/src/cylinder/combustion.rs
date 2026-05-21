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
