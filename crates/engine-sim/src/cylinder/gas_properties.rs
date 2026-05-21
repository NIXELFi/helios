//! Gas properties — γ(T) NASA-7 quadratic fits, mixture R, sound speed.
//! Direct port of `cylinder/gas_properties.py` from the pinned 1d_v2 tree.

pub const R_AIR: f64 = 287.0;       // J/(kg·K), dry air
pub const R_BURNED: f64 = 295.0;    // J/(kg·K), burned stoichiometric gasoline-air

/// γ(T) for unburned air-fuel mixture, valid 300..3000 K.
///
/// NASA-7 quadratic fit applied by the 2026-05-20 audit (replaces the
/// V1 linear fit clamped at 900 K).
#[inline]
pub fn gamma_unburned(t: f64) -> f64 {
    let t_clamped = if t < 300.0 {
        300.0
    } else if t > 3000.0 {
        3000.0
    } else {
        t
    };
    1.4112 - 1.162e-4 * t_clamped + 1.870e-8 * t_clamped * t_clamped
}

/// γ(T) for burned stoichiometric gasoline-air, valid 300..3000 K.
///
/// NASA-7 quadratic fit applied by the 2026-05-19 audit (replaces V1
/// linear fit that under-predicted γ by ~5-15% in the combustion
/// range).
#[inline]
pub fn gamma_burned(t: f64) -> f64 {
    let t_clamped = if t < 300.0 {
        300.0
    } else if t > 3000.0 {
        3000.0
    } else {
        t
    };
    1.40186 - 1.273e-4 * t_clamped + 2.518e-8 * t_clamped * t_clamped
}

/// Mass-fraction weighted γ during combustion. x_b in [0, 1].
#[inline]
pub fn gamma_mixture(t: f64, x_b: f64) -> f64 {
    if x_b <= 0.0 {
        gamma_unburned(t)
    } else if x_b >= 1.0 {
        gamma_burned(t)
    } else {
        (1.0 - x_b) * gamma_unburned(t) + x_b * gamma_burned(t)
    }
}

/// Mass-fraction weighted specific gas constant.
#[inline]
pub fn r_mixture(x_b: f64) -> f64 {
    if x_b <= 0.0 {
        R_AIR
    } else if x_b >= 1.0 {
        R_BURNED
    } else {
        (1.0 - x_b) * R_AIR + x_b * R_BURNED
    }
}

/// a = sqrt(γ·R·T). Clamps T at 1 K to avoid sqrt of negatives on broken state.
#[inline]
pub fn speed_of_sound(gamma: f64, r: f64, t: f64) -> f64 {
    let t_safe = if t < 1.0 { 1.0 } else { t };
    (gamma * r * t_safe).sqrt()
}
