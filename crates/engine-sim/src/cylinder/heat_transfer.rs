//! Woschni in-cylinder heat transfer. Direct port of `cylinder/heat_transfer.py`.

#[derive(Debug, Clone)]
pub struct WoschniParams {
    pub bore: f64,
    pub stroke: f64,
    pub t_wall: f64,
    pub c1_gas_exchange: f64,
    pub c1_compression: f64,
    pub c1_combustion: f64,
    pub c2_combustion: f64,
}

impl WoschniParams {
    pub fn new(bore: f64, stroke: f64) -> Self {
        Self {
            bore,
            stroke,
            t_wall: 450.0,
            c1_gas_exchange: 6.18,
            c1_compression: 2.28,
            c1_combustion: 2.28,
            c2_combustion: 3.24e-3,
        }
    }
}

#[inline]
pub fn mean_piston_speed(stroke: f64, rpm: f64) -> f64 {
    2.0 * stroke * rpm / 60.0
}

#[inline]
pub fn motored_pressure(v: f64, p_ref: f64, v_ref: f64) -> f64 {
    motored_pressure_with_gamma(v, p_ref, v_ref, 1.35)
}

pub fn motored_pressure_with_gamma(v: f64, p_ref: f64, v_ref: f64, gamma_poly: f64) -> f64 {
    if p_ref <= 0.0 || v <= 0.0 {
        return 0.0;
    }
    p_ref * (v_ref / v).powf(gamma_poly)
}

#[allow(clippy::too_many_arguments)]
fn characteristic_velocity(
    rpm: f64, p: f64, v: f64, v_d: f64, phase: i32,
    p_ref: f64, t_ref: f64, v_ref: f64,
    stroke: f64,
    c1_gx: f64, c1_co: f64, c1_cb: f64, c2_cb: f64,
    gamma_poly: f64,
) -> f64 {
    let sp = mean_piston_speed(stroke, rpm);
    if phase == 0 {
        return c1_gx * sp;
    }
    if phase == 1 {
        return c1_co * sp;
    }
    if p_ref <= 0.0 || v_ref <= 0.0 {
        return c1_cb * sp;
    }
    let p_mot = motored_pressure_with_gamma(v, p_ref, v_ref, gamma_poly);
    let bump_raw = p - p_mot;
    let bump = if bump_raw < 0.0 { 0.0 } else { bump_raw };
    let pressure_term = c2_cb * (v_d * t_ref) / (p_ref * v_ref) * bump;
    c1_cb * sp + pressure_term
}

#[allow(clippy::too_many_arguments)]
pub fn woschni_h(
    p: f64, t: f64, rpm: f64, v: f64, v_d: f64,
    phase: i32, p_ref: f64, t_ref: f64, v_ref: f64,
    bore: f64, stroke: f64,
    c1_gx: f64, c1_co: f64, c1_cb: f64, c2_cb: f64,
) -> f64 {
    let w = characteristic_velocity(
        rpm, p, v, v_d, phase, p_ref, t_ref, v_ref, stroke,
        c1_gx, c1_co, c1_cb, c2_cb, 1.35,
    );
    let w_safe = if w < 0.1 { 0.1 } else { w };
    let p_kpa = p / 1000.0;
    let t_safe = if t > 100.0 { t } else { 100.0 };
    3.26 * bore.powf(-0.2) * p_kpa.powf(0.8) * t_safe.powf(-0.53) * w_safe.powf(0.8)
}

#[allow(clippy::too_many_arguments)]
pub fn woschni_d_q_dt(
    p: f64, t: f64, rpm: f64, v: f64, v_d: f64,
    a_surface: f64, t_wall: f64,
    phase: i32, p_ref: f64, t_ref: f64, v_ref: f64,
    bore: f64, stroke: f64,
    c1_gx: f64, c1_co: f64, c1_cb: f64, c2_cb: f64,
) -> f64 {
    let h = woschni_h(p, t, rpm, v, v_d, phase, p_ref, t_ref, v_ref,
                     bore, stroke, c1_gx, c1_co, c1_cb, c2_cb);
    h * a_surface * (t - t_wall)
}
