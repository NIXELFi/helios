//! Latin Hypercube + uniform random samplers in normalized [0, 1) space.
//!
//! The runner maps these to physical bounds via `optimization::bounds`.

use crate::dto::SamplerKind;
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};

/// Returns an `[n_trials × n_params]` matrix where each cell ∈ [0, 1).
pub fn sample(
    kind: SamplerKind,
    n_trials: usize,
    n_params: usize,
    seed: Option<u64>,
) -> Vec<Vec<f64>> {
    let mut rng = match seed {
        Some(s) => StdRng::seed_from_u64(s),
        None => StdRng::from_entropy(),
    };
    match kind {
        SamplerKind::Random => random_uniform(&mut rng, n_trials, n_params),
        SamplerKind::Lhs => latin_hypercube(&mut rng, n_trials, n_params),
    }
}

fn random_uniform(rng: &mut StdRng, n_trials: usize, n_params: usize) -> Vec<Vec<f64>> {
    (0..n_trials)
        .map(|_| (0..n_params).map(|_| rng.gen::<f64>()).collect())
        .collect()
}

/// Standard Latin Hypercube: for each parameter, produce a permutation
/// of `[0, 1/N, 2/N, ..., (N-1)/N]` with uniform random jitter inside
/// each stratum, independently per parameter.
fn latin_hypercube(rng: &mut StdRng, n_trials: usize, n_params: usize) -> Vec<Vec<f64>> {
    let mut out = vec![vec![0.0f64; n_params]; n_trials];
    if n_trials == 0 || n_params == 0 {
        return out;
    }
    let n = n_trials as f64;
    for p in 0..n_params {
        let mut col: Vec<f64> = (0..n_trials)
            .map(|i| (i as f64 + rng.gen::<f64>()) / n)
            .collect();
        col.shuffle(rng);
        for (i, v) in col.into_iter().enumerate() {
            out[i][p] = v;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lhs_cells_in_unit_range() {
        let m = sample(SamplerKind::Lhs, 32, 5, Some(42));
        for row in &m {
            for &v in row {
                assert!(v >= 0.0 && v < 1.0, "cell out of [0,1): {}", v);
            }
        }
    }

    #[test]
    fn lhs_stratification_one_per_bucket() {
        let n = 8;
        let m = sample(SamplerKind::Lhs, n, 3, Some(7));
        for p in 0..3 {
            let mut buckets = vec![0u32; n];
            for row in &m {
                let b = (row[p] * n as f64).floor() as usize;
                buckets[b.min(n - 1)] += 1;
            }
            assert!(
                buckets.iter().all(|&c| c == 1),
                "non-stratified column {}: {:?}",
                p,
                buckets
            );
        }
    }

    #[test]
    fn same_seed_reproducible() {
        let a = sample(SamplerKind::Lhs, 16, 4, Some(123));
        let b = sample(SamplerKind::Lhs, 16, 4, Some(123));
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_differ() {
        let a = sample(SamplerKind::Lhs, 16, 4, Some(1));
        let b = sample(SamplerKind::Lhs, 16, 4, Some(2));
        assert_ne!(a, b);
    }

    #[test]
    fn zero_params_returns_empty_rows() {
        let m = sample(SamplerKind::Lhs, 4, 0, Some(1));
        assert_eq!(m.len(), 4);
        assert!(m.iter().all(|r| r.is_empty()));
    }

    #[test]
    fn zero_trials_returns_empty() {
        let m = sample(SamplerKind::Lhs, 0, 3, Some(1));
        assert!(m.is_empty());
    }

    #[test]
    fn random_is_not_stratified() {
        // Sanity: random sampling will sometimes leave buckets empty for small N.
        let n = 100;
        let m = sample(SamplerKind::Random, n, 1, Some(99));
        let mut buckets = vec![0u32; n];
        for row in &m {
            let b = (row[0] * n as f64).floor() as usize;
            buckets[b.min(n - 1)] += 1;
        }
        assert!(
            buckets.iter().any(|&c| c == 0),
            "random unexpectedly stratified"
        );
    }

    #[test]
    fn random_reproducible_with_seed() {
        let a = sample(SamplerKind::Random, 32, 3, Some(7));
        let b = sample(SamplerKind::Random, 32, 3, Some(7));
        assert_eq!(a, b);
    }
}
