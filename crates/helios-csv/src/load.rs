use crate::{delimiter::detect_delimiter, registry::ChannelRegistry, time_detect::detect_time_unit, CsvLoadError};
use helios_core::{ChannelMeta, RateGroup};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
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
    let raw = std::str::from_utf8(bytes)
        .map_err(|e| CsvLoadError::Malformed(format!("non-utf8 input: {e}")))?;
    let text = preprocess_motec_if_needed(raw);
    let first_line = text.lines().next()
        .ok_or_else(|| CsvLoadError::Malformed("empty file".into()))?;
    let delim = detect_delimiter(first_line);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .from_reader(text.as_bytes());

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

/// MoTeC-style CSV files start with ~12 lines of metadata, then a quoted
/// channel-names row, then a units row, then blanks, then data. The standard
/// `csv` crate handles quoted values fine, but the metadata block must be
/// stripped first. Detection is keyed off the literal `"Format","MoTeC` prefix
/// so non-MoTeC files pass through untouched.
fn preprocess_motec_if_needed(text: &str) -> Cow<'_, str> {
    let first = text.lines().next().unwrap_or("");
    if !(first.starts_with("\"Format\"") && first.contains("MoTeC")) {
        return Cow::Borrowed(text);
    }
    let lines: Vec<&str> = text.lines().collect();

    // Header row = first row whose first cell is exactly "Time". Earlier
    // metadata rows also start with quoted strings, so we use cell equality.
    let header_idx = lines.iter().position(|l| {
        first_csv_cell(l).map(|c| c == "Time").unwrap_or(false)
    });
    let Some(hi) = header_idx else { return Cow::Borrowed(text); };

    // Skip past the header itself, the units row, and any blank rows until
    // we land on a data row (first cell parses as a float).
    let mut data_start = hi + 1;
    while data_start < lines.len() {
        let trimmed = lines[data_start].trim();
        if trimmed.is_empty() { data_start += 1; continue; }
        let first_cell = first_csv_cell(lines[data_start]).unwrap_or("");
        if first_cell.parse::<f64>().is_ok() { break; }
        data_start += 1; // units row, "Beacon Markers", etc.
    }

    // Rebuild header with deduplicated column names. MoTeC files reuse "Time"
    // for both relative-seconds and absolute-minute clocks; the second copy
    // would otherwise collide in the channel id map.
    let header_unique = dedupe_csv_header(lines[hi]);

    let mut out = String::with_capacity(text.len());
    out.push_str(&header_unique);
    out.push('\n');
    for l in &lines[data_start..] {
        out.push_str(l);
        out.push('\n');
    }
    Cow::Owned(out)
}

fn first_csv_cell(line: &str) -> Option<&str> {
    let line = line.trim_start();
    if let Some(rest) = line.strip_prefix('"') {
        let end = rest.find('"')?;
        Some(&rest[..end])
    } else {
        Some(line.split(',').next()?.trim())
    }
}

fn dedupe_csv_header(line: &str) -> String {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(line.as_bytes());
    let mut record = csv::StringRecord::new();
    if rdr.read_record(&mut record).is_err() {
        return line.to_string();
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<String> = Vec::with_capacity(record.len());
    for cell in record.iter() {
        let base = cell.to_string();
        let c = counts.entry(base.clone()).or_insert(0);
        let name = if *c == 0 { base.clone() } else { format!("{base}_{c}") };
        *c += 1;
        out.push(name);
    }
    let mut wtr = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());
    let _ = wtr.write_record(&out);
    let bytes = wtr.into_inner().unwrap_or_default();
    String::from_utf8(bytes).unwrap_or_default().trim_end().to_string()
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

    #[test]
    fn loads_motec_format_via_aliases() {
        let r = load_csv(&fixture("good/motec_minimal.csv"), &registry()).unwrap();
        // Both "Engine Speed" and "Throttle Position" should resolve via aliases.
        let mut rpm_value: Option<f64> = None;
        let mut saw_tps = false;
        for rg in &r.rate_groups {
            if rg.meta("engine.rpm").is_some() {
                rpm_value = Some(rg.channel_data("engine.rpm").unwrap().value(0));
            }
            if rg.meta("engine.tps").is_some() {
                saw_tps = true;
            }
        }
        assert_eq!(rpm_value, Some(1000.0), "engine.rpm not loaded");
        assert!(saw_tps, "engine.tps not loaded");
        assert_eq!(r.duration_us, 40_000);
    }

    #[test]
    fn sample_session_loads() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/sdm26-synthetic-lap.csv");
        let r = load_csv(&path, &registry()).unwrap();
        assert!(r.rate_groups.len() >= 2, "expected at least 100Hz and 10Hz groups");
        assert!(r.duration_us > 89_000_000 && r.duration_us < 91_000_000);
        let has_rpm = r.rate_groups.iter().any(|g| g.meta("engine.rpm").is_some());
        assert!(has_rpm, "engine.rpm missing from sample load");
    }
}
