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
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: ChannelMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }
}
