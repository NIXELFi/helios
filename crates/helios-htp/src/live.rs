use crate::error::HtpError;
use crate::types::ChannelSetDef;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};

/// Wire shape of the Realtime `live_fast` broadcast payload (spec §3.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMessage {
    pub seq: u32,
    pub t_us: u64,
    pub t_send_ms: u64,
    pub cs: u16,
    /// base64 of `pack_live`
    pub v: String,
}

/// Bytes in one `live_fast` value blob for this set: one sample per channel,
/// groups ascending, channels in registered order.
pub fn live_len(set: &ChannelSetDef) -> usize {
    set.sorted_groups().iter().map(|(_, g)| g.channels.iter().map(|c| c.width()).sum::<usize>()).sum()
}

/// `values` must be in `live` order (see `live_len`), one per channel.
pub fn pack_live(set: &ChannelSetDef, values: &[Option<f64>]) -> Result<Vec<u8>, HtpError> {
    let want: usize = set.sorted_groups().iter().map(|(_, g)| g.channels.len()).sum();
    if values.len() != want {
        return Err(HtpError::BadValueCount { got: values.len(), want });
    }
    let mut out = Vec::with_capacity(live_len(set));
    let mut i = 0;
    for (_, g) in set.sorted_groups() {
        for ch in &g.channels {
            ch.encode(values[i], &mut out);
            i += 1;
        }
    }
    Ok(out)
}

pub fn unpack_live(set: &ChannelSetDef, bytes: &[u8]) -> Result<Vec<(String, Option<f64>)>, HtpError> {
    let expected = live_len(set);
    if bytes.len() != expected {
        return Err(HtpError::BadLength { expected, actual: bytes.len() });
    }
    let mut out = Vec::new();
    let mut p = 0;
    for (_, g) in set.sorted_groups() {
        for ch in &g.channels {
            let w = ch.width();
            out.push((ch.id.clone(), ch.decode(&bytes[p..p + w])));
            p += w;
        }
    }
    Ok(out)
}

impl LiveMessage {
    pub fn new(seq: u32, t_us: u64, t_send_ms: u64, cs: u16, packed: &[u8]) -> Self {
        Self { seq, t_us, t_send_ms, cs, v: B64.encode(packed) }
    }
    pub fn decode_values(&self) -> Result<Vec<u8>, HtpError> {
        B64.decode(&self.v).map_err(|e| HtpError::Base64(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ChannelDef, Enc, GroupDef};
    use std::collections::BTreeMap;

    fn set() -> ChannelSetDef {
        let mut groups = BTreeMap::new();
        groups.insert("2".into(), GroupDef { rate_hz: 1, channels: vec![ChannelDef { id: "temp".into(), enc: Enc::I16fp, scale: 0.01, offset: 0.0 }] });
        groups.insert("0".into(), GroupDef { rate_hz: 10, channels: vec![
            ChannelDef { id: "rpm".into(), enc: Enc::I16fp, scale: 0.5, offset: 0.0 },
            ChannelDef { id: "lat".into(), enc: Enc::F32, scale: 1.0, offset: 0.0 },
        ] });
        ChannelSetDef { groups }
    }

    #[test]
    fn length_and_order_follow_ascending_group_keys() {
        assert_eq!(live_len(&set()), 2 + 4 + 2);
        let bytes = pack_live(&set(), &[Some(8000.0), Some(1.5), None]).unwrap();
        assert_eq!(&bytes[0..2], &16000i16.to_le_bytes());
        assert_eq!(&bytes[2..6], &1.5f32.to_le_bytes());
        assert_eq!(&bytes[6..8], &i16::MIN.to_le_bytes());
    }

    #[test]
    fn unpack_roundtrip_returns_ids_in_pack_order() {
        let vals = [Some(8000.0), Some(1.5), None];
        let bytes = pack_live(&set(), &vals).unwrap();
        let out = unpack_live(&set(), &bytes).unwrap();
        assert_eq!(out, vec![("rpm".to_string(), Some(8000.0)), ("lat".to_string(), Some(1.5)), ("temp".to_string(), None)]);
    }

    #[test]
    fn rejects_wrong_value_count_and_bad_length() {
        assert!(matches!(pack_live(&set(), &[Some(1.0)]), Err(HtpError::BadValueCount { got: 1, want: 3 })));
        assert!(matches!(unpack_live(&set(), &[0u8; 5]), Err(HtpError::BadLength { expected: 8, actual: 5 })));
    }

    #[test]
    fn message_json_shape() {
        let m = LiveMessage { seq: 7, t_us: 10, t_send_ms: 11, cs: 1, v: B64.encode([1u8, 2]) };
        let s = serde_json::to_string(&m).unwrap();
        assert_eq!(s, r#"{"seq":7,"t_us":10,"t_send_ms":11,"cs":1,"v":"AQI="}"#);
        assert_eq!(m.decode_values().unwrap(), vec![1u8, 2]);
    }
}
