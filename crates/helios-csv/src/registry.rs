use helios_core::{ChannelMeta, DataType};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error(
        "duplicate alias `{alias}` in channels.yaml: claimed by both `{first_id}` and `{second_id}`"
    )]
    DuplicateAlias { alias: String, first_id: String, second_id: String },
}

#[derive(Debug, Deserialize)]
struct RegistryFile { channels: Vec<RegistryEntry> }

#[derive(Debug, Deserialize)]
struct RegistryEntry {
    id: String,
    display_name: String,
    units: String,
    group: String,
    color: String,
    decimals: u8,
    data_type: DataType,
    source: String,
    sample_rate_hz: f32,
    #[serde(default)] min: Option<f64>,
    #[serde(default)] max: Option<f64>,
    #[serde(default)] warn: Option<f64>,
    #[serde(default)] alarm: Option<f64>,
    #[serde(default)] aliases: Vec<String>,
    /// Semantic-match keywords. Lowercased phrases (single or multi-word) that
    /// strongly suggest this canonical channel. Used as a fallback when exact
    /// alias resolution fails — typical case is a vendor's CSV header that
    /// reads naturally to a human ("TPS (Main)") but isn't in the alias list.
    #[serde(default)] match_keywords: Vec<String>,
    /// Acceptable units for semantic matching. When non-empty, the incoming
    /// CSV unit must match one of these (after normalization) before a
    /// keyword-based match is accepted. Prevents `"Oil Pressure"` (kPa) from
    /// being routed to `engine.oil_temp` (°C) just because both contain "oil".
    /// Leave empty when the channel is dimensionless or unit-agnostic.
    #[serde(default)] match_units: Vec<String>,
}

#[derive(Debug, Clone)]
struct SemanticPattern {
    keywords: Vec<String>,         // lowercased phrases
    units_allowed: Vec<String>,    // normalized; empty = any
    meta: ChannelMeta,
}

pub struct ChannelRegistry {
    by_alias: HashMap<String, ChannelMeta>,
    semantic: Vec<SemanticPattern>,
}

impl ChannelRegistry {
    pub fn from_yaml(yaml: &str) -> Result<Self, RegistryError> {
        let file: RegistryFile = serde_yaml::from_str(yaml)?;
        let mut by_alias: HashMap<String, ChannelMeta> = HashMap::new();
        let mut semantic = Vec::new();
        // Helper closure to flag duplicate inserts. Duplicates used to be
        // silently overwritten — the second entry won, and any channel that
        // depended on the first alias would mysteriously route elsewhere.
        // Now we fail loudly so channels.yaml authors see the collision.
        for e in file.channels {
            let meta = ChannelMeta {
                id: e.id.clone(),
                display_name: e.display_name,
                units: e.units,
                group: e.group,
                color: e.color,
                decimals: e.decimals,
                data_type: e.data_type,
                source: e.source,
                sample_rate_hz: e.sample_rate_hz,
                min: e.min, max: e.max, warn: e.warn, alarm: e.alarm,
                // Populated by the loader once it knows which CSV header
                // resolved through this registry entry. Registry templates
                // themselves carry no source.
                source_header: None,
            };
            if let Some(prev) = by_alias.get(&e.id) {
                // Only conflicting if the previous entry pointed somewhere
                // else; a self-redundant entry (id-as-alias) is benign and
                // we treat it as a no-op so existing channels.yaml files
                // that list their own id under `aliases:` keep working.
                if prev.id != meta.id {
                    return Err(RegistryError::DuplicateAlias {
                        alias: e.id.clone(),
                        first_id: prev.id.clone(),
                        second_id: meta.id.clone(),
                    });
                }
            }
            by_alias.insert(e.id.clone(), meta.clone());
            for a in e.aliases {
                if let Some(prev) = by_alias.get(&a) {
                    if prev.id != meta.id {
                        return Err(RegistryError::DuplicateAlias {
                            alias: a,
                            first_id: prev.id.clone(),
                            second_id: meta.id.clone(),
                        });
                    }
                    // Same target — redundant alias, no-op.
                    continue;
                }
                by_alias.insert(a, meta.clone());
            }
            if !e.match_keywords.is_empty() {
                semantic.push(SemanticPattern {
                    keywords: e.match_keywords.iter().map(|s| s.to_lowercase()).collect(),
                    units_allowed: e.match_units.iter().map(|u| normalize_unit(u)).collect(),
                    meta,
                });
            }
        }
        Ok(Self { by_alias, semantic })
    }

    pub fn from_path(path: &Path) -> Result<Self, anyhow::Error> {
        let yaml = std::fs::read_to_string(path)?;
        Self::from_yaml(&yaml).map_err(Into::into)
    }

    /// Look up by exact alias match. Returns None if unknown.
    pub fn resolve(&self, header: &str) -> Option<&ChannelMeta> {
        self.by_alias.get(header)
    }

    /// Resolve OR synthesize a default ChannelMeta for an unknown header.
    /// When the unit is unknown (plain CSV with no units row), pass `""`.
    /// The default fallback is dimensionless f64 at the supplied rate.
    pub fn resolve_or_default(
        &self,
        header: &str,
        unit_hint: &str,
        default_rate_hz: f32,
    ) -> ResolveResult {
        if let Some(m) = self.by_alias.get(header) {
            return ResolveResult { meta: m.clone(), kind: ResolveKind::ExactAlias };
        }
        if let Some(m) = self.try_semantic(header, unit_hint) {
            return ResolveResult { meta: m, kind: ResolveKind::Semantic };
        }
        let (units, decimals) = guess_units_from_suffix(header);
        let chosen_units = if !unit_hint.trim().is_empty() {
            unit_hint.trim().to_string()
        } else {
            units
        };
        let meta = ChannelMeta {
            id: header.to_string(),
            display_name: header.to_string(),
            units: chosen_units,
            group: "Unknown".into(),
            color: "#888888".into(),
            decimals,
            data_type: DataType::F64,
            source: "csv".into(),
            sample_rate_hz: default_rate_hz,
            min: None, max: None, warn: None, alarm: None,
            // Same here: the loader stamps this with the actual CSV header.
            source_header: None,
        };
        ResolveResult { meta, kind: ResolveKind::Default }
    }

    fn try_semantic(&self, header: &str, unit_hint: &str) -> Option<ChannelMeta> {
        let norm = normalize_name(header);
        let unit_norm = normalize_unit(unit_hint);
        let unit_known = !unit_norm.is_empty();
        let mut best: Option<(usize, &SemanticPattern)> = None;
        for pat in &self.semantic {
            let unit_strict = !pat.units_allowed.is_empty();
            // Unit gate: when the pattern declares accepted units AND we
            // have a unit to check, reject if it doesn't match. This is
            // what prevents "Oil Pressure" (kPa) from being routed to
            // engine.oil_temp (°C).
            if unit_strict
                && unit_known
                && !pat.units_allowed.iter().any(|u| u == &unit_norm)
            {
                continue;
            }
            let score = pat.keywords.iter()
                .filter(|kw| substring_match(&norm, kw))
                .count();
            // When the pattern requires a unit but the source CSV has no
            // units row (plain CSV with no MoTeC/Link metadata), require a
            // higher keyword score before accepting. Avoids confidently
            // mapping ambiguous names like "GP RPM Limit 1" to engine.rpm.
            let min_score = if unit_strict && !unit_known { 2 } else { 1 };
            if score < min_score { continue; }
            // Bonus when unit-confirmed so a tied keyword score still
            // favours the candidate whose unit matches.
            let bonus = if unit_strict && unit_known { 1 } else { 0 };
            let adjusted = score * 10 + bonus;
            if best.map(|(s, _)| adjusted > s).unwrap_or(true) {
                best = Some((adjusted, pat));
            }
        }
        best.map(|(_, pat)| pat.meta.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveKind {
    /// Header (or one of its aliases) was found in the registry as-written.
    ExactAlias,
    /// No alias hit, but a canonical channel's match_keywords + units fit.
    Semantic,
    /// No registry hit at all — synthesized a default ChannelMeta.
    Default,
}

#[derive(Debug)]
pub struct ResolveResult {
    pub meta: ChannelMeta,
    pub kind: ResolveKind,
}

/// Lowercase, replace any non-alphanumeric with a space, collapse runs of
/// whitespace, trim. "TPS (Main)" → "tps main". "GP RPM Limit 1" → "gp rpm
/// limit 1". Used for substring keyword matching.
pub(crate) fn normalize_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true;
    for c in s.chars() {
        if c.is_alphanumeric() {
            for cc in c.to_lowercase() { out.push(cc); }
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    if out.ends_with(' ') { out.pop(); }
    out
}

/// Substring match with word-boundary awareness. Matches the keyword if it
/// occurs as a contiguous run of tokens — `tps` matches `tps main` and `aps tps`,
/// but not `tpsmain` (which `normalize_name` would never produce anyway).
fn substring_match(norm_haystack: &str, keyword: &str) -> bool {
    if keyword.is_empty() { return false; }
    // Pad both sides with spaces so single-word keywords don't false-match
    // partial words: `rpm` should not match `rpmthing`.
    let h = format!(" {} ", norm_haystack);
    let k = format!(" {} ", keyword);
    h.contains(&k)
}

/// Normalize a unit string for set-membership comparison. Lowercase, drop
/// degree symbols + common separators (whitespace, slash, dot), then apply a
/// small synonym table. Preserves single-character units like `%` so they
/// survive normalization.
pub(crate) fn normalize_unit(u: &str) -> String {
    let lower: String = u.to_lowercase();
    // m/s and any case-variants must be detected BEFORE we strip the slash:
    // without the slash, "m/s" → "ms", which collides with milliseconds
    // ("ms"). The audit (2026-05-11) flagged this as a latent bug — no
    // channel uses ms units today, but the collision would silently
    // misroute the moment one was added. Special-case both spellings
    // ("m/s" and the already-stripped "mps") and route to a distinct
    // canonical that can never collide with a real unit token.
    let lower_trimmed = lower.trim();
    if lower_trimmed == "m/s" || lower_trimmed == "mps" {
        return "m_per_s".to_string();
    }
    let cleaned: String = lower.chars()
        .filter(|c| !c.is_whitespace() && *c != '°' && *c != '/' && *c != '.')
        .collect();
    let trimmed = cleaned.trim();
    match trimmed {
        "kph" | "kmh" | "kmph" => "kmh".to_string(),
        "degc"  => "c".to_string(),
        "degf"  => "f".to_string(),
        "kpag"  => "kpa".to_string(),
        _       => trimmed.to_string(),
    }
}

fn guess_units_from_suffix(header: &str) -> (String, u8) {
    let lower = header.to_lowercase();
    for (suf, units, dec) in [
        ("_psi", "psi", 1u8),
        ("_kpa", "kPa", 1),
        ("_bar", "bar", 2),
        ("_c", "°C", 1),
        ("_f", "°F", 1),
        ("_pct", "%", 1),
        ("_rpm", "rpm", 0),
        ("_v", "V", 2),
        ("_a", "A", 2),
        ("_hz", "Hz", 1),
        ("_mm", "mm", 1),
        ("_g", "g", 2),
    ] {
        if lower.ends_with(suf) {
            return (units.to_string(), dec);
        }
    }
    ("".to_string(), 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = r##"
channels:
  - id: engine.rpm
    display_name: Engine RPM
    units: rpm
    group: Engine
    color: "#FFB800"
    decimals: 0
    data_type: f32
    source: link_g4x
    sample_rate_hz: 100
    aliases: [rpm, RPM]
    match_keywords: [rpm, "engine speed"]
    match_units: ["RPM", rpm]

  - id: engine.tps
    display_name: Throttle Position
    units: "%"
    group: Engine
    color: "#4FC3F7"
    decimals: 1
    data_type: f32
    source: link_g4x
    sample_rate_hz: 100
    aliases: [tps, "Throttle Position"]
    match_keywords: [tps, throttle, aps]
    match_units: ["%"]

  - id: engine.oil_temp
    display_name: Oil Temp
    units: "°C"
    group: Engine
    color: "#FF8A65"
    decimals: 1
    data_type: f32
    source: link_g4x
    sample_rate_hz: 10
    match_keywords: [oil]
    match_units: ["°C"]

  - id: engine.oil_pressure
    display_name: Oil Pressure
    units: kPa
    group: Engine
    color: "#FF6F00"
    decimals: 1
    data_type: f32
    source: link_g4x
    sample_rate_hz: 10
    match_keywords: [oil]
    match_units: [kPa]
"##;

    #[test]
    fn resolves_id_and_aliases() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        assert_eq!(r.resolve("engine.rpm").unwrap().display_name, "Engine RPM");
        assert_eq!(r.resolve("rpm").unwrap().id, "engine.rpm");
        assert_eq!(r.resolve("RPM").unwrap().id, "engine.rpm");
        assert!(r.resolve("nope").is_none());
    }

    #[test]
    fn semantic_matches_tps_with_parens() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let res = r.resolve_or_default("TPS (Main)", "%", 100.0);
        assert!(matches!(res.kind, ResolveKind::Semantic));
        assert_eq!(res.meta.id, "engine.tps");
    }

    #[test]
    fn semantic_units_disambiguate_oil_temp_vs_pressure() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let temp = r.resolve_or_default("Oil Temperature", "°C", 10.0);
        assert!(matches!(temp.kind, ResolveKind::Semantic));
        assert_eq!(temp.meta.id, "engine.oil_temp");

        let press = r.resolve_or_default("Oil Pressure", "kPa", 10.0);
        assert!(matches!(press.kind, ResolveKind::Semantic));
        assert_eq!(press.meta.id, "engine.oil_pressure");
    }

    #[test]
    fn semantic_strict_when_unit_unknown() {
        // "GP RPM Limit 1" contains "rpm" but the source CSV's units row had
        // an empty cell for it. With unit_strict patterns we require a higher
        // keyword score before accepting — single keyword + unknown unit is
        // not enough to confidently route this to engine.rpm.
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let res = r.resolve_or_default("GP RPM Limit 1", "", 100.0);
        assert!(matches!(res.kind, ResolveKind::Default), "expected default, got {:?}", res.kind);
        assert_eq!(res.meta.id, "GP RPM Limit 1");
    }

    #[test]
    fn semantic_word_boundary_avoids_false_positive() {
        // "rpm" must not match a name that has the letters "rpm" embedded in
        // a longer token (e.g. "Inrpmthing"). normalize_name + word-bounded
        // substring keeps this clean.
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let res = r.resolve_or_default("Inrpmthing", "RPM", 100.0);
        // Doesn't normalize to a token containing standalone "rpm".
        assert!(!matches!(res.kind, ResolveKind::Semantic));
    }

    #[test]
    fn unknown_uses_suffix_units() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let res = r.resolve_or_default("brake_pressure_psi", "", 100.0);
        assert!(matches!(res.kind, ResolveKind::Default));
        assert_eq!(res.meta.units, "psi");
        assert_eq!(res.meta.decimals, 1);
        assert_eq!(res.meta.group, "Unknown");
    }

    #[test]
    fn default_carries_unit_hint_when_no_alias() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let res = r.resolve_or_default("Wheel Slip Front", "%", 100.0);
        assert_eq!(res.meta.units, "%");
    }

    #[test]
    fn unknown_no_suffix_is_dimensionless() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let res = r.resolve_or_default("foo", "", 100.0);
        assert!(matches!(res.kind, ResolveKind::Default));
        assert_eq!(res.meta.units, "");
    }

    #[test]
    fn real_channels_yaml_parses() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/channels.yaml");
        let r = ChannelRegistry::from_path(&path).expect("docs/channels.yaml must parse");
        assert!(r.resolve("engine.rpm").is_some());
        assert!(r.resolve("rpm").is_some());
        assert!(r.resolve("gps.lat").is_some());
    }

    #[test]
    fn name_normalize_strips_punct_and_collapses() {
        assert_eq!(normalize_name("TPS (Main)"), "tps main");
        assert_eq!(normalize_name("DI 1 - TransSpeed"), "di 1 transspeed");
        assert_eq!(normalize_name("  spaces   collapsed  "), "spaces collapsed");
    }

    /// Two distinct canonical ids competing for the same alias used to
    /// silently overwrite (last entry wins). Now it surfaces as a
    /// `DuplicateAlias` error so the channels.yaml author sees it.
    #[test]
    fn duplicate_alias_across_channels_errors() {
        const YAML_DUP: &str = r##"
channels:
  - id: engine.a
    display_name: A
    units: ""
    group: t
    color: "#fff"
    decimals: 0
    data_type: f32
    source: t
    sample_rate_hz: 100
    aliases: [shared]
  - id: engine.b
    display_name: B
    units: ""
    group: t
    color: "#fff"
    decimals: 0
    data_type: f32
    source: t
    sample_rate_hz: 100
    aliases: [shared]
"##;
        let err = ChannelRegistry::from_yaml(YAML_DUP).err()
            .expect("expected DuplicateAlias error");
        match err {
            RegistryError::DuplicateAlias { alias, first_id, second_id } => {
                assert_eq!(alias, "shared");
                assert_eq!(first_id, "engine.a");
                assert_eq!(second_id, "engine.b");
            }
            other => panic!("expected DuplicateAlias, got {other:?}"),
        }
    }

    /// A channel listing its own id in `aliases:` is harmless redundancy
    /// (and exists in docs/channels.yaml today) — must NOT error.
    #[test]
    fn self_alias_is_not_a_duplicate() {
        const YAML_SELF: &str = r##"
channels:
  - id: engine.rpm
    display_name: RPM
    units: rpm
    group: Engine
    color: "#fff"
    decimals: 0
    data_type: f32
    source: t
    sample_rate_hz: 100
    aliases: ["engine.rpm", rpm]
"##;
        let r = ChannelRegistry::from_yaml(YAML_SELF).expect("self-aliasing must load cleanly");
        assert_eq!(r.resolve("engine.rpm").unwrap().id, "engine.rpm");
        assert_eq!(r.resolve("rpm").unwrap().id, "engine.rpm");
    }

    #[test]
    fn unit_normalize_handles_synonyms() {
        assert_eq!(normalize_unit("°C"), "c");
        assert_eq!(normalize_unit("kph"), "kmh");
        assert_eq!(normalize_unit("km/h"), "kmh");
        assert_eq!(normalize_unit("RPM"), "rpm");
        assert_eq!(normalize_unit("%"), "%");
        assert_eq!(normalize_unit(""), "");
        assert_eq!(normalize_unit("m/s"), "m_per_s");
        assert_eq!(normalize_unit("kPa"), "kpa");
    }

    /// Regression for the audit (2026-05-11): m/s (which the normalizer
    /// strips to "mps") must NOT collide with milliseconds ("ms"). Both
    /// canonicalize to distinct strings so a future channel using either
    /// unit can't be misrouted to the other.
    #[test]
    fn unit_normalize_mps_does_not_collide_with_ms() {
        assert_eq!(normalize_unit("m/s"), "m_per_s");
        assert_eq!(normalize_unit("ms"), "ms");
        assert_ne!(normalize_unit("m/s"), normalize_unit("ms"));
    }
}
