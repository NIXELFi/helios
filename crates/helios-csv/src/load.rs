use crate::{delimiter::detect_delimiter, registry::ChannelRegistry, time_detect::detect_time_unit, CsvLoadError};
use helios_core::{ChannelMeta, RateGroup};
use std::collections::BTreeMap;
use std::path::Path;

pub struct LoadResult {
    pub rate_groups: Vec<RateGroup>,
    pub warnings: Vec<String>,
    pub duration_us: i64,
}

impl std::fmt::Debug for LoadResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadResult")
            .field("rate_groups_count", &self.rate_groups.len())
            .field("warnings", &self.warnings)
            .field("duration_us", &self.duration_us)
            .finish()
    }
}

pub fn load_csv(path: &Path, registry: &ChannelRegistry) -> Result<LoadResult, CsvLoadError> {
    let bytes = std::fs::read(path)?;
    load_csv_bytes(&bytes, registry)
}

pub fn load_csv_bytes(bytes: &[u8], registry: &ChannelRegistry) -> Result<LoadResult, CsvLoadError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| CsvLoadError::Malformed(format!("non-utf8 input: {e}")))?;
    let first_line = text.lines().next()
        .ok_or_else(|| CsvLoadError::Malformed("empty file".into()))?;
    let delim = detect_delimiter(first_line);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .from_reader(bytes);

    let headers = rdr.headers()?.clone();
    if headers.is_empty() {
        return Err(CsvLoadError::Malformed("no headers".into()));
    }
    let time_header = &headers[0];

    // Read all rows into a Vec<Vec<Option<f64>>>; first column treated as time.
    let mut times_raw: Vec<f64> = Vec::new();
    let mut cols: Vec<Vec<Option<f64>>> = vec![Vec::new(); headers.len() - 1];
    for rec in rdr.records() {
        let rec = rec?;
        let t: f64 = rec[0].trim().parse()
            .map_err(|e| CsvLoadError::Malformed(format!("bad time `{}`: {e}", &rec[0])))?;
        times_raw.push(t);
        for (i, c) in cols.iter_mut().enumerate() {
            let s = rec.get(i + 1).unwrap_or("").trim();
            c.push(if s.is_empty() { None } else { s.parse().ok() });
        }
    }

    if times_raw.is_empty() {
        return Err(CsvLoadError::Malformed("no data rows".into()));
    }
    for w in times_raw.windows(2) {
        if w[1] < w[0] {
            return Err(CsvLoadError::Malformed("time column is not monotonically non-decreasing".into()));
        }
    }

    let unit = detect_time_unit(time_header, times_raw[0]);
    let times_us: Vec<i64> = times_raw.iter().copied().map(|v| unit.to_us(v)).collect();

    // Group columns by sample rate. A column's rate = nominal registry rate if known,
    // else inferred from non-None density.
    let mut warnings = Vec::new();
    let mut by_rate: BTreeMap<i32, Vec<(usize, ChannelMeta)>> = BTreeMap::new();
    let span_us = (*times_us.last().unwrap() - times_us[0]).max(1);
    let span_s = span_us as f64 / 1_000_000.0;

    for (i, name) in headers.iter().enumerate().skip(1) {
        let non_null = cols[i - 1].iter().filter(|x| x.is_some()).count();
        let inferred_rate = (non_null as f64 / span_s).round() as i32;
        let (mut meta, was_known) = registry.resolve_or_default(name, inferred_rate.max(1) as f32);
        if !was_known {
            warnings.push(format!("unknown channel `{name}`, registered with defaults"));
        } else {
            meta.sample_rate_hz = meta.sample_rate_hz.max(1.0);
        }
        let key = meta.sample_rate_hz.round() as i32;
        by_rate.entry(key).or_default().push((i - 1, meta));
    }

    let mut rate_groups = Vec::new();
    for (rate, entries) in by_rate {
        let mut keep_indices = Vec::new();
        for r in 0..times_us.len() {
            if entries.iter().any(|(ci, _)| cols[*ci][r].is_some()) {
                keep_indices.push(r);
            }
        }
        let rg_times: Vec<i64> = keep_indices.iter().map(|&r| times_us[r]).collect();
        let mut rg_cols: Vec<(ChannelMeta, Vec<f64>)> = Vec::new();
        for (ci, meta) in entries {
            let mut data = Vec::with_capacity(keep_indices.len());
            let mut last = f64::NAN;
            for &r in &keep_indices {
                if let Some(v) = cols[ci][r] { last = v; data.push(v); }
                else { data.push(last); }
            }
            rg_cols.push((meta, data));
        }
        rate_groups.push(RateGroup::build(format!("{rate}hz"), rate as f32, rg_times, rg_cols)?);
    }

    let duration_us = *times_us.last().unwrap() - times_us[0];
    Ok(LoadResult { rate_groups, warnings, duration_us })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn registry() -> ChannelRegistry {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/channels.yaml");
        ChannelRegistry::from_path(&p).unwrap()
    }

    fn fixture(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(rel)
    }

    #[test]
    fn loads_simple_100hz() {
        let r = load_csv(&fixture("good/simple_100hz.csv"), &registry()).unwrap();
        assert_eq!(r.rate_groups.len(), 1);
        let rg = &r.rate_groups[0];
        assert_eq!(rg.nominal_rate_hz, 100.0);
        assert_eq!(rg.channel_ids(), vec!["engine.rpm", "engine.tps"]);
        assert_eq!(rg.channel_data("engine.rpm").unwrap().value(0), 1000.0);
        assert_eq!(r.duration_us, 40_000);
    }

    #[test]
    fn loads_multi_rate() {
        let r = load_csv(&fixture("multi_rate/two_rates.csv"), &registry()).unwrap();
        assert_eq!(r.rate_groups.len(), 2);
        let rates: Vec<i32> = r.rate_groups.iter().map(|g| g.nominal_rate_hz as i32).collect();
        assert!(rates.contains(&100) && rates.contains(&10));
    }

    #[test]
    fn rejects_non_monotonic() {
        let err = load_csv(&fixture("malformed/non_monotonic.csv"), &registry()).unwrap_err();
        assert!(matches!(err, CsvLoadError::Malformed(_)));
    }

    #[test]
    fn missing_header_row_is_treated_as_data_failure() {
        let r = load_csv(&fixture("malformed/missing_header.csv"), &registry()).unwrap();
        assert!(!r.warnings.is_empty());
    }
}
