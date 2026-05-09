use crate::{delimiter::detect_delimiter, registry::{ChannelRegistry, ResolveKind}, time_detect::detect_time_unit, CsvLoadError};
use helios_core::{ChannelMeta, RateGroup};
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
    let prepared = prepare_csv_input(raw);
    let first_line = prepared.text.lines().next()
        .ok_or_else(|| CsvLoadError::Malformed("empty file".into()))?;
    let delim = detect_delimiter(first_line);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .from_reader(prepared.text.as_bytes());

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
    // Track which canonical ids have already been claimed by an earlier
    // column, across all rate groups. Without this, two source headers that
    // both resolve to the same id (e.g. `TPS (Main)` and `TPS (Sub)` both
    // mapped to `engine.tps`) collide inside RateGroup's HashMap — only the
    // last column would be reachable, and any widget asking for that id
    // would get whichever column was loaded last. We keep the FIRST one
    // mapped to the canonical id and demote subsequent collisions back to
    // their raw header name so all columns stay reachable.
    let mut claimed_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let span_us = (*times_us.last().unwrap() - times_us[0]).max(1);
    let span_s = span_us as f64 / 1_000_000.0;

    for (i, name) in headers.iter().enumerate().skip(1) {
        let non_null = cols[i - 1].iter().filter(|x| x.is_some()).count();
        let inferred_rate = (non_null as f64 / span_s).round() as i32;
        let unit_hint = prepared.units.get(i).map(String::as_str).unwrap_or("");
        let res = registry.resolve_or_default(name, unit_hint, inferred_rate.max(1) as f32);
        let mut meta = res.meta;
        match res.kind {
            ResolveKind::ExactAlias => { meta.sample_rate_hz = meta.sample_rate_hz.max(1.0); }
            ResolveKind::Semantic => {
                meta.sample_rate_hz = meta.sample_rate_hz.max(1.0);
                warnings.push(format!(
                    "channel `{name}` semantic-mapped to `{}` ({})",
                    meta.id, meta.display_name,
                ));
            }
            ResolveKind::Default => {
                warnings.push(format!("unknown channel `{name}`, registered with defaults"));
            }
        }
        if claimed_ids.contains(&meta.id) && meta.id != *name {
            // Two columns wanted the same canonical id. Keep the earlier
            // mapping; the later column reverts to its raw header so
            // downstream consumers can still reach it.
            warnings.push(format!(
                "channel `{name}` resolved to `{}` but that id was already claimed by an earlier column; \
                 storing as `{name}` instead so both remain reachable",
                meta.id,
            ));
            meta.id = name.to_string();
            meta.display_name = name.to_string();
        }
        claimed_ids.insert(meta.id.clone());
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

/// Output of the preamble-stripping pass: the cleaned text the CSV reader
/// will consume, plus the per-column unit row (when the source had one). The
/// units list is parallel to the header row, so `units[i]` is the unit string
/// for `headers[i]`. An empty string means "unit unknown" (no units row, or a
/// blank cell in the source's units row).
struct CsvInput {
    text: String,
    units: Vec<String>,
}

fn prepare_csv_input(raw: &str) -> CsvInput {
    if let Some(prep) = strip_motec(raw) {
        return prep;
    }
    if let Some(prep) = strip_link(raw) {
        return prep;
    }
    CsvInput { text: raw.to_string(), units: Vec::new() }
}

/// MoTeC-style CSV files start with ~12 lines of metadata, then a quoted
/// channel-names row, then a units row, then blanks, then data. The standard
/// `csv` crate handles quoted values fine, but the metadata block must be
/// stripped first. Detection is keyed off the literal `"Format","MoTeC` prefix.
fn strip_motec(text: &str) -> Option<CsvInput> {
    let first = text.lines().next().unwrap_or("");
    if !(first.starts_with("\"Format\"") && first.contains("MoTeC")) {
        return None;
    }
    let lines: Vec<&str> = text.lines().collect();
    let header_idx = lines.iter().position(|l| {
        first_csv_cell(l).map(|c| c == "Time").unwrap_or(false)
    })?;
    // Skip past the header itself, capturing the units row if it's the next
    // non-blank non-data line. MoTeC's row immediately after the header is the
    // units row in every export I've seen, but the parser tolerates anything
    // between header and first numeric row.
    let mut data_start = header_idx + 1;
    let mut units_line: Option<&str> = None;
    while data_start < lines.len() {
        let trimmed = lines[data_start].trim();
        if trimmed.is_empty() { data_start += 1; continue; }
        let first_cell = first_csv_cell(lines[data_start]).unwrap_or("");
        if first_cell.parse::<f64>().is_ok() { break; }
        if units_line.is_none() {
            units_line = Some(lines[data_start]);
        }
        data_start += 1;
    }
    let header_unique = dedupe_csv_header(lines[header_idx]);
    let units = parse_units_line(units_line, count_csv_cells(&header_unique));
    let mut out = String::with_capacity(text.len());
    out.push_str(&header_unique);
    out.push('\n');
    for l in &lines[data_start..] {
        out.push_str(l);
        out.push('\n');
    }
    Some(CsvInput { text: out, units })
}

/// Link ECU CSV exports start with a single quoted preamble line:
///   "Name","ECU Internal Datalog - 2026-05-03 13;33;03"
/// Then the channel-name row, units row, blank line, then data.
fn strip_link(text: &str) -> Option<CsvInput> {
    let mut iter = text.lines();
    let first = iter.next().unwrap_or("");
    if first_csv_cell(first).map(|c| c != "Name").unwrap_or(true) { return None; }
    if !first.contains("ECU") { return None; }
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 3 { return None; }
    let header = lines[1];
    let mut data_start = 2;
    let mut units_line: Option<&str> = None;
    while data_start < lines.len() {
        let trimmed = lines[data_start].trim();
        if trimmed.is_empty() { data_start += 1; continue; }
        let first_cell = first_csv_cell(lines[data_start]).unwrap_or("");
        if first_cell.parse::<f64>().is_ok() { break; }
        if units_line.is_none() {
            units_line = Some(lines[data_start]);
        }
        data_start += 1;
    }
    let header_unique = dedupe_csv_header(header);
    let units = parse_units_line(units_line, count_csv_cells(&header_unique));
    let mut out = String::with_capacity(text.len());
    out.push_str(&header_unique);
    out.push('\n');
    for l in &lines[data_start..] {
        out.push_str(l);
        out.push('\n');
    }
    Some(CsvInput { text: out, units })
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

fn count_csv_cells(line: &str) -> usize {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(line.as_bytes());
    rdr.records().next()
        .and_then(|r| r.ok())
        .map(|r| r.len())
        .unwrap_or(0)
}

/// Parse the source's units row into a Vec<String>, padded to `expected_len`
/// with empty strings. Returns an empty Vec when no units row was found.
fn parse_units_line(line: Option<&str>, expected_len: usize) -> Vec<String> {
    let Some(line) = line else { return Vec::new(); };
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(line.as_bytes());
    let Some(Ok(record)) = rdr.records().next() else { return Vec::new(); };
    let mut out: Vec<String> = record.iter().map(|s| s.to_string()).collect();
    while out.len() < expected_len { out.push(String::new()); }
    out
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
    fn loads_link_format_strips_preamble() {
        let r = load_csv(&fixture("good/link_minimal.csv"), &registry()).unwrap();
        let mut saw_rpm = false;
        let mut rpm_first: Option<f64> = None;
        for rg in &r.rate_groups {
            if rg.meta("engine.rpm").is_some() {
                saw_rpm = true;
                rpm_first = Some(rg.channel_data("engine.rpm").unwrap().value(0));
            }
        }
        assert!(saw_rpm, "engine.rpm not loaded from Link CSV (alias `Engine Speed`)");
        assert_eq!(rpm_first, Some(1000.0));
        assert_eq!(r.duration_us, 10_000);
    }

    /// End-to-end semantic mapping: a Link-flavoured CSV with a column whose
    /// header isn't in any alias list ("Throttle Pedal Pos") but matches the
    /// `engine.tps` semantic pattern via keyword `throttle` + unit `%`.
    /// Verifies the units row survives the preamble strip and reaches the
    /// resolver, AND that the heuristic match surfaces in warnings so users
    /// can audit what got auto-routed.
    #[test]
    fn semantic_mapping_via_units_row() {
        let csv: &[u8] = b"\"Name\",\"ECU Internal Datalog\"\n\
            \"Time\",\"Throttle Pedal Pos\"\n\
            \"s\",\"%\"\n\
            \n\
            \"0\",\"5\"\n\
            \"0.001\",\"5\"\n\
            \"0.002\",\"6\"\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        let has_tps = r.rate_groups.iter().any(|rg| rg.meta("engine.tps").is_some());
        assert!(has_tps, "expected semantic-mapping of `Throttle Pedal Pos` → engine.tps");
        assert!(
            r.warnings.iter().any(|w| w.contains("Throttle Pedal Pos") && w.contains("engine.tps")),
            "expected mapping warning, got {:?}", r.warnings,
        );
    }

    /// When two source headers both alias to the same canonical id (a real
    /// case for Link CSVs that ship `TPS (Main)` and `TPS (Sub)` simultaneously
    /// — both used to alias to `engine.tps` in v2.5.2 and the second silently
    /// overwrote the first inside RateGroup's HashMap), the loader keeps the
    /// FIRST mapping and demotes the colliding column back to its raw header
    /// name so both columns remain reachable.
    #[test]
    fn collision_protection_keeps_both_columns_reachable() {
        // Build a tiny inline registry where two distinct aliases route to
        // the same canonical id, then confirm both columns are findable.
        const COLLIDING_YAML: &str = r##"
channels:
  - id: engine.foo
    display_name: Foo
    units: ""
    group: Engine
    color: "#fff"
    decimals: 0
    data_type: f32
    source: t
    sample_rate_hz: 100
    aliases: ["FOO_A", "FOO_B"]
"##;
        let reg = ChannelRegistry::from_yaml(COLLIDING_YAML).unwrap();
        let csv: &[u8] = b"time,FOO_A,FOO_B\n0,1,10\n0.01,2,20\n0.02,3,30\n";
        let r = load_csv_bytes(csv, &reg).unwrap();
        // Find both columns: FOO_A should claim engine.foo (first); FOO_B
        // should fall back to its raw name.
        let mut saw_canonical = false;
        let mut saw_raw_b = false;
        for rg in &r.rate_groups {
            if rg.meta("engine.foo").is_some() {
                saw_canonical = true;
                // First column's data was 1, 2, 3 — check we kept the right one.
                assert_eq!(rg.channel_data("engine.foo").unwrap().value(0), 1.0);
            }
            if rg.meta("FOO_B").is_some() {
                saw_raw_b = true;
                assert_eq!(rg.channel_data("FOO_B").unwrap().value(0), 10.0);
            }
        }
        assert!(saw_canonical, "first FOO_A should hold engine.foo");
        assert!(saw_raw_b, "second FOO_B should fall back to raw header");
        assert!(
            r.warnings.iter().any(|w| w.contains("FOO_B") && w.contains("engine.foo")),
            "expected collision warning, got {:?}", r.warnings,
        );
    }

    /// Companion to the above: when units conflict (here a temp channel named
    /// `Pedal Coolant` with unit kPa shouldn't be mapped to either tps or
    /// water_temp), the resolver should fall through to default rather than
    /// guess.
    #[test]
    fn semantic_unit_mismatch_falls_through() {
        let csv: &[u8] = b"\"Name\",\"ECU Internal Datalog\"\n\
            \"Time\",\"Coolant Bypass Pressure\"\n\
            \"s\",\"kPa\"\n\
            \n\
            \"0\",\"100\"\n\
            \"0.001\",\"100\"\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        // Should NOT be misrouted to engine.water_temp despite "coolant" in name.
        let has_water = r.rate_groups.iter().any(|rg| rg.meta("engine.water_temp").is_some());
        assert!(!has_water, "incorrectly routed kPa channel to engine.water_temp");
    }

    #[test]
    fn loads_motec_format_via_aliases() {
        let r = load_csv(&fixture("good/motec_minimal.csv"), &registry()).unwrap();
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
