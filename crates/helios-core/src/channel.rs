use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataType { F32, F64, U16, Bool, Enum }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelMeta {
    pub id: String,
    pub display_name: String,
    pub units: String,
    pub group: String,
    pub color: String,
    pub decimals: u8,
    pub data_type: DataType,
    pub source: String,
    pub sample_rate_hz: f32,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub warn: Option<f64>,
    pub alarm: Option<f64>,
    /// The original CSV header text that resolved to this channel, when the
    /// channel was ingested from a tabular source. `None` for math/derived
    /// channels (no source column exists). Required for the per-session
    /// channel-override UI (v3.2.0): a user-facing remap of `engine.aps` to a
    /// different source column needs to identify columns by what they actually
    /// looked like in the CSV, not by the canonical id the resolver assigned.
    ///
    /// `#[serde(default, skip_serializing_if = "Option::is_none")]` keeps
    /// older serialized blobs (e.g. legacy stored math-channel JSON) accepted
    /// and avoids bloating output for math channels that don't have a source
    /// header to record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_header: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_meta_roundtrip_json() {
        let m = ChannelMeta {
            id: "engine.rpm".into(),
            display_name: "Engine RPM".into(),
            units: "rpm".into(),
            group: "Engine".into(),
            color: "#FFB800".into(),
            decimals: 0,
            data_type: DataType::F32,
            source: "link_g4x".into(),
            sample_rate_hz: 100.0,
            min: Some(0.0),
            max: Some(15000.0),
            warn: Some(13500.0),
            alarm: Some(14500.0),
            source_header: Some("Engine Speed".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: ChannelMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }

    /// Older serialized ChannelMeta blobs (pre-3.2.0) do not include the
    /// `source_header` field. With `#[serde(default)]` they must still
    /// deserialize cleanly and surface `None`.
    #[test]
    fn channel_meta_deserializes_without_source_header() {
        let legacy = r##"{
            "id": "engine.rpm",
            "display_name": "Engine RPM",
            "units": "rpm",
            "group": "Engine",
            "color": "#FFB800",
            "decimals": 0,
            "data_type": "f32",
            "source": "link_g4x",
            "sample_rate_hz": 100.0,
            "min": 0.0, "max": 15000.0,
            "warn": 13500.0, "alarm": 14500.0
        }"##;
        let m: ChannelMeta = serde_json::from_str(legacy).unwrap();
        assert_eq!(m.source_header, None);
    }
}
