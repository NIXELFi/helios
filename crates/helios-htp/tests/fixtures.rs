//! Every fixture must roundtrip through this crate. The firmware repo vendors
//! the same files and byte-compares its C encoder against the `.htp`/`.bin`.
use helios_htp::*;
use std::{fs, path::PathBuf};

fn dir() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures") }

#[derive(serde::Deserialize)]
struct JsonWindow { t_start_us: u64, samples: std::collections::BTreeMap<String, Vec<Option<f64>>> }
#[derive(serde::Deserialize)]
struct JsonFrame { session_id: String, channel_set_id: u16, group_key: u8, seq: u32, send_timestamp_ms: u64, windows: Vec<JsonWindow> }

fn set() -> ChannelSetDef {
    serde_json::from_slice(&fs::read(dir().join("channel_set_1.json")).unwrap()).unwrap()
}

#[test]
fn htp1_fixtures_roundtrip() {
    let set = set();
    let mut n = 0;
    for entry in fs::read_dir(dir().join("htp1")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().map(|e| e != "htp").unwrap_or(true) { continue; }
        let bytes = fs::read(&path).unwrap();
        let json: JsonFrame = serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        let decoded = decode_frame(&bytes, &set).unwrap();
        assert_eq!(uuid::Uuid::from_bytes(decoded.session_id).to_string(), json.session_id);
        assert_eq!((decoded.channel_set_id, decoded.group_key, decoded.first_seq, decoded.send_timestamp_ms),
                   (json.channel_set_id, json.group_key, json.seq, json.send_timestamp_ms));
        let group = set.group(json.group_key).unwrap();
        for (w, jw) in decoded.windows.iter().zip(&json.windows) {
            assert_eq!(w.t_start_us, jw.t_start_us);
            for (ch, col) in group.channels.iter().zip(&w.samples) {
                assert_eq!(col, &jw.samples[&ch.id], "{}", ch.id);
            }
        }
        // re-encode must be byte-identical
        assert_eq!(encode_frame(&decoded, group).unwrap(), bytes, "{}", path.display());
        n += 1;
    }
    assert!(n >= 3, "expected one fixture per group, found {n}");
}

#[derive(serde::Deserialize)]
struct JsonLive { cs: u16, values: Vec<(String, Option<f64>)> }

#[test]
fn live_fixtures_roundtrip() {
    let set = set();
    let mut n = 0;
    for entry in fs::read_dir(dir().join("live")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().map(|e| e != "bin").unwrap_or(true) { continue; }
        let bytes = fs::read(&path).unwrap();
        let json: JsonLive = serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        assert_eq!(json.cs, 1);
        assert_eq!(unpack_live(&set, &bytes).unwrap(), json.values);
        let vals: Vec<Option<f64>> = json.values.iter().map(|(_, v)| *v).collect();
        assert_eq!(pack_live(&set, &vals).unwrap(), bytes);
        n += 1;
    }
    assert!(n >= 2);
}
