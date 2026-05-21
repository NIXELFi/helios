//! Engine geometry — bore, stroke, con-rod, V(θ), dV/dθ, surface area.
//! Direct port of `cylinder/geometry.py`.

use std::f64::consts::PI;

#[inline]
fn radians(deg: f64) -> f64 {
    deg * PI / 180.0
}

/// Instantaneous cylinder volume (m³) at crank angle θ_deg (degrees CAD).
pub fn cylinder_volume(theta_deg: f64, bore: f64, stroke: f64, con_rod: f64, cr: f64) -> f64 {
    let a_bore = 0.25 * PI * bore * bore;
    let v_d = a_bore * stroke;
    let v_c = v_d / (cr - 1.0);
    let r = 0.5 * stroke;
    let l = con_rod;
    let theta_r = radians(theta_deg);
    let sin_theta = theta_r.sin();
    let sin_sq = sin_theta * sin_theta;
    let inner = l * l - r * r * sin_sq;
    let inner_clamped = if inner > 0.0 { inner } else { 0.0 };
    let s = r * theta_r.cos() + inner_clamped.sqrt();
    let x_from_tdc = r + l - s;
    v_c + a_bore * x_from_tdc
}

/// dV/dθ in m³ per degree.
pub fn cylinder_d_v_dtheta(theta_deg: f64, bore: f64, stroke: f64, con_rod: f64) -> f64 {
    let a_bore = 0.25 * PI * bore * bore;
    let r = 0.5 * stroke;
    let l = con_rod;
    let theta_r = radians(theta_deg);
    let sin_theta = theta_r.sin();
    let cos_theta = theta_r.cos();
    let inner = l * l - r * r * sin_theta * sin_theta;
    let inner_clamped = if inner > 1e-20 { inner } else { 1e-20 };
    let sqrt_inner = inner_clamped.sqrt();
    let ds_dtheta_r = -r * sin_theta - (r * r * sin_theta * cos_theta) / sqrt_inner;
    a_bore * (-ds_dtheta_r) * (PI / 180.0)
}

/// Approximate total internal surface area at θ: head + piston + liner.
/// Audit 2026-05-20: 2.45·A_bore factor accounts for CBR600RR pent-roof
/// head and dished piston.
pub fn cylinder_surface_area(theta_deg: f64, bore: f64, stroke: f64, con_rod: f64, cr: f64) -> f64 {
    let a_bore = 0.25 * PI * bore * bore;
    let v_d = a_bore * stroke;
    let v_c = v_d / (cr - 1.0);
    let v = cylinder_volume(theta_deg, bore, stroke, con_rod, cr);
    let liner_len_raw = (v - v_c) / a_bore;
    let liner_len = if liner_len_raw > 0.0 { liner_len_raw } else { 0.0 };
    let a_liner = PI * bore * liner_len;
    2.45 * a_bore + a_liner
}
