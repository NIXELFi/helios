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
    // Real MoTeC/Link CSVs are often Windows-exported and can contain stray
    // non-UTF-8 bytes (degree sign in a Latin-1 / Windows-1252 unit string is
    // the canonical case). The audit (2026-05-11) flagged the prior hard
    // rejection as a usability bug: users couldn't load their own files. We
    // fall back to `from_utf8_lossy`, which replaces each invalid byte with
    // U+FFFD (`?`). Channel names and data values still parse; only the
    // offending byte's textual rendering is lost. We deliberately don't add
    // a dependency for perfect Windows-1252 decoding — the goal is to let
    // the file load at all.
    let raw_cow = String::from_utf8_lossy(bytes);
    let prepared = prepare_csv_input(&raw_cow);
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
    // Track per-column counts of non-empty cells that failed to parse as a
    // number. Used after the read pass to surface a warning when a column is
    // dominated by unparseable values (e.g. an "on"/"off" enum, or
    // locale-formatted "1,234"). Individual failures still get coerced to
    // None so legitimately sparse columns load cleanly.
    let mut parse_fail: Vec<usize> = vec![0; headers.len() - 1];
    let mut parse_attempt: Vec<usize> = vec![0; headers.len() - 1];
    for rec in rdr.records() {
        let rec = rec?;
        // `rec.get(0)` guards against a zero-field record (lone delimiter or
        // fully-quoted empty cell would otherwise panic via index op). The
        // empty string falls through to the parse-error branch with a clear
        // "bad time" message.
        let time_cell = rec.get(0).unwrap_or("");
        let t: f64 = time_cell.trim().parse()
            .map_err(|e| CsvLoadError::Malformed(format!("bad time `{}`: {e}", time_cell)))?;
        // `parse::<f64>()` happily accepts "nan"/"inf"/"-inf"/"infinity".
        // A non-finite time poisons every downstream span / rate / monotonic
        // check, so reject it outright rather than carrying it forward.
        if !t.is_finite() {
            return Err(CsvLoadError::Malformed(format!("bad time `{}`: not finite", time_cell)));
        }
        times_raw.push(t);
        for (i, c) in cols.iter_mut().enumerate() {
            let s = rec.get(i + 1).unwrap_or("").trim();
            if s.is_empty() {
                c.push(None);
            } else {
                parse_attempt[i] += 1;
                match s.parse::<f64>() {
                    // Coerce non-finite values (NaN/Inf) to None so they never
                    // enter the Float64 array and poison min/max/sum.
                    Ok(v) if v.is_finite() => c.push(Some(v)),
                    _ => { parse_fail[i] += 1; c.push(None); }
                }
            }
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
    // column, across all rate groups. We keep the FIRST mapping; subsequent
    // collisions demote back to the raw header so both columns stay
    // reachable.
    //
    // We MUST resolve in two passes — exact-alias first across every
    // column, semantic second — so a precise alias on a later column wins
    // over a loose semantic match on an earlier one. Single-pass ordering
    // was wrong: e.g. a MoTeC export with `Throttle Load` (%) before
    // `Throttle Position` (%) used to let the semantic keyword squat on
    // `engine.tps` for Throttle Load; the real Throttle Position then
    // hit a claimed id and was demoted to its raw header — every widget
    // configured for engine.tps showed Throttle Load data instead.
    let mut claimed_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let span_us = (*times_us.last().unwrap() - times_us[0]).max(1);
    let span_s = span_us as f64 / 1_000_000.0;

    // Per-column resolution outcome, keyed by header index (1..headers.len()).
    // `None` means "not yet resolved — try the next pass".
    let mut resolved: Vec<Option<(ChannelMeta, ResolveKind)>> = vec![None; headers.len()];

    let infer_rate = |i: usize| -> i32 {
        let non_null = cols[i - 1].iter().filter(|x| x.is_some()).count();
        (non_null as f64 / span_s).round() as i32
    };

    // Pass 1: exact alias only. Every column gets first crack at a precise
    // alias hit before any semantic guesses get to claim canonical ids.
    // Two columns aliasing the same canonical id (e.g. Link's TPS (Main)
    // + TPS (Sub) before the v2.5.3 split) — first wins, second demotes
    // to its raw header so both stay reachable.
    for (i, name) in headers.iter().enumerate().skip(1) {
        if let Some(m) = registry.resolve(name) {
            let mut meta = m.clone();
            meta.sample_rate_hz = meta.sample_rate_hz.max(1.0);
            if claimed_ids.contains(&meta.id) && meta.id != *name {
                warnings.push(format!(
                    "channel `{name}` resolved to `{}` but that id was already claimed by an earlier column; storing as `{name}` instead so both remain reachable",
                    meta.id,
                ));
                meta.id = name.to_string();
                meta.display_name = name.to_string();
            }
            // Record the original CSV header so the per-session override UI
            // can address this column by what the user actually saw in their
            // file, not the canonical id the resolver picked.
            meta.source_header = Some(name.to_string());
            claimed_ids.insert(meta.id.clone());
            resolved[i] = Some((meta, ResolveKind::ExactAlias));
        }
    }

    // Pass 2: semantic fallback for columns that still have no resolution.
    // A semantic hit against an already-claimed canonical id falls through
    // to default (don't bother carrying through to a demotion warning —
    // pass 3's "unknown channel" path covers it).
    for (i, name) in headers.iter().enumerate().skip(1) {
        if resolved[i].is_some() { continue; }
        let unit_hint = prepared.units.get(i).map(String::as_str).unwrap_or("");
        let inferred_rate = infer_rate(i).max(1) as f32;
        let res = registry.resolve_or_default(name, unit_hint, inferred_rate);
        match res.kind {
            ResolveKind::Semantic if !claimed_ids.contains(&res.meta.id) => {
                let mut meta = res.meta;
                meta.sample_rate_hz = meta.sample_rate_hz.max(1.0);
                meta.source_header = Some(name.to_string());
                warnings.push(format!(
                    "channel `{name}` semantic-mapped to `{}` ({})",
                    meta.id, meta.display_name,
                ));
                claimed_ids.insert(meta.id.clone());
                resolved[i] = Some((meta, ResolveKind::Semantic));
            }
            _ => {
                // Either semantic hit a claimed id, or it was Default to
                // begin with. Treat both the same: registered with defaults.
                // (ExactAlias can't happen here — pass 1 caught those.)
            }
        }
    }

    // Pass 3: anything still unresolved gets a default ChannelMeta keyed by
    // the raw header. This is also the demotion path for source columns
    // whose semantic hit lost to a pass-1 exact alias.
    for (i, name) in headers.iter().enumerate().skip(1) {
        if resolved[i].is_some() { continue; }
        let unit_hint = prepared.units.get(i).map(String::as_str).unwrap_or("");
        let inferred_rate = infer_rate(i).max(1) as f32;
        // Force the default branch by going through resolve_or_default on a
        // header we know won't alias (registry.resolve already returned None
        // in pass 1) and won't semantic-match into anything unclaimed (pass 2
        // already tried).
        let mut res = registry.resolve_or_default(name, unit_hint, inferred_rate);
        // If pass-2 detected a semantic hit on a claimed id, surface that as
        // a "collision" warning so users can see why the precise channel
        // they expected didn't pick up a particular header.
        if matches!(res.kind, ResolveKind::Semantic) {
            warnings.push(format!(
                "channel `{name}` would have semantic-mapped to `{}` but that id was already claimed by an exact alias on another column; storing as `{name}` instead",
                res.meta.id,
            ));
            // Override to the synthesized-from-header default by re-running
            // resolution with a never-matching name. Simpler: build the
            // default meta inline.
            res.meta.id = name.to_string();
            res.meta.display_name = name.to_string();
        } else {
            warnings.push(format!("unknown channel `{name}`, registered with defaults"));
        }
        res.meta.source_header = Some(name.to_string());
        claimed_ids.insert(res.meta.id.clone());
        resolved[i] = Some((res.meta, ResolveKind::Default));
    }

    for (i, slot) in resolved.iter().enumerate().skip(1) {
        let Some((meta, _kind)) = slot else { continue; };
        let key = meta.sample_rate_hz.round() as i32;
        by_rate.entry(key).or_default().push((i - 1, meta.clone()));
    }

    // Warn on columns that look like a fundamentally-unparseable type
    // (>50% of non-empty cells failed to parse as a number, with at least a
    // handful of attempts). Catches the "on"/"off" enum or `"1,234"`
    // locale-formatted column that would otherwise silently load as all
    // nulls.
    const MIN_ATTEMPTS_FOR_WARN: usize = 4;
    for (i, name) in headers.iter().enumerate().skip(1) {
        let attempts = parse_attempt[i - 1];
        let failures = parse_fail[i - 1];
        if attempts >= MIN_ATTEMPTS_FOR_WARN && failures * 2 > attempts {
            warnings.push(format!(
                "column `{name}` has {failures}/{attempts} non-empty cells that failed to parse as number",
            ));
        }
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
        let mut rg_cols: Vec<(ChannelMeta, Vec<Option<f64>>)> = Vec::new();
        for (ci, meta) in entries {
            // Forward-fill interior gaps with the last-known sample, but
            // preserve the LEADING gap (before any sample exists) as
            // Option::None so it surfaces as a true Arrow null rather than a
            // NaN sentinel. Downstream aggregations check `is_null()` and
            // would otherwise silently fold NaN into min/max/sum.
            let mut data: Vec<Option<f64>> = Vec::with_capacity(keep_indices.len());
            let mut last: Option<f64> = None;
            for &r in &keep_indices {
                if let Some(v) = cols[ci][r] { last = Some(v); data.push(Some(v)); }
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
    use arrow::array::Array;
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
    /// header isn't in any alias list ("Throttle Pedal Pos") but matches a
    /// canonical channel's semantic pattern + unit. Per change-doc 33's
    /// TPS/APS split, "Throttle Pedal Pos" is the pedal sensor (engine.aps),
    /// not the throttle plate (engine.tps). The `pedal pos` keyword on
    /// engine.aps + `%` unit gate routes it correctly.
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
        let has_aps = r.rate_groups.iter().any(|rg| rg.meta("engine.aps").is_some());
        assert!(has_aps, "expected semantic-mapping of `Throttle Pedal Pos` → engine.aps");
        assert!(
            r.warnings.iter().any(|w| w.contains("Throttle Pedal Pos") && w.contains("engine.aps")),
            "expected mapping warning, got {:?}", r.warnings,
        );
    }

    /// Regression for the v2.5.2 → v2.5.3 → 3.1.0 saga: a MoTeC export that
    /// includes BOTH `Throttle Load` (a Link/MoTeC engine-load metric, %)
    /// AND the canonical `Throttle Position` column (%) must put the real
    /// throttle data under engine.tps. Pre-fix, the loader's single-pass
    /// resolver let `Throttle Load`'s semantic match squat on engine.tps
    /// (keyword `throttle` matched, unit `%` matched), then demoted the
    /// genuine `Throttle Position` to its raw header on the collision-
    /// protection path — every dashboard tile pinned to engine.tps showed
    /// Throttle Load data instead.
    ///
    /// The fix is two-pronged: keyword tightening (engine.tps no longer
    /// keyword-matches bare "throttle") + two-pass resolution (exact alias
    /// wins across all columns before any semantic guess can claim an id).
    #[test]
    fn throttle_position_wins_over_earlier_throttle_load_match() {
        // Approximate the MoTeC ADL header layout: Throttle Load appears
        // BEFORE Throttle Position in column order, which used to let it
        // squat on engine.tps before the precise alias arrived.
        let csv: &[u8] = b"\"Format\",\"MoTeC CSV File\"\n\
            \"Time\",\"Throttle Load\",\"Throttle Position\"\n\
            \"s\",\"%\",\"%\"\n\
            \n\
            \"0.000\",\"5\",\"14\"\n\
            \"0.001\",\"6\",\"15\"\n\
            \"0.002\",\"7\",\"16\"\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        // engine.tps must be present and hold the Throttle Position data
        // (first sample = 14), NOT Throttle Load (first sample = 5).
        let mut tps_first: Option<f64> = None;
        for rg in &r.rate_groups {
            if rg.meta("engine.tps").is_some() {
                tps_first = Some(rg.channel_data("engine.tps").unwrap().value(0));
            }
        }
        assert_eq!(
            tps_first, Some(14.0),
            "engine.tps must hold `Throttle Position` data (14), not `Throttle Load` (5)"
        );
        // `Throttle Load` must still be reachable. As of the 3.2.0 registry
        // expansion it has its own canonical `engine.throttle_load`; pre-3.2.0
        // it lived under its raw header. Accept either path — the contract
        // is "the column isn't silently dropped".
        let mut saw_load = false;
        for rg in &r.rate_groups {
            if rg.meta("Throttle Load").is_some() || rg.meta("engine.throttle_load").is_some() {
                saw_load = true;
            }
        }
        assert!(saw_load, "Throttle Load column should still be loaded (raw or as engine.throttle_load)");
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

    /// A zero-field record (here from a stray blank line that the csv reader
    /// could feed through as an empty record in pathological inputs, or a
    /// fully-quoted empty cell) used to panic via direct indexing of
    /// `rec[0]`. With `rec.get(0)` the empty cell is reported via the
    /// existing "bad time" malformed error.
    #[test]
    fn empty_time_cell_errors_not_panics() {
        let csv: &[u8] = b"time,rpm\n,1000\n";
        let err = load_csv_bytes(csv, &registry()).unwrap_err();
        match err {
            CsvLoadError::Malformed(msg) => assert!(msg.contains("bad time"), "got: {msg}"),
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    /// A column dominated by non-numeric values (e.g. an "on"/"off" enum)
    /// silently became all-nulls. The loader now surfaces a warning so the
    /// user can tell the column wasn't usefully ingested.
    #[test]
    fn warns_when_column_mostly_unparseable() {
        let csv: &[u8] = b"time,Pump State\n\
            0,on\n\
            0.01,on\n\
            0.02,off\n\
            0.03,on\n\
            0.04,off\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        assert!(
            r.warnings.iter().any(|w| w.contains("Pump State") && w.contains("failed to parse")),
            "expected parse-failure warning, got {:?}", r.warnings,
        );
    }

    /// A leading gap (rows present before the first sample of a channel)
    /// must show up as an Arrow null, not the NaN sentinel that the old
    /// f64::NAN forward-fill produced. We force `rpm` and `tps` into the
    /// same rate group (both resolve to engine.* at 100Hz) so the
    /// rate-grouped row set includes all four rows, and the leading two
    /// blanks in `tps` get carried as None rather than the f64::NAN
    /// sentinel.
    #[test]
    fn leading_blank_is_arrow_null_not_nan() {
        let csv: &[u8] = b"time,rpm,tps\n\
            0,1000,\n\
            0.01,1100,\n\
            0.02,1200,42\n\
            0.03,1300,43\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        let mut checked = false;
        for rg in &r.rate_groups {
            if let Ok(arr) = rg.channel_data("engine.tps") {
                assert!(arr.is_null(0), "leading blank must be Arrow null, not NaN");
                assert!(arr.is_null(1), "leading blank must be Arrow null, not NaN");
                assert!(!arr.is_null(2));
                assert_eq!(arr.value(2), 42.0);
                checked = true;
            }
        }
        assert!(checked, "engine.tps column not found in any rate group");
    }

    /// Audit 2026-05-11: real MoTeC/Link CSVs occasionally contain Latin-1
    /// bytes (the degree sign in a unit row is the canonical case). The
    /// loader used to hard-reject; now it falls back to lossy UTF-8 decoding
    /// so the file loads with the offending byte rendered as U+FFFD.
    #[test]
    fn non_utf8_input_loads_with_lossy_fallback() {
        // 0xB0 is the Latin-1 degree sign — invalid UTF-8 on its own. Place
        // it inside a header so we exercise the channel-name path.
        let mut csv: Vec<u8> = Vec::new();
        csv.extend_from_slice(b"time,temp_");
        csv.push(0xB0);
        csv.extend_from_slice(b"C\n0,20\n0.01,21\n0.02,22\n");
        let r = load_csv_bytes(&csv, &registry()).expect("lossy fallback must load");
        // At least one rate group with one non-time column.
        assert!(!r.rate_groups.is_empty(), "expected at least one rate group");
        let has_column = r.rate_groups.iter().any(|rg| !rg.channel_ids().is_empty());
        assert!(has_column, "expected at least one data column to load");
    }

    /// Every ingested ChannelMeta must carry the original CSV header in
    /// `source_header`. Covers all three resolution outcomes:
    /// ExactAlias (header in alias list), Semantic (keyword + unit match),
    /// and Default (unknown header).
    #[test]
    fn source_header_is_populated_for_all_resolve_outcomes() {
        // Throttle Pedal Pos → engine.aps via Semantic (per change-doc 33).
        // Engine Speed → engine.rpm via ExactAlias.
        // Mystery Probe → kept as Default under its raw header.
        let csv: &[u8] = b"\"Name\",\"ECU Internal Datalog\"\n\
            \"Time\",\"Engine Speed\",\"Throttle Pedal Pos\",\"Mystery Probe\"\n\
            \"s\",\"rpm\",\"%\",\"\"\n\
            \n\
            \"0.000\",\"1000\",\"5\",\"42\"\n\
            \"0.010\",\"1100\",\"6\",\"43\"\n\
            \"0.020\",\"1200\",\"7\",\"44\"\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        let mut found_rpm = false;
        let mut found_aps = false;
        let mut found_mystery = false;
        for rg in &r.rate_groups {
            if let Some(m) = rg.meta("engine.rpm") {
                assert_eq!(m.source_header.as_deref(), Some("Engine Speed"));
                found_rpm = true;
            }
            if let Some(m) = rg.meta("engine.aps") {
                assert_eq!(m.source_header.as_deref(), Some("Throttle Pedal Pos"));
                found_aps = true;
            }
            if let Some(m) = rg.meta("Mystery Probe") {
                assert_eq!(m.source_header.as_deref(), Some("Mystery Probe"));
                found_mystery = true;
            }
        }
        assert!(found_rpm, "engine.rpm missing");
        assert!(found_aps, "engine.aps missing");
        assert!(found_mystery, "Mystery Probe missing");
    }

    /// `parse::<f64>()` accepts "nan"/"inf"/"-inf"/"infinity". A non-finite
    /// TIME value must be rejected as Malformed (it would poison the span /
    /// rate / monotonicity logic), and a non-finite value in a DATA column
    /// must be null-coerced so NaN/Inf never enter the Float64 array and
    /// fold silently into min/max/sum.
    #[test]
    fn non_finite_time_errors() {
        for bad in ["nan", "inf", "-inf", "infinity"] {
            let csv = format!("time,rpm\n0,1000\n{bad},1100\n");
            let err = load_csv_bytes(csv.as_bytes(), &registry()).unwrap_err();
            match err {
                CsvLoadError::Malformed(msg) => {
                    assert!(msg.contains("not finite"), "got: {msg}");
                }
                other => panic!("expected Malformed for time `{bad}`, got {other:?}"),
            }
        }
    }

    #[test]
    fn non_finite_data_value_is_null() {
        // `nan`/`inf` in a data column must coerce to Arrow null, never
        // entering the Float64 array.
        let csv: &[u8] = b"time,rpm\n\
            0,1000\n\
            0.01,nan\n\
            0.02,inf\n\
            0.03,1300\n";
        let r = load_csv_bytes(csv, &registry()).unwrap();
        let mut checked = false;
        for rg in &r.rate_groups {
            if let Ok(arr) = rg.channel_data("engine.rpm") {
                // Row 0 = 1000. Rows 1 and 2 were nan/inf -> coerced to None,
                // then forward-filled to the last-known sample (1000), never
                // NaN/Inf. Confirm no value is non-finite.
                for i in 0..arr.len() {
                    if !arr.is_null(i) {
                        assert!(arr.value(i).is_finite(), "row {i} is non-finite: {}", arr.value(i));
                    }
                }
                checked = true;
            }
        }
        assert!(checked, "engine.rpm column not found in any rate group");
    }

    // NB: a `sample_session_loads` test used to load the bundled
    // `samples/sdm26-synthetic-lap.csv`, but that sample (and all bundled CSVs)
    // was removed in v3.8.1 — the app no longer ships data. Its coverage
    // (multi-rate grouping, engine.rpm detection, duration parsing) lives in the
    // fixture-backed tests above: `loads_multi_rate` (multi_rate/two_rates.csv),
    // plus the MoTeC / Link minimal-fixture tests.
}
