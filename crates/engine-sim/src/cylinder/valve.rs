//! Valve lift profile, Cd(L/D) lookup, effective flow area.
//! Direct port of `cylinder/valve.py`.

use std::f64::consts::PI;

/// 2007 CBR600RR intake Cd(L/D) table.
pub const INTAKE_LD_TABLE: [f64; 6] = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
pub const INTAKE_CD_TABLE: [f64; 6] = [0.19, 0.38, 0.494, 0.551, 0.57, 0.57];
pub const EXHAUST_LD_TABLE: [f64; 6] = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
pub const EXHAUST_CD_TABLE: [f64; 6] = [0.171, 0.333, 0.456, 0.523, 0.542, 0.551];

/// Lift-profile shape selector.
///
/// `Sin2` is the original sin²(π·τ) profile (mean lift = 0.5·max_lift).
/// Matches the Python reference exactly — preserves bit-exact parity.
///
/// `FlatTop` uses a piecewise profile with a hold at peak lift:
///   ramp up over `ramp_frac` of the duration,
///   hold at max_lift,
///   ramp down over `ramp_frac`.
/// For `ramp_frac = 0.25`, mean lift ≈ 0.75·max_lift (50 % more area
/// than sin² for the same max). Closer to real cam profiles which
/// have a flat-top dwell at peak lift.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LiftProfile {
    /// sin² — legacy default, parity-preserving.
    Sin2,
    /// Trapezoidal with linear ramps. `ramp_frac` ∈ (0, 0.5] is the
    /// fraction of the open duration spent in each ramp; the remaining
    /// (1 − 2·ramp_frac) holds at max_lift.
    FlatTop { ramp_frac: f64 },
    /// Finding 0032 cam mode: L(τ) = max_lift · sin^n(π·τ) over the
    /// seat-to-seat window. n > 1 gives zero velocity at the seat (C1).
    /// Used with `seat_window_from_reference_lift`, which widens the
    /// configured 1 mm-lift events to the seat-to-seat window.
    SinPower { exponent: f64 },
}

/// Seat-to-seat window for a `SinPower { exponent: n }` lobe whose lift
/// equals `ref_lift` exactly at the quoted `open`/`close` events (e.g. the
/// "valve timing at 1 mm lift" in a service manual).
///
/// For a symmetric lobe L = L_max·sin^n(πτ), the reference lift is reached
/// at τ₁ = asin((L_ref/L_max)^(1/n))/π, so the seat duration is
/// D = D_ref / (1 − 2τ₁) and each event moves outward by (D − D_ref)/2.
/// Returns the inputs unchanged when the geometry is degenerate
/// (max_lift ≤ ref_lift, non-positive duration or exponent).
pub fn seat_window_from_reference_lift(
    open: f64, close: f64, max_lift: f64, ref_lift: f64, exponent: f64,
) -> (f64, f64) {
    let d_ref = close - open;
    if !(max_lift > ref_lift) || ref_lift <= 0.0 || d_ref <= 0.0 || exponent <= 0.0 {
        return (open, close);
    }
    let s1 = (ref_lift / max_lift).powf(1.0 / exponent);
    let tau1 = s1.asin() / PI;
    let d_seat = d_ref / (1.0 - 2.0 * tau1);
    let ext = 0.5 * (d_seat - d_ref);
    (open - ext, close + ext)
}

impl Default for LiftProfile {
    fn default() -> Self { LiftProfile::Sin2 }
}

#[derive(Debug, Clone)]
pub struct ValveParams {
    pub diameter: f64,
    pub max_lift: f64,
    pub open_angle_deg: f64,
    pub close_angle_deg: f64,
    pub seat_angle_deg: f64,
    pub n_valves: usize,
    pub ld_table: Vec<f64>,
    pub cd_table: Vec<f64>,
    /// Lift-profile shape. Default `Sin2` preserves Python parity.
    pub profile: LiftProfile,
    /// Opt-in low-Reynolds Cd correction (finding 0015 / Heywood §6.2,
    /// Annand-Roe 1974). When false, Cd is the bench-table value
    /// (parity-preserving). When true, Cd is multiplied by a linear
    /// ramp f_Re(Re) ∈ [re_cd_min, 1.0] over Re ∈ [1000, re_crit].
    pub re_correction_enabled: bool,
    /// Minimum Cd multiplier at very low Re (Re ≤ 1000).
    /// Literature midpoint 0.70 (Heywood §6.2).
    pub re_cd_min: f64,
    /// Critical Reynolds above which Cd is full-table (no correction).
    /// Literature midpoint 10,000 (Heywood Fig 6.16).
    pub re_crit: f64,
}

impl ValveParams {
    #[inline]
    pub fn duration_deg(&self) -> f64 {
        self.close_angle_deg - self.open_angle_deg
    }

    #[inline]
    pub fn port_area(&self) -> f64 {
        0.25 * PI * self.diameter * self.diameter
    }
}

/// sin² lift profile: L(θ) = max_lift · sin²(π·(θ − θ_open)/duration).
pub fn valve_lift(theta_local_deg: f64,
                  open_angle: f64, close_angle: f64, max_lift: f64) -> f64 {
    valve_lift_profile(theta_local_deg, open_angle, close_angle, max_lift, LiftProfile::Sin2)
}

/// Lift profile with selectable shape. `Sin2` preserves the legacy
/// `valve_lift` behavior exactly. `FlatTop` uses a trapezoidal profile.
pub fn valve_lift_profile(theta_local_deg: f64,
                          open_angle: f64, close_angle: f64,
                          max_lift: f64, profile: LiftProfile) -> f64 {
    let theta = theta_local_deg.rem_euclid(720.0);
    let duration = close_angle - open_angle;
    // Normalize theta to position within the open window in [0, duration].
    let theta_in_window = if open_angle < close_angle {
        if theta < open_angle || theta > close_angle {
            return 0.0;
        }
        theta - open_angle
    } else {
        if theta >= open_angle {
            theta - open_angle
        } else if theta <= close_angle {
            theta + 720.0 - open_angle
        } else {
            return 0.0;
        }
    };
    if theta_in_window < 0.0 || theta_in_window > duration {
        return 0.0;
    }
    let tau = theta_in_window / duration; // ∈ [0, 1]

    match profile {
        LiftProfile::Sin2 => {
            let s = (PI * tau).sin();
            max_lift * s * s
        }
        LiftProfile::FlatTop { ramp_frac } => {
            let r = ramp_frac.clamp(0.05, 0.5);
            if tau < r {
                max_lift * (tau / r)
            } else if tau < 1.0 - r {
                max_lift
            } else {
                max_lift * ((1.0 - tau) / r)
            }
        }
        LiftProfile::SinPower { exponent } => {
            let s = (PI * tau).sin().max(0.0);
            max_lift * s.powf(exponent)
        }
    }
}

/// Dynamic viscosity of air at temperature `t_kelvin`, Sutherland's formula.
/// μ = μ_ref · (T/T_ref)^1.5 · (T_ref + S) / (T + S)
/// Constants from White, *Viscous Fluid Flow* (Tab 1.2):
///   μ_ref = 1.716e-5 Pa·s, T_ref = 273.15 K, S = 110.4 K.
/// Valid 100 K ≤ T ≤ 2000 K.
#[inline]
pub fn air_viscosity(t_kelvin: f64) -> f64 {
    const MU_REF: f64 = 1.716e-5;
    const T_REF: f64 = 273.15;
    const S: f64 = 110.4;
    let t = t_kelvin.max(100.0);
    MU_REF * (t / T_REF).powf(1.5) * (T_REF + S) / (t + S)
}

/// Low-Reynolds Cd multiplier (finding 0015).
///   f_Re = re_cd_min                       for Re ≤ 1000
///   f_Re = re_cd_min + (1 − re_cd_min) · (Re − 1000)/(re_crit − 1000)   linear interp
///   f_Re = 1.0                              for Re ≥ re_crit
/// Returns 1.0 if re_crit ≤ 1000 (degenerate) so this is safe to multiply by.
#[inline]
pub fn re_cd_multiplier(reynolds: f64, re_crit: f64, re_cd_min: f64) -> f64 {
    if re_crit <= 1000.0 {
        return 1.0;
    }
    let re = reynolds.abs();
    if re >= re_crit {
        return 1.0;
    }
    if re <= 1000.0 {
        return re_cd_min;
    }
    let frac = (re - 1000.0) / (re_crit - 1000.0);
    re_cd_min + frac * (1.0 - re_cd_min)
}

/// Linear interpolation on the Cd(L/D) table; below table[0] linear to 0.
pub fn valve_cd(lift: f64, diameter: f64,
                ld_table: &[f64], cd_table: &[f64]) -> f64 {
    if lift <= 0.0 {
        return 0.0;
    }
    // Empty (or mismatched) tables would otherwise panic on the `[0]`/
    // `len()-1` indexing below. The config loader rejects empty Cd tables,
    // but this function is also called directly with caller-supplied slices,
    // so guard here too: with no table there is no flow coefficient to
    // interpolate.
    if ld_table.is_empty() || cd_table.is_empty() {
        return 0.0;
    }
    let ld = lift / diameter;
    if ld <= ld_table[0] {
        return cd_table[0] * (ld / ld_table[0]);
    }
    let last = ld_table.len() - 1;
    if ld >= ld_table[last] {
        return cd_table[last];
    }
    for k in 0..last {
        if ld_table[k] <= ld && ld <= ld_table[k + 1] {
            let frac = (ld - ld_table[k]) / (ld_table[k + 1] - ld_table[k]);
            return cd_table[k] + frac * (cd_table[k + 1] - cd_table[k]);
        }
    }
    cd_table[last]
}

/// Reference flow area: low-lift curtain → full curtain → port-limited.
pub fn valve_reference_area(lift: f64, diameter: f64, seat_angle_rad: f64) -> f64 {
    if lift <= 0.0 {
        return 0.0;
    }
    let ld = lift / diameter;
    let port_area = 0.25 * PI * diameter * diameter;
    if ld < 0.125 {
        return PI * diameter * lift * seat_angle_rad.cos();
    }
    if ld < 0.25 {
        return PI * diameter * lift;
    }
    port_area
}

#[allow(clippy::too_many_arguments)]
pub fn valve_effective_area(
    theta_local_deg: f64,
    open_angle: f64, close_angle: f64, max_lift: f64,
    diameter: f64, seat_angle_rad: f64, n_valves: usize,
    ld_table: &[f64], cd_table: &[f64],
) -> f64 {
    valve_effective_area_profile(
        theta_local_deg, open_angle, close_angle, max_lift,
        diameter, seat_angle_rad, n_valves, ld_table, cd_table,
        LiftProfile::Sin2,
    )
}

/// Effective area with a selectable lift profile.
#[allow(clippy::too_many_arguments)]
pub fn valve_effective_area_profile(
    theta_local_deg: f64,
    open_angle: f64, close_angle: f64, max_lift: f64,
    diameter: f64, seat_angle_rad: f64, n_valves: usize,
    ld_table: &[f64], cd_table: &[f64],
    profile: LiftProfile,
) -> f64 {
    let l = valve_lift_profile(theta_local_deg, open_angle, close_angle, max_lift, profile);
    if l <= 0.0 {
        return 0.0;
    }
    let cd = valve_cd(l, diameter, ld_table, cd_table);
    let a_ref = valve_reference_area(l, diameter, seat_angle_rad);
    (n_valves as f64) * cd * a_ref
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 0032 cam add-on: the lobe must pass through exactly 1 mm at the
    /// quoted events (CBR600RR PC40 service manual: IN 21° BTDC / 44° ABDC,
    /// EX 40° BBDC / 5° ATDC at 1 mm) and be C1-smooth — zero lift and zero
    /// slope at the seat, continuous slope everywhere.
    #[test]
    fn reference_lift_lobe_hits_1mm_at_events_and_is_c1() {
        for &(open, close, lmax) in &[(339.0, 584.0, 0.00856), (140.0, 365.0, 0.00735)] {
            let n = 1.3;
            let (so, sc) = seat_window_from_reference_lift(open, close, lmax, 0.001, n);
            let prof = LiftProfile::SinPower { exponent: n };
            let lift = |th: f64| valve_lift_profile(th, so, sc, lmax, prof);
            assert!((lift(open) - 0.001).abs() < 1e-12, "IVO/EVO lift {}", lift(open));
            assert!((lift(close) - 0.001).abs() < 1e-12, "IVC/EVC lift {}", lift(close));
            // Seat-to-seat widening lands in the production-cam band.
            let widen = (sc - so) - (close - open);
            assert!(widen > 25.0 && widen < 45.0, "seat widening {widen}");
            // Peak at the window centre.
            assert!((lift(0.5 * (so + sc)) - lmax).abs() < 1e-12);
            // C1: finite-difference slope is continuous (no jump anywhere)
            // and → 0 at both seats.
            let h = 1e-3;
            let slope = |th: f64| (lift(th + h) - lift(th - h)) / (2.0 * h);
            let mut th = so + 0.05;
            let mut prev = slope(th);
            while th < sc - 0.05 {
                th += 0.05;
                let cur = slope(th);
                assert!((cur - prev).abs() < 1e-5, "slope jump at {th}: {prev} -> {cur}");
                prev = cur;
            }
            assert!(slope(so + 1e-3).abs() < 2e-5 && slope(sc - 1e-3).abs() < 2e-5);
            assert_eq!(lift(so - 1.0), 0.0);
            assert_eq!(lift(sc + 1.0), 0.0);
        }
    }

    #[test]
    fn valve_cd_empty_tables_return_zero_not_panic() {
        // Empty L/D or Cd table must not index out of bounds. With no table
        // there's no coefficient to interpolate, so the safe answer is 0.
        assert_eq!(valve_cd(0.005, 0.03, &[], &[]), 0.0);
        assert_eq!(valve_cd(0.005, 0.03, &[], &INTAKE_CD_TABLE), 0.0);
        assert_eq!(valve_cd(0.005, 0.03, &INTAKE_LD_TABLE, &[]), 0.0);
    }

    #[test]
    fn valve_cd_zero_lift_returns_zero() {
        assert_eq!(valve_cd(0.0, 0.03, &INTAKE_LD_TABLE, &INTAKE_CD_TABLE), 0.0);
    }

    #[test]
    fn valve_cd_interpolates_on_a_normal_table() {
        // Above the last L/D returns the last Cd; this also confirms the
        // empty-table guard didn't change the normal path.
        let cd = valve_cd(1.0, 0.01, &INTAKE_LD_TABLE, &INTAKE_CD_TABLE);
        assert_eq!(cd, *INTAKE_CD_TABLE.last().unwrap());
    }
}
