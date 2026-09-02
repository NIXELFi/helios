//! Writes deterministic golden fixtures. Re-run only when the protocol changes;
//! commit the output. `cargo run -p helios-htp --bin gen-fixtures`
use helios_htp::*;
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf};

const SESSION: &str = "9b2f1c3e-4d5a-4b6c-8d7e-0f1a2b3c4d5e";
const T0_US: u64 = 1_781_234_560_000_000;
const SEND_MS: u64 = 1_781_234_567_890;

/// Deterministic, physically-plausible-ish value per (group, channel, sample);
/// every 13th sample is null to exercise the sentinel.
fn value(g: u8, c: usize, s: usize) -> Option<f64> {
    if (c + s) % 13 == 12 { return None; }
    let base = match g { 0 => 100.0 * (c as f64 + 1.0), 1 => 33.0 + c as f64, _ => 20.0 + c as f64 };
    Some(base + (s as f64) * 0.25 - (c as f64) * 0.125)
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    // Channel set 1 is copied verbatim from infra/telemetry-supabase/supabase/seed.sql.
    let set_json = fs::read_to_string(root.join("channel_set_1.json")).expect("fixtures/channel_set_1.json must exist (extract from seed.sql)");
    let set: ChannelSetDef = serde_json::from_str(&set_json).unwrap();
    let session_id = *uuid::Uuid::parse_str(SESSION).unwrap().as_bytes();
    fs::create_dir_all(root.join("htp1")).unwrap();
    fs::create_dir_all(root.join("live")).unwrap();

    for (gk, group) in set.sorted_groups() {
        for &nwin in &[1usize, 4] {
            let windows: Vec<Window> = (0..nwin).map(|w| Window {
                t_start_us: T0_US + w as u64 * 1_000_000,
                samples: (0..group.channels.len()).map(|c| (0..group.rate_hz as usize).map(|s| value(gk, c, s + w * 100)).collect()).collect(),
            }).collect();
            let frame = Frame { session_id, channel_set_id: 1, group_key: gk, first_seq: 1042, send_timestamp_ms: SEND_MS, windows };
            let bytes = encode_frame(&frame, group).unwrap();
            let name = format!("set1_g{gk}_w{nwin}");
            fs::write(root.join("htp1").join(format!("{name}.htp")), &bytes).unwrap();
            // JSON carries the POST-DECODE values (quantised + clamped), so decode == json
            // and re-encode == bytes hold for any scale. Never write the raw inputs here.
            let frame = decode_frame(&bytes, &set).unwrap();
            let json_windows: Vec<Value> = frame.windows.iter().map(|w| {
                let mut m = Map::new();
                for (ch, col) in group.channels.iter().zip(&w.samples) { m.insert(ch.id.clone(), json!(col)); }
                json!({ "t_start_us": w.t_start_us, "samples": m })
            }).collect();
            let j = json!({ "session_id": SESSION, "channel_set_id": 1, "group_key": gk, "seq": 1042,
                            "send_timestamp_ms": SEND_MS, "windows": json_windows });
            fs::write(root.join("htp1").join(format!("{name}.json")), serde_json::to_string_pretty(&j).unwrap()).unwrap();
        }
    }

    for (i, null_every) in [(0usize, usize::MAX), (1, 5)] {
        let mut values = Vec::new();
        for (gk, g) in set.sorted_groups() {
            for (c, ch) in g.channels.iter().enumerate() {
                let v = if null_every != usize::MAX && c % null_every == 0 { None } else { value(gk, c, i) };
                values.push((ch.id.clone(), v));
            }
        }
        let vals: Vec<Option<f64>> = values.iter().map(|(_, v)| *v).collect();
        let bytes = pack_live(&set, &vals).unwrap();
        // store what unpack returns (post-quantisation), so the JSON is the exact decode
        let decoded = unpack_live(&set, &bytes).unwrap();
        fs::write(root.join("live").join(format!("live_{i}.bin")), &bytes).unwrap();
        fs::write(root.join("live").join(format!("live_{i}.json")),
                  serde_json::to_string_pretty(&json!({ "cs": 1, "values": decoded })).unwrap()).unwrap();
    }
    println!("fixtures written to {}", root.display());
}
