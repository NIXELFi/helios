use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_us: i64,
    pub end_us: i64,
}

impl TimeRange {
    pub fn new(start_us: i64, end_us: i64) -> Self {
        debug_assert!(end_us >= start_us, "TimeRange end must be >= start");
        Self { start_us, end_us }
    }

    pub fn duration_us(&self) -> i64 { self.end_us - self.start_us }

    pub fn contains(&self, t_us: i64) -> bool {
        t_us >= self.start_us && t_us < self.end_us
    }

    pub fn intersect(&self, other: &TimeRange) -> Option<TimeRange> {
        let s = self.start_us.max(other.start_us);
        let e = self.end_us.min(other.end_us);
        if e > s { Some(TimeRange::new(s, e)) } else { None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_basic() {
        assert_eq!(TimeRange::new(0, 1_000_000).duration_us(), 1_000_000);
    }

    #[test]
    fn contains_is_half_open() {
        let r = TimeRange::new(0, 100);
        assert!(r.contains(0));
        assert!(r.contains(99));
        assert!(!r.contains(100));
        assert!(!r.contains(-1));
    }

    #[test]
    fn intersect_overlap() {
        let a = TimeRange::new(0, 100);
        let b = TimeRange::new(50, 200);
        assert_eq!(a.intersect(&b), Some(TimeRange::new(50, 100)));
    }

    #[test]
    fn intersect_disjoint() {
        let a = TimeRange::new(0, 100);
        let b = TimeRange::new(100, 200);
        assert_eq!(a.intersect(&b), None);
    }
}
