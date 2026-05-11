use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_us: i64,
    pub end_us: i64,
}

/// Error returned when a TimeRange would be constructed with an inverted span
/// (i.e. `end_us < start_us`). Surfaced at construction time so a bad range
/// never silently produces negative durations downstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvertedTimeRange {
    pub start_us: i64,
    pub end_us: i64,
}

impl std::fmt::Display for InvertedTimeRange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "TimeRange end ({}) must be >= start ({})",
            self.end_us, self.start_us,
        )
    }
}

impl std::error::Error for InvertedTimeRange {}

impl TimeRange {
    /// Construct a TimeRange, returning `Err` if `end_us < start_us`. The
    /// previous `debug_assert!` based constructor silently accepted inverted
    /// ranges in release builds and produced negative durations downstream;
    /// the audit (2026-05-11) flagged this as a latent correctness bug.
    pub fn new(start_us: i64, end_us: i64) -> Result<Self, InvertedTimeRange> {
        if end_us < start_us {
            return Err(InvertedTimeRange { start_us, end_us });
        }
        Ok(Self { start_us, end_us })
    }

    /// Infallible construction for the common in-crate case where the caller
    /// has already proven the range is valid (e.g. `intersect` after a
    /// `e > s` check, or test fixtures). Panics on inverted input.
    pub fn new_unchecked(start_us: i64, end_us: i64) -> Self {
        Self::new(start_us, end_us).expect("TimeRange::new_unchecked called with inverted range")
    }

    pub fn duration_us(&self) -> i64 { self.end_us - self.start_us }

    pub fn contains(&self, t_us: i64) -> bool {
        t_us >= self.start_us && t_us < self.end_us
    }

    pub fn intersect(&self, other: &TimeRange) -> Option<TimeRange> {
        let s = self.start_us.max(other.start_us);
        let e = self.end_us.min(other.end_us);
        // `e > s` proves the range is non-empty and well-ordered, so the
        // infallible constructor is appropriate here.
        if e > s { Some(TimeRange::new_unchecked(s, e)) } else { None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_basic() {
        assert_eq!(TimeRange::new(0, 1_000_000).unwrap().duration_us(), 1_000_000);
    }

    #[test]
    fn contains_is_half_open() {
        let r = TimeRange::new(0, 100).unwrap();
        assert!(r.contains(0));
        assert!(r.contains(99));
        assert!(!r.contains(100));
        assert!(!r.contains(-1));
    }

    #[test]
    fn intersect_overlap() {
        let a = TimeRange::new(0, 100).unwrap();
        let b = TimeRange::new(50, 200).unwrap();
        assert_eq!(a.intersect(&b), Some(TimeRange::new(50, 100).unwrap()));
    }

    #[test]
    fn intersect_disjoint() {
        let a = TimeRange::new(0, 100).unwrap();
        let b = TimeRange::new(100, 200).unwrap();
        assert_eq!(a.intersect(&b), None);
    }

    /// The audit (2026-05-11) flagged that the prior `debug_assert!`-based
    /// constructor accepted inverted ranges in release builds. Verify that
    /// the new constructor surfaces the bad input as an error in all builds.
    #[test]
    fn inverted_range_is_rejected() {
        let err = TimeRange::new(100, 50).unwrap_err();
        assert_eq!(err.start_us, 100);
        assert_eq!(err.end_us, 50);
    }

    #[test]
    fn zero_length_range_is_valid() {
        let r = TimeRange::new(42, 42).unwrap();
        assert_eq!(r.duration_us(), 0);
        assert!(!r.contains(42));
    }
}
