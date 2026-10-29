//! VRLI (variable runner length intake) design logic — finding 0037.
//!
//! Pure functions over a simulated performance surface `T(extension, rpm)`:
//! interpolation in runner length, the continuously-variable envelope for a
//! telescoping design `[a, a + stroke]`, an actuator-rate-limited position
//! schedule (dynamic programming), the requirement metrics from the VRLI
//! problem definition (P1 average-torque gain, P2 no-dip ratio, F2 actuator
//! speed, C2 mass) and the per-stroke placement optimiser.
//!
//! Everything here is deterministic and engine-free so it can be unit-tested
//! on synthetic surfaces; `cmd::vrli` fills the surface from engine runs.

use serde::Serialize;

/// Simulated performance surface: `val[k][j]` at `ext_mm[k]`, `rpm[j]`.
/// `ext_mm` is the runner mouth extension relative to the base config
/// (mm; runner length = base + ext), strictly increasing.
#[derive(Debug, Clone)]
pub struct Surface {
    pub ext_mm: Vec<f64>,
    pub rpm: Vec<f64>,
    pub val: Vec<Vec<f64>>,
}

impl Surface {
    /// Catmull-Rom (C¹, local) interpolation in extension for rpm column
    /// `j`. Clamped to the grid ends (no extrapolation).
    pub fn at(&self, e_mm: f64, j: usize) -> f64 {
        let x = &self.ext_mm;
        let n = x.len();
        if n == 1 {
            return self.val[0][j];
        }
        let e = e_mm.clamp(x[0], x[n - 1]);
        let mut k = match x.iter().position(|&xi| xi > e) {
            Some(0) => 0,
            Some(i) => i - 1,
            None => n - 2,
        };
        if k > n - 2 {
            k = n - 2;
        }
        let (x1, x2) = (x[k], x[k + 1]);
        let t = (e - x1) / (x2 - x1);
        let y1 = self.val[k][j];
        let y2 = self.val[k + 1][j];
        // Tangents by finite differences (one-sided at the ends).
        let m1 = if k == 0 {
            y2 - y1
        } else {
            (y2 - self.val[k - 1][j]) * (x2 - x1) / (x2 - x[k - 1])
        };
        let m2 = if k + 2 >= n {
            y2 - y1
        } else {
            (self.val[k + 2][j] - y1) * (x2 - x1) / (x[k + 2] - x1)
        };
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * y1
            + (t3 - 2.0 * t2 + t) * m1
            + (-2.0 * t3 + 3.0 * t2) * y2
            + (t3 - t2) * m2
    }

    /// Trapezoid weights for the rpm points inside `[lo, hi]` (the band
    /// ends must be grid points for an exact band average).
    pub fn band_weights(&self, lo: f64, hi: f64) -> Vec<f64> {
        let r = &self.rpm;
        let mut w = vec![0.0; r.len()];
        for j in 0..r.len().saturating_sub(1) {
            let (a, b) = (r[j].max(lo), r[j + 1].min(hi));
            if b > a {
                // Linear weights of the clipped segment onto its two ends.
                let h = r[j + 1] - r[j];
                let (ta, tb) = ((a - r[j]) / h, (b - r[j]) / h);
                let seg = b - a;
                let mid = 0.5 * (ta + tb);
                w[j] += seg * (1.0 - mid);
                w[j + 1] += seg * mid;
            }
        }
        w
    }

    /// Weighted mean of a per-rpm series.
    pub fn mean(series: &[f64], w: &[f64]) -> f64 {
        let s: f64 = w.iter().sum();
        series.iter().zip(w).map(|(v, wi)| v * wi).sum::<f64>() / s.max(1e-30)
    }
}

/// Mass model (C2), from the conceptual-design-review breakdown: parts that
/// do not scale with stroke (carrier plate, linear pot, spring, mounts),
/// parts proportional to stroke (guide rods + bushings, lead screw, longer
/// trumpet sleeves) and an actuator whose mass scales with the power needed
/// to move the full stroke in the F2 time (∝ stroke^exponent).
#[derive(Debug, Clone, Serialize)]
pub struct MassModel {
    pub fixed_kg: f64,
    pub per_100mm_kg: f64,
    pub actuator_kg_at_100mm: f64,
    pub actuator_exponent: f64,
    pub limit_kg: f64,
}

impl Default for MassModel {
    fn default() -> Self {
        // CDR: plate 0.20 + pot/spring/mounts 0.10 (fixed); rods 0.15 +
        // screw 0.12 + sleeves 0.15 per 100 mm; actuator 0.30 kg at 100 mm.
        Self { fixed_kg: 0.30, per_100mm_kg: 0.42, actuator_kg_at_100mm: 0.30, actuator_exponent: 0.7, limit_kg: 1.5 }
    }
}

impl MassModel {
    pub fn mass(&self, stroke_mm: f64) -> f64 {
        if stroke_mm <= 0.0 {
            return 0.0; // fixed runner: no mechanism
        }
        self.fixed_kg
            + self.per_100mm_kg * stroke_mm / 100.0
            + self.actuator_kg_at_100mm * (stroke_mm / 100.0).powf(self.actuator_exponent)
    }
}

#[derive(Debug, Clone)]
pub struct DesignSpec {
    pub band: (f64, f64),
    pub driver_band: (f64, f64),
    pub baseline_ext_mm: f64,
    /// Position grid step for the envelope / schedule (mm).
    pub position_step_mm: f64,
    /// F3 positioning resolution the ECU map is quantised to (mm).
    pub f3_resolution_mm: f64,
    /// Fastest engine sweep the actuator must follow (rpm/s).
    pub sweep_rate_rpm_s: f64,
    /// F2: full stroke time (s). Actuator speed = stroke / this.
    pub full_stroke_time_s: f64,
    pub mass: MassModel,
    /// Maximum protrusion into the plenum, `a + stroke − ref` (mm).
    pub max_protrusion_mm: f64,
    pub displacement_ref_mm: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesignResult {
    pub stroke_mm: f64,
    /// Fully-retracted (shortest) position, mm of extension.
    pub lmin_mm: f64,
    pub lmax_mm: f64,
    /// P1: band-average gain vs the fixed baseline, quasi-steady map.
    pub p1_gain: f64,
    /// Upper bound at `sweep_rate_rpm_s`: the best position schedule an
    /// actuator of speed stroke/full_stroke_time can follow (DP).
    pub p1_gain_rate_limited: f64,
    /// P1 of the ECU table (quasi-steady optimum quantised to F3), i.e. a
    /// slow (dyno-like) sweep.
    pub p1_gain_quantised: f64,
    /// P1 when the plate chases the ECU table at full actuator speed during
    /// an up-sweep at `sweep_rate_rpm_s` (what the car does in that gear).
    pub p1_gain_follow: f64,
    /// Driver band (7-10.5k) average gain, quasi-steady.
    pub driver_gain: f64,
    /// P2: min over the band of VRLI / max(fixed short, fixed long) for the
    /// plate chasing the ECU table at `sweep_rate_rpm_s` (the quasi-steady
    /// envelope is ≥ 1 by construction).
    pub p2_ratio: f64,
    pub p2_rpm: f64,
    /// Best single fixed position inside the stroke (fail-safe length).
    pub failsafe_mm: f64,
    pub failsafe_gain: f64,
    /// Actuator speed the quasi-steady map needs at `sweep_rate_rpm_s`.
    pub required_speed_mm_s: f64,
    /// Speed an actuator meeting F2 provides: stroke / full_stroke_time.
    pub available_speed_mm_s: f64,
    /// Largest jump of the quasi-steady optimum between adjacent rpm
    /// points (mm) — a second tuning order taking over.
    pub max_map_jump_mm: f64,
    pub mass_kg: f64,
    pub protrusion_mm: f64,
    pub feasible_mass: bool,
    pub feasible_packaging: bool,
}

/// Position schedule over the rpm grid.
#[derive(Debug, Clone, Serialize)]
pub struct Schedule {
    pub rpm: Vec<f64>,
    pub quasi_steady_mm: Vec<f64>,
    pub rate_limited_mm: Vec<f64>,
    /// The ECU table: quasi-steady optimum quantised to F3.
    pub quantised_mm: Vec<f64>,
    /// Plate position chasing the table during an up-sweep.
    pub follow_mm: Vec<f64>,
}

/// Plate chasing a static rpm -> position table during an up-sweep at
/// `sweep_rpm_s`, moving at most `vmax_mm_s` toward the table value.
pub fn follow_table(rpm: &[f64], table: &[f64], vmax_mm_s: f64, sweep_rpm_s: f64) -> Vec<f64> {
    let mut p = Vec::with_capacity(table.len());
    let mut x = table[0];
    p.push(x);
    for j in 1..table.len() {
        let reach = vmax_mm_s * (rpm[j] - rpm[j - 1]) / sweep_rpm_s;
        let d = table[j] - x;
        x += d.clamp(-reach, reach);
        p.push(x);
    }
    p
}

fn positions(a: f64, stroke: f64, step: f64) -> Vec<f64> {
    if stroke <= 0.0 {
        return vec![a];
    }
    let n = (stroke / step).round().max(1.0) as usize;
    (0..=n).map(|i| a + stroke * i as f64 / n as f64).collect()
}

/// Quasi-steady optimum at every rpm: argmax over the stroke.
pub fn envelope(s: &Surface, a: f64, stroke: f64, step: f64) -> (Vec<f64>, Vec<f64>) {
    let ps = positions(a, stroke, step);
    let mut best_v = Vec::with_capacity(s.rpm.len());
    let mut best_p = Vec::with_capacity(s.rpm.len());
    for j in 0..s.rpm.len() {
        let (mut bv, mut bp) = (f64::NEG_INFINITY, ps[0]);
        for &p in &ps {
            let v = s.at(p, j);
            if v > bv + 1e-12 {
                bv = v;
                bp = p;
            }
        }
        best_v.push(bv);
        best_p.push(bp);
    }
    (best_v, best_p)
}

/// Rate-limited schedule by dynamic programming: maximise Σ_j w_j·T(p_j, j)
/// subject to |p_{j+1} − p_j| ≤ vmax·Δt_j, Δt_j = Δrpm / sweep_rate.
/// `w` weights every rpm point (use all-ones to follow the envelope).
pub fn rate_limited(
    s: &Surface, a: f64, stroke: f64, step: f64, vmax_mm_s: f64, sweep_rpm_s: f64, w: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let ps = positions(a, stroke, step);
    let np = ps.len();
    let nr = s.rpm.len();
    let val: Vec<Vec<f64>> = (0..nr).map(|j| ps.iter().map(|&p| s.at(p, j)).collect()).collect();
    let mut score = vec![vec![f64::NEG_INFINITY; np]; nr];
    let mut from = vec![vec![0usize; np]; nr];
    for i in 0..np {
        score[0][i] = w[0] * val[0][i];
    }
    for j in 1..nr {
        let dt = (s.rpm[j] - s.rpm[j - 1]) / sweep_rpm_s;
        let reach = vmax_mm_s * dt + 1e-9;
        for i in 0..np {
            let (mut bs, mut bi) = (f64::NEG_INFINITY, 0);
            for k in 0..np {
                if (ps[i] - ps[k]).abs() <= reach && score[j - 1][k] > bs {
                    bs = score[j - 1][k];
                    bi = k;
                }
            }
            score[j][i] = bs + w[j] * val[j][i];
            from[j][i] = bi;
        }
    }
    let mut idx = (0..np).max_by(|&x, &y| score[nr - 1][x].total_cmp(&score[nr - 1][y])).unwrap();
    let mut path = vec![0.0; nr];
    let mut vals = vec![0.0; nr];
    for j in (0..nr).rev() {
        path[j] = ps[idx];
        vals[j] = val[j][idx];
        if j > 0 {
            idx = from[j][idx];
        }
    }
    (vals, path)
}

/// Evaluate one telescoping design `[a, a + stroke]` on the surface.
pub fn evaluate(s: &Surface, spec: &DesignSpec, a: f64, stroke: f64) -> (DesignResult, Schedule) {
    let nr = s.rpm.len();
    let wb = s.band_weights(spec.band.0, spec.band.1);
    let wd = s.band_weights(spec.driver_band.0, spec.driver_band.1);
    let base: Vec<f64> = (0..nr).map(|j| s.at(spec.baseline_ext_mm, j)).collect();
    let base_band = Surface::mean(&base, &wb);
    let base_drv = Surface::mean(&base, &wd);

    let (env_v, env_p) = envelope(s, a, stroke, spec.position_step_mm);
    let vmax = if stroke > 0.0 { stroke / spec.full_stroke_time_s } else { 0.0 };
    let ones = vec![1.0; nr];
    let (rl_v, rl_p) = rate_limited(s, a, stroke, spec.position_step_mm, vmax, spec.sweep_rate_rpm_s, &ones);
    let q = spec.f3_resolution_mm.max(1e-9);
    let qp: Vec<f64> = env_p.iter().map(|&p| (a + ((p - a) / q).round() * q).clamp(a, a + stroke)).collect();
    let q_v: Vec<f64> = (0..nr).map(|j| s.at(qp[j], j)).collect();
    let fp = follow_table(&s.rpm, &qp, vmax, spec.sweep_rate_rpm_s);
    let f_v: Vec<f64> = (0..nr).map(|j| s.at(fp[j], j)).collect();

    // P2 against this design's own fixed ends, over the band.
    let (mut p2, mut p2_rpm) = (f64::INFINITY, f64::NAN);
    for j in 0..nr {
        if wb[j] > 0.0 {
            let ends = s.at(a, j).max(s.at(a + stroke, j));
            let r = f_v[j] / ends;
            if r < p2 {
                p2 = r;
                p2_rpm = s.rpm[j];
            }
        }
    }
    // Fail-safe: the best fixed position within the stroke.
    let (mut fs_p, mut fs_v) = (a, f64::NEG_INFINITY);
    for p in positions(a, stroke, spec.position_step_mm) {
        let col: Vec<f64> = (0..nr).map(|j| s.at(p, j)).collect();
        let m = Surface::mean(&col, &wb);
        if m > fs_v {
            fs_v = m;
            fs_p = p;
        }
    }
    // Actuator speed the quasi-steady map needs, band only.
    let (mut req, mut jump) = (0.0f64, 0.0f64);
    for j in 1..nr {
        if wb[j] > 0.0 || wb[j - 1] > 0.0 {
            let dp = (env_p[j] - env_p[j - 1]).abs();
            let dt = (s.rpm[j] - s.rpm[j - 1]) / spec.sweep_rate_rpm_s;
            req = req.max(dp / dt);
            jump = jump.max(dp);
        }
    }
    let mass = spec.mass.mass(stroke);
    let protrusion = (a + stroke - spec.displacement_ref_mm).max(0.0);
    let r = DesignResult {
        stroke_mm: stroke,
        lmin_mm: a,
        lmax_mm: a + stroke,
        p1_gain: Surface::mean(&env_v, &wb) / base_band - 1.0,
        p1_gain_rate_limited: Surface::mean(&rl_v, &wb) / base_band - 1.0,
        p1_gain_quantised: Surface::mean(&q_v, &wb) / base_band - 1.0,
        p1_gain_follow: Surface::mean(&f_v, &wb) / base_band - 1.0,
        driver_gain: Surface::mean(&env_v, &wd) / base_drv - 1.0,
        p2_ratio: p2,
        p2_rpm,
        failsafe_mm: fs_p,
        failsafe_gain: fs_v / base_band - 1.0,
        required_speed_mm_s: req,
        available_speed_mm_s: vmax,
        max_map_jump_mm: jump,
        mass_kg: mass,
        protrusion_mm: protrusion,
        feasible_mass: mass <= spec.mass.limit_kg + 1e-12,
        feasible_packaging: protrusion <= spec.max_protrusion_mm + 1e-9,
    };
    let sched = Schedule { rpm: s.rpm.clone(), quasi_steady_mm: env_p, rate_limited_mm: rl_p, quantised_mm: qp, follow_mm: fp };
    (r, sched)
}

/// For one stroke, the placement `a` (retracted position) maximising P1
/// over `[e_lo, e_hi − stroke]` in `placement_step` increments. Ties go to
/// the higher driver-band gain. Returns every evaluation too.
pub fn best_placement(
    s: &Surface, spec: &DesignSpec, stroke: f64, e_lo: f64, e_hi: f64, placement_step: f64,
) -> Option<(DesignResult, Vec<DesignResult>)> {
    if stroke > e_hi - e_lo + 1e-9 {
        return None;
    }
    let n = ((e_hi - stroke - e_lo) / placement_step).floor() as usize;
    let mut all = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let a = e_lo + i as f64 * placement_step;
        all.push(evaluate(s, spec, a, stroke).0);
    }
    let best = all
        .iter()
        .filter(|r| r.feasible_packaging)
        .max_by(|x, y| {
            (x.p1_gain, x.driver_gain).partial_cmp(&(y.p1_gain, y.driver_gain)).unwrap()
        })?
        .clone();
    Some((best, all))
}

/// Recommendation over the per-stroke optima: the best feasible design
/// (mass + packaging) and the "knee" — the smallest feasible moving design
/// that reaches `knee_fraction` of the best feasible *variable-length
/// increment*, measured over the best fixed runner (stroke 0, if present;
/// otherwise over the fixed baseline, gain 0). A re-optimised fixed runner
/// already captures part of the gain, so the knee is judged on what the
/// moving mechanism adds.
pub fn recommend(per_stroke: &[DesignResult], knee_fraction: f64) -> (Option<DesignResult>, Option<DesignResult>) {
    let feas: Vec<&DesignResult> = per_stroke.iter().filter(|r| r.feasible_mass && r.feasible_packaging).collect();
    let best = feas.iter().max_by(|a, b| a.p1_gain.total_cmp(&b.p1_gain)).map(|r| (*r).clone());
    let fixed = per_stroke.iter().find(|r| r.stroke_mm == 0.0).map(|r| r.p1_gain).unwrap_or(0.0);
    let knee = best.as_ref().and_then(|b| {
        let target = fixed + knee_fraction * (b.p1_gain - fixed);
        feas.iter()
            .filter(|r| r.stroke_mm > 0.0 && r.p1_gain >= target - 1e-12)
            .min_by(|a, c| a.stroke_mm.total_cmp(&c.stroke_mm))
            .map(|r| (*r).clone())
    });
    (best, knee)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic "tuned runner" surface: torque peaks where the runner is
    /// tuned for the rpm, tuned extension e*(rpm) = c/rpm − L0 (quarter-wave:
    /// length ∝ 1/rpm), Gaussian in length mismatch.
    fn tuned_surface(width_mm: f64) -> Surface {
        let ext: Vec<f64> = (-8..=20).map(|i| i as f64 * 10.0).collect();
        let rpm: Vec<f64> = (0..=26).map(|i| 6000.0 + i as f64 * 250.0).collect();
        let tuned = |r: f64| 330.0 * 9000.0 / r - 300.0; // 30 mm at 9k, 195 at 6k, −52 at 12.5k
        let val = ext
            .iter()
            .map(|&e| rpm.iter().map(|&r| 50.0 + 5.0 * (-((e - tuned(r)) / width_mm).powi(2)).exp()).collect())
            .collect();
        Surface { ext_mm: ext, rpm, val }
    }

    fn spec() -> DesignSpec {
        DesignSpec {
            band: (6000.0, 12000.0),
            driver_band: (7000.0, 10500.0),
            baseline_ext_mm: 0.0,
            position_step_mm: 1.0,
            f3_resolution_mm: 2.0,
            sweep_rate_rpm_s: 6000.0,
            full_stroke_time_s: 0.5,
            mass: MassModel::default(),
            max_protrusion_mm: 1000.0,
            displacement_ref_mm: 0.0,
        }
    }

    #[test]
    fn interpolation_hits_grid_points_and_is_smooth() {
        let s = tuned_surface(60.0);
        for k in 0..s.ext_mm.len() {
            for j in [0usize, 7, 26] {
                assert!((s.at(s.ext_mm[k], j) - s.val[k][j]).abs() < 1e-12);
            }
        }
        // between grid points it tracks the analytic function closely
        let f = |e: f64, r: f64| 50.0 + 5.0 * (-((e - (330.0 * 9000.0 / r - 300.0)) / 60.0).powi(2)).exp();
        for e in [-33.0, 4.0, 57.5, 121.0] {
            assert!((s.at(e, 12) - f(e, s.rpm[12])).abs() < 0.05, "{e}");
        }
    }

    #[test]
    fn band_weights_are_the_trapezoid_rule() {
        let s = tuned_surface(60.0);
        let w = s.band_weights(6000.0, 12000.0);
        assert!((w.iter().sum::<f64>() - 6000.0).abs() < 1e-9);
        assert_eq!(w[0], 125.0);
        assert_eq!(w[24], 125.0);
        assert_eq!(w[25], 0.0);
        let lin: Vec<f64> = s.rpm.iter().map(|r| r / 1000.0).collect();
        assert!((Surface::mean(&lin, &w) - 9.0).abs() < 1e-12);
    }

    #[test]
    fn envelope_follows_the_tuned_length_and_is_never_below_its_ends() {
        let s = tuned_surface(60.0);
        let (v, p) = envelope(&s, -80.0, 280.0, 1.0);
        for j in 0..s.rpm.len() {
            let tuned = 330.0 * 9000.0 / s.rpm[j] - 300.0;
            if (-80.0..=200.0).contains(&tuned) {
                // Catmull-Rom on a 10 mm grid: optimum within ~3 mm (F3 is ±2 mm)
                assert!((p[j] - tuned).abs() <= 3.0, "rpm {} p {} tuned {}", s.rpm[j], p[j], tuned);
            }
            assert!(v[j] >= s.at(-80.0, j).max(s.at(200.0, j)) - 1e-9);
        }
    }

    #[test]
    fn zero_stroke_is_the_fixed_runner_and_gain_grows_with_stroke() {
        let s = tuned_surface(40.0);
        let sp = spec();
        let (r0, _) = evaluate(&s, &sp, 0.0, 0.0);
        assert!(r0.p1_gain.abs() < 1e-12 && r0.mass_kg == 0.0 && (r0.p2_ratio - 1.0).abs() < 1e-12);
        let mut last = 0.0;
        for stroke in [25.0, 50.0, 100.0, 150.0, 200.0] {
            let (b, _) = best_placement(&s, &sp, stroke, -80.0, 200.0, 5.0).unwrap();
            assert!(b.p1_gain >= last - 1e-9, "stroke {stroke}: {} < {last}", b.p1_gain);
            last = b.p1_gain;
            assert!(b.p1_gain_rate_limited <= b.p1_gain + 1e-12);
            assert!(b.p1_gain_quantised <= b.p1_gain + 1e-12);
            assert!(b.p1_gain_follow <= b.p1_gain_rate_limited + 0.01);
        }
    }

    #[test]
    fn rate_limit_binds_when_the_actuator_is_slow() {
        let s = tuned_surface(40.0);
        let mut sp = spec();
        let (fast, _) = evaluate(&s, &sp, -50.0, 200.0);
        sp.full_stroke_time_s = 20.0; // 10 mm/s: can barely move during a sweep
        let (slow, sched) = evaluate(&s, &sp, -50.0, 200.0);
        assert!(slow.p1_gain_rate_limited < fast.p1_gain_rate_limited - 1e-3);
        for j in 1..sched.rpm.len() {
            let dt = (sched.rpm[j] - sched.rpm[j - 1]) / sp.sweep_rate_rpm_s;
            assert!((sched.rate_limited_mm[j] - sched.rate_limited_mm[j - 1]).abs() <= 10.0 * dt + 1.0 + 1e-9);
        }
        // the quasi-steady envelope ignores the actuator
        assert!((slow.p1_gain - fast.p1_gain).abs() < 1e-12);
    }

    #[test]
    fn follow_table_is_rate_limited_and_catches_up() {
        let rpm: Vec<f64> = (0..9).map(|i| 6000.0 + 250.0 * i as f64).collect();
        let table = vec![0.0, 0.0, 100.0, 100.0, 100.0, 100.0, 100.0, 0.0, 0.0];
        // 100 mm/s at 6000 rpm/s: 250 rpm = 41.7 ms -> 4.17 mm per step
        let p = follow_table(&rpm, &table, 100.0, 6000.0);
        assert!((p[2] - 100.0 / 24.0).abs() < 1e-9);
        let fast = follow_table(&rpm, &table, 1e6, 6000.0);
        assert_eq!(fast, table);
    }

    #[test]
    fn mass_model_matches_the_cdr_estimate() {
        let m = MassModel::default();
        assert!((m.mass(100.0) - 1.02).abs() < 1e-12);
        assert_eq!(m.mass(0.0), 0.0);
        assert!(m.mass(150.0) > m.mass(100.0));
    }

    #[test]
    fn recommendation_picks_best_feasible_and_knee() {
        let mk = |s: f64, g: f64, m: f64| DesignResult {
            stroke_mm: s, lmin_mm: 0.0, lmax_mm: s, p1_gain: g, p1_gain_rate_limited: g, p1_gain_quantised: g, p1_gain_follow: g,
            driver_gain: g, p2_ratio: 1.0, p2_rpm: 0.0, failsafe_mm: 0.0, failsafe_gain: 0.0,
            required_speed_mm_s: 0.0, available_speed_mm_s: 0.0, max_map_jump_mm: 0.0, mass_kg: m,
            protrusion_mm: 0.0, feasible_mass: m <= 1.5, feasible_packaging: true,
        };
        let v = vec![mk(0.0, 0.0, 0.0), mk(50.0, 0.03, 0.8), mk(100.0, 0.05, 1.0), mk(150.0, 0.052, 1.3), mk(200.0, 0.06, 1.6)];
        let (best, knee) = recommend(&v, 0.9);
        assert_eq!(best.unwrap().stroke_mm, 150.0); // 200 is over mass
        assert_eq!(knee.unwrap().stroke_mm, 100.0); // 0.05 ≥ 0.9 × 0.052
        // the knee is judged on the increment over the best fixed runner
        let v = vec![mk(0.0, 0.040, 0.0), mk(50.0, 0.045, 0.8), mk(100.0, 0.058, 1.0), mk(150.0, 0.060, 1.3)];
        let (_, knee) = recommend(&v, 0.9);
        assert_eq!(knee.unwrap().stroke_mm, 100.0); // 0.058 ≥ 0.040 + 0.9 × 0.020; 50 mm is not
    }
}
