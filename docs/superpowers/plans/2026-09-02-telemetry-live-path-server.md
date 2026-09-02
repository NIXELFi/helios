# Telemetry Live Path (server + Helios) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the ≤ 500 ms live telemetry path in the Helios monorepo: protocol crate + golden fixtures, Realtime channel authorization, device JWT minting, self-provisioned sessions, a hardware-free reference client, and a "Connect live" source in the Logs module.

**Architecture:** The car (or the reference client) publishes a 100 ms `live_fast` broadcast straight onto a private Supabase Realtime channel; Helios subscribes, decodes against the channel-set definition, and rebuilds an immutable `ChannelStore` from ring buffers on a `requestAnimationFrame` gate. The existing HTP/1 durable ingest is merged from `feat/telemetry-pipeline` untouched. `crates/helios-htp` owns both encodings and emits golden fixtures that the TS tests and the firmware repo byte-compare.

**Tech Stack:** Rust 2021 (serde, base64, tokio-tungstenite/rustls, reqwest, hmac/sha2), Postgres RLS on `realtime.messages`, Deno edge function, Node script (HS256 via `node:crypto`), TypeScript (supabase-js Realtime, `@helios/store`, vitest).

**Spec:** `docs/superpowers/specs/2026-09-02-cellular-telemetry-fast-path.md` — read it first.

**Repo conventions that bite (from memory, all verified this session):**
- Pre-commit hook runs the CFD parity suite, ~3.5 min per commit → run `git commit` from the Bash tool with `timeout: 600000`. Batch commits per task, not per step.
- Never round-trip source files through PowerShell `Get-Content`/`Set-Content` (cp1252 + BOM). Use Bash/heredocs or the Edit tool.
- Never `supabase db push` against prod. Migrations go through the Management API query endpoint with an `sbp_` token, then get recorded in `supabase_migrations.schema_migrations` (recipe in memory `helios-migration-apply-management-api`). Prod project ref: `dlmyixonuyckxkknolku`.
- `CHANGELOG.md` needs an `[Unreleased]` entry or the release gate fails.
- `cargo test` for the Tauri desktop crate dies locally with `STATUS_ENTRYPOINT_NOT_FOUND`; test the new crates with `cargo test -p <crate>`, never `--workspace` here.
- Hosted secrets live in `infra/pdm-supabase/.env` and `infra/telemetry-supabase/.env` (gitignored).

---

## File map

**Create**
- `crates/helios-htp/Cargo.toml`, `src/lib.rs`, `src/types.rs` (channel-set definition + scalar encodings), `src/frame.rs` (HTP/1 encode/decode), `src/live.rs` (`live_fast` pack/unpack + message struct), `src/error.rs`, `src/bin/gen-fixtures.rs`
- `crates/helios-htp/fixtures/channel_set_1.json`, `fixtures/htp1/*.htp|.json`, `fixtures/live/*.bin|.json` (generated, committed)
- `infra/telemetry-supabase/supabase/migrations/20260902000000_telemetry_live_channels.sql`, `20260902000100_telemetry_session_status_live.sql` (+ copies into `infra/pdm-supabase/supabase/migrations/`)
- `infra/telemetry-supabase/scripts/mint-device-jwt.mjs`
- `infra/telemetry-supabase/supabase/functions/_shared/auth.ts` (moved), `functions/telemetry-session/index.ts`, `functions/telemetry-session/logic.ts`, `functions/telemetry-session/logic_test.ts`, `functions/telemetry-session/README.md`
- `crates/helios-telemetry-gen/Cargo.toml`, `src/main.rs`, `src/synth.rs`, `src/htp_client.rs`, `src/live_client.rs`, `src/session.rs`
- `packages/store/src/live-buffer.ts`, `packages/store/tests/live-buffer.test.ts`
- `apps/desktop/src/lib/live-decode.ts`, `apps/desktop/src/lib/__tests__/live-decode.test.ts`, `apps/desktop/src/lib/live-session.ts`, `apps/desktop/src/components/ConnectLiveDialog.tsx`

**Modify**
- `Cargo.toml` (workspace members + deps), `Cargo.lock`
- `infra/telemetry-supabase/supabase/functions/telemetry-ingest/auth.ts` (re-export from `_shared`)
- `packages/store/src/index.ts` (export live-buffer)
- `apps/desktop/src/components/SessionPanel.tsx` (Connect-live button + prop)
- `apps/desktop/src/App.tsx` (dialog state, live handles, remove-disconnects)
- `docs/telemetry-wire-protocol.md` (§9 live path), `CHANGELOG.md`

---

### Task 0: Branch + merge the June pipeline onto main

**Files:** `Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`

- [ ] **Step 1: Confirm the working tree is clean, then branch from main**

```bash
cd /c/Users/nmurray/Documents/Helios
git status --porcelain            # must be empty apart from docs/superpowers/**
git fetch origin
git checkout -b feat/telemetry-live-path origin/main
```

- [ ] **Step 2: Merge the pipeline branch; resolve Cargo.lock by regenerating**

```bash
git merge --no-ff origin/feat/telemetry-pipeline -m "merge: feat/telemetry-pipeline onto main (HTP/1 ingest, telemetry schema, compactor)"
# expected: CONFLICT (content): Merge conflict in Cargo.lock — nothing else
git checkout --ours Cargo.lock
```

Then add the compactor to the workspace. In root `Cargo.toml` `members`, after `"crates/helios-mcp",` add:

```toml
  "crates/helios-compactor",
```

(The branch's `Cargo.toml` already added it; the merge keeps it — verify with `grep -n compactor Cargo.toml`. If present, skip.)

```bash
cargo build -p helios-compactor      # rewrites Cargo.lock with only the missing entries
git add Cargo.lock Cargo.toml
git commit --no-edit                 # completes the merge; hook ~3.5 min
```

- [ ] **Step 3: Verify the merged crate tests pass**

Run: `cargo test -p helios-compactor -p helios-arrow`
Expected: all tests `ok`, 0 failed.

- [ ] **Step 4: Re-smoke prod (the function has been idle since June)**

```bash
cd infra/telemetry-supabase
python scripts/hosted-smoke-bench.py --help     # read required env from its header
```

Run it per its header (URL + service-role key from `../pdm-supabase/.env`, HMAC key from `.env`). Expected: session create → ingest 200 with `acked` → staging row readable → cleanup. If it fails with 404 the function is undeployed — stop and report; do not redeploy without asking.

- [ ] **Step 5: CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md` add:

```markdown
### Added
- **Cellular telemetry ingest (server side).** The HTP/1 wire protocol, `telemetry` schema, `telemetry-ingest` edge function and staging compactor from the June pipeline branch are now on main. No user-facing change yet.
```

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note telemetry pipeline merge"
```

---

### Task 1: `crates/helios-htp` — channel-set types + scalar encodings

**Files:**
- Create: `crates/helios-htp/Cargo.toml`, `crates/helios-htp/src/lib.rs`, `crates/helios-htp/src/error.rs`, `crates/helios-htp/src/types.rs`
- Modify: `Cargo.toml` (members + `[workspace.dependencies]`)

- [ ] **Step 1: Register the crate and shared deps**

Root `Cargo.toml` — add to `members` after `"crates/helios-compactor",`:

```toml
  "crates/helios-htp",
```

Add to `[workspace.dependencies]` (keep alphabetical-ish, after `sha2 = "0.10"`):

```toml
base64 = "0.22"
hmac = "0.12"
```

`crates/helios-htp/Cargo.toml`:

```toml
[package]
name = "helios-htp"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "Helios Telemetry Protocol: HTP/1 frames and live_fast packing (single source of truth + golden fixtures)"

[dependencies]
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
base64.workspace = true
uuid.workspace = true
```

`crates/helios-htp/src/lib.rs`:

```rust
//! HTP/1 (docs/telemetry-wire-protocol.md) + the `live_fast` value packing
//! (docs/superpowers/specs/2026-09-02-cellular-telemetry-fast-path.md §3.2).
//! Everything here is pure and allocation-light; no I/O.
pub mod error;
pub mod frame;
pub mod live;
pub mod types;

pub use error::HtpError;
pub use frame::{decode_frame, encode_frame, Frame, Window, HEADER_LEN, MAGIC, VERSION};
pub use live::{live_len, pack_live, unpack_live, LiveMessage};
pub use types::{ChannelDef, ChannelSetDef, Enc, GroupDef};
```

`crates/helios-htp/src/error.rs`:

```rust
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum HtpError {
    #[error("bad magic {0:#06x}")]
    BadMagic(u16),
    #[error("unsupported version {0}")]
    BadVersion(u8),
    #[error("flags must be 0, got {0}")]
    BadFlags(u8),
    #[error("window_count {0} outside 1..=8")]
    BadWindowCount(u8),
    #[error("unknown group_key {0}")]
    UnknownGroup(u8),
    #[error("body length {actual} != expected {expected}")]
    BadLength { expected: usize, actual: usize },
    #[error("window {window}: channel {channel} has {got} samples, group rate is {want}")]
    BadSampleCount { window: usize, channel: String, got: usize, want: usize },
    #[error("value count {got} != channel count {want}")]
    BadValueCount { got: usize, want: usize },
    #[error("base64: {0}")]
    Base64(String),
}
```

- [ ] **Step 2: Write the failing types tests**

`crates/helios-htp/src/types.rs` (tests first; implementation in step 4):

```rust
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
        assert!(ch.decode(&out).is_none()); // NaN → None
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
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p helios-htp`
Expected: compile errors (`encode`, `decode`, `window_bytes`, `group`, `sorted_groups` missing). Add empty `frame.rs` and `live.rs` files (`// filled in Task 2/3`) so `lib.rs` compiles far enough to reach those errors.

- [ ] **Step 4: Implement**

Append to `types.rs` (above the `#[cfg(test)]` block):

```rust
impl ChannelDef {
    pub fn width(&self) -> usize {
        match self.enc { Enc::I16fp => 2, Enc::F32 => 4 }
    }

    /// Appends one encoded sample. `None`/NaN → null sentinel (i16fp) or NaN (f32).
    pub fn encode(&self, v: Option<f64>, out: &mut Vec<u8>) {
        match self.enc {
            Enc::I16fp => {
                let raw = match v {
                    Some(x) if x.is_finite() => {
                        let r = ((x - self.offset) / self.scale).round();
                        // clamp to ±32767 so a real value can never alias the null sentinel
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
    /// 8 (t_start_us) + Σ rate·width — one window, dense rectangle.
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
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p helios-htp`
Expected: `test result: ok. 6 passed`.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock crates/helios-htp
git commit -m "feat(helios-htp): channel-set types and i16fp/f32 scalar encodings"
```

---

### Task 2: `helios-htp` — HTP/1 frame encode/decode

**Files:**
- Create: `crates/helios-htp/src/frame.rs`

- [ ] **Step 1: Write the failing tests**

`crates/helios-htp/src/frame.rs`:

```rust
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
        // 2 windows × (8 + 2×2 + 2×4)
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p helios-htp frame`
Expected: compile error, `encode_frame`/`decode_frame` not found.

- [ ] **Step 3: Implement** (insert above the test module)

```rust
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
```

Add `pub use frame::parse_header;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p helios-htp`
Expected: `10 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/helios-htp
git commit -m "feat(helios-htp): HTP/1 frame encode/decode with header + length validation"
```

---

### Task 3: `helios-htp` — `live_fast` packing + message struct

**Files:**
- Create: `crates/helios-htp/src/live.rs`

- [ ] **Step 1: Write the failing tests**

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p helios-htp live`
Expected: compile error, `live_len`/`pack_live`/`unpack_live`/`decode_values` missing.

- [ ] **Step 3: Implement** (above the tests)

```rust
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
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p helios-htp`
Expected: `14 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/helios-htp
git commit -m "feat(helios-htp): live_fast value packing and LiveMessage"
```

---

### Task 4: Golden fixtures (the cross-repo contract)

**Files:**
- Create: `crates/helios-htp/src/bin/gen-fixtures.rs`, `crates/helios-htp/fixtures/**` (generated), `crates/helios-htp/tests/fixtures.rs`

- [ ] **Step 1: Write the fixture-verification integration test (fails: no fixtures yet)**

`crates/helios-htp/tests/fixtures.rs`:

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p helios-htp --test fixtures`
Expected: FAIL, `No such file or directory` for `fixtures/channel_set_1.json`.

- [ ] **Step 3: Write the generator**

`crates/helios-htp/src/bin/gen-fixtures.rs`:

```rust
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
```

Both fixture kinds store **post-decode** values. This matters: `value()` returns e.g. 2200 for `drivetrain.vehicle_speed` (scale 0.01), which clamps to 327.67 on the wire, so the raw inputs would never roundtrip. The firmware tests therefore reproduce the **inputs** with their own `fixture_value()` mirror and compare **bytes**, never the JSON.

- [ ] **Step 4: Extract channel set 1 and generate**

```bash
cd /c/Users/nmurray/Documents/Helios
mkdir -p crates/helios-htp/fixtures
grep "insert into telemetry.channel_sets" infra/telemetry-supabase/supabase/seed.sql \
  | sed -E "s/.*values \(1, 'SDM26-cell-v1', 'SDM26', '(\{.*\})'::jsonb\).*/\1/" \
  | python -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read()), indent=2))" \
  > crates/helios-htp/fixtures/channel_set_1.json
cargo run -p helios-htp --bin gen-fixtures
ls crates/helios-htp/fixtures/htp1 crates/helios-htp/fixtures/live
```

Expected: 6 `.htp` + 6 `.json` (g0/g1/g2 × w1/w4), 2 `.bin` + 2 `.json`. Sanity: `set1_g0_w4.htp` is exactly 36 + 4×448 = **1828 bytes**; `live_0.bin` is **86 bytes**.

- [ ] **Step 5: Run tests**

Run: `cargo test -p helios-htp`
Expected: 14 unit + 2 integration passed.

- [ ] **Step 6: Commit**

```bash
git add crates/helios-htp
git commit -m "feat(helios-htp): golden HTP/1 and live_fast fixtures + generator"
```

---

### Task 5: Prod migrations — Realtime channel authorization + `sessions.status = 'live'`

**Files:**
- Create: `infra/telemetry-supabase/supabase/migrations/20260902000000_telemetry_live_channels.sql`, `…/20260902000100_telemetry_session_status_live.sql`
- Copy both to: `infra/pdm-supabase/supabase/migrations/`

- [ ] **Step 0: Write the status-constraint migration**

The June schema has `check (status in ('created', 'running', 'ended', 'aborted'))` on `telemetry.sessions` (migration `20260612200000`, lines 16-17). `'live'` is not allowed, so without this the `telemetry-session` insert 500s and the Logs dialog never finds a session.

`20260902000100_telemetry_session_status_live.sql`:

```sql
-- Devices open sessions with status 'live' (telemetry-session edge function).
alter table telemetry.sessions drop constraint if exists sessions_status_check;
alter table telemetry.sessions add constraint sessions_status_check
  check (status in ('created', 'running', 'live', 'ended', 'aborted'));
```

(Confirm the constraint's actual name first: `select conname from pg_constraint where conrelid = 'telemetry.sessions'::regclass and contype = 'c';` — Postgres auto-names inline checks `<table>_<column>_check`. If it differs, use that name.)

- [ ] **Step 1: Write the Realtime migration**

```sql
-- Live telemetry over Supabase Realtime private channels.
-- Topic: telemetry:live:{session_id}. Devices publish with a long-lived HS256
-- JWT carrying role=authenticated + a device_id claim (minted offline by
-- scripts/mint-device-jwt.mjs). Team members subscribe with their normal login.
-- Idempotent: safe to re-run.

drop policy if exists telemetry_live_subscribe on realtime.messages;
create policy telemetry_live_subscribe
  on realtime.messages for select to authenticated
  using (
    realtime.topic() like 'telemetry:live:%'
    and extension in ('broadcast')
  );

drop policy if exists telemetry_live_publish on realtime.messages;
create policy telemetry_live_publish
  on realtime.messages for insert to authenticated
  with check (
    realtime.topic() like 'telemetry:live:%'
    and extension in ('broadcast')
    and coalesce(auth.jwt() ->> 'device_id', '') <> ''
  );
```

```bash
cp infra/telemetry-supabase/supabase/migrations/20260902000*.sql infra/pdm-supabase/supabase/migrations/
```

- [ ] **Step 2: Apply BOTH to prod via the Management API (NOT db push)**

Follow memory `helios-migration-apply-management-api`: `POST https://api.supabase.com/v1/projects/dlmyixonuyckxkknolku/database/query` with `Authorization: Bearer <sbp_token>` and body `{"query": "<file contents>"}`, once per file in version order. Then record them:

```sql
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260902000000', 'telemetry_live_channels'),
  ('20260902000100', 'telemetry_session_status_live')
on conflict do nothing;
```

Verify:

```sql
select policyname, cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'telemetry_live%';
select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'telemetry.sessions'::regclass and contype = 'c';
```

Expected: two policy rows (`SELECT`, `INSERT`) and a check definition containing `'live'`. If the `sbp_` token is not in the environment, stop and ask Nick for it; do not proceed to Task 7's deploy or Task 8's live test without both applied.

- [ ] **Step 3: Commit**

```bash
git add infra/telemetry-supabase/supabase/migrations infra/pdm-supabase/supabase/migrations
git commit -m "feat(telemetry): realtime.messages policies for private live channels; sessions.status allows live"
```

---

### Task 6: Device JWT minting script

**Files:**
- Create: `infra/telemetry-supabase/scripts/mint-device-jwt.mjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// Mints a long-lived HS256 device JWT for the Realtime live path.
//   node mint-device-jwt.mjs --device sdm26-car-1 [--days 365]
// Requires SUPABASE_JWT_SECRET in the environment (Dashboard → Settings → API →
// JWT Settings → legacy secret). The output goes into the device's NVS/secrets.h,
// never into git. Verify: paste at jwt.io — role=authenticated, device_id set.
import { createHmac } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const device = args.device;
const days = Number(args.days ?? 365);
const secret = process.env.SUPABASE_JWT_SECRET;
if (!device || !secret || !Number.isFinite(days)) {
  console.error("usage: SUPABASE_JWT_SECRET=... node mint-device-jwt.mjs --device <id> [--days 365]");
  process.exit(2);
}
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const iat = Math.floor(Date.now() / 1000);
const header = b64({ alg: "HS256", typ: "JWT" });
const payload = b64({
  role: "authenticated", aud: "authenticated", iss: "helios-telemetry-mint",
  sub: `device:${device}`, device_id: device, iat, exp: iat + days * 86400,
});
const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
process.stdout.write(`${header}.${payload}.${sig}\n`);
```

- [ ] **Step 2: Verify it produces a token Realtime accepts**

```bash
cd infra/telemetry-supabase
SUPABASE_JWT_SECRET=<from dashboard> node scripts/mint-device-jwt.mjs --device bench-win-1 > .device-jwt   # .env dir is gitignored; add .device-jwt to .gitignore
node -e "const t=require('fs').readFileSync('.device-jwt','utf8').trim().split('.')[1]; console.log(JSON.parse(Buffer.from(t,'base64url')))"
```

Expected: printed claims with `role: 'authenticated'`, `device_id: 'bench-win-1'`. Full acceptance is proven in Task 8 Step 4 (the gen publishes with it).

⚠ If the project's legacy JWT secret is disabled in favour of asymmetric keys, Realtime returns `{"error":"..."}` on join — report it; the fix is re-enabling the legacy key in the dashboard, not code.

- [ ] **Step 3: Commit**

```bash
echo ".device-jwt" >> infra/telemetry-supabase/.gitignore
git add infra/telemetry-supabase/scripts/mint-device-jwt.mjs infra/telemetry-supabase/.gitignore
git commit -m "feat(telemetry): device JWT minting script for the live path"
```

---

### Task 7: `telemetry-session` edge function (open/close)

**Files:**
- Create: `infra/telemetry-supabase/supabase/functions/_shared/auth.ts`, `functions/telemetry-session/index.ts`, `functions/telemetry-session/logic.ts`, `functions/telemetry-session/logic_test.ts`, `functions/telemetry-session/README.md`
- Modify: `functions/telemetry-ingest/auth.ts`

- [ ] **Step 1: Share auth.ts**

```bash
cd infra/telemetry-supabase/supabase/functions
mkdir -p _shared
git mv telemetry-ingest/auth.ts _shared/auth.ts
printf 'export * from "../_shared/auth.ts";\n' > telemetry-ingest/auth.ts
```

- [ ] **Step 2: Write the failing logic tests** (Deno is not on this machine — tests run in CI or on Nick's Mac; still write them first)

`telemetry-session/logic_test.ts`:

```ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseRequest, RequestError } from "./logic.ts";

Deno.test("open requires device_id and channel_set_id", () => {
  assertEquals(parseRequest({ action: "open", device_id: "car-1", channel_set_id: 1 }),
    { action: "open", deviceId: "car-1", channelSetId: 1, name: undefined });
  assertThrows(() => parseRequest({ action: "open", device_id: "car-1" }), RequestError, "channel_set_id");
  assertThrows(() => parseRequest({ action: "open", channel_set_id: 1 }), RequestError, "device_id");
});

Deno.test("close requires a uuid session_id", () => {
  assertEquals(parseRequest({ action: "close", session_id: "9b2f1c3e-4d5a-4b6c-8d7e-0f1a2b3c4d5e" }),
    { action: "close", sessionId: "9b2f1c3e-4d5a-4b6c-8d7e-0f1a2b3c4d5e" });
  assertThrows(() => parseRequest({ action: "close", session_id: "nope" }), RequestError, "session_id");
});

Deno.test("unknown action rejected", () => {
  assertThrows(() => parseRequest({ action: "explode" }), RequestError, "action");
});
```

- [ ] **Step 3: Implement**

`telemetry-session/logic.ts`:

```ts
export class RequestError extends Error {}

export type SessionRequest =
  | { action: "open"; deviceId: string; channelSetId: number; name: string | undefined }
  | { action: "close"; sessionId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRequest(raw: unknown): SessionRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.action === "open") {
    if (typeof r.device_id !== "string" || r.device_id === "") throw new RequestError("device_id required");
    if (!Number.isInteger(r.channel_set_id) || (r.channel_set_id as number) < 0) throw new RequestError("channel_set_id required");
    return { action: "open", deviceId: r.device_id, channelSetId: r.channel_set_id as number,
             name: typeof r.name === "string" && r.name !== "" ? r.name : undefined };
  }
  if (r.action === "close") {
    if (typeof r.session_id !== "string" || !UUID.test(r.session_id)) throw new RequestError("session_id must be a uuid");
    return { action: "close", sessionId: r.session_id };
  }
  throw new RequestError("action must be open or close");
}

export function defaultName(deviceId: string, now: Date): string {
  return `${deviceId} ${now.toISOString().slice(0, 16).replace("T", " ")}`;
}
```

`telemetry-session/index.ts`:

```ts
/**
 * telemetry-session — devices open/close their own live sessions.
 * Auth: same HMAC as telemetry-ingest (x-htp-device + x-htp-signature over the
 * raw JSON body) or the service-role bearer for tooling.
 *   { action: "open", device_id, channel_set_id, name? } → { session_id, channel_set_id }
 *   { action: "close", session_id }                       → { closed: true }
 * `open` first ends any still-live session for the same device (reboot ⇒ no ghosts).
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate } from "../_shared/auth.ts";
import { defaultName, parseRequest, RequestError } from "./logic.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const body = new Uint8Array(await req.arrayBuffer());
  const auth = await authenticate(req, body);
  if (!auth.ok) return json(401, { error: "unauthorized" });

  let parsed;
  try {
    parsed = parseRequest(JSON.parse(new TextDecoder().decode(body)));
  } catch (e) {
    return json(400, { error: e instanceof RequestError ? e.message : "invalid JSON body" });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } }).schema("telemetry");

  if (parsed.action === "open") {
    // A device's HMAC identity must match the device it claims to be.
    if (auth.method === "hmac" && auth.deviceId !== parsed.deviceId) return json(403, { error: "device_id mismatch" });
    const { data: set } = await db.from("channel_sets").select("id").eq("id", parsed.channelSetId).maybeSingle();
    if (!set) return json(400, { error: `unknown channel_set_id ${parsed.channelSetId}` });

    const now = new Date();
    const { error: closeErr } = await db.from("sessions")
      .update({ status: "ended", ended_at: now.toISOString() })
      .eq("status", "live").eq("source", "live").eq("metadata->>device_id", parsed.deviceId);
    if (closeErr) return json(500, { error: closeErr.message });

    const { data, error } = await db.from("sessions").insert({
      name: parsed.name ?? defaultName(parsed.deviceId, now),
      source: "live", status: "live", started_at: now.toISOString(),
      metadata: { device_id: parsed.deviceId, channel_set_id: parsed.channelSetId },
    }).select("id").single();
    if (error) return json(500, { error: error.message });
    return json(200, { session_id: data.id, channel_set_id: parsed.channelSetId });
  }

  const { error } = await db.from("sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", parsed.sessionId).eq("status", "live");
  if (error) return json(500, { error: error.message });
  return json(200, { closed: true });
});
```

Requires Task 5's `20260902000100` migration (status `'live'`) to be applied — it is, if Task 5 was completed in order.

`telemetry-session/README.md`: the three-line contract from the header comment plus the curl:

```bash
BODY='{"action":"open","device_id":"bench-win-1","channel_set_id":1}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$TELEMETRY_HMAC_KEY" | awk '{print $2}')
curl -s -X POST "$SUPABASE_URL/functions/v1/telemetry-session" -H "content-type: application/json" \
     -H "x-htp-device: bench-win-1" -H "x-htp-signature: $SIG" -d "$BODY"
```

- [ ] **Step 4: Deploy + verify**

```bash
cd infra/telemetry-supabase
supabase functions deploy telemetry-session --project-ref dlmyixonuyckxkknolku --no-verify-jwt
supabase functions deploy telemetry-ingest  --project-ref dlmyixonuyckxkknolku --no-verify-jwt   # auth.ts moved
```

Needs `SUPABASE_ACCESS_TOKEN` (ask Nick). `--no-verify-jwt` because devices authenticate by HMAC, not a Supabase JWT (check how `telemetry-ingest` was deployed in June: the smoke test passing with only HMAC headers means it was `--no-verify-jwt`; keep parity).

Run the README curl. Expected: `{"session_id":"<uuid>","channel_set_id":1}`. Run it again: a second uuid, and `select id,status from telemetry.sessions where metadata->>'device_id'='bench-win-1'` shows the first as `ended`. Then `close` → `{"closed":true}`. Re-run the ingest smoke script from Task 0 to prove the ingest function still authenticates after the move.

- [ ] **Step 5: Commit**

```bash
git add infra/telemetry-supabase/supabase/functions
git commit -m "feat(telemetry): telemetry-session edge function (device self-provisioned live sessions)"
```

---

### Task 8: `crates/helios-telemetry-gen` — reference client (synthetic)

**Files:**
- Create: `crates/helios-telemetry-gen/Cargo.toml`, `src/main.rs`, `src/synth.rs`, `src/session.rs`, `src/htp_client.rs`, `src/live_client.rs`
- Modify: root `Cargo.toml` members + `[workspace.dependencies]`

- [ ] **Step 1: Crate + deps**

Root `Cargo.toml` members: add `"crates/helios-telemetry-gen",`. Workspace deps add:

```toml
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots"] }
futures-util = "0.3"
hex = "0.4"
```

and **extend two existing workspace deps** (additive features only, nothing else in the workspace changes behaviour):

```toml
clap  = { version = "4", features = ["derive", "env"] }                         # was ["derive"]; main.rs uses #[arg(env = …)]
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time", "net"] }  # was without time/net; sleep/timeout/TcpStream
```

`crates/helios-telemetry-gen/Cargo.toml`:

```toml
[package]
name = "helios-telemetry-gen"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "Reference HTP/1 + live_fast client: synthetic car data into the prod telemetry pipeline (no hardware)"

[[bin]]
name = "helios-telemetry-gen"
path = "src/main.rs"

[dependencies]
helios-htp = { path = "../helios-htp" }
anyhow.workspace = true
clap.workspace = true
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
reqwest.workspace = true
tokio-tungstenite.workspace = true
futures-util.workspace = true
hmac.workspace = true
sha2.workspace = true
hex.workspace = true
uuid.workspace = true
```

- [ ] **Step 2: Failing tests for the synthetic signal + retry queue**

`src/synth.rs`:

```rust
//! Physically plausible signals so compression/latency numbers aren't skewed by
//! white noise. Deterministic given (t, channel id).
use helios_htp::ChannelSetDef;

pub struct Synth { lap_s: f64 }

impl Synth {
    pub fn new() -> Self { Self { lap_s: 75.0 } }

    /// Value of `id` at absolute time `t_s` (seconds). Unknown ids → None.
    pub fn value(&self, id: &str, t_s: f64) -> Option<f64> {
        let phase = (t_s % self.lap_s) / self.lap_s; // 0..1 around a lap
        let tps = 0.5 + 0.5 * (phase * std::f64::consts::TAU * 3.0).sin(); // 3 throttle cycles/lap
        let gear = 1.0 + (phase * 6.0).floor().min(5.0);
        let rpm = 4000.0 + 8000.0 * tps * (1.0 - 0.05 * gear);
        Some(match id {
            "engine.rpm" => rpm,
            "engine.tps" | "engine.aps" => tps * 100.0,
            "engine.map" => 30.0 + 70.0 * tps,
            "engine.lambda" => 0.88 + 0.06 * (1.0 - tps),
            "engine.gear" => gear,
            "chassis.steering_angle" => 60.0 * (phase * std::f64::consts::TAU * 5.0).sin(),
            "imu.lat_g" => 1.4 * (phase * std::f64::consts::TAU * 5.0).sin(),
            "imu.long_g" => 0.8 * (tps - 0.5) * 2.0,
            "imu.vert_g" => 1.0 + 0.05 * (t_s * 37.0).sin(),
            "imu.yaw_rate" => 40.0 * (phase * std::f64::consts::TAU * 5.0).sin(),
            "brake.front_pressure" | "brake.rear_pressure" => if tps < 0.2 { 800.0 * (0.2 - tps) * 5.0 } else { 0.0 },
            id if id.starts_with("suspension.travel_") => 25.0 + 10.0 * (t_s * 11.0 + id.len() as f64).sin(),
            id if id.starts_with("drivetrain.wheel_speed_") || id == "drivetrain.vehicle_speed" || id == "gps.speed" => 8.0 + 22.0 * tps,
            "gps.lat_ref" => 33.4231, "gps.lon_ref" => -111.9264,
            "gps.lat_d" => 0.0008 * (phase * std::f64::consts::TAU).sin(),
            "gps.lon_d" => 0.0012 * (phase * std::f64::consts::TAU).cos(),
            "engine.water_temp" => 85.0 + 8.0 * (1.0 - (-t_s / 300.0).exp()),
            "engine.oil_temp" => 90.0 + 15.0 * (1.0 - (-t_s / 400.0).exp()),
            "engine.oil_pressure" => 150.0 + 0.03 * rpm,
            "engine.fuel_pressure" => 300.0,
            "engine.battery_voltage" => 13.8 - 0.2 * tps,
            "power.supply_current" => 8.0 + 4.0 * tps,
            id if id.starts_with("tire.surface_temp_") => 60.0 + 20.0 * (1.0 - (-t_s / 120.0).exp()),
            "gps.fix_quality" => 4.0,
            _ => return None,
        })
    }

    /// One `live_fast` value vector in pack order.
    pub fn live_values(&self, set: &ChannelSetDef, t_s: f64) -> Vec<Option<f64>> {
        set.sorted_groups().iter().flat_map(|(_, g)| g.channels.iter().map(|c| self.value(&c.id, t_s))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rpm_bounded_and_thermal_monotone() {
        let s = Synth::new();
        for i in 0..7500 {
            let r = s.value("engine.rpm", i as f64 * 0.1).unwrap();
            assert!((3000.0..=12500.0).contains(&r), "rpm {r}");
        }
        let a = s.value("engine.water_temp", 10.0).unwrap();
        let b = s.value("engine.water_temp", 200.0).unwrap();
        assert!(b > a);
        assert!(s.value("nope", 0.0).is_none());
    }
}
```

`src/htp_client.rs` — the protocol §4 client (the firmware copies this):

```rust
use anyhow::{bail, Result};
use helios_htp::{encode_frame, Frame, GroupDef, Window};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::VecDeque;
use std::time::Duration;

pub struct RetryQueue { pub cap: usize, pub dropped_oldest: u64, windows: VecDeque<(u32, Window)> }

impl RetryQueue {
    pub fn new(cap: usize) -> Self { Self { cap, dropped_oldest: 0, windows: VecDeque::new() } }
    pub fn push(&mut self, seq: u32, w: Window) {
        if self.windows.len() == self.cap { self.windows.pop_front(); self.dropped_oldest += 1; }
        self.windows.push_back((seq, w));
    }
    /// Up to `max` consecutive pending windows from the head.
    pub fn batch(&self, max: usize) -> Vec<(u32, Window)> {
        let mut out: Vec<(u32, Window)> = Vec::new();
        for (seq, w) in self.windows.iter().take(max) {
            if let Some((last, _)) = out.last() { if *seq != last + 1 { break; } }
            out.push((*seq, w.clone()));
        }
        out
    }
    pub fn ack(&mut self, seqs: &[u32]) { self.windows.retain(|(s, _)| !seqs.contains(s)); }
    pub fn len(&self) -> usize { self.windows.len() }
}

pub fn backoff(attempt: u32) -> Duration {
    let base = 1000u64 << attempt.min(3); // 1,2,4,8 s
    let jitter = (base as f64 * 0.2 * (rand_unit() * 2.0 - 1.0)) as i64;
    Duration::from_millis((base as i64 + jitter).max(100) as u64)
}
fn rand_unit() -> f64 { (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() % 1000) as f64 / 1000.0 }

pub fn sign(key: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

#[derive(serde::Deserialize, Debug)]
pub struct Ack { pub acked: Vec<u32>, #[serde(default)] pub dup: Vec<u32>, pub server_recv_ms: u64, pub server_send_ms: u64 }

pub struct HtpClient { pub http: reqwest::Client, pub url: String, pub device_id: String, pub hmac_key: String }

impl HtpClient {
    pub fn new(base_url: &str, device_id: &str, hmac_key: &str) -> Self {
        let http = reqwest::Client::builder().pool_idle_timeout(Duration::from_secs(90)).tcp_keepalive(Duration::from_secs(30)).build().unwrap();
        Self { http, url: format!("{base_url}/functions/v1/telemetry-ingest"), device_id: device_id.into(), hmac_key: hmac_key.into() }
    }

    /// One POST. Ok(ack) on 200; Err on anything else (caller decides retry vs drop via `is_permanent`).
    pub async fn post(&self, frame: &Frame, group: &GroupDef) -> Result<Ack> {
        let body = encode_frame(frame, group)?;
        let res = self.http.post(&self.url)
            .header("content-type", "application/x-htp")
            .header("x-htp-device", &self.device_id)
            .header("x-htp-signature", sign(&self.hmac_key, &body))
            .body(body).send().await?;
        let status = res.status().as_u16();
        if status == 200 { return Ok(res.json().await?); }
        let text = res.text().await.unwrap_or_default();
        bail!("HTTP {status}: {text}");
    }
}

pub fn is_permanent(err: &anyhow::Error) -> bool {
    let s = err.to_string();
    s.starts_with("HTTP 400") || s.starts_with("HTTP 401") || s.starts_with("HTTP 403") || s.starts_with("HTTP 413") || s.starts_with("HTTP 415")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn w(t: u64) -> Window { Window { t_start_us: t, samples: vec![] } }

    #[test]
    fn queue_drops_oldest_and_counts() {
        let mut q = RetryQueue::new(3);
        for s in 0..5 { q.push(s, w(s as u64)); }
        assert_eq!(q.len(), 3);
        assert_eq!(q.dropped_oldest, 2);
        assert_eq!(q.batch(8).iter().map(|(s, _)| *s).collect::<Vec<_>>(), vec![2, 3, 4]);
    }

    #[test]
    fn batch_stops_at_seq_gap_and_ack_removes() {
        let mut q = RetryQueue::new(10);
        for s in [1, 2, 3, 5, 6] { q.push(s, w(0)); }
        assert_eq!(q.batch(8).len(), 3);
        q.ack(&[1, 2, 3]);
        assert_eq!(q.batch(8).iter().map(|(s, _)| *s).collect::<Vec<_>>(), vec![5, 6]);
    }

    #[test]
    fn backoff_caps_at_8s_with_jitter() {
        for a in 0..10 { let d = backoff(a).as_millis(); assert!((100..=9600).contains(&d)); }
        assert!(backoff(5).as_millis() >= 6400);
    }

    #[test]
    fn hmac_matches_known_vector() {
        // echo -n body | openssl dgst -sha256 -hmac key
        assert_eq!(sign("key", b"The quick brown fox jumps over the lazy dog"),
                   "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    }
}
```

- [ ] **Step 3: Run failing → implement main/session/live, then pass**

Run: `cargo test -p helios-telemetry-gen` → compile errors until `main.rs` declares the modules. Then write:

`src/session.rs`:

```rust
use anyhow::{bail, Result};
use crate::htp_client::sign;

pub async fn open(base_url: &str, device_id: &str, hmac_key: &str, channel_set_id: u16, name: Option<&str>) -> Result<String> {
    let body = serde_json::json!({ "action": "open", "device_id": device_id, "channel_set_id": channel_set_id, "name": name }).to_string();
    let res = reqwest::Client::new().post(format!("{base_url}/functions/v1/telemetry-session"))
        .header("content-type", "application/json").header("x-htp-device", device_id)
        .header("x-htp-signature", sign(hmac_key, body.as_bytes())).body(body).send().await?;
    if !res.status().is_success() { bail!("session open failed: {} {}", res.status(), res.text().await?); }
    let v: serde_json::Value = res.json().await?;
    Ok(v["session_id"].as_str().unwrap().to_string())
}

pub async fn close(base_url: &str, device_id: &str, hmac_key: &str, session_id: &str) -> Result<()> {
    let body = serde_json::json!({ "action": "close", "session_id": session_id }).to_string();
    let res = reqwest::Client::new().post(format!("{base_url}/functions/v1/telemetry-session"))
        .header("content-type", "application/json").header("x-htp-device", device_id)
        .header("x-htp-signature", sign(hmac_key, body.as_bytes())).body(body).send().await?;
    if !res.status().is_success() { bail!("session close failed: {}", res.status()); }
    Ok(())
}

pub async fn channel_set(base_url: &str, anon_key: &str, service_key: &str, id: u16) -> Result<helios_htp::ChannelSetDef> {
    let res = reqwest::Client::new().get(format!("{base_url}/rest/v1/channel_sets?id=eq.{id}&select=definition"))
        .header("apikey", anon_key).header("authorization", format!("Bearer {service_key}"))
        .header("accept-profile", "telemetry").send().await?;
    let rows: Vec<serde_json::Value> = res.json().await?;
    match rows.first() { Some(r) => Ok(serde_json::from_value(r["definition"].clone())?), None => bail!("channel set {id} not found") }
}
```

`src/live_client.rs` — Phoenix protocol over WebSocket (what the firmware copies):

```rust
//! Supabase Realtime = Phoenix channels over WebSocket.
//!   url:  wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0
//!   join: {"topic":"realtime:telemetry:live:<sid>","event":"phx_join","ref":"1",
//!          "payload":{"config":{"broadcast":{"self":false,"ack":false},"presence":{"key":""},"private":true},
//!                     "access_token":"<device jwt>"}}
//!   send: {"topic":"realtime:…","event":"broadcast","ref":null,
//!          "payload":{"type":"broadcast","event":"live_fast","payload":{…LiveMessage…}}}
//!   heartbeat every 25 s: {"topic":"phoenix","event":"heartbeat","payload":{},"ref":"<n>"}
use anyhow::{bail, Result};
use futures_util::{SinkExt, StreamExt};
use helios_htp::LiveMessage;
use tokio_tungstenite::tungstenite::Message;

pub struct LiveClient { ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, topic: String, next_ref: u64 }

impl LiveClient {
    pub async fn connect(base_url: &str, anon_key: &str, device_jwt: &str, session_id: &str) -> Result<Self> {
        let ws_url = format!("{}/realtime/v1/websocket?apikey={anon_key}&vsn=1.0.0", base_url.replacen("https://", "wss://", 1));
        let (ws, _) = tokio_tungstenite::connect_async(ws_url).await?;
        let mut c = Self { ws, topic: format!("realtime:telemetry:live:{session_id}"), next_ref: 1 };
        let join = serde_json::json!({ "topic": c.topic, "event": "phx_join", "ref": "1", "payload": {
            "config": { "broadcast": { "self": false, "ack": false }, "presence": { "key": "" }, "private": true },
            "access_token": device_jwt } });
        c.ws.send(Message::Text(join.to_string())).await?;
        // Wait for phx_reply ok; anything else (error / unauthorized) is fatal and loud.
        while let Some(msg) = c.ws.next().await {
            let text = match msg? { Message::Text(t) => t, _ => continue };
            let v: serde_json::Value = serde_json::from_str(&text)?;
            if v["event"] == "phx_reply" {
                if v["payload"]["status"] == "ok" { return Ok(c); }
                bail!("realtime join rejected: {text}");
            }
        }
        bail!("websocket closed during join");
    }

    pub async fn publish(&mut self, m: &LiveMessage) -> Result<()> {
        let msg = serde_json::json!({ "topic": self.topic, "event": "broadcast", "ref": null,
            "payload": { "type": "broadcast", "event": "live_fast", "payload": m } });
        Ok(self.ws.send(Message::Text(msg.to_string())).await?)
    }

    pub async fn heartbeat(&mut self) -> Result<()> {
        self.next_ref += 1;
        let hb = serde_json::json!({ "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": self.next_ref.to_string() });
        Ok(self.ws.send(Message::Text(hb.to_string())).await?)
    }

    /// Drain inbound frames without blocking (replies, heartbeats). Returns Err if the socket closed.
    pub async fn pump(&mut self) -> Result<()> {
        while let Ok(Some(m)) = tokio::time::timeout(std::time::Duration::from_millis(1), self.ws.next()).await {
            if let Message::Close(_) = m? { bail!("realtime socket closed"); }
        }
        Ok(())
    }
}
```

`src/main.rs`:

```rust
mod htp_client; mod live_client; mod session; mod synth;
use anyhow::Result;
use clap::{Parser, Subcommand};
use helios_htp::*;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(about = "Reference HTP/1 + live_fast client (synthetic SDM26 data → prod telemetry pipeline)")]
struct Cli {
    /// e.g. https://dlmyixonuyckxkknolku.supabase.co  (env SUPABASE_URL)
    #[arg(long, env = "SUPABASE_URL")] url: String,
    #[arg(long, env = "SUPABASE_ANON_KEY")] anon_key: String,
    #[arg(long, env = "SUPABASE_SERVICE_ROLE_KEY")] service_key: String,
    #[arg(long, env = "TELEMETRY_HMAC_KEY")] hmac_key: String,
    #[arg(long, default_value = "bench-win-1")] device: String,
    #[command(subcommand)] cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Open a live session; prints the uuid.
    OpenSession { #[arg(long, default_value_t = 1)] set: u16, #[arg(long)] name: Option<String> },
    CloseSession { #[arg(long)] session: String },
    /// Durable path: HTP/1 frames for every group, `--windows` per POST.
    Replay { #[arg(long)] session: String, #[arg(long, default_value_t = 1)] set: u16, #[arg(long, default_value_t = 4)] windows: usize,
             #[arg(long, default_value_t = 60.0)] seconds: f64, #[arg(long, default_value_t = 32)] queue: usize },
    /// Live path: live_fast over Realtime at --hz. Needs a device JWT (env TELEMETRY_DEVICE_JWT).
    Live { #[arg(long)] session: String, #[arg(long, default_value_t = 1)] set: u16, #[arg(long, default_value_t = 10)] hz: u32,
           #[arg(long, default_value_t = 60.0)] seconds: f64, #[arg(long, env = "TELEMETRY_DEVICE_JWT")] jwt: String },
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::OpenSession { set, name } => {
            println!("{}", session::open(&cli.url, &cli.device, &cli.hmac_key, set, name.as_deref()).await?);
        }
        Cmd::CloseSession { session } => session::close(&cli.url, &cli.device, &cli.hmac_key, &session).await?,
        Cmd::Replay { session, set, windows, seconds, queue } => replay(&cli, &session, set, windows, seconds, queue).await?,
        Cmd::Live { session, set, hz, seconds, jwt } => live(&cli, &session, set, hz, seconds, &jwt).await?,
    }
    Ok(())
}

async fn replay(cli: &Cli, session: &str, set_id: u16, per_post: usize, seconds: f64, queue_cap: usize) -> Result<()> {
    let set = session::channel_set(&cli.url, &cli.anon_key, &cli.service_key, set_id).await?;
    let client = htp_client::HtpClient::new(&cli.url, &cli.device, &cli.hmac_key);
    let synth = synth::Synth::new();
    let sid = *uuid::Uuid::parse_str(session)?.as_bytes();
    let groups = set.sorted_groups();
    let mut queues: Vec<htp_client::RetryQueue> = groups.iter().map(|_| htp_client::RetryQueue::new(queue_cap)).collect();
    let mut next_seq = vec![0u32; groups.len()];
    let t0 = now_ms() / 1000 * 1000;
    let start = Instant::now();
    let mut sec = 0u64;
    let (mut posts, mut acked, mut dups, mut rtt_ms) = (0u64, 0u64, 0u64, Vec::new());
    while (sec as f64) < seconds {
        // build this second's window for every group
        for (gi, (_, g)) in groups.iter().enumerate() {
            let t_start_us = (t0 + sec * 1000) * 1000;
            let samples = g.channels.iter().map(|c| (0..g.rate_hz).map(|i| synth.value(&c.id, sec as f64 + i as f64 / g.rate_hz as f64)).collect()).collect();
            queues[gi].push(next_seq[gi], Window { t_start_us, samples });
            next_seq[gi] += 1;
        }
        // send any full batches (or whatever is pending — never wait > 1 window period)
        for (gi, (gk, g)) in groups.iter().enumerate() {
            let batch = queues[gi].batch(per_post);
            if batch.is_empty() || (batch.len() < per_post && queues[gi].len() < per_post) { continue; }
            let frame = Frame { session_id: sid, channel_set_id: set_id, group_key: *gk, first_seq: batch[0].0,
                                send_timestamp_ms: now_ms(), windows: batch.iter().map(|(_, w)| w.clone()).collect() };
            let mut attempt = 0;
            loop {
                let t = Instant::now();
                match client.post(&frame, g).await {
                    Ok(ack) => { posts += 1; rtt_ms.push(t.elapsed().as_millis() as u64); acked += ack.acked.len() as u64; dups += ack.dup.len() as u64;
                                 let all: Vec<u32> = ack.acked.iter().chain(&ack.dup).copied().collect(); queues[gi].ack(&all); break; }
                    Err(e) if htp_client::is_permanent(&e) => { eprintln!("permanent error, dropping frame: {e}"); queues[gi].ack(&frame.windows.iter().enumerate().map(|(i, _)| frame.first_seq + i as u32).collect::<Vec<_>>()); break; }
                    Err(e) => { eprintln!("transient: {e}"); tokio::time::sleep(htp_client::backoff(attempt)).await; attempt += 1; }
                }
            }
        }
        sec += 1;
        let target = Duration::from_secs(sec);
        if let Some(d) = target.checked_sub(start.elapsed()) { tokio::time::sleep(d).await; }
    }
    rtt_ms.sort();
    let p = |q: f64| rtt_ms.get(((rtt_ms.len() as f64 - 1.0) * q) as usize).copied().unwrap_or(0);
    println!("posts={posts} acked={acked} dup={dups} dropped_oldest={} rtt_p50={}ms p95={}ms", queues.iter().map(|q| q.dropped_oldest).sum::<u64>(), p(0.5), p(0.95));
    Ok(())
}

async fn live(cli: &Cli, session: &str, set_id: u16, hz: u32, seconds: f64, jwt: &str) -> Result<()> {
    let set = session::channel_set(&cli.url, &cli.anon_key, &cli.service_key, set_id).await?;
    let synth = synth::Synth::new();
    let mut ws = live_client::LiveClient::connect(&cli.url, &cli.anon_key, jwt, session).await?;
    println!("joined telemetry:live:{session} (private) as device");
    let period = Duration::from_millis(1000 / hz as u64);
    let start = Instant::now();
    let mut seq = 0u32;
    let mut last_hb = Instant::now();
    while start.elapsed().as_secs_f64() < seconds {
        let t_s = start.elapsed().as_secs_f64();
        let packed = pack_live(&set, &synth.live_values(&set, t_s))?;
        let t_ms = now_ms();
        ws.publish(&LiveMessage::new(seq, t_ms * 1000, t_ms, set_id, &packed)).await?;
        seq += 1;
        if last_hb.elapsed() > Duration::from_secs(25) { ws.heartbeat().await?; last_hb = Instant::now(); }
        ws.pump().await?;
        let next = period * seq;
        if let Some(d) = next.checked_sub(start.elapsed()) { tokio::time::sleep(d).await; }
    }
    println!("published {seq} live_fast messages at {hz} Hz");
    Ok(())
}
```

Run: `cargo test -p helios-telemetry-gen` → expected `5 passed`. `cargo build -p helios-telemetry-gen` → clean (fix warnings).

- [ ] **Step 4: End-to-end against prod, from this machine**

```bash
cd infra/telemetry-supabase
set -a; . ../pdm-supabase/.env; . ./.env; set +a          # SUPABASE_URL, keys, TELEMETRY_HMAC_KEY
export TELEMETRY_DEVICE_JWT=$(cat .device-jwt)
SID=$(cargo run -q -p helios-telemetry-gen -- open-session --name "gen smoke")
echo $SID
cargo run -q -p helios-telemetry-gen -- replay --session $SID --seconds 20
cargo run -q -p helios-telemetry-gen -- live   --session $SID --seconds 20 --hz 10
```

Expected: replay prints `posts=15 acked=60 dup=0 dropped_oldest=0` (3 groups × 20 s / 4 windows = 15 posts) with p50 RTT in the 100-400 ms range from this network; live prints `joined … as device` then `published 200 live_fast messages`. If join is rejected with an authorization error, Task 5's policy or Task 6's token is wrong — fix there.

Verify staging: `select group_key, count(*) from telemetry.staging_chunks where session_id='<SID>' group by 1` → 20 rows per group. Then `close-session`.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/helios-telemetry-gen
git commit -m "feat(helios-telemetry-gen): reference HTP/1 + live_fast client with synthetic SDM26 signals"
```

---

### Task 9: `@helios/store` — `LiveBuffer`

**Files:**
- Create: `packages/store/src/live-buffer.ts`, `packages/store/tests/live-buffer.test.ts`
- Modify: `packages/store/src/index.ts`

- [ ] **Step 1: Failing tests**

`packages/store/tests/live-buffer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LiveBuffer } from "../src/live-buffer";
import type { ChannelMeta } from "../src/types";

const meta = (id: string, group: string, rate: number): ChannelMeta =>
  ({ id, display_name: id, units: "", group, color: "#fff", decimals: 2, data_type: "f64", source: "live", sample_rate_hz: rate });

describe("LiveBuffer", () => {
  it("builds a store with one rate group per live group, in push order", () => {
    const b = new LiveBuffer({ 0: { rateHz: 10, channelIds: ["a", "b"] } }, 4);
    b.push(0, 1000, [1, 2]);
    b.push(0, 2000, [3, NaN]);
    const store = b.toStore([meta("a", "g", 10), meta("b", "g", 10)]);
    const g = store.groupOf("a")!;
    expect(Array.from(g.time)).toEqual([1000n, 2000n]);
    expect(Array.from(g.data("a"))).toEqual([1, 3]);
    expect(Number.isNaN(g.data("b")[1])).toBe(true);
    expect(store.extentUs()).toEqual({ startUs: 1000, endUs: 2000 });
  });

  it("is a ring: keeps the newest `capacity` samples in time order", () => {
    const b = new LiveBuffer({ 0: { rateHz: 10, channelIds: ["a"] } }, 3);
    for (let i = 1; i <= 5; i++) b.push(0, i * 100, [i]);
    const g = b.toStore([meta("a", "g", 10)]).groupOf("a")!;
    expect(Array.from(g.time)).toEqual([300n, 400n, 500n]);
    expect(Array.from(g.data("a"))).toEqual([3, 4, 5]);
    expect(b.dropped).toBe(2);
  });

  it("ignores out-of-order (older) samples and counts them", () => {
    const b = new LiveBuffer({ 0: { rateHz: 10, channelIds: ["a"] } }, 8);
    b.push(0, 500, [1]);
    b.push(0, 400, [2]);
    expect(b.toStore([meta("a", "g", 10)]).groupOf("a")!.time.length).toBe(1);
    expect(b.rejectedOutOfOrder).toBe(1);
  });

  it("empty buffer yields a store with no groups", () => {
    const b = new LiveBuffer({ 0: { rateHz: 10, channelIds: ["a"] } }, 8);
    expect(b.toStore([meta("a", "g", 10)]).groups()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @helios/store test -- live-buffer`
Expected: FAIL, cannot find module `../src/live-buffer`.

- [ ] **Step 3: Implement**

`packages/store/src/live-buffer.ts`:

```ts
import { ChannelStore } from "./channel-store";
import { RateGroup } from "./rate-group";
import type { ChannelMeta } from "./types";

export interface LiveGroupSpec { rateHz: number; channelIds: string[] }

/** Per-group ring buffers for live telemetry. `toStore()` materialises an
 *  immutable ChannelStore (the widget contract) — call it at most once per
 *  animation frame, never per message. Values arrive as one sample per
 *  channel; NaN = null. */
export class LiveBuffer {
  readonly capacity: number;
  dropped = 0;
  rejectedOutOfOrder = 0;
  #groups = new Map<number, { spec: LiveGroupSpec; time: BigInt64Array; cols: Float64Array[]; head: number; len: number }>();

  constructor(groups: Record<number, LiveGroupSpec>, capacity: number) {
    this.capacity = capacity;
    for (const [k, spec] of Object.entries(groups)) {
      this.#groups.set(Number(k), {
        spec, time: new BigInt64Array(capacity),
        cols: spec.channelIds.map(() => new Float64Array(capacity)), head: 0, len: 0,
      });
    }
  }

  /** @param values one per channelId in spec order */
  push(groupKey: number, tUs: number, values: ArrayLike<number>): void {
    const g = this.#groups.get(groupKey);
    if (!g) return;
    if (g.len > 0) {
      const lastIdx = (g.head + g.len - 1) % this.capacity;
      if (BigInt(tUs) <= g.time[lastIdx]!) { this.rejectedOutOfOrder++; return; }
    }
    let idx: number;
    if (g.len < this.capacity) { idx = (g.head + g.len) % this.capacity; g.len++; }
    else { idx = g.head; g.head = (g.head + 1) % this.capacity; this.dropped++; }
    g.time[idx] = BigInt(tUs);
    for (let c = 0; c < g.cols.length; c++) g.cols[c]![idx] = values[c] ?? NaN;
  }

  latest(groupKey: number): { tUs: number; values: Float64Array } | null {
    const g = this.#groups.get(groupKey);
    if (!g || g.len === 0) return null;
    const idx = (g.head + g.len - 1) % this.capacity;
    return { tUs: Number(g.time[idx]), values: Float64Array.from(g.cols, (col) => col[idx]!) };
  }

  toStore(metas: ChannelMeta[]): ChannelStore {
    const byId = new Map(metas.map((m) => [m.id, m]));
    const store = new ChannelStore();
    for (const [k, g] of this.#groups) {
      if (g.len === 0) continue;
      const time = new BigInt64Array(g.len);
      const columns = new Map<string, Float64Array>();
      const linear = (src: Float64Array | BigInt64Array, dst: Float64Array | BigInt64Array) => {
        const first = Math.min(g.len, this.capacity - g.head);
        (dst as any).set(src.subarray(g.head, g.head + first), 0);
        if (first < g.len) (dst as any).set(src.subarray(0, g.len - first), first);
      };
      linear(g.time, time);
      const groupMetas: ChannelMeta[] = [];
      g.spec.channelIds.forEach((id, c) => {
        const col = new Float64Array(g.len);
        linear(g.cols[c]!, col);
        columns.set(id, col);
        groupMetas.push(byId.get(id) ?? { id, display_name: id, units: "", group: "Live", color: "#FFC627", decimals: 2, data_type: "f64", source: "live", sample_rate_hz: g.spec.rateHz });
      });
      store.addRateGroup(RateGroup.fromColumns({ id: `live-g${k}`, nominalRateHz: g.spec.rateHz, time, columns }), groupMetas);
    }
    return store;
  }
}
```

Add `export * from "./live-buffer";` to `packages/store/src/index.ts`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @helios/store test` and `pnpm --filter @helios/store typecheck`
Expected: all pass (34 existing + 4 new), typecheck clean. If `extentUs()` on a store with an empty group list throws, that is the existing contract — the 4th test only asserts `groups()`.

- [ ] **Step 5: Commit**

```bash
git add packages/store
git commit -m "feat(store): LiveBuffer ring buffers that materialise a ChannelStore per frame"
```

---

### Task 10: Desktop — `live_fast` decoder (TS twin of `helios-htp::live`, fixture-verified)

**Files:**
- Create: `apps/desktop/src/lib/live-decode.ts`, `apps/desktop/src/lib/__tests__/live-decode.test.ts`

- [ ] **Step 1: Failing test against the golden fixtures**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeLiveValues, liveLayout, type ChannelSetDefinition } from "../live-decode";

const FIX = join(__dirname, "../../../../../crates/helios-htp/fixtures");
const set: ChannelSetDefinition = JSON.parse(readFileSync(join(FIX, "channel_set_1.json"), "utf8"));

describe("live_fast decode", () => {
  it("layout is groups-ascending, 86 bytes for set 1", () => {
    const layout = liveLayout(set);
    expect(layout.byteLength).toBe(86);
    expect(layout.channels[0]!.id).toBe("engine.rpm");
    expect(layout.channels[22]!.id).toBe("gps.lat_ref");
    expect(layout.channels[27]!.id).toBe("engine.water_temp");
  });

  for (const f of readdirSync(join(FIX, "live")).filter((n) => n.endsWith(".bin"))) {
    it(`matches fixture ${f}`, () => {
      const bytes = new Uint8Array(readFileSync(join(FIX, "live", f)));
      const expected = JSON.parse(readFileSync(join(FIX, "live", f.replace(".bin", ".json")), "utf8")) as { values: [string, number | null][] };
      const got = decodeLiveValues(liveLayout(set), bytes);
      expected.values.forEach(([id, v], i) => {
        expect(got.ids[i]).toBe(id);
        if (v === null) expect(Number.isNaN(got.values[i])).toBe(true);
        else expect(got.values[i]).toBeCloseTo(v, 9);
      });
    });
  }

  it("rejects wrong length", () => {
    expect(() => decodeLiveValues(liveLayout(set), new Uint8Array(5))).toThrow(/86/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @helios/desktop test -- live-decode`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/desktop/src/lib/live-decode.ts`:

```ts
/** TS twin of crates/helios-htp/src/live.rs. Keep byte-identical; the golden
 *  fixtures in crates/helios-htp/fixtures/live are the contract. */
export interface ChannelDefinition { id: string; enc: "i16fp" | "f32"; scale?: number; offset?: number }
export interface GroupDefinition { rate_hz: number; channels: ChannelDefinition[] }
export interface ChannelSetDefinition { groups: Record<string, GroupDefinition> }

export interface LiveChannel { id: string; groupKey: number; offset: number; enc: "i16fp" | "f32"; scale: number; add: number }
export interface LiveLayout { byteLength: number; channels: LiveChannel[]; groupKeys: number[]; groups: Record<number, GroupDefinition> }

const I16_NULL = -32768;

export function liveLayout(def: ChannelSetDefinition): LiveLayout {
  const groupKeys = Object.keys(def.groups).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const channels: LiveChannel[] = [];
  const groups: Record<number, GroupDefinition> = {};
  let offset = 0;
  for (const k of groupKeys) {
    const g = def.groups[String(k)]!;
    groups[k] = g;
    for (const ch of g.channels) {
      channels.push({ id: ch.id, groupKey: k, offset, enc: ch.enc, scale: ch.scale ?? 1, add: ch.offset ?? 0 });
      offset += ch.enc === "f32" ? 4 : 2;
    }
  }
  return { byteLength: offset, channels, groupKeys, groups };
}

export function decodeLiveValues(layout: LiveLayout, bytes: Uint8Array): { ids: string[]; values: Float64Array } {
  if (bytes.byteLength !== layout.byteLength) throw new Error(`live_fast blob is ${bytes.byteLength} bytes, expected ${layout.byteLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float64Array(layout.channels.length);
  layout.channels.forEach((ch, i) => {
    if (ch.enc === "f32") values[i] = view.getFloat32(ch.offset, true);
    else { const raw = view.getInt16(ch.offset, true); values[i] = raw === I16_NULL ? NaN : raw * ch.scale + ch.add; }
  });
  return { ids: layout.channels.map((c) => c.id), values };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @helios/desktop test -- live-decode`
Expected: 4 passed (layout, 2 fixtures, length).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/live-decode.ts apps/desktop/src/lib/__tests__/live-decode.test.ts
git commit -m "feat(desktop): live_fast decoder verified against helios-htp golden fixtures"
```

---

### Task 11: Desktop — live session source + Connect-live UI

**Files:**
- Create: `apps/desktop/src/lib/live-session.ts`, `apps/desktop/src/components/ConnectLiveDialog.tsx`
- Modify: `apps/desktop/src/components/SessionPanel.tsx`, `apps/desktop/src/App.tsx`

- [ ] **Step 1: Live session controller**

`apps/desktop/src/lib/live-session.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { LiveBuffer, type ChannelMeta } from "@helios/store";
import type { LoadedSession } from "./session";
import { base64ToBytes, decodeLiveValues, liveLayout, type ChannelSetDefinition, type LiveLayout } from "./live-decode";

export interface LiveSessionRow { id: string; name: string; status: string; started_at: string | null; metadata: { device_id?: string; channel_set_id?: number } }

export interface LiveHandle {
  sessionId: string;
  stop(): void;
  /** glass latency estimate from the last message's t_send_ms (device clock) */
  lastLatencyMs(): number | null;
}

export const LIVE_ID_PREFIX = "live:";
export const LIVE_HISTORY_SECONDS = 600;

export async function listLiveSessions(client: SupabaseClient): Promise<LiveSessionRow[]> {
  const { data, error } = await client.schema("telemetry").from("sessions")
    .select("id,name,status,started_at,metadata").eq("status", "live").order("started_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as LiveSessionRow[];
}

async function loadDefinition(client: SupabaseClient, channelSetId: number): Promise<{ layout: LiveLayout; metas: ChannelMeta[] }> {
  const [{ data: set, error: e1 }, { data: reg, error: e2 }] = await Promise.all([
    client.schema("telemetry").from("channel_sets").select("definition").eq("id", channelSetId).single(),
    client.schema("telemetry").from("channel_registry").select("id,display_name,units,group,sample_rate_hz"),
  ]);
  if (e1 || !set) throw new Error(`channel set ${channelSetId}: ${e1?.message ?? "not found"}`);
  if (e2) throw new Error(e2.message);
  const layout = liveLayout(set.definition as ChannelSetDefinition);
  const byId = new Map((reg ?? []).map((r: any) => [r.id, r]));
  const metas: ChannelMeta[] = layout.channels.map((c) => {
    const r = byId.get(c.id);
    return { id: c.id, display_name: r?.display_name ?? c.id, units: r?.units ?? "", group: r?.group ?? "Live", color: "#FFC627",
             decimals: 2, data_type: "f64", source: "live", sample_rate_hz: layout.groups[c.groupKey]!.rate_hz };
  });
  return { layout, metas };
}

/** Subscribes to telemetry:live:{id}; calls `commit` with a fresh LoadedSession at most
 *  once per animation frame while messages arrive. */
export async function connectLiveSession(
  client: SupabaseClient, row: LiveSessionRow, color: string,
  commit: (session: LoadedSession) => void,
): Promise<LiveHandle> {
  const channelSetId = row.metadata.channel_set_id ?? 1;
  const { layout, metas } = await loadDefinition(client, channelSetId);
  const groups: Record<number, { rateHz: number; channelIds: string[] }> = {};
  for (const k of layout.groupKeys) groups[k] = { rateHz: layout.groups[k]!.rate_hz, channelIds: layout.groups[k]!.channels.map((c) => c.id) };
  const capacity = LIVE_HISTORY_SECONDS * Math.max(...layout.groupKeys.map((k) => layout.groups[k]!.rate_hz));
  const buffer = new LiveBuffer(groups, capacity);
  const id = LIVE_ID_PREFIX + row.id;
  let dirty = false, raf = 0, lastLatency: number | null = null, stopped = false;

  const flush = () => {
    raf = 0;
    if (stopped || !dirty) return;
    dirty = false;
    commit({ id, label: `LIVE · ${row.name}`, defaultLabel: `LIVE · ${row.name}`, store: buffer.toStore(metas), color, visible: true,
             lapConfig: { mode: "none" } as LoadedSession["lapConfig"], laps: null, channelOverrides: {} });
  };

  // supabase-js needs the user's JWT on the socket for private channels.
  await client.realtime.setAuth();
  const channel = client.channel(`telemetry:live:${row.id}`, { config: { private: true, broadcast: { self: false } } });
  channel.on("broadcast", { event: "live_fast" }, ({ payload }: { payload: { seq: number; t_us: number; t_send_ms: number; cs: number; v: string } }) => {
    if (stopped || payload.cs !== channelSetId) return;
    let decoded;
    try { decoded = decodeLiveValues(layout, base64ToBytes(payload.v)); } catch (e) { console.warn("live_fast decode:", e); return; }
    // one sample per channel → route to each group's ring by slicing the flat vector
    let i = 0;
    for (const k of layout.groupKeys) {
      const n = groups[k]!.channelIds.length;
      buffer.push(k, payload.t_us, decoded.values.subarray(i, i + n));
      i += n;
    }
    lastLatency = Date.now() - payload.t_send_ms;
    dirty = true;
    if (!raf) raf = requestAnimationFrame(flush);
  });
  channel.subscribe((status: string) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") console.error(`live channel ${row.id}: ${status}`);
  });

  return {
    sessionId: row.id,
    lastLatencyMs: () => lastLatency,
    stop() { stopped = true; if (raf) cancelAnimationFrame(raf); client.removeChannel(channel); },
  };
}
```

Check `LapDetectionConfig` in `@helios/lib` for the exact "none" shape (`grep -n "mode" packages/lib/src/laps.ts | head`) and replace the cast with the real literal.

- [ ] **Step 2: Dialog**

`apps/desktop/src/components/ConnectLiveDialog.tsx` — follow the look of the existing confirm/dialog components in `apps/desktop/src/components/` (same panel colours `#0E0E10`/`#2A2C32`/`#FFC627`):

```tsx
import { useEffect, useState } from "react";
import { useSupabaseClientOrNull } from "@helios/auth";
import { listLiveSessions, type LiveSessionRow } from "../lib/live-session";

export function ConnectLiveDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (row: LiveSessionRow) => void }) {
  const client = useSupabaseClientOrNull();
  const [rows, setRows] = useState<LiveSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !client) return;
    setRows(null); setError(null);
    listLiveSessions(client).then(setRows).catch((e) => setError(String(e.message ?? e)));
  }, [open, client]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-96 bg-[#0E0E10] border border-[#2A2C32] rounded p-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-wider text-[#9097A0] mb-2">Connect live telemetry</div>
        {!client && <div className="text-sm text-[#9097A0]">Sign in to see live sessions.</div>}
        {error && <div className="text-sm text-[#EF5350]">{error}</div>}
        {rows && rows.length === 0 && <div className="text-sm text-[#9097A0]">No car is streaming right now.</div>}
        {rows?.map((r) => (
          <button key={r.id} onClick={() => { onPick(r); onClose(); }}
            className="w-full text-left px-2 py-1.5 rounded hover:bg-[#16171B] text-sm">
            <div className="text-[#E6E6E6]">{r.name}</div>
            <div className="text-[11px] text-[#9097A0]">{r.metadata.device_id ?? "unknown device"} · since {r.started_at ? new Date(r.started_at).toLocaleTimeString() : "?"}</div>
          </button>
        ))}
        <div className="mt-2 flex justify-end"><button onClick={onClose} className="text-xs text-[#9097A0] hover:text-[#FFC627]">Close</button></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: SessionPanel button**

In `SessionPanel.tsx` `Props` add `onConnectLive: () => void;` (destructure it), and next to the `+` button insert:

```tsx
          <button
            aria-label="Connect live telemetry"
            onClick={onConnectLive}
            className="w-5 h-5 flex items-center justify-center text-[#EF5350] hover:bg-[#16171B] rounded-sm"
            title="Connect to a car streaming live telemetry"
          >◉</button>
```

- [ ] **Step 4: App wiring**

In `App.tsx`:
- imports: `import { ConnectLiveDialog } from "./components/ConnectLiveDialog"; import { connectLiveSession, LIVE_ID_PREFIX, type LiveHandle, type LiveSessionRow } from "./lib/live-session"; import { useSupabaseClientOrNull } from "@helios/auth";`
- state next to `sessions` (line ~97): `const [liveDialogOpen, setLiveDialogOpen] = useState(false); const liveHandles = useRef(new Map<string, LiveHandle>()); const supabaseForLive = useSupabaseClientOrNull();`
- handler near `handleAddSessionFiles`:

```ts
  async function handleConnectLive(row: LiveSessionRow) {
    if (!supabaseForLive) return;
    const id = LIVE_ID_PREFIX + row.id;
    liveHandles.current.get(id)?.stop();
    try {
      const handle = await connectLiveSession(supabaseForLive, row, colorForIndex(0), (session) => {
        setSessions((prev) => mergeSessionsWithColors(prev ?? [], [session]));
      });
      liveHandles.current.set(id, handle);
    } catch (e) {
      setConfirmState({ title: "Live connect failed", message: String((e as Error).message ?? e), confirmLabel: "OK", onConfirm: () => setConfirmState(null) } as any);
    }
  }
```
  (Match `setConfirmState`'s real shape from the surrounding code — read the existing usage at ~line 1100 and mirror it exactly instead of the `as any`.)
- in `handleRemoveSession(id)` add first line: `liveHandles.current.get(id)?.stop(); liveHandles.current.delete(id);`
- `<SessionPanel … onConnectLive={() => setLiveDialogOpen(true)} />` and render `<ConnectLiveDialog open={liveDialogOpen} onClose={() => setLiveDialogOpen(false)} onPick={handleConnectLive} />` beside the other dialogs.
- Live sessions must not be written to the recent-sessions list (they have no `sourcePath`; confirm `addRecentSession` is only called in the file path — it is).

- [ ] **Step 5: Typecheck + tests + look at it**

Run: `pnpm --filter @helios/desktop typecheck && pnpm --filter @helios/desktop test`
Expected: clean, all existing tests pass.

Then the real check (memory rule: verify UI by screenshot/eyes): `pnpm --filter @helios/desktop dev`, sign in, start `helios-telemetry-gen live --seconds 300` from Task 8, press ◉, pick the session, add a strip-chart tile on `engine.rpm` + a numeric gauge. Expected: trace advances at 10 Hz, RPM 4000–12000 sawtooth. Read `lastLatencyMs()` by temporarily logging it in `flush` → expect **< 500 ms p50** on this network (host clock = device clock here). Remove the log.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): Connect live — Realtime live_fast source for the Logs module"
```

---

### Task 12: Docs + changelog + PR

**Files:**
- Modify: `docs/telemetry-wire-protocol.md`, `CHANGELOG.md`, `infra/telemetry-supabase/README.md`

- [ ] **Step 1: Protocol doc §9**

Append to `docs/telemetry-wire-protocol.md`:

```markdown
## 9. Live path (`live_fast`, 2026-09)

HTP/1 frames are the durable path only. Latency-critical live data bypasses the
edge function: the device holds one WebSocket to Supabase Realtime and
broadcasts on private topic `telemetry:live:{session_id}`, event `live_fast`,
every `1000/LIVE_HZ` ms (default 10 Hz):

    { "seq": u32, "t_us": u64, "t_send_ms": u64, "cs": u16, "v": base64 }

`v` = one sample per channel, groups ascending by key, channels in registered
order, same scalar encodings as §3.3 (i16fp null = 0x8000). For set 1 this is
86 bytes. Auth = HS256 device JWT (`scripts/mint-device-jwt.mjs`) sent as
`access_token` in the Phoenix `phx_join`; authorization = RLS on
`realtime.messages` (migration 20260902000000; 20260902000100 lets
`sessions.status` be `'live'`). Reference implementation:
`crates/helios-telemetry-gen/src/live_client.rs`; golden fixtures:
`crates/helios-htp/fixtures/live/`. Sessions are opened by the device via the
`telemetry-session` function (see its README).
```

- [ ] **Step 2: CHANGELOG**

Under `[Unreleased]` → `### Added`:

```markdown
- **Live telemetry in Logs.** A new ◉ button in the Sessions panel connects to a car that is streaming live over cellular; the session behaves like any other overlay session with the last 10 minutes of history. Backed by a direct Realtime path designed for under half a second sensor-to-screen.
```

- [ ] **Step 3: README status line**

In `infra/telemetry-supabase/README.md` replace `Status: **authored, not yet verified**…` with `Status: **deployed to prod** (June 2026 ingest + Sept 2026 live path). See docs/superpowers/specs/2026-09-02-cellular-telemetry-fast-path.md.` and add `telemetry-session` + `_shared/` to the Layout list.

- [ ] **Step 4: Commit + push + PR**

```bash
git add docs CHANGELOG.md infra/telemetry-supabase/README.md
git commit -m "docs(telemetry): live path protocol section, changelog, README status"
git push -u origin feat/telemetry-live-path
gh pr create --title "Telemetry live path: helios-htp, Realtime live_fast, device sessions, Logs live source" --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-09-02-cellular-telemetry-fast-path.md (server half).

- merges feat/telemetry-pipeline (HTP/1 ingest, schema, compactor) onto main
- crates/helios-htp: protocol single source of truth + golden fixtures (firmware repo vendors these)
- realtime.messages policies for private telemetry:live:* channels; device JWT mint script
- telemetry-session edge function (device self-provisioned sessions)
- crates/helios-telemetry-gen: synthetic reference client (replay + live), proven against prod
- Logs: Connect live (◉) → LiveBuffer + rAF-gated store rebuild

Prod changes already applied: migrations 20260902000000 (realtime.messages policies) + 20260902000100 (sessions.status allows 'live'), functions telemetry-session deployed + telemetry-ingest redeployed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01UZaC8bmiDuyQhpBeumgTmP
EOF
```

---

## Follow-ups (not in this plan)
- CSV replay source for `helios-telemetry-gen` via `helios_csv::load_csv` (integrity differ needs it; live path doesn't).
- Helios Lite live view (same `live-decode` + `LiveBuffer`; needs those two modules lifted into `packages/`).
- Compactor hosting decision.
- Firmware: `docs/superpowers/plans/2026-09-02-telemetry-firmware.md`.
