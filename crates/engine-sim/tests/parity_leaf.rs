//! Parity tests for the leaf kernels (no internal deps). Each test
//! loads the corresponding `fixtures/parity/*.json` golden and verifies
//! that the Rust implementation matches Python within the declared
//! tolerance.

mod common;
use common::*;

use engine_sim::cylinder::combustion::{
    WiebeParams, wiebe_xb, wiebe_burn_rate, is_combusting,
};
use engine_sim::cylinder::gas_properties::{
    gamma_unburned, gamma_burned, gamma_mixture, r_mixture, speed_of_sound,
};
use engine_sim::cylinder::geometry::{
    cylinder_volume, cylinder_d_v_dtheta, cylinder_surface_area,
};
use engine_sim::cylinder::heat_transfer::{
    mean_piston_speed, motored_pressure, woschni_h, woschni_d_q_dt,
};
use engine_sim::cylinder::kinematics::{cylinder_phase_offsets, omega_from_rpm};
use engine_sim::cylinder::valve::{
    valve_cd, valve_effective_area, valve_lift, valve_reference_area,
};

#[test]
fn gas_properties_parity() {
    let fx = load_fixture("gas_properties");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        if let Some(v) = out.get("gamma_unburned") {
            let got = gamma_unburned(f64_val(&inp["T"]));
            assert_close(name, got, f64_val(v), &tol);
        } else if let Some(v) = out.get("gamma_burned") {
            let got = gamma_burned(f64_val(&inp["T"]));
            assert_close(name, got, f64_val(v), &tol);
        } else if let Some(v) = out.get("gamma_mixture") {
            let got = gamma_mixture(f64_val(&inp["T"]), f64_val(&inp["x_b"]));
            assert_close(name, got, f64_val(v), &tol);
        } else if let Some(v) = out.get("R_mixture") {
            let got = r_mixture(f64_val(&inp["x_b"]));
            assert_close(name, got, f64_val(v), &tol);
        } else if let Some(v) = out.get("a") {
            let got = speed_of_sound(
                f64_val(&inp["gamma"]),
                f64_val(&inp["R"]),
                f64_val(&inp["T"]),
            );
            assert_close(name, got, f64_val(v), &tol);
        } else {
            panic!("{name}: unrecognised output shape");
        }
    }
}

#[test]
fn geometry_parity() {
    let fx = load_fixture("geometry");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let b = f64_val(&inp["bore"]);
        let s = f64_val(&inp["stroke"]);
        let l = f64_val(&inp["con_rod"]);
        let cr = f64_val(&inp["CR"]);
        let thetas = f64_array(&inp["thetas"]);
        let want_v = f64_array(&out["V"]);
        let want_dv = f64_array(&out["dVdtheta"]);
        let want_a = f64_array(&out["A_surface"]);
        for (i, &t) in thetas.iter().enumerate() {
            assert_close(&format!("V[{i}]"), cylinder_volume(t, b, s, l, cr), want_v[i], &tol);
            assert_close(&format!("dV[{i}]"), cylinder_d_v_dtheta(t, b, s, l), want_dv[i], &tol);
            assert_close(&format!("A[{i}]"), cylinder_surface_area(t, b, s, l, cr), want_a[i], &tol);
        }
    }
}

#[test]
fn kinematics_parity() {
    let fx = load_fixture("kinematics");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        if let Some(rpms) = inp.get("rpms") {
            let rpms = f64_array(rpms);
            let want = f64_array(&out["omegas"]);
            for (i, &r) in rpms.iter().enumerate() {
                assert_close(&format!("omega[{i}]"), omega_from_rpm(r), want[i], &tol);
            }
        } else {
            let n_cyl = inp["n_cyl"].as_u64().unwrap() as usize;
            let order: Vec<i32> = inp["firing_order"].as_array().unwrap().iter()
                .map(|v| v.as_i64().unwrap() as i32).collect();
            let interval = f64_val(&inp["firing_interval"]);
            let got = cylinder_phase_offsets(n_cyl, &order, interval);
            for (k, v) in out["offsets"].as_object().unwrap() {
                let key: i32 = k.parse().unwrap();
                let want = v.as_f64().unwrap();
                assert_close(
                    &format!("{name}.{key}"),
                    *got.get(&key).unwrap(), want, &tol,
                );
            }
        }
    }
}

#[test]
fn combustion_parity() {
    let fx = load_fixture("combustion");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        if name == "wiebe_sweep_default" {
            let a = f64_val(&inp["a"]);
            let m = f64_val(&inp["m"]);
            let dur = f64_val(&inp["duration"]);
            let t0 = f64_val(&inp["theta_start"]);
            let thetas = f64_array(&inp["thetas"]);
            let want_xb = f64_array(&out["xb"]);
            let want_br = f64_array(&out["burn_rate"]);
            let want_ic = out["is_combusting"].as_array().unwrap();
            for (i, &t) in thetas.iter().enumerate() {
                assert_close(&format!("xb[{i}]"), wiebe_xb(t, a, m, t0, dur), want_xb[i], &tol);
                assert_close(&format!("br[{i}]"), wiebe_burn_rate(t, a, m, t0, dur), want_br[i], &tol);
                let got_ic = is_combusting(t, t0, dur);
                let w = want_ic[i].as_bool().unwrap();
                assert_eq!(got_ic, w, "is_combusting[{i}] mismatch at t={t}");
            }
        } else if name == "eta_comb_at_rpm_default" {
            let wp = WiebeParams::default();
            assert_close("base_eta", wp.eta_comb, f64_val(&inp["base_eta"]), &tol);
            let rpms = f64_array(&inp["rpms"]);
            let want = f64_array(&out["etas"]);
            for (i, &r) in rpms.iter().enumerate() {
                assert_close(&format!("eta[{i}]"), wp.eta_comb_at_rpm(r), want[i], &tol);
            }
        }
    }
}

#[test]
fn heat_transfer_parity() {
    let fx = load_fixture("heat_transfer");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        match name {
            "mean_piston_speed" => {
                let stroke = f64_val(&inp["stroke"]);
                let rpms = f64_array(&inp["rpms"]);
                let want = f64_array(&out["Sp"]);
                for (i, &r) in rpms.iter().enumerate() {
                    assert_close(&format!("Sp[{i}]"), mean_piston_speed(stroke, r), want[i], &tol);
                }
            }
            "motored_pressure" => {
                let p_ref = f64_val(&inp["p_ref"]);
                let v_ref = f64_val(&inp["V_ref"]);
                let items = out["items"].as_array().unwrap();
                for (i, it) in items.iter().enumerate() {
                    let v = f64_val(&it["V"]);
                    let want = f64_val(&it["p_mot"]);
                    let got = motored_pressure(v, p_ref, v_ref);
                    assert_close(&format!("p_mot[{i}]"), got, want, &tol);
                }
            }
            "woschni_grid" => {
                let p_ref = f64_val(&inp["p_ref"]);
                let t_ref = f64_val(&inp["T_ref"]);
                let v_ref = f64_val(&inp["V_ref"]);
                let v_d = f64_val(&inp["V_d"]);
                let b = f64_val(&inp["bore"]);
                let s = f64_val(&inp["stroke"]);
                let rpm = f64_val(&inp["rpm"]);
                let c1gx = f64_val(&inp["C1_gx"]);
                let c1co = f64_val(&inp["C1_co"]);
                let c1cb = f64_val(&inp["C1_cb"]);
                let c2cb = f64_val(&inp["C2_cb"]);
                let t_wall = f64_val(&inp["T_wall"]);
                let a_surface = f64_val(&inp["A_surface"]);
                for (i, it) in out["items"].as_array().unwrap().iter().enumerate() {
                    let phase = it["phase"].as_i64().unwrap() as i32;
                    let p = f64_val(&it["p"]);
                    let t = f64_val(&it["T"]);
                    let v = f64_val(&it["V"]);
                    let want_h = f64_val(&it["h"]);
                    let want_dq = f64_val(&it["dQ"]);
                    let got_h = woschni_h(p, t, rpm, v, v_d, phase,
                                          p_ref, t_ref, v_ref, b, s,
                                          c1gx, c1co, c1cb, c2cb);
                    let got_dq = woschni_d_q_dt(p, t, rpm, v, v_d, a_surface, t_wall,
                                                phase, p_ref, t_ref, v_ref, b, s,
                                                c1gx, c1co, c1cb, c2cb);
                    assert_close(&format!("h[{i}]"), got_h, want_h, &tol);
                    assert_close(&format!("dQ[{i}]"), got_dq, want_dq, &tol);
                }
            }
            _ => panic!("unknown case {name}"),
        }
    }
}

#[test]
fn valve_cyl_parity() {
    let fx = load_fixture("valve_cyl");
    let tol = tolerance(&fx);
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let inp = &case["inputs"];
        let out = &case["outputs"];
        let p = &inp["params"];
        let d = f64_val(&p["diameter"]);
        let max_l = f64_val(&p["max_lift"]);
        let oa = f64_val(&p["open_angle"]);
        let ca = f64_val(&p["close_angle"]);
        let sa = f64_val(&p["seat_angle_rad"]);
        let nv = p["n_valves"].as_u64().unwrap() as usize;
        let ldt = f64_array(&p["ld_table"]);
        let cdt = f64_array(&p["cd_table"]);
        let thetas = f64_array(&inp["thetas"]);
        let want_l = f64_array(&out["L"]);
        let want_cd = f64_array(&out["Cd"]);
        let want_ar = f64_array(&out["A_ref"]);
        let want_ae = f64_array(&out["A_eff"]);
        for (i, &t) in thetas.iter().enumerate() {
            let l = valve_lift(t, oa, ca, max_l);
            let cd = valve_cd(l, d, &ldt, &cdt);
            let ar = valve_reference_area(l, d, sa);
            let ae = valve_effective_area(t, oa, ca, max_l, d, sa, nv, &ldt, &cdt);
            assert_close(&format!("{name}.L[{i}]"), l, want_l[i], &tol);
            assert_close(&format!("{name}.Cd[{i}]"), cd, want_cd[i], &tol);
            assert_close(&format!("{name}.Ar[{i}]"), ar, want_ar[i], &tol);
            assert_close(&format!("{name}.Ae[{i}]"), ae, want_ae[i], &tol);
        }
    }
}
