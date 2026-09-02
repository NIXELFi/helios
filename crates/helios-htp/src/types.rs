use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Enc {
    I16fp,
    F32,
}

fn one() -> f64 { 1.0 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelDef {
    pub id: String,
    pub enc: Enc,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub offset: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupDef {
    pub rate_hz: u32,
    pub channels: Vec<ChannelDef>,
}

/// Mirrors `telemetry.channel_sets.definition` exactly: `{"groups":{"0":{...}}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelSetDef {
    pub groups: BTreeMap<String, GroupDef>,
}

pub const I16_NULL: i16 = i16::MIN; // 0x8000 null sentinel

impl ChannelDef {
    pub fn width(&self) -> usize {
        match self.enc { Enc::I16fp => 2, Enc::F32 => 4 }
    }

    /// Appends one encoded sample. `None`/NaN -> null sentinel (i16fp) or NaN (f32).
    pub fn encode(&self, v: Option<f64>, out: &mut Vec<u8>) {
        match self.enc {
            Enc::I16fp => {
                let raw = match v {
                    Some(x) if x.is_finite() => {
                        let r = ((x - self.offset) / self.scale).round();
                        // clamp to +/-32767 so a real value can never alias the null sentinel
                        r.clamp(-(i16::MAX as f64), i16::MAX as f64) as i16
                    }
                    _ => I16_NULL,
                };
                out.extend_from_slice(&raw.to_le_bytes());
            }
            Enc::F32 => {
                let f = match v { Some(x) => x as f32, None => f32::NAN };
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
    }

    /// Decodes one sample from the first `width()` bytes of `b`.
    pub fn decode(&self, b: &[u8]) -> Option<f64> {
        match self.enc {
            Enc::I16fp => {
                let raw = i16::from_le_bytes([b[0], b[1]]);
                if raw == I16_NULL { None } else { Some(raw as f64 * self.scale + self.offset) }
            }
            Enc::F32 => {
                let f = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                if f.is_nan() { None } else { Some(f as f64) }
            }
        }
    }
}

impl GroupDef {
    /// 8 (t_start_us) + sum rate*width -- one window, dense rectangle.
    pub fn window_bytes(&self) -> usize {
        8 + self.channels.iter().map(|c| self.rate_hz as usize * c.width()).sum::<usize>()
    }
}

impl ChannelSetDef {
    pub fn group(&self, key: u8) -> Option<&GroupDef> {
        self.groups.get(&key.to_string())
    }

    /// Groups in ascending numeric key order (BTreeMap sorts "10" before "2").
    pub fn sorted_groups(&self) -> Vec<(u8, &GroupDef)> {
        let mut v: Vec<(u8, &GroupDef)> = self
            .groups
            .iter()
            .filter_map(|(k, g)| k.parse::<u8>().ok().map(|k| (k, g)))
            .collect();
        v.sort_by_key(|(k, _)| *k);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i16ch(scale: f64, offset: f64) -> ChannelDef {
        ChannelDef { id: "x".into(), enc: Enc::I16fp, scale, offset }
    }

    #[test]
    fn i16fp_roundtrips_at_documented_resolution() {
        let ch = i16ch(0.5, 0.0);
        let mut out = Vec::new();
        ch.encode(Some(8123.0), &mut out);
        assert_eq!(out, 16246i16.to_le_bytes());
        assert_eq!(ch.decode(&out), Some(8123.0));
    }

    #[test]
    fn i16fp_offset_and_clamp() {
        let ch = i16ch(0.0001, 0.6); // lambda: 0.6 + raw*1e-4
        let mut out = Vec::new();
        ch.encode(Some(1.0), &mut out);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), 4000);
        out.clear();
        ch.encode(Some(1e9), &mut out); // clamps, never wraps into the null sentinel
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), i16::MAX);
        out.clear();
        ch.encode(Some(-1e9), &mut out);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), -i16::MAX);
    }

    #[test]
    fn i16fp_null_sentinel() {
        let ch = i16ch(1.0, 0.0);
        let mut out = Vec::new();
        ch.encode(None, &mut out);
        assert_eq!(out, I16_NULL.to_le_bytes());
        ch.encode(Some(f64::NAN), &mut out);
        assert_eq!(&out[2..], &I16_NULL.to_le_bytes()[..]);
        assert_eq!(ch.decode(&out[..2]), None);
    }

    #[test]
    fn f32_bit_exact() {
        let ch = ChannelDef { id: "g".into(), enc: Enc::F32, scale: 1.0, offset: 0.0 };
        let v = 33.4231f32 as f64;
        let mut out = Vec::new();
        ch.encode(Some(v), &mut out);
        assert_eq!(out, (v as f32).to_le_bytes());
        assert_eq!(ch.decode(&out), Some(v));
        out.clear();
        ch.encode(None, &mut out);
        assert!(ch.decode(&out).is_none()); // NaN -> None
    }

    #[test]
    fn group_window_bytes_matches_spec_math() {
        let g = GroupDef { rate_hz: 10, channels: (0..22).map(|i| { let mut c = i16ch(1.0, 0.0); c.id = format!("c{i}"); c }).collect() };
        assert_eq!(g.window_bytes(), 8 + 22 * 10 * 2);
    }

    #[test]
    fn definition_json_matches_seed_shape() {
        let json = r#"{"groups":{"0":{"rate_hz":10,"channels":[{"id":"engine.rpm","enc":"i16fp","scale":0.5,"offset":0}]},"1":{"rate_hz":10,"channels":[{"id":"gps.lat_ref","enc":"f32"}]}}}"#;
        let def: ChannelSetDef = serde_json::from_str(json).unwrap();
        assert_eq!(def.group(1).unwrap().channels[0].scale, 1.0);
        assert_eq!(def.sorted_groups().iter().map(|(k, _)| *k).collect::<Vec<_>>(), vec![0, 1]);
        assert!(def.group(7).is_none());
    }
}
