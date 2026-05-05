#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeUnit {
    Seconds,
    Milliseconds,
    Microseconds,
}

impl TimeUnit {
    pub fn to_us(self, v: f64) -> i64 {
        match self {
            TimeUnit::Seconds => (v * 1_000_000.0).round() as i64,
            TimeUnit::Milliseconds => (v * 1_000.0).round() as i64,
            TimeUnit::Microseconds => v.round() as i64,
        }
    }
}

/// Detect time unit from header name + first sample value.
/// Header suffix takes priority; otherwise infer from magnitude.
pub fn detect_time_unit(header: &str, first_value: f64) -> TimeUnit {
    let lower = header.to_lowercase();
    if lower.ends_with("_us") || lower == "time_us" {
        return TimeUnit::Microseconds;
    }
    if lower.ends_with("_ms") || lower == "time_ms" {
        return TimeUnit::Milliseconds;
    }
    if lower.ends_with("_s") || lower == "time_s" || lower == "time" || lower == "t" {
        return TimeUnit::Seconds;
    }
    if first_value > 1e8 {
        TimeUnit::Microseconds
    } else if first_value > 1e4 {
        TimeUnit::Milliseconds
    } else {
        TimeUnit::Seconds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_from_header() {
        assert_eq!(detect_time_unit("time_s", 0.0), TimeUnit::Seconds);
    }
    #[test]
    fn ms_from_header() {
        assert_eq!(detect_time_unit("time_ms", 0.0), TimeUnit::Milliseconds);
    }
    #[test]
    fn us_from_header() {
        assert_eq!(detect_time_unit("time_us", 0.0), TimeUnit::Microseconds);
    }
    #[test]
    fn time_alias() {
        assert_eq!(detect_time_unit("time", 0.0), TimeUnit::Seconds);
    }
    #[test]
    fn t_alias() {
        assert_eq!(detect_time_unit("t", 0.0), TimeUnit::Seconds);
    }

    #[test]
    fn fallback_seconds() {
        assert_eq!(detect_time_unit("foo", 12.5), TimeUnit::Seconds);
    }
    #[test]
    fn fallback_ms() {
        assert_eq!(detect_time_unit("foo", 12_500.0), TimeUnit::Milliseconds);
    }
    #[test]
    fn fallback_us() {
        assert_eq!(detect_time_unit("foo", 12_500_000_000.0), TimeUnit::Microseconds);
    }

    #[test]
    fn convert_seconds() {
        assert_eq!(TimeUnit::Seconds.to_us(1.5), 1_500_000);
    }
    #[test]
    fn convert_ms() {
        assert_eq!(TimeUnit::Milliseconds.to_us(1.5), 1_500);
    }
    #[test]
    fn convert_us() {
        assert_eq!(TimeUnit::Microseconds.to_us(1.5), 2);
    }
}
