//! Map normalized [0,1) samples to physical bounds, with optional
//! step-grid snapping.

use crate::dto::ParameterBounds;

/// Map a normalized [0,1) value to physical space and (optionally) snap
/// to a step grid. The snapped value is clamped to `[min, max]` so a
/// borderline `normalized = 0.999...` can't escape past max.
pub fn map_to_physical(b: &ParameterBounds, normalized: f64) -> f64 {
    let raw = b.min + (b.max - b.min) * normalized;
    match b.step {
        Some(step) if step > 0.0 => {
            let n = ((raw - b.min) / step).round();
            (b.min + n * step).clamp(b.min, b.max)
        }
        _ => raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(min: f64, max: f64, step: Option<f64>) -> ParameterBounds {
        ParameterBounds {
            path: "x".into(),
            min,
            max,
            step,
        }
    }

    #[test]
    fn continuous_endpoints() {
        let b = bounds(10.0, 20.0, None);
        assert!((map_to_physical(&b, 0.0) - 10.0).abs() < 1e-12);
        assert!((map_to_physical(&b, 0.5) - 15.0).abs() < 1e-12);
    }

    #[test]
    fn step_snaps_to_grid() {
        let b = bounds(0.0, 10.0, Some(2.0));
        // 0.0 -> 0.0
        assert_eq!(map_to_physical(&b, 0.0), 0.0);
        // 0.05 -> raw=0.5 -> n = round(0.25) = 0 -> 0.0
        assert_eq!(map_to_physical(&b, 0.05), 0.0);
        // 0.25 -> raw=2.5 -> n = round(1.25) = 1 -> 2.0
        assert_eq!(map_to_physical(&b, 0.25), 2.0);
        // 0.5 -> raw=5.0 -> n = round(2.5) = 3 (banker's rounding) -> ties
        //   but Rust f64::round rounds half-away-from-zero, so 2.5 -> 3.0
        //   -> 6.0
        // We don't pin this exact tie behavior; just assert it's on the grid.
        let v = map_to_physical(&b, 0.5);
        let on_grid = (v - 4.0).abs() < 1e-12 || (v - 6.0).abs() < 1e-12;
        assert!(on_grid, "expected on-grid 4.0 or 6.0, got {}", v);
    }

    #[test]
    fn step_clamps_to_max() {
        let b = bounds(0.0, 10.0, Some(3.0));
        let v = map_to_physical(&b, 0.999);
        // raw ≈ 9.99, n = round(3.33) = 3, value = 9.0 (≤ 10)
        assert!(v <= 10.0 + 1e-12);
        assert!((v - 9.0).abs() < 1e-12);
    }

    #[test]
    fn zero_step_treated_as_continuous() {
        let b = bounds(0.0, 10.0, Some(0.0));
        assert!((map_to_physical(&b, 0.5) - 5.0).abs() < 1e-12);
    }

    #[test]
    fn negative_step_treated_as_continuous() {
        let b = bounds(0.0, 10.0, Some(-1.0));
        assert!((map_to_physical(&b, 0.5) - 5.0).abs() < 1e-12);
    }

    #[test]
    fn map_at_zero_is_min() {
        let b = bounds(-5.0, 5.0, None);
        assert!((map_to_physical(&b, 0.0) - -5.0).abs() < 1e-12);
    }
}
