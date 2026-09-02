use crate::error::HtpError;
use crate::types::{ChannelSetDef, GroupDef};

pub const MAGIC: u16 = 0x4854;
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 36;
pub const MAX_WINDOWS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub t_start_us: u64,
    /// samples[channel_index][sample_index], channel order = group.channels
    pub samples: Vec<Vec<Option<f64>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub session_id: [u8; 16],
    pub channel_set_id: u16,
    pub group_key: u8,
    pub first_seq: u32,
    pub send_timestamp_ms: u64,
    pub windows: Vec<Window>,
}

/// Encodes one frame for `group` (the group must match `frame.group_key`).
pub fn encode_frame(frame: &Frame, group: &GroupDef) -> Result<Vec<u8>, HtpError> {
    let n = frame.windows.len();
    if n == 0 || n > MAX_WINDOWS {
        return Err(HtpError::BadWindowCount(n as u8));
    }
    let mut out = Vec::with_capacity(HEADER_LEN + n * group.window_bytes());
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.push(VERSION);
    out.push(0);
    out.extend_from_slice(&frame.session_id);
    out.extend_from_slice(&frame.channel_set_id.to_le_bytes());
    out.push(frame.group_key);
    out.push(n as u8);
    out.extend_from_slice(&frame.first_seq.to_le_bytes());
    out.extend_from_slice(&frame.send_timestamp_ms.to_le_bytes());
    let want = group.rate_hz as usize;
    for (wi, w) in frame.windows.iter().enumerate() {
        if w.samples.len() != group.channels.len() {
            return Err(HtpError::BadValueCount { got: w.samples.len(), want: group.channels.len() });
        }
        out.extend_from_slice(&w.t_start_us.to_le_bytes());
        for (ch, col) in group.channels.iter().zip(&w.samples) {
            if col.len() != want {
                return Err(HtpError::BadSampleCount { window: wi, channel: ch.id.clone(), got: col.len(), want });
            }
            for v in col {
                ch.encode(*v, &mut out);
            }
        }
    }
    Ok(out)
}

/// Parses only the 36-byte header (what the edge function does before loading the set).
pub fn parse_header(bytes: &[u8]) -> Result<Frame, HtpError> {
    if bytes.len() < HEADER_LEN {
        return Err(HtpError::BadLength { expected: HEADER_LEN, actual: bytes.len() });
    }
    let magic = u16::from_le_bytes([bytes[0], bytes[1]]);
    if magic != MAGIC { return Err(HtpError::BadMagic(magic)); }
    if bytes[2] != VERSION { return Err(HtpError::BadVersion(bytes[2])); }
    if bytes[3] != 0 { return Err(HtpError::BadFlags(bytes[3])); }
    let mut session_id = [0u8; 16];
    session_id.copy_from_slice(&bytes[4..20]);
    let n = bytes[23];
    if n == 0 || n as usize > MAX_WINDOWS { return Err(HtpError::BadWindowCount(n)); }
    Ok(Frame {
        session_id,
        channel_set_id: u16::from_le_bytes([bytes[20], bytes[21]]),
        group_key: bytes[22],
        first_seq: u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
        send_timestamp_ms: u64::from_le_bytes(bytes[28..36].try_into().unwrap()),
        windows: Vec::with_capacity(n as usize),
    })
}

pub fn decode_frame(bytes: &[u8], set: &ChannelSetDef) -> Result<Frame, HtpError> {
    let mut frame = parse_header(bytes)?;
    let n = bytes[23] as usize;
    let group = set.group(frame.group_key).ok_or(HtpError::UnknownGroup(frame.group_key))?;
    let expected = HEADER_LEN + n * group.window_bytes();
    if bytes.len() != expected {
        return Err(HtpError::BadLength { expected, actual: bytes.len() });
    }
    let rate = group.rate_hz as usize;
    let mut p = HEADER_LEN;
    for _ in 0..n {
        let t_start_us = u64::from_le_bytes(bytes[p..p + 8].try_into().unwrap());
        p += 8;
        let mut samples = Vec::with_capacity(group.channels.len());
        for ch in &group.channels {
            let w = ch.width();
            let mut col = Vec::with_capacity(rate);
            for _ in 0..rate {
                col.push(ch.decode(&bytes[p..p + w]));
                p += w;
            }
            samples.push(col);
        }
        frame.windows.push(Window { t_start_us, samples });
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ChannelDef, Enc};
    use std::collections::BTreeMap;

    fn set() -> ChannelSetDef {
        let mut groups = BTreeMap::new();
        groups.insert("0".to_string(), GroupDef {
            rate_hz: 2,
            channels: vec![
                ChannelDef { id: "a".into(), enc: Enc::I16fp, scale: 0.5, offset: 0.0 },
                ChannelDef { id: "b".into(), enc: Enc::F32, scale: 1.0, offset: 0.0 },
            ],
        });
        ChannelSetDef { groups }
    }

    fn frame() -> Frame {
        Frame {
            session_id: *uuid::Uuid::parse_str("9b2f1c3e-4d5a-4b6c-8d7e-0f1a2b3c4d5e").unwrap().as_bytes(),
            channel_set_id: 1,
            group_key: 0,
            first_seq: 1042,
            send_timestamp_ms: 1_781_234_567_890,
            windows: vec![
                Window { t_start_us: 1_781_234_560_000_000, samples: vec![vec![Some(8123.0), Some(8204.5)], vec![Some(1.5), None]] },
                Window { t_start_us: 1_781_234_561_000_000, samples: vec![vec![None, Some(0.0)], vec![Some(-2.25), Some(3.0)]] },
            ],
        }
    }

    #[test]
    fn header_layout_is_byte_exact() {
        let bytes = encode_frame(&frame(), set().group(0).unwrap()).unwrap();
        assert_eq!(&bytes[0..2], &0x4854u16.to_le_bytes());
        assert_eq!(bytes[2], 1);
        assert_eq!(bytes[3], 0);
        assert_eq!(&bytes[4..20], &frame().session_id);
        assert_eq!(&bytes[20..22], &1u16.to_le_bytes());
        assert_eq!(bytes[22], 0);
        assert_eq!(bytes[23], 2);
        assert_eq!(&bytes[24..28], &1042u32.to_le_bytes());
        assert_eq!(&bytes[28..36], &1_781_234_567_890u64.to_le_bytes());
        // 2 windows x (8 + 2x2 + 2x4)
        assert_eq!(bytes.len(), HEADER_LEN + 2 * (8 + 4 + 8));
    }

    #[test]
    fn roundtrip() {
        let f = frame();
        let bytes = encode_frame(&f, set().group(0).unwrap()).unwrap();
        assert_eq!(decode_frame(&bytes, &set()).unwrap(), f);
    }

    #[test]
    fn rejects_bad_length_magic_group_and_count() {
        let s = set();
        let mut bytes = encode_frame(&frame(), s.group(0).unwrap()).unwrap();
        bytes.push(0);
        assert!(matches!(decode_frame(&bytes, &s), Err(HtpError::BadLength { .. })));
        bytes.pop();
        bytes[0] = 0;
        assert!(matches!(decode_frame(&bytes, &s), Err(HtpError::BadMagic(_))));
        bytes[0] = 0x54;
        bytes[22] = 9;
        assert!(matches!(decode_frame(&bytes, &s), Err(HtpError::UnknownGroup(9))));
        bytes[22] = 0;
        bytes[23] = 0;
        assert!(matches!(decode_frame(&bytes, &s), Err(HtpError::BadWindowCount(0))));
    }

    #[test]
    fn encode_rejects_wrong_sample_count() {
        let mut f = frame();
        f.windows[0].samples[0].push(Some(1.0));
        assert!(matches!(encode_frame(&f, set().group(0).unwrap()), Err(HtpError::BadSampleCount { .. })));
    }
}
