use helios_core::{ChannelMeta, DataType};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

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
}

pub struct ChannelRegistry {
    by_alias: HashMap<String, ChannelMeta>,
}

impl ChannelRegistry {
    pub fn from_yaml(yaml: &str) -> Result<Self, serde_yaml::Error> {
        let file: RegistryFile = serde_yaml::from_str(yaml)?;
        let mut by_alias = HashMap::new();
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
            };
            by_alias.insert(e.id.clone(), meta.clone());
            for a in e.aliases {
                by_alias.insert(a, meta.clone());
            }
        }
        Ok(Self { by_alias })
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
    /// The default is dimensionless f64 at 100 Hz, group="Unknown".
    pub fn resolve_or_default(&self, header: &str, default_rate_hz: f32) -> (ChannelMeta, bool) {
        if let Some(m) = self.by_alias.get(header) {
            return (m.clone(), true);
        }
        let (units, decimals) = guess_units_from_suffix(header);
        let meta = ChannelMeta {
            id: header.to_string(),
            display_name: header.to_string(),
            units,
            group: "Unknown".into(),
            color: "#888888".into(),
            decimals,
            data_type: DataType::F64,
            source: "csv".into(),
            sample_rate_hz: default_rate_hz,
            min: None, max: None, warn: None, alarm: None,
        };
        (meta, false)
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
    fn unknown_uses_suffix_units() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let (m, was_known) = r.resolve_or_default("brake_pressure_psi", 100.0);
        assert!(!was_known);
        assert_eq!(m.units, "psi");
        assert_eq!(m.decimals, 1);
        assert_eq!(m.group, "Unknown");
    }

    #[test]
    fn unknown_no_suffix_is_dimensionless() {
        let r = ChannelRegistry::from_yaml(YAML).unwrap();
        let (m, was_known) = r.resolve_or_default("foo", 100.0);
        assert!(!was_known);
        assert_eq!(m.units, "");
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
}
