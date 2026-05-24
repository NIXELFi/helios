//! 0D cylinder thermodynamic integrator.
//! Direct port of `cylinder/cylinder.py`.

use std::f64::consts::PI;

use crate::cylinder::combustion::{is_combusting, wiebe_burn_rate, wiebe_xb, WiebeParams};
use crate::cylinder::gas_properties::{gamma_burned, gamma_mixture, gamma_unburned, r_mixture};
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
    // ---- Two-zone state (only meaningful when WiebeParams::two_zone_enabled = true) ----
    /// Mass of burned zone (kg). 0 outside the combustion window.
    pub m_b: f64,
    /// Mass of unburned zone (kg). Equals total mass outside combustion.
    pub m_u: f64,
    /// Burned-zone temperature (K). Set to t at ignition; rises as combustion progresses.
    pub t_b: f64,
    /// Unburned-zone temperature (K). Mostly the compressed-charge T.
    pub t_u: f64,
    /// Flag: are we currently inside a two-zone combustion window?
    /// When false, m_b/m_u/t_b/t_u are not maintained.
    pub two_zone_active: bool,
    /// 0013: Livengood-Wu knock integral, accumulated from IVC over the
    /// compression stroke. Reset to 0 at IVC. Integration formula:
    ///   I = ∫_IVC^t (1 / τ(P, T)) dt
    /// with τ from Douaud-Eyzat 1978:
    ///   τ_ms = 17.68 · (ON/100)^3.402 · P_atm^(-1.7) · exp(3800 / T_unb)
    /// `knock_integral_at_spark` is the snapshot at the first step of
    /// combustion — that's the physically-relevant value (the end-gas
    /// auto-ignition threshold). I > 1.0 → end-gas auto-ignites before
    /// the flame front arrives → knock predicted.
    pub knock_integral_accum: f64,
    pub knock_integral_at_spark: f64,
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
            m_b: 0.0, m_u: 0.0, t_b: 0.0, t_u: 0.0,
            two_zone_active: false,
            knock_integral_accum: 0.0,
            knock_integral_at_spark: 0.0,
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
    /// 0013: Fuel octane number for the Livengood-Wu knock integral.
    /// Default 95 (race gas / premium pump). Pump gas ~91. Default
    /// behavior at any reasonable octane is a no-op diagnostic that
    /// just reports `knock_integral_at_spark` — it does NOT feed back
    /// into combustion. Designers should treat I > 1.0 as a hard
    /// no-go for SDM27 architectures.
    pub octane_number: f64,
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
            octane_number: 95.0,
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

    fn phase_code(&self, theta_local_deg: f64, rpm: f64) -> i32 {
        let iv_open = valve_is_open(theta_local_deg, &self.intake_valve);
        let ev_open = valve_is_open(theta_local_deg, &self.exhaust_valve);
        if iv_open || ev_open {
            return 0;
        }
        // 0006: RPM-aware combustion window so a non-zero spark-advance
        // ramp or duration exponent shifts the burn phase code with RPM.
        // Defaults (slope=0, exp=0) leave `theta_start_at` / `duration_at`
        // identical to the legacy `theta_start` / `duration_deg`.
        if is_combusting(theta_local_deg, self.wiebe.theta_start_at(rpm), self.wiebe.duration_at(rpm)) {
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

        // Snapshot x_b BEFORE the Wiebe update so the single-zone γ
        // matches the legacy code (which evaluated γ at the start of
        // the step, prior to x_b advancing).
        let x_b_pre = self.state.x_b;
        let r_gas = r_mixture(self.state.x_b);

        let v = self.volume(theta_local);
        let d_v_dt = self.d_v_dtheta(theta_local) * (180.0 / PI) * omega;

        let phase = self.phase_code(theta_local, rpm);

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

        let eta = self.wiebe.eta_at(rpm);
        // 0007: RPM-scaled Wiebe a (turbulent flame speed). Defaults to
        // RPM-invariant `self.wiebe.a` when wiebe_a_rpm_exp = 0.
        let a_eff = self.wiebe.a_at(rpm) * (1.0 + self.wiebe.tumble_burn_factor);

        // 0013: Livengood-Wu knock integral. Accumulate during
        // compression (valves closed, NOT yet combusting), reset at IVC
        // (handled in the IVC block below), snapshot at combustion start.
        // Diagnostic only — does not affect combustion model.
        let iv_open = valve_is_open(theta_local, &self.intake_valve);
        let ev_open = valve_is_open(theta_local, &self.exhaust_valve);
        let in_compression = !iv_open && !ev_open;
        // 0006: pull the RPM-aware combustion window. With default
        // slope=0 + exp=0 these return the legacy constants; with
        // non-zero slope / exp they shift the burn with RPM.
        let theta_start_rpm = self.wiebe.theta_start_at(rpm);
        let duration_rpm = self.wiebe.duration_at(rpm);
        let burning = is_combusting(theta_local, theta_start_rpm, duration_rpm)
            && self.state.m_fuel > 0.0;

        // Integrate LW knock measure: from IVC through end of combustion.
        // The "snapshot" happens at end of combustion (when burning goes
        // back to false), capturing the full end-gas exposure history.
        if in_compression && self.state.knock_integral_at_spark == 0.0 {
            // Douaud-Eyzat 1978 auto-ignition delay τ_ms:
            //   τ_ms = 17.68 · (ON/100)^3.402 · P_atm^(-1.7) · exp(3800/T_unb)
            //
            // T_unburned choice:
            //   * Pre-burn (in_compression && !burning): bulk T is correct.
            //   * Two-zone active: explicit t_u.
            //   * Single-zone during burn: polytropic compression estimate
            //     from IVC, T_u(P) = T_IVC × (P/P_IVC)^((γ−1)/γ). This is the
            //     textbook end-gas T model (Heywood §9.6) and avoids the
            //     burned-gas heating bias of using bulk T during burn.
            let t_unb = if self.state.two_zone_active && self.state.t_u > 0.0 {
                self.state.t_u
            } else if burning && self.state.p_at_ivc > 0.0 {
                let pr = (self.state.p / self.state.p_at_ivc).max(1.0);
                // γ for unburned charge at SI temperatures: γ varies from
                // 1.40 at cold (300 K, fresh air-fuel) to 1.30 at hot
                // (~900 K end-gas). The mass-averaged value for the end-
                // gas compression history is ~1.33 (Heywood Fig 4-9 for
                // typical SI mixtures). Using 1.33 here is less aggressive
                // than the 1.35 first attempt — produces I_LW values that
                // are still direction-correct but better calibrated against
                // real-engine knock-onset CR limits.
                let exp_gm1_over_g = 0.33 / 1.33;
                (self.state.t_at_ivc * pr.powf(exp_gm1_over_g)).max(200.0)
            } else {
                self.state.t.max(200.0)
            };
            let p_atm = (self.state.p / 101325.0).max(0.1);
            let on_factor = (self.octane_number / 100.0).powf(3.402);
            let tau_ms = 17.68 * on_factor * p_atm.powf(-1.7) * (3800.0 / t_unb).exp();
            if tau_ms > 1e-12 {
                let di = (dt * 1000.0) / tau_ms; // dt in s, tau in ms → dimensionless
                self.state.knock_integral_accum += di;
            }
        }
        // Snapshot at END of combustion (first step where burning goes
        // back to false after having been true). This captures the full
        // end-gas auto-ignition exposure including the burn-phase
        // compression by the flame front — the physically-relevant
        // knock criterion.
        if !burning && self.state.knock_integral_accum > 0.0
           && self.state.x_b > 0.5  // proxy: combustion has happened this cycle
           && self.state.knock_integral_at_spark == 0.0
        {
            self.state.knock_integral_at_spark = self.state.knock_integral_accum;
        }
        let mut d_q_comb_dt = 0.0_f64;
        let mut dxb_dt = 0.0_f64;
        if burning {
            let dxb_dtheta = wiebe_burn_rate(
                theta_local, a_eff, self.wiebe.m,
                theta_start_rpm, duration_rpm,
            );
            dxb_dt = dxb_dtheta * 180.0 / PI * omega;
            d_q_comb_dt = eta * self.state.m_fuel * self.wiebe.q_lhv * dxb_dt;
            self.state.x_b = wiebe_xb(
                theta_local, a_eff, self.wiebe.m,
                theta_start_rpm, duration_rpm,
            );
        }

        // ---- Two-zone heat-loss/γ override (opt-in) ----
        // When two_zone_enabled and we are combusting, recompute the
        // heat-loss term and the effective gamma using a per-zone split.
        // Pressure remains spatially uniform (P_b = P_u = P), so the
        // pressure ODE structure is unchanged — only `gamma` and
        // `d_q_ht_dt` are replaced.
        let two_zone = self.wiebe.two_zone_enabled;
        if two_zone && burning {
            // Lazily initialize zones at the very first combustion step
            // of the cycle.
            if !self.state.two_zone_active {
                // m_b starts as a tiny seed so we don't divide by zero;
                // bulk mass-averaged T is conserved (m_b·T_b + m_u·T_u = m·T).
                let m_total = self.state.m.max(1e-12);
                let seed = (1e-6_f64 * m_total).max(1e-15);
                self.state.m_b = seed;
                self.state.m_u = (m_total - seed).max(0.0);
                // Estimate burned-zone T from adiabatic flame T at the
                // current charge state. A simple proxy: c_v_avg · (T_b - T)
                // = η · m_fuel · q_lhv · (seed/m_fuel_burned_total)
                // i.e. all of the seed-mass's share of fuel went exothermic.
                // To avoid an early heat-flux spike, set T_b = T initially
                // (gets pulled toward flame T quickly via the energy balance).
                self.state.t_b = self.state.t;
                self.state.t_u = self.state.t;
                self.state.two_zone_active = true;
            }
            // Advance zone masses (explicit, mass conservative).
            let dm_b = (dxb_dt * self.state.m).max(0.0) * dt;
            // Cap so we never overshoot m_u.
            let dm_b = dm_b.min(self.state.m_u.max(0.0));
            self.state.m_b += dm_b;
            self.state.m_u -= dm_b;
            // Clamp for floating safety
            if self.state.m_u < 0.0 { self.state.m_u = 0.0; }
            if self.state.m_b < 1e-15 { self.state.m_b = 1e-15; }
        } else if two_zone && !burning && self.state.two_zone_active {
            // Combustion just ended — collapse back to mass-averaged.
            self.state.two_zone_active = false;
            self.state.m_b = self.state.m;
            self.state.m_u = 0.0;
            self.state.t_b = self.state.t;
            self.state.t_u = self.state.t;
        }

        // Compute effective gamma + heat loss (two-zone aware).
        let (gamma, d_q_ht_dt) = if two_zone && self.state.two_zone_active {
            let m_total = self.state.m.max(1e-12);
            let m_b = self.state.m_b.max(1e-15);
            let m_u = self.state.m_u.max(0.0);
            let t_b = self.state.t_b.max(100.0);
            let t_u = self.state.t_u.max(100.0);
            // Pressure-equilibrium volume fractions.
            //   Legacy (parity-preserving):
            //     V_z/V = m_z·T_z / Σ(m_i·T_i)   (assumes R_b = R_u)
            //   R-weighted (correct EOS):
            //     V_z/V = m_z·R_z·T_z / Σ(m_i·R_i·T_i)
            // With R_b = 295 J/(kg·K), R_u = 287 J/(kg·K) the burned-zone
            // volume share is ~3% higher under the R-weighted form, which
            // moves part of the wall-area Q_loss budget toward the hotter
            // zone — a real first-law correction.
            // Bundled under `two_zone_gamma_cv_weighted` because it's part
            // of the same thermodynamically-consistent two-zone fix-up
            // (finding 0016 § followup 0021).
            let (v_frac_b, v_frac_u) = if self.wiebe.two_zone_gamma_cv_weighted {
                let r_b = r_mixture(1.0);
                let r_u = r_mixture(0.0);
                let mrt_b = m_b * r_b * t_b;
                let mrt_u = m_u * r_u * t_u;
                let mrt_sum = (mrt_b + mrt_u).max(1e-12);
                let vb = (mrt_b / mrt_sum).clamp(0.0, 1.0);
                (vb, 1.0 - vb)
            } else {
                let mt_b = m_b * t_b;
                let mt_u = m_u * t_u;
                let mt_sum = (mt_b + mt_u).max(1e-12);
                let vb = (mt_b / mt_sum).clamp(0.0, 1.0);
                (vb, 1.0 - vb)
            };
            let a_b = a_surf * v_frac_b;
            let a_u = a_surf * v_frac_u;
            let q_ht = h_c * (a_b * (t_b - self.woschni.t_wall)
                            + a_u * (t_u - self.woschni.t_wall));
            // Per-zone γ.
            let g_b = gamma_burned(t_b);
            let g_u = gamma_unburned(t_u);
            // Finding 0016: effective γ for the bulk pressure ODE.
            //   mass-averaged form (legacy, parity-preserving):
            //     γ_eff = (m_b·γ_b + m_u·γ_u) / m_total
            //   c_v-weighted form (thermodynamically correct for a true
            //   two-zone first law at common pressure):
            //     γ_eff = (m_b·c_p_b + m_u·c_p_u) / (m_b·c_v_b + m_u·c_v_u)
            // With c_p = γ·c_v and c_v = R/(γ−1), the c_v-weighted γ collapses
            // to γ(T) when T_b = T_u and to γ_z when only one zone exists. The
            // mass-averaged form does not satisfy the second limit cleanly
            // when R differs between zones, and biases the expansion-stroke
            // work because it weights γ_b (low) at the wrong "thermodynamic
            // weight." See finding 0016.
            let g = if self.wiebe.two_zone_gamma_cv_weighted {
                let r_b = r_mixture(1.0);
                let r_u = r_mixture(0.0);
                let cv_b = r_b / (g_b - 1.0);
                let cv_u = r_u / (g_u - 1.0);
                let cp_b = g_b * cv_b;
                let cp_u = g_u * cv_u;
                let num = m_b * cp_b + m_u * cp_u;
                let den = (m_b * cv_b + m_u * cv_u).max(1e-20);
                num / den
            } else {
                (m_b * g_b + m_u * g_u) / m_total
            };
            (g, q_ht)
        } else {
            // Single-zone (parity branch): γ uses the PRE-update x_b
            // so the result is bit-identical to the legacy code path.
            let g = gamma_mixture(self.state.t, x_b_pre);
            let q_ht = h_c * a_surf * (self.state.t - self.woschni.t_wall);
            (g, q_ht)
        };

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
            let wiebe_a = self.wiebe.a_at(rpm) * (1.0 + self.wiebe.tumble_burn_factor);
            let wiebe_m = self.wiebe.m;
            // 0006: RPM-aware burn window; defaults match legacy constants.
            let theta_start = self.wiebe.theta_start_at(rpm);
            let duration = self.wiebe.duration_at(rpm);
            let m_fuel = self.state.m_fuel;
            let q_lhv = self.wiebe.q_lhv;
            // Two-zone heat-loss override: if active, hold per-zone Q_ht
            // constant over the RK4 step (good to 1st order for the small
            // step size we use here). Convert d/dt -> d/dθ via 1/omega.
            let two_zone_active = self.state.two_zone_active;
            let q_ht_per_theta_override = if two_zone_active {
                d_q_ht_dt / omega.max(1.0)
            } else {
                0.0
            };

            let dpdth = |p_local: f64, th: f64| -> f64 {
                let v_l = cylinder_volume(th, bore, stroke, con_rod, cr);
                let dv_l_dth = cylinder_d_v_dtheta(th, bore, stroke, con_rod);
                let dv_l_dth_rad = dv_l_dth * (180.0 / PI);
                let t_local = if m_const > 1e-10 {
                    (p_local * v_l) / (m_const * r_gas)
                } else {
                    t_init
                };
                let d_q_ht = if two_zone_active {
                    q_ht_per_theta_override
                } else {
                    let a_s = cylinder_surface_area(th, bore, stroke, con_rod, cr);
                    let h_local = woschni_h(
                        p_local, t_local, rpm, v_l, v_d, phase,
                        p_ref, t_ref, v_ref, ws_bore, ws_stroke,
                        c1gx, c1co, c1cb, c2cb,
                    );
                    h_local * a_s * (t_local - ws_t_wall) / omega.max(1.0)
                };
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
            let p_before = self.state.p;
            self.state.p += dth_rad / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
            let theta_new = (theta_local + dtheta_deg).rem_euclid(720.0);
            let v_new = self.volume(theta_new);
            if self.state.m > 1e-10 {
                self.state.t = self.state.p * v_new / (self.state.m * r_gas);
            }
            self.state.t = self.state.t.max(100.0);
            self.state.p = self.state.p.max(100.0);

            // ---- Two-zone temperature update (post-pressure-step) ----
            // Strategy:
            //   1. Update T_u via polytropic compression (pressure ratio) +
            //      explicit wall-heat-loss term.
            //   2. Solve T_b from total internal-energy conservation:
            //        m_b c_v_b T_b + m_u c_v_u T_u  ≈  m c_v_eff T_avg
            //      (where T_avg is the just-updated bulk T from PV=mRT).
            //   3. Clamp T_b to a physical range [T_avg, ~3500 K].
            //
            // This is a pragmatic 2-zone closure that avoids the awkward
            // dV_b/dt bookkeeping while staying energy-consistent at each
            // step. It captures the key effect we wanted (higher T_b →
            // larger heat-loss split, different gamma) without
            // introducing a stiff per-zone ODE.
            if self.state.two_zone_active && self.state.m > 1e-10 {
                let m_total = self.state.m;
                let m_b = self.state.m_b.max(1e-15);
                let m_u = self.state.m_u.max(0.0);
                // 1) Adiabatic-pressure-ratio update for unburned T_u.
                //    γ_u depends weakly on T_u — use current value.
                let g_u = gamma_unburned(self.state.t_u.max(300.0));
                let p_ratio = (self.state.p / p_before.max(1.0)).max(1e-6);
                let t_u_pc = self.state.t_u * p_ratio.powf((g_u - 1.0) / g_u);
                // Subtract unburned-zone wall heat loss explicitly.
                // dQ_loss_u = h_c · A_u · (T_u - T_w) over this step.
                let r_u = r_mixture(0.0);
                let c_v_u = r_u / (g_u - 1.0);
                let mt_b0 = m_b * self.state.t_b.max(100.0);
                let mt_u0 = m_u * self.state.t_u.max(100.0);
                let v_frac_u_old = mt_u0 / (mt_b0 + mt_u0).max(1e-12);
                let a_u_old = a_surf * v_frac_u_old;
                let q_loss_u = h_c * a_u_old * (self.state.t_u - self.woschni.t_wall) * dt;
                let dt_u_loss = if m_u > 1e-12 { -q_loss_u / (m_u * c_v_u) } else { 0.0 };
                let mut t_u_new = t_u_pc + dt_u_loss;
                if t_u_new < 200.0 { t_u_new = 200.0; }
                if t_u_new > 3500.0 { t_u_new = 3500.0; }

                // 2) Solve T_b from total energy conservation.
                //    Use frozen c_v_b at the current T_b for the inversion.
                let g_b = gamma_burned(self.state.t_b.max(300.0));
                let r_b = r_mixture(1.0);
                let c_v_b = r_b / (g_b - 1.0);
                // Finding 0016: when c_v-weighted γ is active for the bulk
                // pressure ODE, also use it here for self-consistency. Both
                // forms collapse to γ(T) when T_b = T_u so this only matters
                // during the burn.
                let g_eff = if self.wiebe.two_zone_gamma_cv_weighted {
                    let cv_u_loc = r_u / (g_u - 1.0);
                    let cp_b_loc = g_b * c_v_b;
                    let cp_u_loc = g_u * cv_u_loc;
                    let num = m_b * cp_b_loc + m_u * cp_u_loc;
                    let den = (m_b * c_v_b + m_u * cv_u_loc).max(1e-20);
                    num / den
                } else {
                    (m_b * g_b + m_u * g_u) / m_total
                };
                let c_v_eff = r_gas / (g_eff - 1.0);
                let total_u = m_total * c_v_eff * self.state.t;
                let u_unburned = m_u * c_v_u * t_u_new;
                let mut t_b_new = if m_b > 1e-12 {
                    (total_u - u_unburned) / (m_b * c_v_b)
                } else {
                    self.state.t
                };
                // Burned zone must be hotter than bulk avg; clamp.
                if t_b_new < self.state.t { t_b_new = self.state.t; }
                if t_b_new > 3500.0 { t_b_new = 3500.0; }
                self.state.t_b = t_b_new;
                self.state.t_u = t_u_new;
            }
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
            // Two-zone state reset at IVC. The next cycle's combustion
            // window will re-initialize zones lazily.
            self.state.two_zone_active = false;
            self.state.m_b = 0.0;
            self.state.m_u = self.state.m;
            self.state.t_b = self.state.t;
            self.state.t_u = self.state.t;
            // 0013: reset knock integral at IVC so each cycle gets a
            // fresh measurement.
            self.state.knock_integral_accum = 0.0;
            self.state.knock_integral_at_spark = 0.0;
        }
    }
}
