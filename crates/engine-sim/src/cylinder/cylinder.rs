//! 0D cylinder thermodynamic integrator.
//! Direct port of `cylinder/cylinder.py`.

use std::f64::consts::PI;

use crate::cylinder::combustion::{is_combusting, wiebe_burn_rate, wiebe_xb, WiebeParams};
use crate::cylinder::gas_properties::{gamma_mixture, r_mixture};
use crate::cylinder::geometry::{cylinder_d_v_dtheta, cylinder_surface_area, cylinder_volume};
use crate::cylinder::heat_transfer::{woschni_h, WoschniParams};
use crate::cylinder::valve::ValveParams;

#[derive(Debug, Clone, Copy)]
pub struct CylinderGeom {
    pub bore: f64,
    pub stroke: f64,
    pub con_rod: f64,
    pub cr: f64,
    pub n_intake_valves: usize,
    pub n_exhaust_valves: usize,
}

impl CylinderGeom {
    #[inline]
    pub fn v_d(&self) -> f64 {
        0.25 * PI * self.bore * self.bore * self.stroke
    }
    #[inline]
    pub fn v_c(&self) -> f64 {
        self.v_d() / (self.cr - 1.0)
    }
}

#[derive(Debug, Clone)]
pub struct CylinderState {
    pub p: f64,
    pub t: f64,
    pub m: f64,
    pub x_b: f64,
    pub m_fuel: f64,
    pub m_intake_total: f64,
    pub m_exhaust_total: f64,
    pub work_cycle: f64,
    pub p_at_ivc: f64,
    pub t_at_ivc: f64,
    pub v_at_ivc: f64,
    pub mdot_intake: f64,
    pub mdot_exhaust: f64,
    pub t_intake: f64,
    pub t_exhaust: f64,
    pub m_residual: f64,
    pub p_at_evc: f64,
    pub t_at_evc: f64,
    pub f_residual_at_ivc: f64,
    pub m_at_ivc: f64,
    pub phase_offset_deg: f64,
}

impl Default for CylinderState {
    fn default() -> Self {
        Self {
            p: 101325.0, t: 300.0, m: 0.0, x_b: 0.0, m_fuel: 0.0,
            m_intake_total: 0.0, m_exhaust_total: 0.0, work_cycle: 0.0,
            p_at_ivc: 101325.0, t_at_ivc: 300.0, v_at_ivc: 0.0,
            mdot_intake: 0.0, mdot_exhaust: 0.0,
            t_intake: 300.0, t_exhaust: 1000.0,
            m_residual: 0.0, p_at_evc: 101325.0, t_at_evc: 1000.0,
            f_residual_at_ivc: 0.0, m_at_ivc: 0.0,
            phase_offset_deg: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CylinderModel {
    pub geom: CylinderGeom,
    pub wiebe: WiebeParams,
    pub woschni: WoschniParams,
    pub intake_valve: ValveParams,
    pub exhaust_valve: ValveParams,
    pub state: CylinderState,
    pub enable_residual_tracking: bool,
}

#[inline]
fn valve_is_open(theta_local_deg: f64, vp: &ValveParams) -> bool {
    let theta = theta_local_deg.rem_euclid(720.0);
    if vp.open_angle_deg < vp.close_angle_deg {
        return vp.open_angle_deg <= theta && theta <= vp.close_angle_deg;
    }
    theta >= vp.open_angle_deg || theta <= vp.close_angle_deg
}

impl CylinderModel {
    pub fn new(
        geom: CylinderGeom, wiebe: WiebeParams, woschni: WoschniParams,
        intake_valve: ValveParams, exhaust_valve: ValveParams,
        phase_offset_deg: f64, enable_residual_tracking: bool,
    ) -> Self {
        let mut state = CylinderState::default();
        state.phase_offset_deg = phase_offset_deg;
        Self {
            geom, wiebe, woschni, intake_valve, exhaust_valve,
            state, enable_residual_tracking,
        }
    }

    #[inline]
    pub fn local_theta(&self, theta_global_deg: f64) -> f64 {
        (theta_global_deg - self.state.phase_offset_deg).rem_euclid(720.0)
    }

    #[inline]
    pub fn volume(&self, theta_local_deg: f64) -> f64 {
        cylinder_volume(theta_local_deg, self.geom.bore, self.geom.stroke,
                        self.geom.con_rod, self.geom.cr)
    }

    #[inline]
    pub fn d_v_dtheta(&self, theta_local_deg: f64) -> f64 {
        cylinder_d_v_dtheta(theta_local_deg, self.geom.bore, self.geom.stroke,
                            self.geom.con_rod)
    }

    pub fn initialize(&mut self, p: f64, t: f64, theta_global_deg: f64) {
        let theta_local = self.local_theta(theta_global_deg);
        let v0 = self.volume(theta_local);
        let r = r_mixture(0.0);
        self.state.p = p;
        self.state.t = t;
        self.state.m = p * v0 / (r * t);
        self.state.x_b = 0.0;
        self.state.m_fuel = 0.0;
        self.state.m_intake_total = 0.0;
        self.state.m_exhaust_total = 0.0;
        self.state.work_cycle = 0.0;
        self.state.p_at_ivc = p;
        self.state.t_at_ivc = t;
        self.state.v_at_ivc = v0;
        self.state.m_residual = 0.0;
        self.state.p_at_evc = p;
        self.state.t_at_evc = t;
    }

    fn phase_code(&self, theta_local_deg: f64) -> i32 {
        let iv_open = valve_is_open(theta_local_deg, &self.intake_valve);
        let ev_open = valve_is_open(theta_local_deg, &self.exhaust_valve);
        if iv_open || ev_open {
            return 0;
        }
        if is_combusting(theta_local_deg, self.wiebe.theta_start(), self.wiebe.duration_deg) {
            return 2;
        }
        let ivc = self.intake_valve.close_angle_deg.rem_euclid(720.0);
        if ivc < theta_local_deg && theta_local_deg < 720.0 {
            return 1;
        }
        2
    }

    pub fn advance(&mut self, theta_global_deg: f64, dtheta_deg: f64, rpm: f64, dt: f64) {
        let theta_local = self.local_theta(theta_global_deg);
        let omega = if rpm > 0.0 { 2.0 * PI * rpm / 60.0 } else { 1.0 };

        let gamma = gamma_mixture(self.state.t, self.state.x_b);
        let r_gas = r_mixture(self.state.x_b);

        let v = self.volume(theta_local);
        let d_v_dt = self.d_v_dtheta(theta_local) * (180.0 / PI) * omega;

        let phase = self.phase_code(theta_local);

        let a_surf = cylinder_surface_area(
            theta_local, self.geom.bore, self.geom.stroke, self.geom.con_rod, self.geom.cr,
        );
        let p_ref = self.state.p_at_ivc;
        let t_ref = self.state.t_at_ivc;
        let v_ref = if self.state.v_at_ivc > 0.0 { self.state.v_at_ivc } else { v };
        let h_c = woschni_h(
            self.state.p, self.state.t, rpm, v, self.geom.v_d(),
            phase, p_ref, t_ref, v_ref,
            self.woschni.bore, self.woschni.stroke,
            self.woschni.c1_gas_exchange, self.woschni.c1_compression,
            self.woschni.c1_combustion, self.woschni.c2_combustion,
        );
        let d_q_ht_dt = h_c * a_surf * (self.state.t - self.woschni.t_wall);

        let eta = self.wiebe.eta_at(rpm);
        let a_eff = self.wiebe.a * (1.0 + self.wiebe.tumble_burn_factor);
        let mut d_q_comb_dt = 0.0_f64;
        if is_combusting(theta_local, self.wiebe.theta_start(), self.wiebe.duration_deg)
            && self.state.m_fuel > 0.0
        {
            let dxb_dtheta = wiebe_burn_rate(
                theta_local, a_eff, self.wiebe.m,
                self.wiebe.theta_start(), self.wiebe.duration_deg,
            );
            let dxb_dt = dxb_dtheta * 180.0 / PI * omega;
            d_q_comb_dt = eta * self.state.m_fuel * self.wiebe.q_lhv * dxb_dt;
            self.state.x_b = wiebe_xb(
                theta_local, a_eff, self.wiebe.m,
                self.wiebe.theta_start(), self.wiebe.duration_deg,
            );
        }

        if phase == 0 {
            let mdot_in = self.state.mdot_intake;
            let mdot_out = self.state.mdot_exhaust;
            let t_eff_in = if mdot_in >= 0.0 { self.state.t_intake } else { self.state.t };
            let t_eff_out = if mdot_out >= 0.0 { self.state.t } else { self.state.t_exhaust };
            let dp_dt = if v > 1e-20 {
                (1.0 / v) * (
                    -gamma * self.state.p * d_v_dt
                    + (gamma - 1.0) * (d_q_comb_dt - d_q_ht_dt)
                    + gamma * r_gas * t_eff_in * mdot_in
                    - gamma * r_gas * t_eff_out * mdot_out
                )
            } else {
                0.0
            };
            let dm_dt = mdot_in - mdot_out;
            let d_t_dt = if self.state.m > 1e-10 {
                self.state.t * (dp_dt / self.state.p.max(1.0) + d_v_dt / v - dm_dt / self.state.m)
            } else {
                0.0
            };
            self.state.p += dp_dt * dt;
            self.state.m += dm_dt * dt;
            self.state.t += d_t_dt * dt;
            self.state.m_intake_total += mdot_in * dt;
            self.state.m_exhaust_total += mdot_out * dt;
        } else {
            // RK4 on p(θ). m unchanged in closed cycle.
            let dth_rad = dtheta_deg.to_radians();
            let th0 = theta_local;
            let m_const = self.state.m;
            let t_init = self.state.t;
            let bore = self.geom.bore;
            let stroke = self.geom.stroke;
            let con_rod = self.geom.con_rod;
            let cr = self.geom.cr;
            let v_d = self.geom.v_d();
            let ws_bore = self.woschni.bore;
            let ws_stroke = self.woschni.stroke;
            let ws_t_wall = self.woschni.t_wall;
            let c1gx = self.woschni.c1_gas_exchange;
            let c1co = self.woschni.c1_compression;
            let c1cb = self.woschni.c1_combustion;
            let c2cb = self.woschni.c2_combustion;
            let wiebe_a = self.wiebe.a * (1.0 + self.wiebe.tumble_burn_factor);
            let wiebe_m = self.wiebe.m;
            let theta_start = self.wiebe.theta_start();
            let duration = self.wiebe.duration_deg;
            let m_fuel = self.state.m_fuel;
            let q_lhv = self.wiebe.q_lhv;

            let dpdth = |p_local: f64, th: f64| -> f64 {
                let v_l = cylinder_volume(th, bore, stroke, con_rod, cr);
                let dv_l_dth = cylinder_d_v_dtheta(th, bore, stroke, con_rod);
                let dv_l_dth_rad = dv_l_dth * (180.0 / PI);
                let t_local = if m_const > 1e-10 {
                    (p_local * v_l) / (m_const * r_gas)
                } else {
                    t_init
                };
                let a_s = cylinder_surface_area(th, bore, stroke, con_rod, cr);
                let h_local = woschni_h(
                    p_local, t_local, rpm, v_l, v_d, phase,
                    p_ref, t_ref, v_ref, ws_bore, ws_stroke,
                    c1gx, c1co, c1cb, c2cb,
                );
                let d_q_ht = h_local * a_s * (t_local - ws_t_wall) / omega.max(1.0);
                let mut d_q_comb_local = 0.0;
                if is_combusting(th, theta_start, duration) && m_fuel > 0.0 {
                    let dxb_dth = wiebe_burn_rate(th, wiebe_a, wiebe_m, theta_start, duration);
                    d_q_comb_local = eta * m_fuel * q_lhv * dxb_dth * (180.0 / PI);
                }
                if v_l < 1e-20 {
                    return 0.0;
                }
                -gamma * (p_local / v_l) * dv_l_dth_rad
                    + (gamma - 1.0) / v_l * (d_q_comb_local - d_q_ht)
            };

            let k1 = dpdth(self.state.p, th0);
            let k2 = dpdth(self.state.p + 0.5 * dth_rad * k1, th0 + 0.5 * dtheta_deg);
            let k3 = dpdth(self.state.p + 0.5 * dth_rad * k2, th0 + 0.5 * dtheta_deg);
            let k4 = dpdth(self.state.p + dth_rad * k3, th0 + dtheta_deg);
            self.state.p += dth_rad / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
            let theta_new = (theta_local + dtheta_deg).rem_euclid(720.0);
            let v_new = self.volume(theta_new);
            if self.state.m > 1e-10 {
                self.state.t = self.state.p * v_new / (self.state.m * r_gas);
            }
            self.state.t = self.state.t.max(100.0);
            self.state.p = self.state.p.max(100.0);
        }

        self.state.work_cycle += self.state.p * d_v_dt * dt;

        let evc = self.exhaust_valve.close_angle_deg.rem_euclid(720.0);
        if self.enable_residual_tracking
            && theta_local <= evc && evc < (theta_local + dtheta_deg)
        {
            self.state.m_residual = self.state.m;
            self.state.p_at_evc = self.state.p;
            self.state.t_at_evc = self.state.t;
        }

        let ivc = self.intake_valve.close_angle_deg.rem_euclid(720.0);
        if theta_local <= ivc && ivc < (theta_local + dtheta_deg) {
            self.state.p_at_ivc = self.state.p;
            self.state.t_at_ivc = self.state.t;
            self.state.v_at_ivc = v;
            self.state.m_at_ivc = self.state.m;
            if self.enable_residual_tracking {
                let m_fresh = (self.state.m - self.state.m_residual).max(0.0);
                self.state.m_fuel = m_fresh / (1.0 + self.wiebe.afr_target);
                if self.state.m > 1e-12 {
                    let f = (self.state.m_residual / self.state.m).clamp(0.0, 1.0);
                    self.state.x_b = f;
                    self.state.f_residual_at_ivc = f;
                } else {
                    self.state.x_b = 0.0;
                    self.state.f_residual_at_ivc = 0.0;
                }
            } else {
                self.state.m_fuel = self.state.m / (1.0 + self.wiebe.afr_target);
                self.state.x_b = 0.0;
                self.state.f_residual_at_ivc = 0.0;
            }
        }
    }
}
