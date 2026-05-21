//! Crank-angle kinematics utilities. Direct port of `cylinder/kinematics.py`.

use std::collections::HashMap;
use std::f64::consts::PI;

/// Angular speed in rad/s.
#[inline]
pub fn omega_from_rpm(rpm: f64) -> f64 {
    2.0 * PI * rpm / 60.0
}

/// Map cylinder number (1-indexed per firing order) to crank offset in degrees.
/// Cylinder 1 is at offset 0; subsequent cylinders are offset by
/// `firing_interval * position_in_order`.
pub fn cylinder_phase_offsets(
    n_cyl: usize, firing_order: &[i32], firing_interval: f64,
) -> HashMap<i32, f64> {
    let mut offsets: HashMap<i32, f64> = HashMap::new();
    for (i, &cyl_num) in firing_order.iter().enumerate() {
        offsets.insert(cyl_num, (i as f64) * firing_interval);
    }
    if n_cyl != firing_order.len() {
        for c in 1..=(n_cyl as i32) {
            offsets.entry(c).or_insert(0.0);
        }
    }
    offsets
}
