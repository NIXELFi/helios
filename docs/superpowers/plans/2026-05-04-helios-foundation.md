# Helios Plan 1 — Foundation + First Vertical Slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Helios monorepo, Rust + TypeScript channel store, CSV loader, and a Tauri desktop app that auto-loads a sample SDM26 lap and displays it in two widgets (StripChart + NumericReadout). End state: `pnpm dev` opens the app, sample CSV loads, both widgets render real data with a working synced cursor.

**Architecture:** Three-layer (Channel Store → Session → Widgets) per the design spec. Plan 1 ships the data layer end-to-end and exactly two widgets to prove the architecture. Subsequent plans extend horizontally (more widgets, math, datums, alarms, polish).

**Tech Stack:** Tauri 2 · Rust · React 18 + TypeScript 5 · Vite · uPlot · arquero (Apache Arrow) · Zustand · Tailwind · Vitest · pnpm workspaces · cargo workspaces · Turbo

**Reference:** `docs/superpowers/specs/2026-05-04-helios-design.md`

---

## File Structure (Plan 1)

```
helios/
├── .gitignore
├── README.md
├── package.json                          # root pnpm workspace
├── pnpm-workspace.yaml
├── Cargo.toml                            # root cargo workspace
├── tsconfig.base.json
├── turbo.json
├── docs/channels.yaml                    # curated SDM26 registry (minimal)
├── samples/sdm26-synthetic-lap.csv       # ~90s synthetic lap
├── fixtures/
│   ├── good/simple_100hz.csv
│   ├── multi_rate/two_rates.csv
│   └── malformed/{missing_header.csv, non_monotonic.csv}
├── crates/
│   ├── helios-core/                      # ChannelMeta, RateGroup, TimeRange
│   ├── helios-csv/                       # CSV → Vec<RateGroup>
│   └── helios-arrow/                     # Arrow IPC helpers
├── packages/
│   ├── store/                            # ChannelStore (TS)
│   ├── lib/                              # cursor emitter, time utils
│   ├── ui/                               # theme tokens
│   └── widgets/                          # registry + StripChart + NumericReadout
└── apps/desktop/
    ├── src/                              # React frontend
    │   ├── App.tsx                       # wires store → workspace → widgets
    │   └── workspaces/overview-default.ts
    └── src-tauri/
        └── src/commands/load_csv.rs      # Tauri command bridging to helios-csv
```

---

## Task 1: Repo skeleton — workspaces, ignores, README

**Files:**
- Create: `helios/.gitignore`
- Create: `helios/package.json`
- Create: `helios/pnpm-workspace.yaml`
- Create: `helios/Cargo.toml`
- Create: `helios/tsconfig.base.json`
- Create: `helios/turbo.json`
- Create: `helios/README.md`

(Helios git repo and `docs/` already exist from brainstorming.)

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# Node
node_modules/
.turbo/
dist/
*.log

# Rust
target/
**/*.rs.bk
Cargo.lock.bak

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/*
!.vscode/extensions.json
.idea/

# Tauri
apps/desktop/src-tauri/gen/
apps/desktop/src-tauri/target/

# Env
.env
.env.local

# Test artifacts
coverage/
playwright-report/
test-results/
```

- [ ] **Step 2: Create `package.json` (root)**

```json
{
  "name": "helios",
  "version": "0.0.1",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "turbo run dev --filter=@helios/desktop",
    "build": "turbo run build",
    "test": "turbo run test",
    "test:visual": "turbo run test:visual",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "bench": "turbo run bench"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 4: Create `Cargo.toml` (root workspace)**

```toml
[workspace]
resolver = "2"
members = [
  "crates/helios-core",
  "crates/helios-csv",
  "crates/helios-arrow",
  "apps/desktop/src-tauri",
]

[workspace.package]
version = "0.0.1"
edition = "2021"
license = "MIT"

[workspace.dependencies]
arrow = "53"
arrow-ipc = "53"
csv = "1.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
thiserror = "1"
anyhow = "1"
```

- [ ] **Step 5: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  }
}
```

- [ ] **Step 6: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "test": { "dependsOn": ["^build"] },
    "test:visual": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "bench": { "cache": false }
  }
}
```

- [ ] **Step 7: Create `README.md`**

```markdown
# Helios

Sun Devil Motorsports ground-station telemetry suite.

## Quick start

```bash
pnpm install
pnpm dev
```

## Documentation

- Design spec: `docs/superpowers/specs/2026-05-04-helios-design.md`
- Architecture: `docs/architecture.md`
- Channel registry: `docs/channels.yaml`

## Repo layout

- `apps/desktop/` — Tauri shell + React frontend
- `crates/` — Rust crates (channel store core, CSV loader, Arrow helpers)
- `packages/` — TypeScript packages (store bridge, widgets, UI primitives)
- `samples/` — bundled sample sessions
- `fixtures/` — test fixtures

## Tests

```bash
pnpm test       # all TS tests
cargo test      # all Rust tests
```
```

- [ ] **Step 8: Commit**

```bash
git add .gitignore package.json pnpm-workspace.yaml Cargo.toml tsconfig.base.json turbo.json README.md
git commit -m "chore: scaffold pnpm + cargo workspaces"
```

---

## Task 2: helios-core — ChannelMeta, RateGroup, TimeRange types

**Files:**
- Create: `crates/helios-core/Cargo.toml`
- Create: `crates/helios-core/src/lib.rs`
- Create: `crates/helios-core/src/channel.rs`
- Create: `crates/helios-core/src/rate_group.rs`
- Create: `crates/helios-core/src/time.rs`

- [ ] **Step 1: Create `crates/helios-core/Cargo.toml`**

```toml
[package]
name = "helios-core"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
arrow = { workspace = true }
serde = { workspace = true }
thiserror = { workspace = true }
```

- [ ] **Step 2: Create `crates/helios-core/src/lib.rs`**

```rust
pub mod channel;
pub mod rate_group;
pub mod time;

pub use channel::{ChannelMeta, DataType};
pub use rate_group::RateGroup;
pub use time::TimeRange;
```

- [ ] **Step 3: Write failing test for `ChannelMeta` construction**

Append to `crates/helios-core/src/channel.rs`:

```rust
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
```

Add `serde_json = { workspace = true }` to dev-deps in `Cargo.toml`:

```toml
[dev-dependencies]
serde_json = { workspace = true }
```

- [ ] **Step 4: Run test, confirm pass**

```bash
cargo test -p helios-core channel_meta_roundtrip_json
```

Expected: 1 passed.

- [ ] **Step 5: Add `TimeRange` type with tests**

Create `crates/helios-core/src/time.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_us: i64,
    pub end_us: i64,
}

impl TimeRange {
    pub fn new(start_us: i64, end_us: i64) -> Self {
        debug_assert!(end_us >= start_us, "TimeRange end must be >= start");
        Self { start_us, end_us }
    }

    pub fn duration_us(&self) -> i64 { self.end_us - self.start_us }

    pub fn contains(&self, t_us: i64) -> bool {
        t_us >= self.start_us && t_us < self.end_us
    }

    pub fn intersect(&self, other: &TimeRange) -> Option<TimeRange> {
        let s = self.start_us.max(other.start_us);
        let e = self.end_us.min(other.end_us);
        if e > s { Some(TimeRange::new(s, e)) } else { None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_basic() {
        assert_eq!(TimeRange::new(0, 1_000_000).duration_us(), 1_000_000);
    }

    #[test]
    fn contains_is_half_open() {
        let r = TimeRange::new(0, 100);
        assert!(r.contains(0));
        assert!(r.contains(99));
        assert!(!r.contains(100));
        assert!(!r.contains(-1));
    }

    #[test]
    fn intersect_overlap() {
        let a = TimeRange::new(0, 100);
        let b = TimeRange::new(50, 200);
        assert_eq!(a.intersect(&b), Some(TimeRange::new(50, 100)));
    }

    #[test]
    fn intersect_disjoint() {
        let a = TimeRange::new(0, 100);
        let b = TimeRange::new(100, 200);
        assert_eq!(a.intersect(&b), None);
    }
}
```

- [ ] **Step 6: Run TimeRange tests**

```bash
cargo test -p helios-core time::tests
```

Expected: 4 passed.

- [ ] **Step 7: Add `RateGroup` skeleton with construction + lookup tests**

Create `crates/helios-core/src/rate_group.rs`:

```rust
use crate::channel::ChannelMeta;
use arrow::array::{ArrayRef, Float64Array, Int64Array};
use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RateGroupError {
    #[error("channel id `{0}` not found in rate group")]
    UnknownChannel(String),
    #[error("arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
}

/// A group of channels that share a sample rate and time index.
/// One Arrow RecordBatch with `time_us` (Int64) plus one Float64 column per channel.
pub struct RateGroup {
    pub id: String,
    pub nominal_rate_hz: f32,
    channels: HashMap<String, usize>, // channel_id -> column index in batch
    metas: Vec<ChannelMeta>,
    batch: RecordBatch,
}

impl RateGroup {
    pub fn build(
        id: impl Into<String>,
        nominal_rate_hz: f32,
        time_us: Vec<i64>,
        channel_data: Vec<(ChannelMeta, Vec<f64>)>,
    ) -> Result<Self, RateGroupError> {
        let n = time_us.len();
        for (m, v) in &channel_data {
            assert_eq!(v.len(), n, "channel `{}` has wrong length", m.id);
        }
        let mut fields = vec![Field::new("time_us", ArrowDataType::Int64, false)];
        let mut arrays: Vec<ArrayRef> = vec![Arc::new(Int64Array::from(time_us))];
        let mut channels = HashMap::new();
        let mut metas = Vec::new();
        for (i, (meta, data)) in channel_data.into_iter().enumerate() {
            fields.push(Field::new(&meta.id, ArrowDataType::Float64, true));
            arrays.push(Arc::new(Float64Array::from(data)));
            channels.insert(meta.id.clone(), i + 1);
            metas.push(meta);
        }
        let schema = Arc::new(Schema::new(fields));
        let batch = RecordBatch::try_new(schema, arrays)?;
        Ok(Self { id: id.into(), nominal_rate_hz, channels, metas, batch })
    }

    pub fn channel_ids(&self) -> Vec<&str> {
        self.metas.iter().map(|m| m.id.as_str()).collect()
    }

    pub fn meta(&self, id: &str) -> Option<&ChannelMeta> {
        self.channels.get(id).map(|&i| &self.metas[i - 1])
    }

    pub fn batch(&self) -> &RecordBatch { &self.batch }

    pub fn time_us(&self) -> &Int64Array {
        self.batch.column(0).as_any().downcast_ref::<Int64Array>().unwrap()
    }

    pub fn channel_data(&self, id: &str) -> Result<&Float64Array, RateGroupError> {
        let &col = self.channels.get(id)
            .ok_or_else(|| RateGroupError::UnknownChannel(id.into()))?;
        Ok(self.batch.column(col).as_any().downcast_ref::<Float64Array>().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::DataType;

    fn meta(id: &str) -> ChannelMeta {
        ChannelMeta {
            id: id.into(), display_name: id.into(), units: "".into(),
            group: "test".into(), color: "#fff".into(), decimals: 2,
            data_type: DataType::F64, source: "test".into(),
            sample_rate_hz: 100.0, min: None, max: None, warn: None, alarm: None,
        }
    }

    #[test]
    fn build_and_lookup() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000, 20_000],
            vec![
                (meta("engine.rpm"), vec![1000.0, 2000.0, 3000.0]),
                (meta("engine.tps"), vec![10.0, 20.0, 30.0]),
            ],
        ).unwrap();

        assert_eq!(rg.channel_ids(), vec!["engine.rpm", "engine.tps"]);
        assert!(rg.meta("engine.rpm").is_some());
        assert_eq!(rg.time_us().value(1), 10_000);
        assert_eq!(rg.channel_data("engine.rpm").unwrap().value(2), 3000.0);
    }

    #[test]
    fn unknown_channel_errors() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000],
            vec![(meta("a"), vec![1.0, 2.0])],
        ).unwrap();
        assert!(matches!(
            rg.channel_data("missing"),
            Err(RateGroupError::UnknownChannel(_))
        ));
    }
}
```

- [ ] **Step 8: Run all helios-core tests**

```bash
cargo test -p helios-core
```

Expected: 7 passed (1 channel + 4 time + 2 rate_group).

- [ ] **Step 9: Commit**

```bash
git add crates/helios-core
git commit -m "feat(core): add ChannelMeta, RateGroup, TimeRange types with tests"
```

---

## Task 3: helios-arrow — Arrow IPC helpers

**Files:**
- Create: `crates/helios-arrow/Cargo.toml`
- Create: `crates/helios-arrow/src/lib.rs`

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "helios-arrow"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
arrow = { workspace = true }
arrow-ipc = { workspace = true }
helios-core = { path = "../helios-core" }
thiserror = { workspace = true }
```

- [ ] **Step 2: Write failing IPC round-trip test**

Create `crates/helios-arrow/src/lib.rs`:

```rust
use arrow::record_batch::RecordBatch;
use arrow_ipc::reader::StreamReader;
use arrow_ipc::writer::StreamWriter;
use helios_core::RateGroup;
use std::io::Cursor;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ArrowIpcError {
    #[error("arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
}

/// Serialize a RateGroup's RecordBatch to Arrow IPC stream bytes (zero-copy on the read side).
pub fn batch_to_ipc(batch: &RecordBatch) -> Result<Vec<u8>, ArrowIpcError> {
    let mut buf = Vec::new();
    {
        let mut w = StreamWriter::try_new(&mut buf, &batch.schema())?;
        w.write(batch)?;
        w.finish()?;
    }
    Ok(buf)
}

/// Deserialize Arrow IPC stream bytes back into a single RecordBatch.
pub fn batch_from_ipc(bytes: &[u8]) -> Result<RecordBatch, ArrowIpcError> {
    let mut r = StreamReader::try_new(Cursor::new(bytes), None)?;
    let batch = r.next().expect("expected exactly one batch")?;
    Ok(batch)
}

pub fn rate_group_to_ipc(rg: &RateGroup) -> Result<Vec<u8>, ArrowIpcError> {
    batch_to_ipc(rg.batch())
}

#[cfg(test)]
mod tests {
    use super::*;
    use helios_core::{ChannelMeta, DataType};

    fn meta(id: &str) -> ChannelMeta {
        ChannelMeta {
            id: id.into(), display_name: id.into(), units: "".into(),
            group: "t".into(), color: "#fff".into(), decimals: 2,
            data_type: DataType::F64, source: "t".into(),
            sample_rate_hz: 100.0, min: None, max: None, warn: None, alarm: None,
        }
    }

    #[test]
    fn ipc_roundtrip() {
        let rg = RateGroup::build(
            "100hz", 100.0,
            vec![0, 10_000, 20_000],
            vec![(meta("a"), vec![1.0, 2.0, 3.0])],
        ).unwrap();
        let bytes = rate_group_to_ipc(&rg).unwrap();
        let back = batch_from_ipc(&bytes).unwrap();
        assert_eq!(back.num_rows(), 3);
        assert_eq!(back.num_columns(), 2);
        assert_eq!(back.schema().field(1).name(), "a");
    }
}
```

- [ ] **Step 3: Run test**

```bash
cargo test -p helios-arrow
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/helios-arrow
git commit -m "feat(arrow): add Arrow IPC round-trip helpers"
```

---

## Task 4: helios-csv — delimiter and time-unit detection

**Files:**
- Create: `crates/helios-csv/Cargo.toml`
- Create: `crates/helios-csv/src/lib.rs`
- Create: `crates/helios-csv/src/delimiter.rs`
- Create: `crates/helios-csv/src/time_detect.rs`
- Create: `fixtures/good/simple_100hz.csv`
- Create: `fixtures/multi_rate/two_rates.csv`
- Create: `fixtures/malformed/missing_header.csv`
- Create: `fixtures/malformed/non_monotonic.csv`

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "helios-csv"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
helios-core = { path = "../helios-core" }
csv = { workspace = true }
serde = { workspace = true }
serde_yaml = { workspace = true }
thiserror = { workspace = true }
anyhow = { workspace = true }
arrow = { workspace = true }

[dev-dependencies]
```

- [ ] **Step 2: Create `src/lib.rs` with module decls**

```rust
pub mod delimiter;
pub mod time_detect;

#[derive(Debug, thiserror::Error)]
pub enum CsvLoadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("csv: {0}")]
    Csv(#[from] csv::Error),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("core: {0}")]
    Core(#[from] helios_core::rate_group::RateGroupError),
}
```

- [ ] **Step 3: Write failing delimiter detection tests**

Create `crates/helios-csv/src/delimiter.rs`:

```rust
/// Detects the most likely delimiter from the first line of a CSV.
/// Tries `,` `;` `\t` in order and picks the one with the most occurrences (>= 1).
pub fn detect_delimiter(first_line: &str) -> u8 {
    let candidates = [b',', b';', b'\t'];
    candidates
        .into_iter()
        .max_by_key(|&d| first_line.bytes().filter(|&b| b == d).count())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn comma() { assert_eq!(detect_delimiter("a,b,c"), b','); }
    #[test] fn semi() { assert_eq!(detect_delimiter("a;b;c"), b';'); }
    #[test] fn tab() { assert_eq!(detect_delimiter("a\tb\tc"), b'\t'); }
    #[test] fn comma_wins_tie_with_no_others() {
        assert_eq!(detect_delimiter("only_one_column"), b',');
    }
}
```

- [ ] **Step 4: Run delimiter tests**

```bash
cargo test -p helios-csv delimiter::tests
```

Expected: 4 passed.

- [ ] **Step 5: Write failing time-unit detection tests**

Create `crates/helios-csv/src/time_detect.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeUnit { Seconds, Milliseconds, Microseconds }

impl TimeUnit {
    pub fn to_us(self, v: f64) -> i64 {
        match self {
            TimeUnit::Seconds => (v * 1_000_000.0).round() as i64,
            TimeUnit::Milliseconds => (v * 1_000.0).round() as i64,
            TimeUnit::Microseconds => v.round() as i64,
        }
    }
}

/// Detect time unit from header name + first sample value.
/// Header suffix takes priority; otherwise infer from magnitude.
pub fn detect_time_unit(header: &str, first_value: f64) -> TimeUnit {
    let lower = header.to_lowercase();
    if lower.ends_with("_us") || lower == "time_us" { return TimeUnit::Microseconds; }
    if lower.ends_with("_ms") || lower == "time_ms" { return TimeUnit::Milliseconds; }
    if lower.ends_with("_s") || lower == "time_s" || lower == "time" || lower == "t" {
        return TimeUnit::Seconds;
    }
    // Fall back to magnitude heuristic on the first row's first value.
    if first_value > 1e9 { TimeUnit::Microseconds }
    else if first_value > 1e6 { TimeUnit::Milliseconds }
    else { TimeUnit::Seconds }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn seconds_from_header() { assert_eq!(detect_time_unit("time_s", 0.0), TimeUnit::Seconds); }
    #[test] fn ms_from_header()      { assert_eq!(detect_time_unit("time_ms", 0.0), TimeUnit::Milliseconds); }
    #[test] fn us_from_header()      { assert_eq!(detect_time_unit("time_us", 0.0), TimeUnit::Microseconds); }
    #[test] fn time_alias()          { assert_eq!(detect_time_unit("time", 0.0), TimeUnit::Seconds); }
    #[test] fn t_alias()             { assert_eq!(detect_time_unit("t", 0.0), TimeUnit::Seconds); }

    #[test] fn fallback_seconds()    { assert_eq!(detect_time_unit("foo", 12.5), TimeUnit::Seconds); }
    #[test] fn fallback_ms()         { assert_eq!(detect_time_unit("foo", 12_500.0), TimeUnit::Milliseconds); }
    #[test] fn fallback_us()         { assert_eq!(detect_time_unit("foo", 12_500_000_000.0), TimeUnit::Microseconds); }

    #[test] fn convert_seconds()     { assert_eq!(TimeUnit::Seconds.to_us(1.5), 1_500_000); }
    #[test] fn convert_ms()          { assert_eq!(TimeUnit::Milliseconds.to_us(1.5), 1_500); }
    #[test] fn convert_us()          { assert_eq!(TimeUnit::Microseconds.to_us(1.5), 2); }
}
```

- [ ] **Step 6: Run time-detect tests**

```bash
cargo test -p helios-csv time_detect::tests
```

Expected: 11 passed.

- [ ] **Step 7: Create test fixtures**

Create `fixtures/good/simple_100hz.csv`:

```
time_s,engine.rpm,engine.tps
0.00,1000,5
0.01,1010,5
0.02,1020,6
0.03,1030,6
0.04,1040,7
```

Create `fixtures/multi_rate/two_rates.csv` (engine 100 Hz, gps 10 Hz; gps cells empty when no sample):

```
time_s,engine.rpm,gps.speed
0.00,1000,12.0
0.01,1010,
0.02,1020,
0.03,1030,
0.04,1040,
0.05,1050,
0.06,1060,
0.07,1070,
0.08,1080,
0.09,1090,
0.10,1100,12.5
```

Create `fixtures/malformed/missing_header.csv`:

```
0.00,1000,5
0.01,1010,5
```

Create `fixtures/malformed/non_monotonic.csv`:

```
time_s,engine.rpm
0.00,1000
0.02,1010
0.01,1020
```

- [ ] **Step 8: Commit**

```bash
git add crates/helios-csv fixtures/
git commit -m "feat(csv): add delimiter + time-unit detection with fixtures"
```

---

## Task 5: channels.yaml registry + registry loader

**Files:**
- Create: `docs/channels.yaml`
- Create: `crates/helios-csv/src/registry.rs`
- Modify: `crates/helios-csv/src/lib.rs`

- [ ] **Step 1: Create `docs/channels.yaml` with the SDM26 starter inventory**

```yaml
# Helios canonical channel registry
# Each entry maps one channel id to its display metadata.
# `aliases:` lists CSV header names that should resolve to this channel.

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
    min: 0
    max: 15000
    warn: 13500
    alarm: 14500
    aliases: [rpm, RPM, engine_rpm, "engine.rpm"]

  - id: engine.tps
    display_name: Throttle Position
    units: "%"
    group: Engine
    color: "#4FC3F7"
    decimals: 1
    data_type: f32
    source: link_g4x
    sample_rate_hz: 100
    min: 0
    max: 100
    aliases: [tps, TPS, throttle, throttle_pct, "engine.tps"]

  - id: engine.water_temp
    display_name: Water Temp
    units: "°C"
    group: Engine
    color: "#66BB6A"
    decimals: 1
    data_type: f32
    source: link_g4x
    sample_rate_hz: 10
    min: 0
    max: 130
    warn: 105
    alarm: 115
    aliases: [water_temp, ECT, "engine.water_temp"]

  - id: engine.oil_temp
    display_name: Oil Temp
    units: "°C"
    group: Engine
    color: "#FF8A65"
    decimals: 1
    data_type: f32
    source: link_g4x
    sample_rate_hz: 10
    min: 0
    max: 150
    warn: 120
    alarm: 135
    aliases: [oil_temp, OilT, "engine.oil_temp"]

  - id: engine.gear
    display_name: Gear
    units: ""
    group: Engine
    color: "#BA68C8"
    decimals: 0
    data_type: u16
    source: link_g4x
    sample_rate_hz: 100
    min: 0
    max: 6
    aliases: [gear, "engine.gear"]

  - id: gps.lat
    display_name: GPS Latitude
    units: "°"
    group: GPS
    color: "#9CCC65"
    decimals: 6
    data_type: f64
    source: gps_module
    sample_rate_hz: 10
    aliases: [lat, latitude, "gps.lat"]

  - id: gps.lon
    display_name: GPS Longitude
    units: "°"
    group: GPS
    color: "#9CCC65"
    decimals: 6
    data_type: f64
    source: gps_module
    sample_rate_hz: 10
    aliases: [lon, lng, longitude, "gps.lon"]

  - id: gps.speed
    display_name: GPS Speed
    units: m/s
    group: GPS
    color: "#26A69A"
    decimals: 2
    data_type: f32
    source: gps_module
    sample_rate_hz: 10
    aliases: [speed, gps_speed, "gps.speed"]

  - id: imu.lat_g
    display_name: Lateral G
    units: g
    group: IMU
    color: "#EF5350"
    decimals: 2
    data_type: f32
    source: imu
    sample_rate_hz: 100
    min: -3
    max: 3
    aliases: [lat_g, "imu.lat_g"]
```

- [ ] **Step 2: Write failing registry tests**

Create `crates/helios-csv/src/registry.rs`:

```rust
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
            // The id always resolves to itself.
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

    const YAML: &str = r#"
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
"#;

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
}
```

Add `pub mod registry;` to `crates/helios-csv/src/lib.rs`.

- [ ] **Step 3: Run registry tests**

```bash
cargo test -p helios-csv registry::tests
```

Expected: 3 passed.

- [ ] **Step 4: Verify the real `docs/channels.yaml` parses**

Add to `crates/helios-csv/src/registry.rs` `tests` module:

```rust
    #[test]
    fn real_channels_yaml_parses() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/channels.yaml");
        let r = ChannelRegistry::from_path(&path).expect("docs/channels.yaml must parse");
        assert!(r.resolve("engine.rpm").is_some());
        assert!(r.resolve("rpm").is_some());
        assert!(r.resolve("gps.lat").is_some());
    }
```

```bash
cargo test -p helios-csv registry::tests::real_channels_yaml_parses
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add docs/channels.yaml crates/helios-csv/src/registry.rs crates/helios-csv/src/lib.rs
git commit -m "feat(csv): add channels.yaml registry + alias resolver"
```

---

## Task 6: helios-csv — load_csv() integration with rate-group assembly

**Files:**
- Create: `crates/helios-csv/src/load.rs`
- Modify: `crates/helios-csv/src/lib.rs`

- [ ] **Step 1: Write failing integration test against the simple fixture**

Create `crates/helios-csv/src/load.rs`:

```rust
use crate::{delimiter::detect_delimiter, registry::ChannelRegistry, time_detect::detect_time_unit, CsvLoadError};
use helios_core::{ChannelMeta, RateGroup};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug)]
pub struct LoadResult {
    pub rate_groups: Vec<RateGroup>,
    pub warnings: Vec<String>,
    pub duration_us: i64,
}

pub fn load_csv(path: &Path, registry: &ChannelRegistry) -> Result<LoadResult, CsvLoadError> {
    let bytes = std::fs::read(path)?;
    load_csv_bytes(&bytes, registry)
}

pub fn load_csv_bytes(bytes: &[u8], registry: &ChannelRegistry) -> Result<LoadResult, CsvLoadError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| CsvLoadError::Malformed(format!("non-utf8 input: {e}")))?;
    let first_line = text.lines().next()
        .ok_or_else(|| CsvLoadError::Malformed("empty file".into()))?;
    let delim = detect_delimiter(first_line);

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(true)
        .from_reader(bytes);

    let headers = rdr.headers()?.clone();
    if headers.is_empty() {
        return Err(CsvLoadError::Malformed("no headers".into()));
    }
    let time_header = &headers[0];

    // Read all rows into a Vec<Vec<Option<f64>>>; first column treated as time.
    let mut times_raw: Vec<f64> = Vec::new();
    let mut cols: Vec<Vec<Option<f64>>> = vec![Vec::new(); headers.len() - 1];
    for rec in rdr.records() {
        let rec = rec?;
        let t: f64 = rec[0].trim().parse()
            .map_err(|e| CsvLoadError::Malformed(format!("bad time `{}`: {e}", &rec[0])))?;
        times_raw.push(t);
        for (i, c) in cols.iter_mut().enumerate() {
            let s = rec.get(i + 1).unwrap_or("").trim();
            c.push(if s.is_empty() { None } else { s.parse().ok() });
        }
    }

    if times_raw.is_empty() {
        return Err(CsvLoadError::Malformed("no data rows".into()));
    }
    for w in times_raw.windows(2) {
        if w[1] < w[0] {
            return Err(CsvLoadError::Malformed("time column is not monotonically non-decreasing".into()));
        }
    }

    let unit = detect_time_unit(time_header, times_raw[0]);
    let times_us: Vec<i64> = times_raw.iter().copied().map(|v| unit.to_us(v)).collect();

    // Group columns by sample rate. A column's rate = nominal registry rate if known,
    // else inferred from non-None density.
    let mut warnings = Vec::new();
    let mut by_rate: BTreeMap<i32, Vec<(usize, ChannelMeta)>> = BTreeMap::new();
    let span_us = (*times_us.last().unwrap() - times_us[0]).max(1);
    let span_s = span_us as f64 / 1_000_000.0;

    for (i, name) in headers.iter().enumerate().skip(1) {
        let non_null = cols[i - 1].iter().filter(|x| x.is_some()).count();
        let inferred_rate = (non_null as f64 / span_s).round() as i32;
        let (mut meta, was_known) = registry.resolve_or_default(name, inferred_rate.max(1) as f32);
        if !was_known {
            warnings.push(format!("unknown channel `{name}`, registered with defaults"));
        } else {
            // Use registry rate, not inferred.
            meta.sample_rate_hz = meta.sample_rate_hz.max(1.0);
        }
        let key = meta.sample_rate_hz.round() as i32;
        by_rate.entry(key).or_default().push((i - 1, meta));
    }

    // Build a RateGroup per rate.
    let mut rate_groups = Vec::new();
    for (rate, entries) in by_rate {
        // Filter rows where at least one channel in this group has a value.
        let mut keep_indices = Vec::new();
        for r in 0..times_us.len() {
            if entries.iter().any(|(ci, _)| cols[*ci][r].is_some()) {
                keep_indices.push(r);
            }
        }
        let rg_times: Vec<i64> = keep_indices.iter().map(|&r| times_us[r]).collect();
        let mut rg_cols: Vec<(ChannelMeta, Vec<f64>)> = Vec::new();
        for (ci, meta) in entries {
            let mut data = Vec::with_capacity(keep_indices.len());
            let mut last = f64::NAN;
            for &r in &keep_indices {
                if let Some(v) = cols[ci][r] { last = v; data.push(v); }
                else { data.push(last); } // forward-fill
            }
            rg_cols.push((meta, data));
        }
        rate_groups.push(RateGroup::build(format!("{rate}hz"), rate as f32, rg_times, rg_cols)?);
    }

    let duration_us = *times_us.last().unwrap() - times_us[0];
    Ok(LoadResult { rate_groups, warnings, duration_us })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn registry() -> ChannelRegistry {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/channels.yaml");
        ChannelRegistry::from_path(&p).unwrap()
    }

    fn fixture(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(rel)
    }

    #[test]
    fn loads_simple_100hz() {
        let r = load_csv(&fixture("good/simple_100hz.csv"), &registry()).unwrap();
        assert_eq!(r.rate_groups.len(), 1);
        let rg = &r.rate_groups[0];
        assert_eq!(rg.nominal_rate_hz, 100.0);
        assert_eq!(rg.channel_ids(), vec!["engine.rpm", "engine.tps"]);
        assert_eq!(rg.channel_data("engine.rpm").unwrap().value(0), 1000.0);
        assert_eq!(r.duration_us, 40_000); // 0.00 -> 0.04 s
    }

    #[test]
    fn loads_multi_rate() {
        let r = load_csv(&fixture("multi_rate/two_rates.csv"), &registry()).unwrap();
        assert_eq!(r.rate_groups.len(), 2);
        let rates: Vec<i32> = r.rate_groups.iter().map(|g| g.nominal_rate_hz as i32).collect();
        assert!(rates.contains(&100) && rates.contains(&10));
    }

    #[test]
    fn rejects_non_monotonic() {
        let err = load_csv(&fixture("malformed/non_monotonic.csv"), &registry()).unwrap_err();
        assert!(matches!(err, CsvLoadError::Malformed(_)));
    }

    #[test]
    fn missing_header_row_is_treated_as_data_failure() {
        // First row "0.00,1000,5" is taken as headers; subsequent numeric "headers"
        // become unknown channels — load still succeeds with warnings.
        let r = load_csv(&fixture("malformed/missing_header.csv"), &registry()).unwrap();
        assert!(!r.warnings.is_empty());
    }
}
```

- [ ] **Step 2: Add `pub mod load;` to `crates/helios-csv/src/lib.rs` and re-export**

Edit `crates/helios-csv/src/lib.rs` to be:

```rust
pub mod delimiter;
pub mod load;
pub mod registry;
pub mod time_detect;

pub use load::{load_csv, load_csv_bytes, LoadResult};
pub use registry::ChannelRegistry;

#[derive(Debug, thiserror::Error)]
pub enum CsvLoadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("csv: {0}")]
    Csv(#[from] csv::Error),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("core: {0}")]
    Core(#[from] helios_core::rate_group::RateGroupError),
}
```

- [ ] **Step 3: Run all helios-csv tests**

```bash
cargo test -p helios-csv
```

Expected: 4 load + 11 time_detect + 4 delimiter + 4 registry = 23 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/helios-csv
git commit -m "feat(csv): add load_csv() with rate-group assembly + multi-rate support"
```

---

## Task 7: Synthetic SDM26 sample CSV

**Files:**
- Create: `samples/sdm26-synthetic-lap.csv`
- Create: `scripts/generate_sample.py`

- [ ] **Step 1: Create generator script**

Create `scripts/generate_sample.py`:

```python
#!/usr/bin/env python3
"""Generate a synthetic 90-second SDM26 lap CSV for the Helios sample session.

Engine + IMU at 100 Hz, GPS at 10 Hz (forward-filled into 100 Hz grid for simplicity here),
water/oil temps at 10 Hz. Produces deterministic data; do not edit by hand.
"""
import math
import random

random.seed(42)
DT = 0.01      # 100 Hz
DUR = 90.0     # seconds
N = int(DUR / DT)

def write():
    headers = [
        "time_s", "engine.rpm", "engine.tps", "engine.gear",
        "engine.water_temp", "engine.oil_temp",
        "gps.lat", "gps.lon", "gps.speed", "imu.lat_g",
    ]
    lines = [",".join(headers)]
    for i in range(N):
        t = i * DT
        # Lap profile: accelerate, brake, corner, repeat.
        phase = (t % 30.0) / 30.0
        rpm = 4000 + 8000 * (0.5 + 0.5 * math.sin(2 * math.pi * phase * 1.5))
        rpm += random.uniform(-50, 50)
        tps = max(0.0, min(100.0, 50 + 50 * math.sin(2 * math.pi * phase * 1.5)))
        gear = 1 + int(min(5, phase * 5))
        # Slow channels updated every 10 samples (10 Hz).
        if i % 10 == 0:
            water = 88 + 4 * math.sin(t / 30) + random.uniform(-0.2, 0.2)
            oil   = 95 + 8 * math.sin(t / 30) + random.uniform(-0.2, 0.2)
            lat   = 33.4242 + 0.0008 * math.sin(2 * math.pi * t / 60)
            lon   = -111.9281 + 0.0008 * math.cos(2 * math.pi * t / 60)
            speed = max(5.0, 30 + 20 * math.sin(2 * math.pi * phase * 1.5))
        else:
            water, oil, lat, lon, speed = "", "", "", "", ""
        lat_g = 1.4 * math.sin(2 * math.pi * t / 5)
        lines.append(f"{t:.2f},{rpm:.0f},{tps:.1f},{gear},{water},{oil},{lat},{lon},{speed},{lat_g:.3f}")
    with open("samples/sdm26-synthetic-lap.csv", "w") as f:
        f.write("\n".join(lines) + "\n")

if __name__ == "__main__":
    write()
    print(f"wrote samples/sdm26-synthetic-lap.csv ({N} rows)")
```

- [ ] **Step 2: Generate the sample CSV**

```bash
mkdir -p samples
python3 scripts/generate_sample.py
```

Expected stdout: `wrote samples/sdm26-synthetic-lap.csv (9000 rows)`

- [ ] **Step 3: Add a test that loads the sample successfully**

Append to `crates/helios-csv/src/load.rs` `tests` module:

```rust
    #[test]
    fn sample_session_loads() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/sdm26-synthetic-lap.csv");
        let r = load_csv(&path, &registry()).unwrap();
        assert!(r.rate_groups.len() >= 2, "expected at least 100Hz and 10Hz groups");
        assert!(r.duration_us > 89_000_000 && r.duration_us < 91_000_000);
        // engine.rpm should appear in the 100 Hz group.
        let has_rpm = r.rate_groups.iter().any(|g| g.meta("engine.rpm").is_some());
        assert!(has_rpm, "engine.rpm missing from sample load");
    }
```

```bash
cargo test -p helios-csv sample_session_loads
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add samples/ scripts/ crates/helios-csv/src/load.rs
git commit -m "feat(samples): add synthetic 90s SDM26 lap and generator script"
```

---

## Task 8: Tauri desktop app scaffold

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/styles.css`
- Create: `apps/desktop/tailwind.config.ts`
- Create: `apps/desktop/postcss.config.js`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/build.rs`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/icons/` (placeholder)

- [ ] **Step 1: Create `apps/desktop/package.json`**

```json
{
  "name": "@helios/desktop",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "vite:dev": "vite",
    "vite:build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@helios/store": "workspace:*",
    "@helios/lib": "workspace:*",
    "@helios/ui": "workspace:*",
    "@helios/widgets": "workspace:*",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-fs": "^2.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `apps/desktop/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "noEmit": true,
    "types": ["vite/client", "node"],
    "paths": {
      "@helios/store": ["../../packages/store/src"],
      "@helios/lib": ["../../packages/lib/src"],
      "@helios/ui": ["../../packages/ui/src"],
      "@helios/widgets": ["../../packages/widgets/src"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `apps/desktop/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "esnext", minify: "esbuild" },
  resolve: {
    alias: {
      "@helios/store": path.resolve(__dirname, "../../packages/store/src"),
      "@helios/lib": path.resolve(__dirname, "../../packages/lib/src"),
      "@helios/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@helios/widgets": path.resolve(__dirname, "../../packages/widgets/src"),
    },
  },
});
```

- [ ] **Step 4: Create `apps/desktop/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Helios</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `apps/desktop/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: Create temporary `apps/desktop/src/App.tsx`**

```tsx
export default function App() {
  return (
    <div className="min-h-screen bg-[#0E0E10] text-[#D8DCE2] flex items-center justify-center font-sans">
      <h1 className="text-2xl">Helios</h1>
    </div>
  );
}
```

- [ ] **Step 7: Create `apps/desktop/src/styles.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; margin: 0; }
body { background: #0E0E10; color: #D8DCE2; font-family: Inter, system-ui, sans-serif; }
.font-mono-num { font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 8: Create `apps/desktop/tailwind.config.ts`**

```ts
import type { Config } from "tailwindcss";

export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/**/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "helios-base": "#0E0E10",
        "helios-panel": "#16171B",
        "helios-line": "#2A2C32",
        "helios-text": "#D8DCE2",
        "helios-dim":  "#7B8088",
        "asu-maroon": "#8C1D40",
        "asu-gold":   "#FFC627",
      },
    },
  },
} satisfies Config;
```

- [ ] **Step 9: Create `apps/desktop/postcss.config.js`**

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 10: Create `apps/desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "helios-desktop"
version.workspace = true
edition.workspace = true
license.workspace = true

[lib]
name = "helios_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { workspace = true }
serde_json = { workspace = true }
helios-core = { path = "../../../crates/helios-core" }
helios-csv = { path = "../../../crates/helios-csv" }
helios-arrow = { path = "../../../crates/helios-arrow" }
```

- [ ] **Step 11: Create `apps/desktop/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Helios",
  "version": "0.0.1",
  "identifier": "edu.asu.sdm.helios",
  "build": {
    "beforeDevCommand": "pnpm vite:dev",
    "beforeBuildCommand": "pnpm vite:build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      { "title": "Helios", "width": 1600, "height": 1000, "resizable": true }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "appimage", "msi"],
    "icon": [],
    "resources": {
      "../../../samples/sdm26-synthetic-lap.csv": "samples/sdm26-synthetic-lap.csv",
      "../../../docs/channels.yaml": "channels.yaml"
    }
  }
}
```

- [ ] **Step 12: Create `apps/desktop/src-tauri/build.rs`**

```rust
fn main() { tauri_build::build() }
```

- [ ] **Step 13: Create `apps/desktop/src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() { helios_desktop_lib::run() }
```

- [ ] **Step 14: Create `apps/desktop/src-tauri/src/lib.rs`**

```rust
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
```

- [ ] **Step 15: Install deps and verify dev server boots**

```bash
pnpm install
pnpm --filter @helios/desktop typecheck
```

Expected: typecheck succeeds.

**Manual smoke (no auto-test for this step):** run `pnpm dev` from repo root in another terminal; confirm a window opens showing "Helios" centered on a dark background, then close it. (Skip Tauri build steps in CI when tauri-cli isn't installed; document in README that local dev needs system webview deps.)

- [ ] **Step 16: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): scaffold Tauri 2 + React + Vite + Tailwind app shell"
```

---

## Task 9: packages/lib — cursor emitter + time utilities

**Files:**
- Create: `packages/lib/package.json`
- Create: `packages/lib/tsconfig.json`
- Create: `packages/lib/src/index.ts`
- Create: `packages/lib/src/cursor-emitter.ts`
- Create: `packages/lib/src/time.ts`
- Create: `packages/lib/tests/cursor-emitter.test.ts`
- Create: `packages/lib/tests/time.test.ts`
- Create: `packages/lib/vitest.config.ts`

- [ ] **Step 1: Create `packages/lib/package.json`**

```json
{
  "name": "@helios/lib",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/lib/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": ".", "noEmit": true },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `packages/lib/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"] } });
```

- [ ] **Step 4: Write failing cursor-emitter tests**

Create `packages/lib/tests/cursor-emitter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CursorEmitter } from "../src/cursor-emitter";

describe("CursorEmitter", () => {
  it("delivers updates to subscribers", () => {
    const e = new CursorEmitter();
    const cb = vi.fn();
    e.subscribe(cb);
    e.emit(1234);
    expect(cb).toHaveBeenCalledWith(1234);
  });

  it("unsubscribe stops delivery", () => {
    const e = new CursorEmitter();
    const cb = vi.fn();
    const off = e.subscribe(cb);
    off();
    e.emit(99);
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple subscribers each receive emissions", () => {
    const e = new CursorEmitter();
    const a = vi.fn(); const b = vi.fn();
    e.subscribe(a); e.subscribe(b);
    e.emit(7);
    expect(a).toHaveBeenCalledWith(7);
    expect(b).toHaveBeenCalledWith(7);
  });

  it("get() returns last emitted value", () => {
    const e = new CursorEmitter();
    e.emit(42);
    expect(e.get()).toBe(42);
  });
});
```

- [ ] **Step 5: Implement CursorEmitter**

Create `packages/lib/src/cursor-emitter.ts`:

```ts
export type CursorListener = (timeUs: number) => void;

/**
 * Pub/sub cursor — bypasses React state to allow 100 Hz cursor moves
 * without triggering component re-renders. Widgets subscribe via ref
 * and update their canvas imperatively.
 */
export class CursorEmitter {
  #listeners = new Set<CursorListener>();
  #last = 0;

  subscribe(cb: CursorListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  emit(timeUs: number): void {
    this.#last = timeUs;
    for (const cb of this.#listeners) cb(timeUs);
  }

  get(): number { return this.#last; }
}
```

- [ ] **Step 6: Write failing time-utility tests**

Create `packages/lib/tests/time.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatLapTime, formatClock, usToS } from "../src/time";

describe("time utils", () => {
  it("formats lap time as M:SS.mmm", () => {
    expect(formatLapTime(75_432_000)).toBe("1:15.432");
    expect(formatLapTime(0)).toBe("0:00.000");
  });

  it("formats clock as MM:SS.mmm", () => {
    expect(formatClock(75_432_000)).toBe("01:15.432");
  });

  it("usToS converts microseconds to seconds", () => {
    expect(usToS(1_500_000)).toBeCloseTo(1.5);
  });
});
```

- [ ] **Step 7: Implement time utilities**

Create `packages/lib/src/time.ts`:

```ts
export function usToS(us: number): number { return us / 1_000_000; }

export function formatLapTime(us: number): string {
  const ms = Math.round(us / 1000);
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${min}:${String(sec).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function formatClock(us: number): string {
  const ms = Math.round(us / 1000);
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}
```

- [ ] **Step 8: Create `packages/lib/src/index.ts`**

```ts
export * from "./cursor-emitter";
export * from "./time";
```

- [ ] **Step 9: Run tests**

```bash
pnpm --filter @helios/lib test
```

Expected: 7 passed.

- [ ] **Step 10: Commit**

```bash
git add packages/lib
git commit -m "feat(lib): add CursorEmitter pub/sub + time formatting utils"
```

---

## Task 10: packages/store — TS ChannelStore over Arrow IPC

**Files:**
- Create: `packages/store/package.json`
- Create: `packages/store/tsconfig.json`
- Create: `packages/store/vitest.config.ts`
- Create: `packages/store/src/index.ts`
- Create: `packages/store/src/types.ts`
- Create: `packages/store/src/channel-store.ts`
- Create: `packages/store/src/rate-group.ts`
- Create: `packages/store/src/slice.ts`
- Create: `packages/store/tests/channel-store.test.ts`
- Create: `packages/store/tests/slice.test.ts`

- [ ] **Step 1: Create `packages/store/package.json`**

```json
{
  "name": "@helios/store",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "apache-arrow": "^17.0.0",
    "@tauri-apps/api": "^2.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/store/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "noEmit": true },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `packages/store/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"] } });
```

- [ ] **Step 4: Define types**

Create `packages/store/src/types.ts`:

```ts
export type DataType = "f32" | "f64" | "u16" | "bool" | "enum";

export interface ChannelMeta {
  id: string;
  display_name: string;
  units: string;
  group: string;
  color: string;
  decimals: number;
  data_type: DataType;
  source: string;
  sample_rate_hz: number;
  min?: number;
  max?: number;
  warn?: number;
  alarm?: number;
}

export interface TimeRange {
  startUs: number;
  endUs: number;
}

export interface ChannelSlice {
  /** time index, microseconds, length N */
  time: BigInt64Array;
  /** parallel arrays per requested channel id */
  data: Map<string, Float64Array>;
  /** the time range that was requested (clamped to actual data extent) */
  range: TimeRange;
}
```

- [ ] **Step 5: Write failing slice tests using a hand-built RateGroup**

Create `packages/store/tests/slice.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sliceRateGroup } from "../src/slice";
import { RateGroup } from "../src/rate-group";

function makeRg() {
  // 5 samples at 0, 10ms, 20ms, 30ms, 40ms (microseconds)
  const time = BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n, 40_000n]);
  const rpm = Float64Array.from([1000, 2000, 3000, 4000, 5000]);
  const tps = Float64Array.from([10, 20, 30, 40, 50]);
  return RateGroup.fromColumns({
    id: "100hz", nominalRateHz: 100,
    time,
    columns: new Map([["engine.rpm", rpm], ["engine.tps", tps]]),
  });
}

describe("sliceRateGroup", () => {
  it("returns full range when range covers all samples", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm"], { startUs: 0, endUs: 50_000 });
    expect(Array.from(s.data.get("engine.rpm")!)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(s.time.length).toBe(5);
  });

  it("half-open: end exclusive", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm"], { startUs: 10_000, endUs: 30_000 });
    // Indices 1, 2 → time = 10_000, 20_000
    expect(Array.from(s.time)).toEqual([10_000n, 20_000n]);
    expect(Array.from(s.data.get("engine.rpm")!)).toEqual([2000, 3000]);
  });

  it("returns empty slice when range is before all data", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm"], { startUs: -100, endUs: -1 });
    expect(s.time.length).toBe(0);
  });

  it("requesting unknown channel throws", () => {
    const rg = makeRg();
    expect(() => sliceRateGroup(rg, ["bogus"], { startUs: 0, endUs: 50_000 }))
      .toThrow(/unknown channel/);
  });

  it("multiple channels return parallel arrays", () => {
    const rg = makeRg();
    const s = sliceRateGroup(rg, ["engine.rpm", "engine.tps"], { startUs: 0, endUs: 50_000 });
    expect(s.data.size).toBe(2);
    expect(Array.from(s.data.get("engine.tps")!)).toEqual([10, 20, 30, 40, 50]);
  });
});
```

- [ ] **Step 6: Implement RateGroup wrapper**

Create `packages/store/src/rate-group.ts`:

```ts
export interface RateGroupInit {
  id: string;
  nominalRateHz: number;
  time: BigInt64Array;          // length N
  columns: Map<string, Float64Array>; // each length N
}

export class RateGroup {
  readonly id: string;
  readonly nominalRateHz: number;
  readonly time: BigInt64Array;
  readonly columns: Map<string, Float64Array>;

  private constructor(init: RateGroupInit) {
    this.id = init.id;
    this.nominalRateHz = init.nominalRateHz;
    this.time = init.time;
    this.columns = init.columns;
    for (const [id, col] of this.columns) {
      if (col.length !== this.time.length) {
        throw new Error(`column ${id} length mismatch`);
      }
    }
  }

  static fromColumns(init: RateGroupInit): RateGroup { return new RateGroup(init); }

  has(channelId: string): boolean { return this.columns.has(channelId); }

  channelIds(): string[] { return Array.from(this.columns.keys()); }

  data(channelId: string): Float64Array {
    const col = this.columns.get(channelId);
    if (!col) throw new Error(`unknown channel ${channelId}`);
    return col;
  }
}
```

- [ ] **Step 7: Implement slicing**

Create `packages/store/src/slice.ts`:

```ts
import { RateGroup } from "./rate-group";
import type { ChannelSlice, TimeRange } from "./types";

/**
 * Half-open slice: includes samples where startUs <= t < endUs.
 * Uses binary search on the monotonic time index. O(log N + K).
 */
export function sliceRateGroup(rg: RateGroup, channels: string[], range: TimeRange): ChannelSlice {
  for (const id of channels) {
    if (!rg.has(id)) throw new Error(`unknown channel ${id}`);
  }
  const { time } = rg;
  const lo = lowerBound(time, BigInt(range.startUs));
  const hi = lowerBound(time, BigInt(range.endUs));
  const len = Math.max(0, hi - lo);

  const sliceTime = time.slice(lo, hi);
  const data = new Map<string, Float64Array>();
  for (const id of channels) {
    data.set(id, rg.data(id).slice(lo, hi));
  }
  return { time: sliceTime, data, range };
}

function lowerBound(arr: BigInt64Array, target: bigint): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
```

- [ ] **Step 8: Run slice tests**

```bash
pnpm --filter @helios/store test slice
```

Expected: 5 passed.

- [ ] **Step 9: Implement ChannelStore**

Create `packages/store/src/channel-store.ts`:

```ts
import { RateGroup } from "./rate-group";
import { sliceRateGroup } from "./slice";
import type { ChannelMeta, ChannelSlice, TimeRange } from "./types";

export class ChannelStore {
  #metas = new Map<string, ChannelMeta>();
  #channelToGroup = new Map<string, string>(); // channel id → rate group id
  #groups = new Map<string, RateGroup>();

  list(): ChannelMeta[] { return Array.from(this.#metas.values()); }
  get(id: string): ChannelMeta | undefined { return this.#metas.get(id); }
  groups(): RateGroup[] { return Array.from(this.#groups.values()); }

  addRateGroup(rg: RateGroup, metas: ChannelMeta[]): void {
    if (this.#groups.has(rg.id)) throw new Error(`duplicate rate group ${rg.id}`);
    this.#groups.set(rg.id, rg);
    for (const m of metas) {
      this.#metas.set(m.id, m);
      this.#channelToGroup.set(m.id, rg.id);
    }
  }

  /** Slice across rate groups; channels split by which group owns them. */
  slice(channels: string[], range: TimeRange): ChannelSlice {
    const byGroup = new Map<string, string[]>();
    for (const id of channels) {
      const g = this.#channelToGroup.get(id);
      if (!g) throw new Error(`unknown channel ${id}`);
      const list = byGroup.get(g) ?? [];
      list.push(id);
      byGroup.set(g, list);
    }
    // For Plan 1 we collapse per-group slices into one ChannelSlice using
    // each group's native time index. If callers mix rate-groups they get
    // a slice whose `time` is from the first group queried. (Per-rate
    // alignment is a Plan-3 widget concern.)
    let outTime: BigInt64Array | null = null;
    const outData = new Map<string, Float64Array>();
    for (const [groupId, ids] of byGroup) {
      const rg = this.#groups.get(groupId)!;
      const part = sliceRateGroup(rg, ids, range);
      if (outTime === null) outTime = part.time;
      for (const [id, arr] of part.data) outData.set(id, arr);
    }
    return { time: outTime ?? new BigInt64Array(0), data: outData, range };
  }

  /** Range of [min t, max t] across all groups, in microseconds. */
  extentUs(): { startUs: number; endUs: number } {
    let s = Number.POSITIVE_INFINITY, e = Number.NEGATIVE_INFINITY;
    for (const g of this.#groups.values()) {
      if (g.time.length === 0) continue;
      s = Math.min(s, Number(g.time[0]!));
      e = Math.max(e, Number(g.time[g.time.length - 1]!));
    }
    if (!Number.isFinite(s)) return { startUs: 0, endUs: 0 };
    return { startUs: s, endUs: e };
  }
}
```

- [ ] **Step 10: Write ChannelStore tests**

Create `packages/store/tests/channel-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ChannelStore, RateGroup } from "../src";
import type { ChannelMeta } from "../src/types";

const meta = (id: string, group = "test"): ChannelMeta => ({
  id, display_name: id, units: "", group, color: "#fff",
  decimals: 2, data_type: "f64", source: "test", sample_rate_hz: 100,
});

function makeStore() {
  const store = new ChannelStore();
  const rg100 = RateGroup.fromColumns({
    id: "100hz", nominalRateHz: 100,
    time: BigInt64Array.from([0n, 10_000n, 20_000n]),
    columns: new Map([
      ["engine.rpm", Float64Array.from([1000, 2000, 3000])],
      ["engine.tps", Float64Array.from([10, 20, 30])],
    ]),
  });
  store.addRateGroup(rg100, [meta("engine.rpm"), meta("engine.tps")]);
  const rg10 = RateGroup.fromColumns({
    id: "10hz", nominalRateHz: 10,
    time: BigInt64Array.from([0n, 100_000n]),
    columns: new Map([["engine.water_temp", Float64Array.from([88, 89])]]),
  });
  store.addRateGroup(rg10, [meta("engine.water_temp")]);
  return store;
}

describe("ChannelStore", () => {
  it("lists all channels across rate groups", () => {
    const ids = makeStore().list().map(m => m.id).sort();
    expect(ids).toEqual(["engine.rpm", "engine.tps", "engine.water_temp"]);
  });

  it("slice routes channels to their owning rate group", () => {
    const s = makeStore().slice(["engine.rpm", "engine.water_temp"], { startUs: 0, endUs: 100_001 });
    expect(s.data.has("engine.rpm")).toBe(true);
    expect(s.data.has("engine.water_temp")).toBe(true);
  });

  it("extentUs reports overall range", () => {
    const e = makeStore().extentUs();
    expect(e.startUs).toBe(0);
    expect(e.endUs).toBe(100_000);
  });

  it("unknown channel throws", () => {
    expect(() => makeStore().slice(["nope"], { startUs: 0, endUs: 100 }))
      .toThrow(/unknown channel/);
  });
});
```

- [ ] **Step 11: Create `packages/store/src/index.ts`**

```ts
export * from "./types";
export * from "./rate-group";
export * from "./slice";
export * from "./channel-store";
```

- [ ] **Step 12: Run all store tests**

```bash
pnpm --filter @helios/store test
```

Expected: 9 passed.

- [ ] **Step 13: Commit**

```bash
git add packages/store
git commit -m "feat(store): add ChannelStore + RateGroup + slice with binary-search indexing"
```

---

## Task 11: Tauri load_csv command + Arrow IPC bridge

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/load_csv.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `packages/store/src/load.ts`
- Modify: `packages/store/src/index.ts`

- [ ] **Step 1: Create `apps/desktop/src-tauri/src/commands/mod.rs`**

```rust
pub mod load_csv;
```

- [ ] **Step 2: Create `apps/desktop/src-tauri/src/commands/load_csv.rs`**

```rust
use helios_arrow::rate_group_to_ipc;
use helios_csv::{load_csv as csv_load, ChannelRegistry};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct LoadedRateGroup {
    pub id: String,
    pub nominal_rate_hz: f32,
    pub channel_metas: Vec<helios_core::ChannelMeta>,
    /// Arrow IPC stream bytes (one RecordBatch).
    pub ipc: Vec<u8>,
}

#[derive(Serialize, Clone)]
pub struct LoadCsvResponse {
    pub rate_groups: Vec<LoadedRateGroup>,
    pub warnings: Vec<String>,
    pub duration_us: i64,
}

#[tauri::command]
pub fn load_csv(path: String, registry_path: String) -> Result<LoadCsvResponse, String> {
    let registry = ChannelRegistry::from_path(&PathBuf::from(&registry_path))
        .map_err(|e| format!("registry load: {e}"))?;
    let result = csv_load(&PathBuf::from(&path), &registry)
        .map_err(|e| format!("csv load: {e}"))?;
    let mut rate_groups = Vec::new();
    for rg in result.rate_groups {
        let metas: Vec<_> = rg.channel_ids().into_iter()
            .map(|id| rg.meta(id).cloned().unwrap())
            .collect();
        let ipc = rate_group_to_ipc(&rg).map_err(|e| format!("ipc: {e}"))?;
        rate_groups.push(LoadedRateGroup {
            id: rg.id.clone(),
            nominal_rate_hz: rg.nominal_rate_hz,
            channel_metas: metas,
            ipc,
        });
    }
    Ok(LoadCsvResponse {
        rate_groups,
        warnings: result.warnings,
        duration_us: result.duration_us,
    })
}
```

(Tiny helper needed — `cloned()` on `&ChannelMeta`. ChannelMeta already derives Clone in Task 2.)

- [ ] **Step 3: Wire the command into `apps/desktop/src-tauri/src/lib.rs`**

Replace contents:

```rust
mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
```

- [ ] **Step 4: Create the TS-side bridge `packages/store/src/load.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { tableFromIPC } from "apache-arrow";
import { ChannelStore } from "./channel-store";
import { RateGroup } from "./rate-group";
import type { ChannelMeta } from "./types";

interface LoadedRateGroupRaw {
  id: string;
  nominal_rate_hz: number;
  channel_metas: ChannelMeta[];
  ipc: number[]; // Vec<u8> serialized as array
}
interface LoadCsvResponseRaw {
  rate_groups: LoadedRateGroupRaw[];
  warnings: string[];
  duration_us: number;
}

export interface LoadResult {
  warnings: string[];
  durationUs: number;
}

export async function loadCsvIntoStore(
  store: ChannelStore,
  csvPath: string,
  registryPath: string,
): Promise<LoadResult> {
  const resp = await invoke<LoadCsvResponseRaw>("load_csv", {
    path: csvPath,
    registryPath,
  });
  for (const rg of resp.rate_groups) {
    const bytes = new Uint8Array(rg.ipc);
    const table = tableFromIPC(bytes);
    const timeCol = table.getChild("time_us")!;
    const time = new BigInt64Array(table.numRows);
    for (let i = 0; i < table.numRows; i++) time[i] = timeCol.get(i) as bigint;

    const columns = new Map<string, Float64Array>();
    for (const meta of rg.channel_metas) {
      const col = table.getChild(meta.id);
      if (!col) continue;
      const arr = new Float64Array(table.numRows);
      for (let i = 0; i < table.numRows; i++) arr[i] = col.get(i) as number;
      columns.set(meta.id, arr);
    }
    store.addRateGroup(
      RateGroup.fromColumns({ id: rg.id, nominalRateHz: rg.nominal_rate_hz, time, columns }),
      rg.channel_metas,
    );
  }
  return { warnings: resp.warnings, durationUs: resp.duration_us };
}
```

- [ ] **Step 5: Re-export from `packages/store/src/index.ts`**

```ts
export * from "./types";
export * from "./rate-group";
export * from "./slice";
export * from "./channel-store";
export * from "./load";
```

- [ ] **Step 6: Verify Rust side builds**

```bash
cargo build -p helios-desktop
```

Expected: success. (Compile errors here usually mean Tauri version mismatch — pin per Cargo.toml in Task 8 step 10.)

- [ ] **Step 7: Verify TS side typechecks**

```bash
pnpm --filter @helios/store typecheck
```

Expected: success.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri packages/store
git commit -m "feat(bridge): add load_csv Tauri command + Arrow IPC client decode"
```

---

## Task 12: packages/ui — theme tokens

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/theme.ts`

- [ ] **Step 1: Create `packages/ui/package.json`**

```json
{
  "name": "@helios/ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit" },
  "devDependencies": { "typescript": "^5.4.0" }
}
```

- [ ] **Step 2: Create `packages/ui/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "noEmit": true },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/ui/src/theme.ts`**

```ts
export const theme = {
  colors: {
    base:   "#0E0E10",
    panel:  "#16171B",
    line:   "#2A2C32",
    text:   "#D8DCE2",
    dim:    "#7B8088",
    maroon: "#8C1D40",
    gold:   "#FFC627",
    chartGrid: "#23252B",
    chartAxis: "#5A5F66",
  },
  font: {
    sans: 'Inter, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
} as const;

/** 12-color trace palette tuned for dark backgrounds. */
export const tracePalette = [
  "#FFB800", "#4FC3F7", "#66BB6A", "#FF8A65",
  "#BA68C8", "#9CCC65", "#26A69A", "#EF5350",
  "#5C6BC0", "#FFCA28", "#26C6DA", "#AB47BC",
] as const;
```

- [ ] **Step 4: Create `packages/ui/src/index.ts`**

```ts
export * from "./theme";
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @helios/ui typecheck
```

Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): add theme tokens + trace palette"
```

---

## Task 13: packages/widgets — registry + Widget contract

**Files:**
- Create: `packages/widgets/package.json`
- Create: `packages/widgets/tsconfig.json`
- Create: `packages/widgets/vitest.config.ts`
- Create: `packages/widgets/src/index.ts`
- Create: `packages/widgets/src/types.ts`
- Create: `packages/widgets/src/registry.ts`
- Create: `packages/widgets/tests/registry.test.ts`

- [ ] **Step 1: Create `packages/widgets/package.json`**

```json
{
  "name": "@helios/widgets",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@helios/lib": "workspace:*",
    "@helios/store": "workspace:*",
    "@helios/ui": "workspace:*",
    "react": "^18.3.0",
    "uplot": "^1.6.30"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/widgets/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "noEmit": true, "jsx": "react-jsx" },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `packages/widgets/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"] },
});
```

- [ ] **Step 4: Define the Widget contract**

Create `packages/widgets/src/types.ts`:

```ts
import type { FC } from "react";
import type { ChannelSlice, TimeRange } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";

export interface WidgetRenderProps<Config> {
  config: Config;
  slice: ChannelSlice;
  cursorEmitter: CursorEmitter;
  timeRange: TimeRange;
}

export interface WidgetConfigEditorProps<Config> {
  config: Config;
  onChange: (next: Config) => void;
}

export interface Widget<Config> {
  type: string;
  defaultConfig: Config;
  ConfigEditor: FC<WidgetConfigEditorProps<Config>>;
  Render: FC<WidgetRenderProps<Config>>;
  requiredChannels: (config: Config) => string[];
}
```

- [ ] **Step 5: Define the registry**

Create `packages/widgets/src/registry.ts`:

```ts
import type { Widget } from "./types";

class Registry {
  #widgets = new Map<string, Widget<unknown>>();

  register<C>(w: Widget<C>): void {
    if (this.#widgets.has(w.type)) {
      throw new Error(`widget type ${w.type} already registered`);
    }
    this.#widgets.set(w.type, w as unknown as Widget<unknown>);
  }

  get<C = unknown>(type: string): Widget<C> {
    const w = this.#widgets.get(type);
    if (!w) throw new Error(`unknown widget type ${type}`);
    return w as Widget<C>;
  }

  has(type: string): boolean { return this.#widgets.has(type); }
  list(): string[] { return Array.from(this.#widgets.keys()); }
}

export const widgetRegistry = new Registry();
```

- [ ] **Step 6: Write registry tests**

Create `packages/widgets/tests/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { widgetRegistry } from "../src/registry";
import type { Widget } from "../src/types";

const dummy = (type: string): Widget<{}> => ({
  type,
  defaultConfig: {},
  ConfigEditor: () => null,
  Render: () => null,
  requiredChannels: () => [],
});

describe("widgetRegistry", () => {
  beforeEach(() => {
    // Clear by re-importing isn't trivial; instead, use unique types per test.
  });

  it("registers and retrieves a widget", () => {
    widgetRegistry.register(dummy("test.alpha"));
    expect(widgetRegistry.get("test.alpha").type).toBe("test.alpha");
    expect(widgetRegistry.has("test.alpha")).toBe(true);
  });

  it("duplicate registration throws", () => {
    widgetRegistry.register(dummy("test.beta"));
    expect(() => widgetRegistry.register(dummy("test.beta"))).toThrow(/already registered/);
  });

  it("unknown type throws on get", () => {
    expect(() => widgetRegistry.get("nope")).toThrow(/unknown widget type/);
  });
});
```

- [ ] **Step 7: Create `packages/widgets/src/index.ts`**

```ts
export * from "./types";
export * from "./registry";
```

- [ ] **Step 8: Run tests**

```bash
pnpm install
pnpm --filter @helios/widgets test
```

Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add packages/widgets
git commit -m "feat(widgets): add Widget<T> contract + global widgetRegistry"
```

---

## Task 14: NumericReadout widget

**Files:**
- Create: `packages/widgets/src/numeric-readout/index.tsx`
- Create: `packages/widgets/src/numeric-readout/render.tsx`
- Create: `packages/widgets/src/numeric-readout/config-editor.tsx`
- Create: `packages/widgets/tests/numeric-readout.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Write failing render test**

Create `packages/widgets/tests/numeric-readout.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { numericReadoutWidget } from "../src/numeric-readout";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";

function fakeSlice(): ChannelSlice {
  return {
    time: BigInt64Array.from([0n, 10_000n, 20_000n, 30_000n]),
    data: new Map([["engine.rpm", Float64Array.from([1000, 2000, 3000, 4000])]]),
    range: { startUs: 0, endUs: 30_001 },
  };
}

describe("NumericReadout", () => {
  let cursor: CursorEmitter;
  beforeEach(() => { cursor = new CursorEmitter(); });

  it("renders the value at cursor=0 initially", () => {
    render(<numericReadoutWidget.Render
      config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm", units: "rpm", decimals: 0 }}
      slice={fakeSlice()}
      cursorEmitter={cursor}
      timeRange={{ startUs: 0, endUs: 30_001 }}
    />);
    expect(screen.getByText("1000")).toBeDefined();
    expect(screen.getByText("rpm")).toBeDefined();
  });

  it("updates the value when the cursor moves", async () => {
    render(<numericReadoutWidget.Render
      config={{ ...numericReadoutWidget.defaultConfig, channelId: "engine.rpm", units: "rpm", decimals: 0 }}
      slice={fakeSlice()}
      cursorEmitter={cursor}
      timeRange={{ startUs: 0, endUs: 30_001 }}
    />);
    act(() => { cursor.emit(20_000); });
    expect(screen.getByText("3000")).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement Render**

Create `packages/widgets/src/numeric-readout/render.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { WidgetRenderProps } from "../types";

export interface NumericReadoutConfig {
  channelId: string;
  units: string;
  decimals: number;
  warn?: number;
  alarm?: number;
}

export function NumericReadoutRender(props: WidgetRenderProps<NumericReadoutConfig>) {
  const { config, slice, cursorEmitter } = props;
  const [value, setValue] = useState<number | null>(() => sampleAt(slice, config.channelId, cursorEmitter.get()));
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      const v = sampleAt(slice, config.channelId, t);
      if (v !== valueRef.current) setValue(v);
    });
    return off;
  }, [slice, config.channelId, cursorEmitter]);

  const display = value === null ? "—" : value.toFixed(config.decimals);
  const color =
    value !== null && config.alarm !== undefined && value >= config.alarm ? "#EF5350" :
    value !== null && config.warn  !== undefined && value >= config.warn  ? "#FFB800" :
    "#D8DCE2";

  return (
    <div className="flex flex-col items-center justify-center h-full bg-[#16171B] p-4">
      <div className="text-xs uppercase tracking-wider text-[#7B8088]">{config.channelId}</div>
      <div className="font-mono-num text-5xl mt-1" style={{ color }}>{display}</div>
      <div className="text-xs text-[#7B8088] mt-1">{config.units}</div>
    </div>
  );
}

function sampleAt(slice: { time: BigInt64Array; data: Map<string, Float64Array> }, id: string, tUs: number): number | null {
  const col = slice.data.get(id);
  if (!col || slice.time.length === 0) return null;
  const t = BigInt(tUs);
  // Binary search: find largest idx where time[idx] <= t.
  let lo = 0, hi = slice.time.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (slice.time[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = Math.max(0, lo - 1);
  return col[idx] ?? null;
}
```

- [ ] **Step 3: Implement ConfigEditor**

Create `packages/widgets/src/numeric-readout/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { NumericReadoutConfig } from "./render";

export function NumericReadoutConfigEditor({ config, onChange }: WidgetConfigEditorProps<NumericReadoutConfig>) {
  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      <label>Channel
        <input
          className="ml-2 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.channelId}
          onChange={(e) => onChange({ ...config, channelId: e.target.value })}
        />
      </label>
      <label>Units
        <input
          className="ml-2 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.units}
          onChange={(e) => onChange({ ...config, units: e.target.value })}
        />
      </label>
      <label>Decimals
        <input
          type="number" min={0} max={6}
          className="ml-2 w-12 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.decimals}
          onChange={(e) => onChange({ ...config, decimals: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}
```

- [ ] **Step 4: Wire up the Widget descriptor**

Create `packages/widgets/src/numeric-readout/index.tsx`:

```tsx
import type { Widget } from "../types";
import { NumericReadoutConfigEditor } from "./config-editor";
import { NumericReadoutRender, type NumericReadoutConfig } from "./render";

export const numericReadoutWidget: Widget<NumericReadoutConfig> = {
  type: "numeric_readout",
  defaultConfig: { channelId: "", units: "", decimals: 1 },
  ConfigEditor: NumericReadoutConfigEditor,
  Render: NumericReadoutRender,
  requiredChannels: (c) => (c.channelId ? [c.channelId] : []),
};

export type { NumericReadoutConfig } from "./render";
```

- [ ] **Step 5: Update `packages/widgets/src/index.ts`**

```ts
export * from "./types";
export * from "./registry";
export * from "./numeric-readout";
```

- [ ] **Step 6: Run NumericReadout tests**

```bash
pnpm --filter @helios/widgets test numeric-readout
```

Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add packages/widgets
git commit -m "feat(widgets): add NumericReadout with cursor-driven sample display"
```

---

## Task 15: StripChart widget (uPlot)

**Files:**
- Create: `packages/widgets/src/strip-chart/index.tsx`
- Create: `packages/widgets/src/strip-chart/render.tsx`
- Create: `packages/widgets/src/strip-chart/config-editor.tsx`
- Create: `packages/widgets/tests/strip-chart.test.tsx`
- Modify: `packages/widgets/src/index.ts`

- [ ] **Step 1: Write smoke test (mounts without crashing, renders a canvas)**

Create `packages/widgets/tests/strip-chart.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { stripChartWidget } from "../src/strip-chart";
import { CursorEmitter } from "@helios/lib";
import type { ChannelSlice } from "@helios/store";

function fakeSlice(): ChannelSlice {
  const N = 1000;
  const time = new BigInt64Array(N);
  const rpm = new Float64Array(N);
  for (let i = 0; i < N; i++) { time[i] = BigInt(i * 10_000); rpm[i] = 1000 + i; }
  return { time, data: new Map([["engine.rpm", rpm]]), range: { startUs: 0, endUs: N * 10_000 } };
}

describe("StripChart", () => {
  it("mounts and renders a canvas", () => {
    const { container } = render(<stripChartWidget.Render
      config={{ channels: [{ id: "engine.rpm", color: "#FFB800" }], yMin: 0, yMax: 15000 }}
      slice={fakeSlice()}
      cursorEmitter={new CursorEmitter()}
      timeRange={{ startUs: 0, endUs: 1_000 * 10_000 }}
    />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("requiredChannels returns configured ids", () => {
    const ids = stripChartWidget.requiredChannels({
      channels: [{ id: "a", color: "#fff" }, { id: "b", color: "#000" }],
      yMin: 0, yMax: 1,
    });
    expect(ids).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Implement Render**

Create `packages/widgets/src/strip-chart/render.tsx`:

```tsx
import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import type { WidgetRenderProps } from "../types";

export interface StripChartChannel { id: string; color: string; }
export interface StripChartConfig {
  channels: StripChartChannel[];
  yMin: number;
  yMax: number;
}

export function StripChartRender(props: WidgetRenderProps<StripChartConfig>) {
  const { config, slice, cursorEmitter, timeRange } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const cursorElRef = useRef<SVGLineElement | null>(null);

  // Build aligned data: x in seconds, then one y series per channel.
  useEffect(() => {
    if (!containerRef.current) return;
    const N = slice.time.length;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = Number(slice.time[i]) / 1_000_000;

    const ys: Float64Array[] = config.channels.map((c) => {
      const arr = slice.data.get(c.id);
      return arr ?? new Float64Array(N);
    });

    const data: AlignedData = [x, ...ys];

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      pxAlign: 0,
      cursor: { drag: { x: true, y: false }, sync: undefined, points: { show: false } },
      scales: { x: {}, y: { range: [config.yMin, config.yMax] } },
      axes: [
        { stroke: "#5A5F66", grid: { stroke: "#23252B" } },
        { stroke: "#5A5F66", grid: { stroke: "#23252B" } },
      ],
      series: [
        {},
        ...config.channels.map((c) => ({ stroke: c.color, width: 1 })),
      ],
    };

    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, containerRef.current);

    return () => { plotRef.current?.destroy(); plotRef.current = null; };
  }, [slice, config, timeRange]);

  // Cursor sync — imperative, no React re-renders.
  useEffect(() => {
    const off = cursorEmitter.subscribe((tUs) => {
      const u = plotRef.current; if (!u) return;
      const tS = tUs / 1_000_000;
      const left = u.valToPos(tS, "x", true);
      const root = u.root;
      let line = root.querySelector<HTMLDivElement>(".helios-cursor");
      if (!line) {
        line = document.createElement("div");
        line.className = "helios-cursor";
        line.style.position = "absolute";
        line.style.top = "0";
        line.style.bottom = "0";
        line.style.width = "1px";
        line.style.background = "#FFC627";
        line.style.pointerEvents = "none";
        root.appendChild(line);
      }
      line.style.left = `${left}px`;
    });
    return off;
  }, [cursorEmitter]);

  return <div ref={containerRef} className="w-full h-full bg-[#16171B]" />;
}
```

- [ ] **Step 3: Implement ConfigEditor**

Create `packages/widgets/src/strip-chart/config-editor.tsx`:

```tsx
import type { WidgetConfigEditorProps } from "../types";
import type { StripChartConfig } from "./render";

export function StripChartConfigEditor({ config, onChange }: WidgetConfigEditorProps<StripChartConfig>) {
  return (
    <div className="flex flex-col gap-2 p-2 text-xs text-[#D8DCE2]">
      <div>Channels:
        {config.channels.map((c, i) => (
          <div key={i} className="flex gap-1 mt-1">
            <input
              className="bg-[#0E0E10] border border-[#2A2C32] px-1 flex-1"
              value={c.id}
              onChange={(e) => {
                const next = [...config.channels];
                next[i] = { ...c, id: e.target.value };
                onChange({ ...config, channels: next });
              }}
            />
            <input
              type="color"
              value={c.color}
              onChange={(e) => {
                const next = [...config.channels];
                next[i] = { ...c, color: e.target.value };
                onChange({ ...config, channels: next });
              }}
            />
          </div>
        ))}
        <button
          className="mt-1 text-[#FFC627]"
          onClick={() => onChange({ ...config, channels: [...config.channels, { id: "", color: "#FFB800" }] })}
        >+ add</button>
      </div>
      <label>Y min
        <input type="number" className="ml-2 w-20 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.yMin}
          onChange={(e) => onChange({ ...config, yMin: Number(e.target.value) })} />
      </label>
      <label>Y max
        <input type="number" className="ml-2 w-20 bg-[#0E0E10] border border-[#2A2C32] px-1"
          value={config.yMax}
          onChange={(e) => onChange({ ...config, yMax: Number(e.target.value) })} />
      </label>
    </div>
  );
}
```

- [ ] **Step 4: Wire up the Widget descriptor**

Create `packages/widgets/src/strip-chart/index.tsx`:

```tsx
import type { Widget } from "../types";
import { StripChartConfigEditor } from "./config-editor";
import { StripChartRender, type StripChartConfig } from "./render";

export const stripChartWidget: Widget<StripChartConfig> = {
  type: "strip_chart",
  defaultConfig: { channels: [], yMin: 0, yMax: 100 },
  ConfigEditor: StripChartConfigEditor,
  Render: StripChartRender,
  requiredChannels: (c) => c.channels.map((x) => x.id).filter(Boolean),
};

export type { StripChartConfig, StripChartChannel } from "./render";
```

- [ ] **Step 5: Update `packages/widgets/src/index.ts`**

```ts
export * from "./types";
export * from "./registry";
export * from "./numeric-readout";
export * from "./strip-chart";
```

- [ ] **Step 6: Run strip-chart tests**

```bash
pnpm install
pnpm --filter @helios/widgets test strip-chart
```

Expected: 2 passed. (uPlot in jsdom needs canvas mocked or the chart construction may noop — the test only asserts a canvas/div exists; if jsdom complains about uPlot, gate the construction with `if (typeof window === "undefined") return;` and assert mount only.)

- [ ] **Step 7: Commit**

```bash
git add packages/widgets
git commit -m "feat(widgets): add StripChart with uPlot + imperative cursor sync"
```

---

## Task 16: App.tsx — wire sample CSV → store → workspace → widgets

**Files:**
- Create: `apps/desktop/src/workspaces/overview-default.ts`
- Create: `apps/desktop/src/lib/load-sample.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/components/Tile.tsx`

- [ ] **Step 1: Define the default Overview workspace**

Create `apps/desktop/src/workspaces/overview-default.ts`:

```ts
import type { StripChartConfig, NumericReadoutConfig } from "@helios/widgets";

export interface TileSpec {
  id: string;
  widgetType: "strip_chart" | "numeric_readout";
  config: StripChartConfig | NumericReadoutConfig;
  // Plain percentages 0..1 for Plan 1 — replaced by react-grid-layout in a later plan.
  x: number; y: number; w: number; h: number;
}

export const overviewDefault: TileSpec[] = [
  {
    id: "rpm-strip",
    widgetType: "strip_chart",
    config: {
      channels: [{ id: "engine.rpm", color: "#FFB800" }],
      yMin: 0, yMax: 15000,
    } satisfies StripChartConfig,
    x: 0, y: 0, w: 1, h: 0.65,
  },
  {
    id: "rpm-readout",
    widgetType: "numeric_readout",
    config: {
      channelId: "engine.rpm", units: "rpm", decimals: 0,
      warn: 13500, alarm: 14500,
    } satisfies NumericReadoutConfig,
    x: 0, y: 0.65, w: 1, h: 0.35,
  },
];
```

- [ ] **Step 2: Sample load helper that resolves resource paths**

Create `apps/desktop/src/lib/load-sample.ts`:

```ts
import { resolveResource } from "@tauri-apps/api/path";
import { ChannelStore, loadCsvIntoStore } from "@helios/store";

export async function loadSampleSession(): Promise<ChannelStore> {
  const store = new ChannelStore();
  // Paths declared as Tauri resources in apps/desktop/src-tauri/tauri.conf.json.
  // Resolved at runtime via resolveResource which works in both dev and bundled builds.
  const csv = await resolveResource("samples/sdm26-synthetic-lap.csv");
  const yaml = await resolveResource("channels.yaml");
  await loadCsvIntoStore(store, csv, yaml);
  return store;
}
```

- [ ] **Step 3: Tile renderer**

Create `apps/desktop/src/components/Tile.tsx`:

```tsx
import { stripChartWidget, numericReadoutWidget, type Widget, type WidgetRenderProps } from "@helios/widgets";
import type { ChannelStore } from "@helios/store";
import type { CursorEmitter } from "@helios/lib";
import type { TileSpec } from "../workspaces/overview-default";

const widgets: Record<string, Widget<unknown>> = {
  strip_chart: stripChartWidget as unknown as Widget<unknown>,
  numeric_readout: numericReadoutWidget as unknown as Widget<unknown>,
};

interface Props {
  spec: TileSpec;
  store: ChannelStore;
  cursorEmitter: CursorEmitter;
}

export function Tile({ spec, store, cursorEmitter }: Props) {
  const widget = widgets[spec.widgetType]!;
  const channels = widget.requiredChannels(spec.config);
  const range = store.extentUs();
  const slice = store.slice(channels, { startUs: range.startUs, endUs: range.endUs });

  const RenderC = widget.Render;
  return (
    <div
      className="absolute border border-[#2A2C32]"
      style={{
        left: `${spec.x * 100}%`, top: `${spec.y * 100}%`,
        width: `${spec.w * 100}%`, height: `${spec.h * 100}%`,
      }}
    >
      <div className="bg-[#0E0E10] text-[#7B8088] text-[10px] uppercase tracking-wider px-2 py-1 border-b border-[#2A2C32]">
        {spec.id}
      </div>
      <div className="absolute inset-0 top-[20px]">
        <RenderC
          config={spec.config}
          slice={slice}
          cursorEmitter={cursorEmitter}
          timeRange={{ startUs: range.startUs, endUs: range.endUs }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Replace `App.tsx` with the wired-up version**

Replace `apps/desktop/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ChannelStore } from "@helios/store";
import { CursorEmitter, formatClock } from "@helios/lib";
import { loadSampleSession } from "./lib/load-sample";
import { overviewDefault } from "./workspaces/overview-default";
import { Tile } from "./components/Tile";

export default function App() {
  const [store, setStore] = useState<ChannelStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursorUs, setCursorUs] = useState(0);
  const [emitter] = useState(() => new CursorEmitter());

  useEffect(() => {
    loadSampleSession().then(setStore).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => emitter.subscribe(setCursorUs), [emitter]);

  if (error) return <div className="p-8 text-[#EF5350]">{error}</div>;
  if (!store) return <div className="p-8 text-[#7B8088]">Loading sample session…</div>;

  const ext = store.extentUs();

  return (
    <div className="flex flex-col h-screen bg-[#0E0E10] text-[#D8DCE2]">
      <header className="h-10 flex items-center px-3 border-b border-[#2A2C32] text-xs">
        <span className="text-[#FFC627] font-bold">HELIOS</span>
        <span className="ml-3 text-[#7B8088]">sdm26-synthetic-lap.csv</span>
        <span className="ml-auto font-mono-num">{formatClock(cursorUs)}</span>
      </header>

      <main
        className="flex-1 relative cursor-crosshair"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const t = ext.startUs + frac * (ext.endUs - ext.startUs);
          emitter.emit(t);
        }}
      >
        {overviewDefault.map((spec) => (
          <Tile key={spec.id} spec={spec} store={store} cursorEmitter={emitter} />
        ))}
      </main>

      <footer className="h-6 flex items-center px-3 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
        channels {store.list().length} · range {(ext.endUs - ext.startUs) / 1_000_000}s
      </footer>
    </div>
  );
}
```

- [ ] **Step 5: Verify typecheck**

```bash
pnpm install
pnpm --filter @helios/desktop typecheck
```

Expected: success.

- [ ] **Step 6: Manual smoke**

Run `pnpm dev` from repo root in another terminal.

Expected:
- Window opens, says "Loading sample session…" briefly
- StripChart shows a multi-second RPM trace in gold
- NumericReadout below shows current RPM at the cursor
- Moving the mouse left↔right across the main area sweeps a gold cursor line through the strip chart and updates the readout
- Footer reads "channels N · range 90s"

If it doesn't work: check the browser console (`right-click → Inspect → Console`), verify the Tauri command logs in the terminal, and confirm the resolved resource paths match the actual file locations.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): wire sample CSV load → workspace → widgets with mouse cursor"
```

---

## Task 17: End-to-end smoke documentation

**Files:**
- Create: `docs/architecture.md`

This isn't a code task — it's the evergreen architecture pointer the design spec refers to.

- [ ] **Step 1: Create `docs/architecture.md`**

```markdown
# Helios Architecture

The authoritative design spec is at `docs/superpowers/specs/2026-05-04-helios-design.md`.

This file is a quick orientation pointer for new contributors.

## Layers (top → bottom)

1. **Widgets** (`packages/widgets/`) — pure React renderers. Each widget implements the `Widget<Config>` contract: `defaultConfig`, `ConfigEditor`, `Render`, `requiredChannels`. The global `widgetRegistry` maps `type` → widget. Widgets receive a `ChannelSlice` and a `CursorEmitter` ref; they update imperatively on cursor events to avoid React re-renders at 100 Hz.

2. **Session** (Plan 1: minimal stub in `apps/desktop/src/workspaces/`; full layer arrives in Plan 3) — workspaces, layouts, math channels, alarms, datums, laps, cursor, playback. Plan 1 ships a single hardcoded workspace; Plan 3 introduces the full session reducer + persistence.

3. **Channel Store** (`packages/store/`, `crates/helios-*`) — the only place samples live. Rust crates parse CSV (and later `.ld`) into rate-grouped Arrow tables; a Tauri command serializes each rate group as Arrow IPC bytes; the TS `ChannelStore` decodes them back into typed arrays. `slice()` is the hot path: binary-search on `time_us`, return parallel `Float64Array`s for the requested channels.

## Channel registry

`docs/channels.yaml` is the canonical SDM26 channel inventory. The CSV loader resolves column names against alias lists in this file. Unknown columns get auto-registered with sane defaults derived from header suffixes (`_psi`, `_rpm`, `_pct`, etc.).

## How to add a new channel

1. Add an entry to `docs/channels.yaml`.
2. Add the column to your CSV (or alias an existing column name).
3. Reference the channel id in any widget config.

Channels never need code changes.

## How to add a new widget

1. Create `packages/widgets/src/<your-widget>/{index,render,config-editor}.tsx`.
2. Implement the `Widget<Config>` contract.
3. Re-export from `packages/widgets/src/index.ts`.
4. Add it to the `widgets` map in `apps/desktop/src/components/Tile.tsx`.
5. Add at least one render test in `packages/widgets/tests/`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: add architecture orientation pointer"
```

---

## Task 18: Plan 1 acceptance checklist

This is a meta-task — confirm Plan 1's success criteria are met before declaring it shipped.

- [ ] **Step 1: Run all Rust tests**

```bash
cargo test
```

Expected output ends with: `test result: ok. N passed; 0 failed` for each crate (helios-core, helios-csv, helios-arrow).

- [ ] **Step 2: Run all TS tests**

```bash
pnpm test
```

Expected: every workspace package reports tests passing.

- [ ] **Step 3: Typecheck the workspace**

```bash
pnpm typecheck
```

Expected: success.

- [ ] **Step 4: Manual smoke of `pnpm dev`**

Run `pnpm dev`, confirm:

- [ ] Window opens within ~5s with the sample session loaded.
- [ ] StripChart renders the engine.rpm trace.
- [ ] NumericReadout shows a current RPM value.
- [ ] Moving the mouse across the main area sweeps the cursor and updates the readout.
- [ ] Footer reports `channels 9 · range 90s`.

- [ ] **Step 5: Tag the milestone**

```bash
git tag -a plan-1-foundation -m "Plan 1 complete: foundation + first vertical slice"
```

- [ ] **Step 6: Final commit (no-op if clean)**

```bash
git status
# Expect "nothing to commit, working tree clean"
```
