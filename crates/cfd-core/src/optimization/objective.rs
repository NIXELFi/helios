//! Objective evaluation: extract a CycleStats metric per RPM, then
//! reduce across the RPM list with the chosen aggregator.

use crate::dto::{ObjectiveAggregator, ObjectiveSpec, SweepPoint};
use engine_sim::model::sdm26::CycleStats;

#[derive(Debug, thiserror::Error)]
pub enum ObjectiveError {
    #[error("empty rpm_list — objective requires at least 1 rpm")]
    EmptyRpmList,
    #[error("no sweep points produced — cannot evaluate objective")]
    NoSweepPoints,
    #[error("unknown metric: {0} (must be a CycleStats field name)")]
    UnknownMetric(String),
    #[error("rpm {target} not present in sweep results")]
    RpmNotFound { target: f64 },
}

/// Extract a single CycleStats field by snake_case name.
fn extract(stats: &CycleStats, metric: &str) -> Result<f64, ObjectiveError> {
    Ok(match metric {
        "mass_total" => stats.mass_total,
        "mass_drift" => stats.mass_drift,
        "mass_in_restrictor" => stats.mass_in_restrictor,
        "mass_out_collector" => stats.mass_out_collector,
        "net_port_flow" => stats.net_port_flow,
        "nonconservation" => stats.nonconservation,
        "imep_bar" => stats.imep_bar,
        "bmep_bar" => stats.bmep_bar,
        "fmep_bar" => stats.fmep_bar,
        "ve_atm" => stats.ve_atm,
        "intake_mass_per_cycle_g" => stats.intake_mass_per_cycle_g,
        "f_residual" => stats.f_residual,
        "indicated_power_k_w" => stats.indicated_power_k_w,
        "indicated_power_hp" => stats.indicated_power_hp,
        "brake_power_k_w" => stats.brake_power_k_w,
        "brake_power_hp" => stats.brake_power_hp,
        "wheel_power_k_w" => stats.wheel_power_k_w,
        "wheel_power_hp" => stats.wheel_power_hp,
        "indicated_torque_nm" => stats.indicated_torque_nm,
        "brake_torque_nm" => stats.brake_torque_nm,
        "wheel_torque_nm" => stats.wheel_torque_nm,
        "egt_mean" => stats.egt_mean,
        m => return Err(ObjectiveError::UnknownMetric(m.to_string())),
    })
}

/// Evaluate the objective over a sweep's per-RPM `last_cycle` stats.
pub fn evaluate(spec: &ObjectiveSpec, sweep_points: &[SweepPoint]) -> Result<f64, ObjectiveError> {
    if spec.rpm_list.is_empty() {
        return Err(ObjectiveError::EmptyRpmList);
    }
    if sweep_points.is_empty() {
        return Err(ObjectiveError::NoSweepPoints);
    }

    // (rpm, metric_value) pairs sorted by rpm so AUC trapezoids are well-defined.
    let mut pairs: Vec<(f64, f64)> = sweep_points
        .iter()
        .map(|p| extract(&p.last_cycle, &spec.metric).map(|v| (p.rpm, v)))
        .collect::<Result<Vec<_>, _>>()?;
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    use ObjectiveAggregator::*;
    Ok(match spec.aggregator {
        Max => pairs.iter().map(|(_, v)| *v).fold(f64::NEG_INFINITY, f64::max),
        Min => pairs.iter().map(|(_, v)| *v).fold(f64::INFINITY, f64::min),
        Mean => {
            let sum: f64 = pairs.iter().map(|(_, v)| v).sum();
            sum / pairs.len() as f64
        }
        Sum => pairs.iter().map(|(_, v)| v).sum(),
        Auc => {
            // Trapezoidal integration over rpm axis.
            let mut acc = 0.0;
            for w in pairs.windows(2) {
                acc += 0.5 * (w[1].0 - w[0].0) * (w[0].1 + w[1].1);
            }
            acc
        }
        AtRpm { rpm_int } => {
            let target = rpm_int as f64;
            pairs
                .iter()
                .find(|(r, _)| (r - target).abs() < 0.5)
                .map(|(_, v)| *v)
                .ok_or(ObjectiveError::RpmNotFound { target })?
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ObjectiveDirection;

    /// Construct a zero-valued CycleStats with `imep_bar` (or whichever
    /// metric we test against) preset. CycleStats has no Default, so we
    /// build it field-by-field.
    fn make_stats(imep: f64) -> CycleStats {
        CycleStats {
            cycle: 1,
            mass_total: 0.0,
            mass_drift: 0.0,
            mass_in_restrictor: 0.0,
            mass_out_collector: 0.0,
            net_port_flow: 0.0,
            nonconservation: 0.0,
            imep_bar: imep,
            bmep_bar: 0.0,
            fmep_bar: 0.0,
            ve_atm: 0.0,
            intake_mass_per_cycle_g: 0.0,
            f_residual: 0.0,
            indicated_power_k_w: 0.0,
            indicated_power_hp: 0.0,
            brake_power_k_w: 0.0,
            brake_power_hp: 0.0,
            wheel_power_k_w: 0.0,
            wheel_power_hp: 0.0,
            indicated_torque_nm: 0.0,
            brake_torque_nm: 0.0,
            wheel_torque_nm: 0.0,
            egt_mean: 0.0,
        }
    }

    fn synth(rpm: f64, imep: f64) -> SweepPoint {
        SweepPoint {
            rpm,
            converged_cycle: 1,
            n_cycles_run: 1,
            last_cycle: make_stats(imep),
            nonconservation_max: 0.0,
            wall_time_s: 0.0,
            step_count: 0,
        }
    }

    fn spec_for(agg: ObjectiveAggregator) -> ObjectiveSpec {
        ObjectiveSpec {
            metric: "imep_bar".into(),
            aggregator: agg,
            rpm_list: vec![4000.0, 6000.0, 8000.0],
            direction: ObjectiveDirection::Maximize,
        }
    }

    #[test]
    fn max_picks_highest() {
        let pts = vec![synth(4000.0, 5.0), synth(6000.0, 9.0), synth(8000.0, 7.0)];
        assert_eq!(evaluate(&spec_for(ObjectiveAggregator::Max), &pts).unwrap(), 9.0);
    }

    #[test]
    fn min_picks_lowest() {
        let pts = vec![synth(4000.0, 5.0), synth(6000.0, 9.0), synth(8000.0, 7.0)];
        assert_eq!(evaluate(&spec_for(ObjectiveAggregator::Min), &pts).unwrap(), 5.0);
    }

    #[test]
    fn mean_averages() {
        let pts = vec![synth(4000.0, 6.0), synth(6000.0, 6.0), synth(8000.0, 12.0)];
        assert_eq!(evaluate(&spec_for(ObjectiveAggregator::Mean), &pts).unwrap(), 8.0);
    }

    #[test]
    fn sum_sums() {
        let pts = vec![synth(4000.0, 1.5), synth(6000.0, 2.5)];
        assert_eq!(evaluate(&spec_for(ObjectiveAggregator::Sum), &pts).unwrap(), 4.0);
    }

    #[test]
    fn auc_trapezoidal() {
        let pts = vec![synth(4000.0, 0.0), synth(6000.0, 10.0)];
        // ½ · 2000 · (0 + 10) = 10_000
        assert_eq!(evaluate(&spec_for(ObjectiveAggregator::Auc), &pts).unwrap(), 10_000.0);
    }

    #[test]
    fn auc_sorts_pairs_before_integrating() {
        // Inputs reversed; AUC must sort to give a non-negative trapezoid.
        // After sort: (4000, 0), (8000, 10) -> ½ · 4000 · (0 + 10) = 20_000.
        let pts = vec![synth(8000.0, 10.0), synth(4000.0, 0.0)];
        let v = evaluate(&spec_for(ObjectiveAggregator::Auc), &pts).unwrap();
        assert_eq!(v, 20_000.0);
    }

    #[test]
    fn at_rpm_finds_exact() {
        let pts = vec![synth(4000.0, 5.0), synth(6000.0, 9.0), synth(8000.0, 7.0)];
        let v = evaluate(
            &spec_for(ObjectiveAggregator::AtRpm { rpm_int: 6000 }),
            &pts,
        )
        .unwrap();
        assert_eq!(v, 9.0);
    }

    #[test]
    fn at_rpm_missing_errors() {
        let pts = vec![synth(4000.0, 5.0)];
        let err = evaluate(
            &spec_for(ObjectiveAggregator::AtRpm { rpm_int: 6000 }),
            &pts,
        )
        .unwrap_err();
        assert!(matches!(err, ObjectiveError::RpmNotFound { .. }));
    }

    #[test]
    fn unknown_metric_errors() {
        let pts = vec![synth(4000.0, 5.0)];
        let mut s = spec_for(ObjectiveAggregator::Max);
        s.metric = "not_a_field".into();
        let err = evaluate(&s, &pts).unwrap_err();
        assert!(matches!(err, ObjectiveError::UnknownMetric(_)));
    }

    #[test]
    fn empty_rpm_list_errors() {
        let pts = vec![synth(4000.0, 5.0)];
        let mut s = spec_for(ObjectiveAggregator::Max);
        s.rpm_list = vec![];
        let err = evaluate(&s, &pts).unwrap_err();
        assert!(matches!(err, ObjectiveError::EmptyRpmList));
    }

    #[test]
    fn empty_sweep_points_errors() {
        let s = spec_for(ObjectiveAggregator::Max);
        let err = evaluate(&s, &[]).unwrap_err();
        assert!(matches!(err, ObjectiveError::NoSweepPoints));
    }

    #[test]
    fn covers_all_22_metric_fields() {
        // Run extract over every documented metric name; none should
        // error (UnknownMetric is the failure mode).
        let stats = make_stats(0.0);
        for m in [
            "mass_total",
            "mass_drift",
            "mass_in_restrictor",
            "mass_out_collector",
            "net_port_flow",
            "nonconservation",
            "imep_bar",
            "bmep_bar",
            "fmep_bar",
            "ve_atm",
            "intake_mass_per_cycle_g",
            "f_residual",
            "indicated_power_k_w",
            "indicated_power_hp",
            "brake_power_k_w",
            "brake_power_hp",
            "wheel_power_k_w",
            "wheel_power_hp",
            "indicated_torque_nm",
            "brake_torque_nm",
            "wheel_torque_nm",
            "egt_mean",
        ] {
            extract(&stats, m).unwrap_or_else(|e| panic!("extract({}) failed: {}", m, e));
        }
    }
}
