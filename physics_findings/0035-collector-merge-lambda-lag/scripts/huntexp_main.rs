// usage: huntexp <config.json> <rpm_lo> <rpm_hi> <step> <cycles> [k=v ...]
// special keys: firing=1-3-4-2, cdscale_in, cdscale_ex, residual=1
use engine_sim::config::loader::load_v1_json_with_warnings;
use engine_sim::model::sdm26::*;
use engine_sim::solver::state::*;

struct Obs { tin_num: f64, tin_den: f64, ovl_ex_out: f64, ovl_in_back: f64, pl_t: f64, pl_p: f64, n: f64, egt_num: f64, egt_den: f64, rn_t: f64 }
impl CycleObserver for Obs {
    fn on_step(&mut self, th: f64, dt: f64, e: &SDM26Engine) {
        for c in &e.cylinders {
            let s = &c.state;
            let tl = c.local_theta(th); let ivo = c.intake_valve.open_angle_deg.rem_euclid(720.0); let evc = c.exhaust_valve.close_angle_deg.rem_euclid(720.0);
            let in_ovl = tl >= ivo && tl <= evc;
            if s.mdot_intake > 0.0 { self.tin_num += s.t_intake * s.mdot_intake * dt; self.tin_den += s.mdot_intake * dt; }
            if s.mdot_exhaust > 0.0 { self.egt_num += s.t * s.mdot_exhaust * dt; self.egt_den += s.mdot_exhaust * dt; }
            if in_ovl {
                if s.mdot_exhaust > 0.0 { self.ovl_ex_out += s.mdot_exhaust * dt; }
                if s.mdot_intake < 0.0 { self.ovl_in_back += -s.mdot_intake * dt; }
            }
        }
        let p = &e.pipes[e.plenum_idx];
        let (mut tt, mut pp) = (0.0, 0.0);
        for k in 0..p.n_cells { let i = k + p.n_ghost; let a = p.area[i];
            let rho = p.q[i*N_VARS]/a; let u = p.q[i*N_VARS+1]/(rho*a); let en = p.q[i*N_VARS+2]/a;
            let pr = (p.gamma-1.0)*(en-0.5*rho*u*u); pp += pr; tt += pr/(rho*p.r_gas); }
        self.pl_t += tt/(p.n_cells as f64)*dt; self.pl_p += pp/(p.n_cells as f64)*dt; self.n += dt;
        // runner 1 mid-cell T
        let r = &e.pipes[e.runner_idx[0]]; let i = r.n_ghost + r.n_cells/2; let a = r.area[i];
        let rho = r.q[i*N_VARS]/a; let u = r.q[i*N_VARS+1]/(rho*a); let en = r.q[i*N_VARS+2]/a;
        let pr = (r.gamma-1.0)*(en-0.5*rho*u*u); self.rn_t += pr/(rho*r.r_gas)*dt;
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (mut cfg, _w) = load_v1_json_with_warnings(&a[1]).expect("load");
    let lo: f64 = a[2].parse().unwrap(); let hi: f64 = a[3].parse().unwrap(); let st: f64 = a[4].parse().unwrap();
    let cycles: usize = a[5].parse().unwrap();
    for kv in &a[6..] {
        let (k, v) = kv.split_once('=').unwrap();
        match k {
            "firing" => cfg.firing_order = v.split('-').map(|x| x.parse().unwrap()).collect(),
            "cdscale_in" => { let s: f64 = v.parse().unwrap(); for x in cfg.intake_cd_table.iter_mut() { *x *= s; } }
            "cdscale_ex" => { let s: f64 = v.parse().unwrap(); for x in cfg.exhaust_cd_table.iter_mut() { *x *= s; } }
            _ => cfd_core::params::apply_override(&mut cfg, k, v.parse().unwrap()).expect(k),
        }
    }
    let mut rpm = lo;
    while rpm <= hi + 1e-6 {
        let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Characteristic);
        let mut st8 = CycleLoopState::new(&mut eng);
        let target = cycles as f64 * 720.0;
        let mut last = None; let mut ob = Obs{tin_num:0.,tin_den:0.,ovl_ex_out:0.,ovl_in_back:0.,pl_t:0.,pl_p:0.,n:0.,egt_num:0.,egt_den:0.,rn_t:0.};
        let mut k = 0;
        while st8.theta < target {
            let use_obs = k >= cycles - 3;
            let r = if use_obs { eng.advance_one_cycle(rpm, &mut st8, Some(target), Some(&mut ob), None) } else { eng.advance_one_cycle(rpm, &mut st8, Some(target), None, None) };
            match r { CycleOutcome::Cycle(s) => { last = Some(s); k += 1; } _ => break }
        }
        let s = last.unwrap();
        let vd: f64 = eng.cylinders[0].geom.v_d() * eng.cylinders.len() as f64;
        let rho = cfg.p_ambient / (287.0 * cfg.t_ambient);
        let m_ivc: f64 = eng.cylinders.iter().map(|c| c.state.m_at_ivc).sum();
        let m_res: f64 = eng.cylinders.iter().map(|c| c.state.m_residual).sum();
        let cyc = 3.0;
        println!("{{\"rpm\":{},\"ve_del\":{:.5},\"ve_trap_tot\":{:.5},\"ve_trap_fresh\":{:.5},\"res_frac\":{:.4},\"ovl_ex_out_ve\":{:.5},\"ovl_in_back_ve\":{:.5},\"t_in_massavg\":{:.1},\"t_plenum\":{:.1},\"p_plenum\":{:.0},\"t_runner1_mid\":{:.1},\"egt_massavg\":{:.1},\"imep\":{:.3},\"bt\":{:.3}}}",
            rpm, s.ve_atm, m_ivc/(rho*vd), (m_ivc-m_res)/(rho*vd), if m_ivc>0.0 {m_res/m_ivc} else {0.0},
            ob.ovl_ex_out/cyc/(rho*vd), ob.ovl_in_back/cyc/(rho*vd), ob.tin_num/ob.tin_den.max(1e-30), ob.pl_t/ob.n, ob.pl_p/ob.n, ob.rn_t/ob.n, ob.egt_num/ob.egt_den.max(1e-30), s.imep_bar, s.brake_torque_nm);
        rpm += st;
    }
}
