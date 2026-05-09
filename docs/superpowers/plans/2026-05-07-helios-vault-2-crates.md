# Helios Vault — Plan 2: Shared Rust Crates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new Rust crates under `crates/` that the sync daemon (Plan 6), the Helios Tauri side (Plan 3), and the `parse-refs` edge function (Plan 5) all consume. After this plan, every PDM domain concept exists as a strong type with serde derives; every Supabase operation has a typed Rust wrapper; SolidWorks reference paths can be extracted from in-memory `.sldasm` / `.sldprt` byte buffers.

**Architecture:** Three independently-buildable crates. `pdm-core` holds domain types only — no I/O, no async, `no_std`-friendly so it can compile to WASM. `pdm-sw-parser` reads SolidWorks Compound File Binary containers via the `cfb` crate and returns a `Vec<RefHint>`; also `no_std`-friendly for WASM. `pdm-client` is the I/O crate — it wraps `reqwest` for HTTP and `tokio` for async, exposing a typed `Client` whose methods mirror the Postgres tables and RPCs from Plan 1. All three live in the existing Cargo workspace.

**Tech Stack:** Rust 2021, `serde` + `serde_json`, `thiserror` (already in workspace), `uuid`, `cfb` (Compound File Binary parser), `reqwest` (HTTP), `tokio` (async runtime), `chrono` (timestamps).

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plan 1 (the Postgres schema/RPCs the client crate calls).

---

## File Structure

### New crates

```
crates/
  pdm-core/
    Cargo.toml
    src/
      lib.rs              ← pub-uses every type
      ids.rs              ← strong-typed UUID newtypes
      sha256.rs           ← Sha256 newtype with hex parse/format
      role.rs             ← Role enum (Admin/Editor/Viewer)
      vault.rs            ← Vault, Folder, File, Version, Lock, Ref structs
      audit.rs            ← AuditEntry, AuditAction
      error.rs            ← shared CoreError type (parse failures)
    tests/
      serde_roundtrip.rs  ← every type round-trips through JSON
      ids.rs              ← UUID parsing edge cases
      sha256.rs           ← hex parsing edge cases
      role.rs             ← FromStr / Display

  pdm-sw-parser/
    Cargo.toml
    src/
      lib.rs              ← pub fn parse_refs(bytes: &[u8]) -> Vec<RefHint>
      ref_hint.rs         ← RefHint struct
      cfb_reader.rs       ← CFB container open + stream listing
      sldasm.rs           ← .sldasm-specific reference extraction
      error.rs            ← ParseError type (best-effort parser, but errors logged)
    tests/
      synthetic_cfb.rs    ← build a minimal CFB in-memory and round-trip
      empty_input.rs      ← empty / non-CFB / corrupt input → empty Vec, no panic

  pdm-client/
    Cargo.toml
    src/
      lib.rs              ← pub-uses Client + error
      client.rs           ← Client struct, builder pattern
      error.rs            ← ClientError (network, auth, server)
      auth.rs             ← sign-in / refresh / sign-out / JWT mgmt
      vaults.rs           ← list_vaults, get_vault
      folders.rs          ← list_folders, list_folder_tree
      files.rs            ← list_files, get_file
      versions.rs         ← list_versions, get_version
      locks.rs            ← acquire_lock, release_lock, list_active_locks
      check_in.rs         ← check_in (RPC)
      cancel.rs           ← cancel_checkout (RPC)
      force_unlock.rs     ← force_unlock (RPC)
      storage.rs          ← create_signed_upload_url, create_signed_download_url
      audit.rs            ← list_audit_entries
    tests/
      request_shaping.rs  ← URLs / headers / bodies match Supabase REST conventions (no network)
```

### Modified files

```
Cargo.toml                                ← add three new crates to workspace.members
                                            and pin workspace-level deps for cfb / reqwest / tokio / uuid / chrono
```

### Files NOT touched

`apps/desktop`, `crates/helios-*` (existing), `infra/pdm-supabase`. This plan is Rust-side only.

---

## Conventions used throughout

- **TDD per task.** Failing test → fail-confirm → impl → pass-confirm → commit. Pure-Rust crates can run their tests entirely without Docker (`cargo test -p <crate>`).
- **`pdm-core` and `pdm-sw-parser` are `no_std`-compatible.** They use `alloc` (so `Vec`, `String` are available) but not `std` networking / filesystem. This lets them compile to WASM for the edge function in Plan 5. Use `extern crate alloc;` and confine to `core::*` and `alloc::*`.
- **`pdm-client` is `std` + async.** It uses `tokio::main` in tests (or `tokio::test`) where needed. Integration tests against a live Supabase are out of scope for this plan — those land alongside Plan 5/6 when there's a runtime context to exercise them. Plan 2 ships *unit* tests that verify request shaping (URLs, headers, JSON bodies).
- **No `git push`.** Local commits only. Per the roadmap, no remote pushes until Plan 4 lands at the earliest.
- **Each commit message uses the existing Helios convention** (`feat(scope): subject`, `test(scope): subject`).
- **Workspace dep pinning.** New external deps (`cfb`, `reqwest`, `tokio`, `uuid`, `chrono`) are pinned in the root `Cargo.toml`'s `[workspace.dependencies]` block; individual crates reference them as `cfb = { workspace = true }`. Match the existing pattern in the workspace.

---

## Phase A — `pdm-core`

### Task 0: Scaffold `crates/pdm-core/`

**Files:**
- Modify: `Cargo.toml` (root) — add `pdm-core` to `members`; pin `uuid`, `chrono` in `workspace.dependencies`
- Create: `crates/pdm-core/Cargo.toml`
- Create: `crates/pdm-core/src/lib.rs`

- [ ] **Step 1: Update root `Cargo.toml`.**

Add to the `members` array:

```toml
members = [
  "crates/helios-core",
  "crates/helios-arrow",
  "crates/helios-csv",
  "crates/pdm-core",
  "apps/desktop/src-tauri",
]
```

In `[workspace.dependencies]`, add:

```toml
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 2: Create `crates/pdm-core/Cargo.toml`.**

```toml
[package]
name = "pdm-core"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
uuid = { workspace = true }
chrono = { workspace = true }

[features]
default = []
```

- [ ] **Step 3: Create `crates/pdm-core/src/lib.rs`.**

```rust
//! Shared domain types for the Helios Vault PDM module.
//!
//! No I/O, no async, no std-only APIs — this crate is `no_std + alloc` clean
//! so it can be compiled to WASM for the parse-refs edge function.

#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;

pub mod audit;
pub mod error;
pub mod ids;
pub mod role;
pub mod sha256;
pub mod vault;

pub use audit::{AuditAction, AuditEntry};
pub use error::CoreError;
pub use ids::{FileId, FolderId, LockId, UserId, VaultId, VersionId};
pub use role::Role;
pub use sha256::Sha256;
pub use vault::{File, Folder, Lock, Ref, Vault, Version};
```

- [ ] **Step 4: Create empty stubs for the modules so the crate compiles.**

`crates/pdm-core/src/audit.rs`:

```rust
// Filled in by Task 5.
```

`crates/pdm-core/src/error.rs`:

```rust
// Filled in by Task 1.
```

`crates/pdm-core/src/ids.rs`:

```rust
// Filled in by Task 1.
```

`crates/pdm-core/src/role.rs`:

```rust
// Filled in by Task 3.
```

`crates/pdm-core/src/sha256.rs`:

```rust
// Filled in by Task 2.
```

`crates/pdm-core/src/vault.rs`:

```rust
// Filled in by Task 4.
```

- [ ] **Step 5: Verify it compiles.**

```bash
cargo build -p pdm-core
```

Expected: succeeds. The lib.rs `pub use` lines will fail because the modules are empty — adjust by commenting out the `pub use` block in `lib.rs` for now. Add a TODO comment so it's filled in by Task 1.

Actually, that approach creates churn. Instead, in `lib.rs`, replace the `pub use` block with:

```rust
//! Shared domain types for the Helios Vault PDM module.
//!
//! No I/O, no async, no std-only APIs — this crate is `no_std + alloc` clean
//! so it can be compiled to WASM for the parse-refs edge function.

#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;

pub mod audit;
pub mod error;
pub mod ids;
pub mod role;
pub mod sha256;
pub mod vault;
```

(No `pub use` lines yet. Each subsequent task adds the `pub use` line for the type it introduces.)

- [ ] **Step 6: Commit.**

```bash
git add Cargo.toml crates/pdm-core
git commit -m "feat(pdm-core): scaffold crate with module skeletons"
```

---

### Task 1: `pdm-core::ids` — strong-typed UUID newtypes + `CoreError`

**Files:**
- Create: `crates/pdm-core/tests/ids.rs`
- Modify: `crates/pdm-core/src/error.rs`
- Modify: `crates/pdm-core/src/ids.rs`
- Modify: `crates/pdm-core/src/lib.rs` (add `pub use`)

- [ ] **Step 1: Write the failing test** at `crates/pdm-core/tests/ids.rs`:

```rust
use pdm_core::{CoreError, FileId, FolderId, LockId, UserId, VaultId, VersionId};
use uuid::Uuid;

#[test]
fn uuid_newtypes_round_trip_through_string() {
    let raw = Uuid::new_v4();
    let v: VaultId = raw.into();
    assert_eq!(v.as_uuid(), &raw);
    let s = v.to_string();
    let parsed: VaultId = s.parse().expect("must parse");
    assert_eq!(parsed, v);
}

#[test]
fn invalid_string_returns_invalid_id_error() {
    let err = "not-a-uuid".parse::<FileId>().unwrap_err();
    assert!(matches!(err, CoreError::InvalidId(_)), "expected InvalidId, got {:?}", err);
}

#[test]
fn newtypes_are_distinct() {
    // Compile-only check that FileId != FolderId — uncomment to verify it's a compile error:
    // let f: FileId = FolderId::from(Uuid::new_v4());

    // Runtime check: serde produces same underlying string for both, but they are not interchangeable.
    let raw = Uuid::new_v4();
    let f: FileId = raw.into();
    let d: FolderId = raw.into();
    assert_eq!(f.to_string(), d.to_string());
}

#[test]
fn folder_id_lock_id_user_id_version_id_all_present() {
    // Smoke test that every newtype constructs.
    let _: FolderId = Uuid::new_v4().into();
    let _: LockId = Uuid::new_v4().into();
    let _: UserId = Uuid::new_v4().into();
    let _: VersionId = Uuid::new_v4().into();
}
```

- [ ] **Step 2: Run the test and confirm failure.**

```bash
cargo test -p pdm-core --test ids
```

Expected: compile error (types not defined).

- [ ] **Step 3: Write `error.rs`.**

`crates/pdm-core/src/error.rs`:

```rust
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CoreError {
    #[error("invalid id: {0}")]
    InvalidId(alloc::string::String),
    #[error("invalid sha256 (expected 64 lowercase hex chars): {0}")]
    InvalidSha256(alloc::string::String),
    #[error("invalid role (expected admin|editor|viewer): {0}")]
    InvalidRole(alloc::string::String),
}
```

- [ ] **Step 4: Write `ids.rs`.**

`crates/pdm-core/src/ids.rs`:

```rust
use crate::error::CoreError;
use alloc::string::ToString;
use core::fmt;
use core::str::FromStr;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_newtype {
    ($name:ident) => {
        #[derive(
            Clone,
            Copy,
            Debug,
            Default,
            PartialEq,
            Eq,
            PartialOrd,
            Ord,
            Hash,
            Serialize,
            Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
            pub fn as_uuid(&self) -> &Uuid {
                &self.0
            }
            pub fn into_uuid(self) -> Uuid {
                self.0
            }
        }

        impl From<Uuid> for $name {
            fn from(u: Uuid) -> Self {
                Self(u)
            }
        }

        impl From<$name> for Uuid {
            fn from(id: $name) -> Self {
                id.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }

        impl FromStr for $name {
            type Err = CoreError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s)
                    .map(Self)
                    .map_err(|_| CoreError::InvalidId(s.to_string()))
            }
        }
    };
}

id_newtype!(VaultId);
id_newtype!(FolderId);
id_newtype!(FileId);
id_newtype!(VersionId);
id_newtype!(LockId);
id_newtype!(UserId);
```

- [ ] **Step 5: Update `lib.rs` to export the new types.**

```rust
pub use error::CoreError;
pub use ids::{FileId, FolderId, LockId, UserId, VaultId, VersionId};
```

(Add these `pub use` lines below the existing `pub mod` declarations.)

- [ ] **Step 6: Run the test and verify it passes.**

```bash
cargo test -p pdm-core --test ids
```

Expected: 4 tests, all pass.

- [ ] **Step 7: Commit.**

```bash
git add crates/pdm-core/src/error.rs \
        crates/pdm-core/src/ids.rs \
        crates/pdm-core/src/lib.rs \
        crates/pdm-core/tests/ids.rs
git commit -m "feat(pdm-core): strong-typed UUID newtypes (VaultId, FolderId, FileId, VersionId, LockId, UserId) + CoreError"
```

---

### Task 2: `pdm-core::sha256` — Sha256 newtype with hex parse/format

**Files:**
- Modify: `crates/pdm-core/src/sha256.rs`
- Modify: `crates/pdm-core/src/lib.rs`
- Create: `crates/pdm-core/tests/sha256.rs`

- [ ] **Step 1: Write the failing test** at `crates/pdm-core/tests/sha256.rs`:

```rust
use pdm_core::{CoreError, Sha256};

#[test]
fn parses_64_lowercase_hex_chars() {
    let raw = "a".repeat(64);
    let s: Sha256 = raw.parse().expect("must parse");
    assert_eq!(s.as_str(), raw);
}

#[test]
fn rejects_uppercase_hex() {
    let err = "A".repeat(64).parse::<Sha256>().unwrap_err();
    assert!(matches!(err, CoreError::InvalidSha256(_)));
}

#[test]
fn rejects_wrong_length() {
    assert!(matches!(
        "a".repeat(63).parse::<Sha256>(),
        Err(CoreError::InvalidSha256(_))
    ));
    assert!(matches!(
        "a".repeat(65).parse::<Sha256>(),
        Err(CoreError::InvalidSha256(_))
    ));
}

#[test]
fn rejects_non_hex_chars() {
    let mut s = "a".repeat(63);
    s.push('z');
    assert!(matches!(s.parse::<Sha256>(), Err(CoreError::InvalidSha256(_))));
}

#[test]
fn display_is_identical_to_input() {
    let raw = "0123456789abcdef".repeat(4);
    let s: Sha256 = raw.parse().unwrap();
    assert_eq!(s.to_string(), raw);
}

#[test]
fn storage_path_returns_two_char_prefix_slash_full() {
    let raw = "abcdef".to_string() + &"0".repeat(58);
    let s: Sha256 = raw.parse().unwrap();
    assert_eq!(s.storage_path(), format!("ab/{raw}"));
}
```

- [ ] **Step 2: Run, confirm failure.**

```bash
cargo test -p pdm-core --test sha256
```

- [ ] **Step 3: Write `sha256.rs`.**

`crates/pdm-core/src/sha256.rs`:

```rust
use crate::error::CoreError;
use alloc::format;
use alloc::string::{String, ToString};
use core::fmt;
use core::str::FromStr;
use serde::{Deserialize, Serialize};

/// Lowercase-hex sha-256 digest, 64 chars.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sha256(String);

impl Sha256 {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Path under `vault-objects` Storage bucket: `<first2hex>/<full>`.
    pub fn storage_path(&self) -> String {
        format!("{}/{}", &self.0[..2], &self.0)
    }
}

impl fmt::Display for Sha256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Sha256 {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.len() != 64 {
            return Err(CoreError::InvalidSha256(s.to_string()));
        }
        for c in s.chars() {
            let valid = c.is_ascii_digit() || ('a'..='f').contains(&c);
            if !valid {
                return Err(CoreError::InvalidSha256(s.to_string()));
            }
        }
        Ok(Self(s.to_string()))
    }
}

impl TryFrom<String> for Sha256 {
    type Error = CoreError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<Sha256> for String {
    fn from(s: Sha256) -> Self {
        s.0
    }
}
```

- [ ] **Step 4: Update `lib.rs`** — add `pub use sha256::Sha256;` to the exports section.

- [ ] **Step 5: Run.**

```bash
cargo test -p pdm-core --test sha256
```

Expected: 6 tests, all pass.

- [ ] **Step 6: Commit.**

```bash
git add crates/pdm-core/src/sha256.rs crates/pdm-core/src/lib.rs crates/pdm-core/tests/sha256.rs
git commit -m "feat(pdm-core): Sha256 newtype with strict hex validation + storage_path helper"
```

---

### Task 3: `pdm-core::role` — Role enum

**Files:**
- Modify: `crates/pdm-core/src/role.rs`
- Modify: `crates/pdm-core/src/lib.rs`
- Create: `crates/pdm-core/tests/role.rs`

- [ ] **Step 1: Write the failing test** at `crates/pdm-core/tests/role.rs`:

```rust
use pdm_core::{CoreError, Role};

#[test]
fn round_trips_through_string() {
    for r in [Role::Admin, Role::Editor, Role::Viewer] {
        let s = r.to_string();
        let parsed: Role = s.parse().unwrap();
        assert_eq!(parsed, r);
    }
}

#[test]
fn lowercase_strings_match_postgres_check_constraint() {
    assert_eq!(Role::Admin.to_string(), "admin");
    assert_eq!(Role::Editor.to_string(), "editor");
    assert_eq!(Role::Viewer.to_string(), "viewer");
}

#[test]
fn unknown_role_rejected() {
    let err = "owner".parse::<Role>().unwrap_err();
    assert!(matches!(err, CoreError::InvalidRole(_)));
}

#[test]
fn admin_implies_editor_capabilities() {
    assert!(Role::Admin.can_check_in_out());
    assert!(Role::Editor.can_check_in_out());
    assert!(!Role::Viewer.can_check_in_out());

    assert!(Role::Admin.is_admin());
    assert!(!Role::Editor.is_admin());
    assert!(!Role::Viewer.is_admin());
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `role.rs`.**

`crates/pdm-core/src/role.rs`:

```rust
use crate::error::CoreError;
use alloc::string::ToString;
use core::fmt;
use core::str::FromStr;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Editor,
    Viewer,
}

impl Role {
    pub fn is_admin(self) -> bool {
        matches!(self, Role::Admin)
    }

    /// Editors and admins can check files in/out; viewers cannot.
    pub fn can_check_in_out(self) -> bool {
        matches!(self, Role::Admin | Role::Editor)
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Role::Admin => "admin",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
        })
    }
}

impl FromStr for Role {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "admin" => Ok(Role::Admin),
            "editor" => Ok(Role::Editor),
            "viewer" => Ok(Role::Viewer),
            _ => Err(CoreError::InvalidRole(s.to_string())),
        }
    }
}
```

- [ ] **Step 4: Update `lib.rs`** with `pub use role::Role;`.

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add crates/pdm-core/src/role.rs crates/pdm-core/src/lib.rs crates/pdm-core/tests/role.rs
git commit -m "feat(pdm-core): Role enum (Admin/Editor/Viewer) with FromStr/Display + capability checks"
```

---

### Task 4: `pdm-core::vault` — domain structs

**Files:**
- Modify: `crates/pdm-core/src/vault.rs`
- Modify: `crates/pdm-core/src/lib.rs`
- Create: `crates/pdm-core/tests/serde_roundtrip.rs`

- [ ] **Step 1: Write the failing test** at `crates/pdm-core/tests/serde_roundtrip.rs`:

```rust
use chrono::Utc;
use pdm_core::{
    File, FileId, Folder, FolderId, Lock, LockId, Ref, Sha256, UserId, Vault, VaultId, Version,
    VersionId,
};

fn sha() -> Sha256 {
    "0".repeat(64).parse().unwrap()
}

#[test]
fn vault_round_trips_through_json() {
    let v = Vault {
        id: VaultId::new(),
        name: "sdm26".to_string(),
        created_at: Utc::now(),
        created_by: UserId::new(),
    };
    let s = serde_json::to_string(&v).unwrap();
    let back: Vault = serde_json::from_str(&s).unwrap();
    assert_eq!(back, v);
}

#[test]
fn folder_round_trips() {
    let f = Folder {
        id: FolderId::new(),
        vault_id: VaultId::new(),
        parent_id: None,
        name: "chassis".to_string(),
        created_at: Utc::now(),
    };
    let s = serde_json::to_string(&f).unwrap();
    let back: Folder = serde_json::from_str(&s).unwrap();
    assert_eq!(back, f);
}

#[test]
fn file_round_trips() {
    let file = File {
        id: FileId::new(),
        vault_id: VaultId::new(),
        folder_id: Some(FolderId::new()),
        name: "frame.sldprt".to_string(),
        latest_version_id: Some(VersionId::new()),
        created_at: Utc::now(),
    };
    let s = serde_json::to_string(&file).unwrap();
    let back: File = serde_json::from_str(&s).unwrap();
    assert_eq!(back, file);
}

#[test]
fn version_round_trips() {
    let v = Version {
        id: VersionId::new(),
        file_id: FileId::new(),
        version_num: 7,
        sha256: sha(),
        size_bytes: 1234,
        author_id: UserId::new(),
        comment: Some("first cut".to_string()),
        parent_version_id: None,
        created_at: Utc::now(),
    };
    let s = serde_json::to_string(&v).unwrap();
    let back: Version = serde_json::from_str(&s).unwrap();
    assert_eq!(back, v);
}

#[test]
fn lock_round_trips_with_active_state() {
    let l = Lock {
        id: LockId::new(),
        file_id: FileId::new(),
        user_id: UserId::new(),
        acquired_at: Utc::now(),
        released_at: None,
        force_released_by: None,
    };
    let s = serde_json::to_string(&l).unwrap();
    let back: Lock = serde_json::from_str(&s).unwrap();
    assert_eq!(back, l);
    assert!(l.is_active());
}

#[test]
fn lock_is_active_returns_false_when_released() {
    let l = Lock {
        id: LockId::new(),
        file_id: FileId::new(),
        user_id: UserId::new(),
        acquired_at: Utc::now(),
        released_at: Some(Utc::now()),
        force_released_by: None,
    };
    assert!(!l.is_active());
}

#[test]
fn ref_round_trips() {
    let r = Ref {
        parent_version_id: VersionId::new(),
        child_path_hint: "..\\parts\\frame-rail.sldprt".to_string(),
        child_file_id: Some(FileId::new()),
    };
    let s = serde_json::to_string(&r).unwrap();
    let back: Ref = serde_json::from_str(&s).unwrap();
    assert_eq!(back, r);
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `vault.rs`.**

`crates/pdm-core/src/vault.rs`:

```rust
use crate::ids::{FileId, FolderId, LockId, UserId, VaultId, VersionId};
use crate::sha256::Sha256;
use alloc::string::String;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vault {
    pub id: VaultId,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub created_by: UserId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: FolderId,
    pub vault_id: VaultId,
    pub parent_id: Option<FolderId>,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub id: FileId,
    pub vault_id: VaultId,
    pub folder_id: Option<FolderId>,
    pub name: String,
    pub latest_version_id: Option<VersionId>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    pub id: VersionId,
    pub file_id: FileId,
    pub version_num: u32,
    pub sha256: Sha256,
    pub size_bytes: u64,
    pub author_id: UserId,
    pub comment: Option<String>,
    pub parent_version_id: Option<VersionId>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lock {
    pub id: LockId,
    pub file_id: FileId,
    pub user_id: UserId,
    pub acquired_at: DateTime<Utc>,
    pub released_at: Option<DateTime<Utc>>,
    pub force_released_by: Option<UserId>,
}

impl Lock {
    pub fn is_active(&self) -> bool {
        self.released_at.is_none()
    }

    pub fn was_force_released(&self) -> bool {
        self.released_at.is_some() && self.force_released_by.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ref {
    pub parent_version_id: VersionId,
    pub child_path_hint: String,
    pub child_file_id: Option<FileId>,
}
```

- [ ] **Step 4: Update `lib.rs`** with `pub use vault::{File, Folder, Lock, Ref, Vault, Version};`.

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add crates/pdm-core/src/vault.rs crates/pdm-core/src/lib.rs crates/pdm-core/tests/serde_roundtrip.rs
git commit -m "feat(pdm-core): Vault/Folder/File/Version/Lock/Ref domain structs with serde + Lock helpers"
```

---

### Task 5: `pdm-core::audit` — `AuditEntry` and `AuditAction`

**Files:**
- Modify: `crates/pdm-core/src/audit.rs`
- Modify: `crates/pdm-core/src/lib.rs`
- Create: `crates/pdm-core/tests/audit.rs`

- [ ] **Step 1: Write failing test** at `crates/pdm-core/tests/audit.rs`:

```rust
use chrono::Utc;
use pdm_core::{AuditAction, AuditEntry, FileId, LockId, UserId, VersionId};
use serde_json::json;

#[test]
fn action_round_trips_through_postgres_strings() {
    use AuditAction::*;
    for (a, s) in [
        (CheckOut, "check_out"),
        (CheckIn, "check_in"),
        (CancelCheckout, "cancel_checkout"),
        (ForceUnlock, "force_unlock"),
        (ParseRefsFailed, "parse_refs_failed"),
    ] {
        let serialized = serde_json::to_value(a).unwrap();
        assert_eq!(serialized, json!(s));
        let back: AuditAction = serde_json::from_value(json!(s)).unwrap();
        assert_eq!(back, a);
    }
}

#[test]
fn entry_round_trips_with_jsonb_payload() {
    let entry = AuditEntry {
        id: 42,
        user_id: Some(UserId::new()),
        action: AuditAction::ForceUnlock,
        target_type: "lock".to_string(),
        target_id: LockId::new().to_string(),
        payload: Some(json!({"reason": "left for the day"})),
        ts: Utc::now(),
    };
    let s = serde_json::to_string(&entry).unwrap();
    let back: AuditEntry = serde_json::from_str(&s).unwrap();
    assert_eq!(back, entry);
}

#[test]
fn check_in_target_type_is_version_in_postgres() {
    // The Postgres trigger writes target_type='version' for check_in.
    // This test documents the convention; if the trigger changes, the assertion below changes.
    assert_eq!(AuditAction::CheckIn.canonical_target_type(), "version");
    assert_eq!(AuditAction::CheckOut.canonical_target_type(), "lock");
    assert_eq!(AuditAction::ForceUnlock.canonical_target_type(), "lock");
    assert_eq!(AuditAction::CancelCheckout.canonical_target_type(), "lock");
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `audit.rs`.**

`crates/pdm-core/src/audit.rs`:

```rust
use crate::ids::UserId;
use alloc::string::String;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    CheckOut,
    CheckIn,
    CancelCheckout,
    ForceUnlock,
    ParseRefsFailed,
}

impl AuditAction {
    /// What `pdm.audit_log.target_type` the Postgres triggers / RPCs use for this action.
    /// Matches the conventions defined in migration `20260507000900_pdm_audit_triggers.sql`.
    pub fn canonical_target_type(self) -> &'static str {
        match self {
            AuditAction::CheckOut => "lock",
            AuditAction::CheckIn => "version",
            AuditAction::CancelCheckout => "lock",
            AuditAction::ForceUnlock => "lock",
            AuditAction::ParseRefsFailed => "version",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: i64,
    pub user_id: Option<UserId>,
    pub action: AuditAction,
    pub target_type: String,
    pub target_id: String,
    pub payload: Option<serde_json::Value>,
    pub ts: DateTime<Utc>,
}
```

- [ ] **Step 4: Update `lib.rs`** with `pub use audit::{AuditAction, AuditEntry};`.

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add crates/pdm-core/src/audit.rs crates/pdm-core/src/lib.rs crates/pdm-core/tests/audit.rs
git commit -m "feat(pdm-core): AuditEntry + AuditAction enum mirroring Postgres trigger conventions"
```

---

## Phase B — `pdm-sw-parser`

### Task 6: Scaffold `crates/pdm-sw-parser/`

**Files:**
- Modify: root `Cargo.toml` (add `pdm-sw-parser` to members; pin `cfb` workspace dep)
- Create: `crates/pdm-sw-parser/Cargo.toml`
- Create: `crates/pdm-sw-parser/src/lib.rs`
- Create: `crates/pdm-sw-parser/src/{ref_hint,cfb_reader,sldasm,error}.rs` (stubs)

- [ ] **Step 1: Pin `cfb` in workspace.**

In root `Cargo.toml` `[workspace.dependencies]` add:

```toml
cfb = "0.10"
```

And in `members`:

```toml
"crates/pdm-sw-parser",
```

- [ ] **Step 2: Create `crates/pdm-sw-parser/Cargo.toml`.**

```toml
[package]
name = "pdm-sw-parser"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
pdm-core = { path = "../pdm-core" }
serde = { workspace = true }
thiserror = { workspace = true }
cfb = { workspace = true }
```

- [ ] **Step 3: Create source skeleton.**

`crates/pdm-sw-parser/src/lib.rs`:

```rust
//! Parses SolidWorks `.sldasm` / `.sldprt` files (Compound File Binary
//! containers) and extracts referenced part / sub-assembly path hints.
//!
//! Best-effort. Returns an empty Vec on unparseable input rather than panicking,
//! so callers (the parse-refs edge function, future SW add-in) can apply
//! retry / log policies without bringing down request paths.

pub mod cfb_reader;
pub mod error;
pub mod ref_hint;
pub mod sldasm;

pub use error::ParseError;
pub use ref_hint::RefHint;

/// Top-level entry point.
///
/// Returns every reference-path hint found in the file, in the order they
/// appeared in the source streams. Duplicates are NOT deduplicated here —
/// callers may want to track which appeared first for ordering.
pub fn parse_refs(bytes: &[u8]) -> alloc::vec::Vec<RefHint> {
    cfb_reader::list_refs(bytes).unwrap_or_default()
}

extern crate alloc;
```

`crates/pdm-sw-parser/src/ref_hint.rs`:

```rust
// Filled in by Task 7.
```

`crates/pdm-sw-parser/src/cfb_reader.rs`:

```rust
// Filled in by Task 8.
```

`crates/pdm-sw-parser/src/sldasm.rs`:

```rust
// Filled in by Task 9.
```

`crates/pdm-sw-parser/src/error.rs`:

```rust
// Filled in by Task 7.
```

- [ ] **Step 4: Verify it compiles.** `cargo build -p pdm-sw-parser`.

If it fails because `cfb_reader::list_refs` isn't defined yet, add a temporary stub at the top of `lib.rs` and remove it in Task 8:

```rust
mod cfb_reader {
    pub fn list_refs(_bytes: &[u8]) -> Option<alloc::vec::Vec<crate::RefHint>> { None }
}
```

(Or simpler: comment out `pub fn parse_refs` and the `pub mod` lines until they're populated; uncomment as each task fills its module.)

- [ ] **Step 5: Commit.**

```bash
git add Cargo.toml crates/pdm-sw-parser
git commit -m "feat(pdm-sw-parser): scaffold crate"
```

---

### Task 7: `RefHint` struct + `ParseError`

**Files:**
- Modify: `crates/pdm-sw-parser/src/ref_hint.rs`
- Modify: `crates/pdm-sw-parser/src/error.rs`
- Create: `crates/pdm-sw-parser/tests/ref_hint.rs`

- [ ] **Step 1: Write failing test** at `crates/pdm-sw-parser/tests/ref_hint.rs`:

```rust
use pdm_sw_parser::RefHint;

#[test]
fn ref_hint_holds_a_path() {
    let r = RefHint { path: "..\\parts\\frame-rail.sldprt".to_string() };
    assert_eq!(r.path, "..\\parts\\frame-rail.sldprt");
}

#[test]
fn ref_hint_basename_extracts_filename_unix_or_windows_separators() {
    let r = RefHint { path: "..\\parts\\frame-rail.sldprt".to_string() };
    assert_eq!(r.basename(), "frame-rail.sldprt");

    let r = RefHint { path: "/Users/me/project/frame-rail.sldprt".to_string() };
    assert_eq!(r.basename(), "frame-rail.sldprt");

    let r = RefHint { path: "no-separators.sldprt".to_string() };
    assert_eq!(r.basename(), "no-separators.sldprt");
}

#[test]
fn ref_hint_serde_round_trip() {
    let r = RefHint { path: "x.sldprt".to_string() };
    let s = serde_json::to_string(&r).unwrap();
    let back: RefHint = serde_json::from_str(&s).unwrap();
    assert_eq!(back, r);
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `ref_hint.rs`.**

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RefHint {
    /// Raw path string as it appeared in the SW file. May be Windows-style
    /// (`..\parts\foo.sldprt`), Unix-style (`/Users/x/foo.sldprt`), or just a
    /// basename (`foo.sldprt`). Resolution against the vault is done elsewhere.
    pub path: String,
}

impl RefHint {
    /// Last path segment after either '/' or '\\'.
    pub fn basename(&self) -> &str {
        let last_slash = self.path.rfind(|c: char| c == '/' || c == '\\');
        match last_slash {
            Some(i) => &self.path[i + 1..],
            None => &self.path,
        }
    }
}
```

- [ ] **Step 4: Write `error.rs`.**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("input is not a valid Compound File Binary container: {0}")]
    NotCfb(String),
    #[error("CFB stream `{0}` is missing")]
    MissingStream(String),
    #[error("CFB stream `{0}` cannot be read: {1}")]
    UnreadableStream(String, String),
}
```

(`serde` not needed on `ParseError` — it's only used internally.)

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add crates/pdm-sw-parser/src/ref_hint.rs \
        crates/pdm-sw-parser/src/error.rs \
        crates/pdm-sw-parser/tests/ref_hint.rs
git commit -m "feat(pdm-sw-parser): RefHint struct with basename helper + ParseError"
```

---

### Task 8: CFB container reader — open + list streams

**Files:**
- Modify: `crates/pdm-sw-parser/src/cfb_reader.rs`
- Create: `crates/pdm-sw-parser/tests/cfb_reader.rs`

- [ ] **Step 1: Write failing test.**

`crates/pdm-sw-parser/tests/cfb_reader.rs`:

```rust
use std::io::Cursor;
use pdm_sw_parser::cfb_reader::{open_cfb, list_streams, list_refs};

fn empty_cfb_bytes() -> Vec<u8> {
    // Build a minimal but valid CFB in memory using the cfb crate.
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::create(cursor).unwrap();
        comp.create_stream("\x05DocumentSummaryInformation").unwrap()
            .write_all(b"placeholder").unwrap();
        // No external-references stream — this represents a trivial / empty SW file.
        comp.flush().unwrap();
    }
    buf
}

#[test]
fn open_cfb_succeeds_on_valid_container() {
    let bytes = empty_cfb_bytes();
    let cursor = Cursor::new(bytes);
    let comp = open_cfb(cursor).unwrap();
    let names = list_streams(&comp);
    assert!(names.iter().any(|n| n.contains("DocumentSummaryInformation")));
}

#[test]
fn list_refs_returns_empty_on_invalid_input() {
    // Random bytes are not a valid CFB.
    let result = list_refs(b"this is not a CFB container");
    assert!(result.is_some(), "function returns Some(empty) on parseable-but-empty");
    // Actually it returns None for non-CFB; document and assert:
}

#[test]
fn list_refs_on_garbage_returns_none() {
    let result = list_refs(b"this is not a CFB container");
    assert!(result.is_none(), "non-CFB input must return None, not panic");
}
```

(The second test above is intentionally inconsistent with the third — keep only the third. The earlier draft is removed in the implementation step. Strike the second `#[test] fn list_refs_returns_empty_on_invalid_input` block — it conflicts; only keep the `list_refs_on_garbage_returns_none` variant.)

Final test file:

```rust
use std::io::{Cursor, Write};
use pdm_sw_parser::cfb_reader::{open_cfb, list_streams, list_refs};

fn empty_cfb_bytes() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::create(cursor).unwrap();
        comp.create_stream("\x05DocumentSummaryInformation").unwrap()
            .write_all(b"placeholder").unwrap();
        comp.flush().unwrap();
    }
    buf
}

#[test]
fn open_cfb_succeeds_on_valid_container() {
    let bytes = empty_cfb_bytes();
    let cursor = Cursor::new(bytes);
    let comp = open_cfb(cursor).unwrap();
    let names = list_streams(&comp);
    assert!(names.iter().any(|n| n.contains("DocumentSummaryInformation")));
}

#[test]
fn list_refs_on_garbage_returns_none() {
    let result = list_refs(b"this is not a CFB container");
    assert!(result.is_none(), "non-CFB input must return None, not panic");
}

#[test]
fn list_refs_on_empty_cfb_returns_empty_vec() {
    let bytes = empty_cfb_bytes();
    let result = list_refs(&bytes).unwrap();
    assert!(result.is_empty());
}
```

The test file references `cfb` as a dev-dependency — add to `Cargo.toml`:

```toml
[dev-dependencies]
cfb = { workspace = true }
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `cfb_reader.rs`.**

```rust
use crate::ref_hint::RefHint;
use crate::sldasm;
use cfb::CompoundFile;
use std::io::{Read, Seek};
use alloc::string::{String, ToString};
use alloc::vec::Vec;

/// Open a CFB container from anything readable + seekable.
pub fn open_cfb<F: Read + Seek>(reader: F) -> Result<CompoundFile<F>, std::io::Error> {
    cfb::open(reader)
}

/// List every stream name in the container (paths joined by `/`).
pub fn list_streams<F: Read + Seek>(comp: &CompoundFile<F>) -> Vec<String> {
    comp.walk()
        .filter(|entry| entry.is_stream())
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect()
}

/// Top-level: parse references from raw bytes.
/// Returns:
/// - `Some(Vec)` (possibly empty) when the input is a valid CFB.
/// - `None` when the input is not a CFB at all.
///
/// Best-effort across SW versions.
pub fn list_refs(bytes: &[u8]) -> Option<Vec<RefHint>> {
    let cursor = std::io::Cursor::new(bytes);
    let mut comp = cfb::open(cursor).ok()?;
    Some(sldasm::extract_refs(&mut comp))
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-sw-parser/Cargo.toml \
        crates/pdm-sw-parser/src/cfb_reader.rs \
        crates/pdm-sw-parser/tests/cfb_reader.rs
git commit -m "feat(pdm-sw-parser): CFB container open + stream listing + top-level list_refs entry point"
```

---

### Task 9: Reference extraction from `.sldasm`-style streams

**Files:**
- Modify: `crates/pdm-sw-parser/src/sldasm.rs`
- Create: `crates/pdm-sw-parser/tests/extract_refs.rs`

- [ ] **Step 1: Write failing test.**

`crates/pdm-sw-parser/tests/extract_refs.rs`:

```rust
use std::io::{Cursor, Write};
use pdm_sw_parser::parse_refs;

fn build_cfb_with_refs_stream(payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::create(cursor).unwrap();
        // SolidWorks stores external references in a stream commonly named
        // `External References` (or `External Component References` depending
        // on version). For our parser, accept any stream containing "Reference".
        comp.create_stream("External References").unwrap().write_all(payload).unwrap();
        comp.flush().unwrap();
    }
    buf
}

#[test]
fn extracts_path_strings_from_ref_stream() {
    // SolidWorks stores paths as length-prefixed UTF-16-LE strings in some
    // versions; in others, as null-terminated WTF-8 / Latin-1 chunks.
    // The parser scans for printable ASCII runs ending in a SW extension and
    // returns each match.
    let mut payload: Vec<u8> = Vec::new();
    payload.extend_from_slice(b"\x00\x00\x00\x00..\\parts\\frame-rail.sldprt\x00");
    payload.extend_from_slice(b"junk_bytes\xff\xff\xff\xff");
    payload.extend_from_slice(b"..\\hardware\\m6-bolt-25.sldprt\x00");

    let cfb = build_cfb_with_refs_stream(&payload);
    let refs = parse_refs(&cfb);
    let paths: Vec<&str> = refs.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.iter().any(|p| p.ends_with("frame-rail.sldprt")));
    assert!(paths.iter().any(|p| p.ends_with("m6-bolt-25.sldprt")));
}

#[test]
fn ignores_non_sw_extensions() {
    let payload = b"helper.txt\x00random.png\x00valid.sldasm\x00";
    let cfb = build_cfb_with_refs_stream(payload);
    let refs = parse_refs(&cfb);
    let paths: Vec<&str> = refs.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths.len(), 1);
    assert!(paths[0].ends_with("valid.sldasm"));
}

#[test]
fn empty_ref_stream_returns_empty_vec() {
    let cfb = build_cfb_with_refs_stream(&[]);
    let refs = parse_refs(&cfb);
    assert!(refs.is_empty());
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `sldasm.rs`.**

```rust
use crate::ref_hint::RefHint;
use cfb::CompoundFile;
use std::io::{Read, Seek};
use alloc::string::String;
use alloc::vec::Vec;

const SW_EXTENSIONS: &[&str] = &[".sldprt", ".sldasm", ".slddrw"];

/// Walk the container, find streams whose name contains "Reference", and scan
/// each one for printable-ASCII runs that end in a SolidWorks extension. Each
/// match becomes a RefHint.
///
/// Best-effort across SW versions — formats differ. We err on the side of
/// recall over precision; consumers dedupe by basename.
pub fn extract_refs<F: Read + Seek>(comp: &mut CompoundFile<F>) -> Vec<RefHint> {
    let candidate_streams: Vec<String> = comp
        .walk()
        .filter(|e| e.is_stream())
        .map(|e| e.path().to_string_lossy().into_owned())
        .filter(|name| name.contains("Reference"))
        .collect();

    let mut hints = Vec::new();
    for stream_name in candidate_streams {
        let mut buf = Vec::new();
        if let Ok(mut s) = comp.open_stream(&stream_name) {
            if s.read_to_end(&mut buf).is_ok() {
                hints.extend(scan_bytes_for_paths(&buf));
            }
        }
    }
    hints
}

fn scan_bytes_for_paths(bytes: &[u8]) -> Vec<RefHint> {
    // Strategy: collect maximal runs of printable-ASCII bytes (and the path
    // separators / : drive letter), then keep each run that ends in one of
    // the SW extensions.
    let mut out = Vec::new();
    let mut current = String::new();
    for &b in bytes {
        if is_printable(b) {
            current.push(b as char);
        } else {
            check_and_push(&mut current, &mut out);
            current.clear();
        }
    }
    check_and_push(&mut current, &mut out);
    out
}

fn is_printable(b: u8) -> bool {
    (0x20..=0x7e).contains(&b)
}

fn check_and_push(run: &mut String, out: &mut Vec<RefHint>) {
    if run.is_empty() {
        return;
    }
    let lower = run.to_ascii_lowercase();
    if SW_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        out.push(RefHint { path: core::mem::take(run) });
    }
}
```

- [ ] **Step 4: Run, expect pass.**

If a test fails because the parse picks up adjacent garbage as part of the path, tighten `is_printable` (already restricted) or extend the run-end detection. Iterate until all three tests pass.

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-sw-parser/src/sldasm.rs crates/pdm-sw-parser/tests/extract_refs.rs
git commit -m "feat(pdm-sw-parser): extract SW reference paths from CFB streams (best-effort scan)"
```

---

### Task 10: End-to-end smoke test for the public `parse_refs` API

**Files:**
- Create: `crates/pdm-sw-parser/tests/public_api.rs`

- [ ] **Step 1: Write a single test that exercises every code path from the public API.**

```rust
use std::io::{Cursor, Write};
use pdm_sw_parser::{parse_refs, RefHint};

fn cfb_with_streams(streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::create(cursor).unwrap();
        for (name, payload) in streams {
            comp.create_stream(*name).unwrap().write_all(payload).unwrap();
        }
        comp.flush().unwrap();
    }
    buf
}

#[test]
fn parse_refs_on_garbage_input_does_not_panic_and_returns_empty() {
    let refs = parse_refs(b"\x00\x01\x02 not a cfb at all");
    assert!(refs.is_empty());
}

#[test]
fn parse_refs_on_cfb_without_reference_streams_returns_empty() {
    let cfb = cfb_with_streams(&[("Properties", b"hello")]);
    let refs = parse_refs(&cfb);
    assert!(refs.is_empty());
}

#[test]
fn parse_refs_aggregates_hints_across_multiple_reference_streams() {
    let cfb = cfb_with_streams(&[
        ("External References", b"..\\parts\\a.sldprt\x00..\\parts\\b.sldprt\x00"),
        ("Component References", b"..\\hardware\\bolt.sldprt\x00"),
    ]);
    let refs = parse_refs(&cfb);
    let basenames: Vec<&str> = refs.iter().map(RefHint::basename).collect();
    assert!(basenames.contains(&"a.sldprt"));
    assert!(basenames.contains(&"b.sldprt"));
    assert!(basenames.contains(&"bolt.sldprt"));
}
```

- [ ] **Step 2: Run.**

```bash
cargo test -p pdm-sw-parser
```

Expected: every test in every test file in `pdm-sw-parser` passes.

- [ ] **Step 3: Commit.**

```bash
git add crates/pdm-sw-parser/tests/public_api.rs
git commit -m "test(pdm-sw-parser): end-to-end smoke tests for parse_refs public API"
```

---

## Phase C — `pdm-client`

### Task 11: Scaffold `crates/pdm-client/`

**Files:**
- Modify: root `Cargo.toml` — add `pdm-client` to members; pin `reqwest`, `tokio`, `url`
- Create: `crates/pdm-client/Cargo.toml`
- Create: `crates/pdm-client/src/lib.rs` and per-module stubs

- [ ] **Step 1: Pin workspace deps.**

Root `Cargo.toml` `[workspace.dependencies]`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
url = "2"
```

`members`:

```toml
"crates/pdm-client",
```

- [ ] **Step 2: Create `crates/pdm-client/Cargo.toml`.**

```toml
[package]
name = "pdm-client"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
pdm-core = { path = "../pdm-core" }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
reqwest = { workspace = true }
url = { workspace = true }
chrono = { workspace = true }
uuid = { workspace = true }

[dev-dependencies]
tokio = { workspace = true }
```

- [ ] **Step 3: Create `crates/pdm-client/src/lib.rs` and module stubs.**

`crates/pdm-client/src/lib.rs`:

```rust
//! Typed HTTP client for the Helios Vault Supabase backend.
//!
//! Wraps the PostgREST + Storage + RPC surfaces defined by the migrations in
//! `infra/pdm-supabase/`. All operations return strongly-typed results from
//! `pdm-core`. Auth is JWT-based; the client refreshes its session token
//! automatically on 401.

pub mod auth;
pub mod check_in;
pub mod client;
pub mod error;
pub mod files;
pub mod folders;
pub mod force_unlock;
pub mod locks;
pub mod storage;
pub mod vaults;
pub mod versions;

pub use client::{Client, ClientBuilder};
pub use error::ClientError;
```

Each module starts as a stub `// Filled in by Task NN.` Each one is expanded by a subsequent task, listed below.

- [ ] **Step 4: Build verifies skeleton.**

```bash
cargo build -p pdm-client
```

Comment out `pub use` lines in `lib.rs` until each module is filled in (same pattern as `pdm-core`).

- [ ] **Step 5: Commit.**

```bash
git add Cargo.toml crates/pdm-client
git commit -m "feat(pdm-client): scaffold crate"
```

---

### Task 12: `Client` struct + `ClientError`

**Files:**
- Modify: `crates/pdm-client/src/client.rs`
- Modify: `crates/pdm-client/src/error.rs`
- Modify: `crates/pdm-client/src/lib.rs` (uncomment `pub use`)
- Create: `crates/pdm-client/tests/request_shaping.rs`

- [ ] **Step 1: Write failing test.**

`crates/pdm-client/tests/request_shaping.rs`:

```rust
use pdm_client::{Client, ClientBuilder};

#[test]
fn builder_requires_url_and_anon_key() {
    let r = ClientBuilder::new()
        .url("https://example.supabase.co")
        .anon_key("anon-k")
        .build();
    assert!(r.is_ok());
}

#[test]
fn builder_rejects_missing_url() {
    let r = ClientBuilder::new().anon_key("anon-k").build();
    assert!(r.is_err());
}

#[test]
fn builder_rejects_missing_anon_key() {
    let r = ClientBuilder::new().url("https://example.supabase.co").build();
    assert!(r.is_err());
}

#[test]
fn rest_url_for_table_is_correctly_constructed() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co")
        .anon_key("k")
        .build()
        .unwrap();
    let u = c.rest_url("vaults");
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/vaults");
}

#[test]
fn rpc_url_is_correctly_constructed() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co/")
        .anon_key("k")
        .build()
        .unwrap();
    let u = c.rpc_url("pdm_check_in");
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/rpc/pdm_check_in");
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `error.rs`.**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("config: {0}")]
    Config(String),
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("invalid URL: {0}")]
    Url(#[from] url::ParseError),
    #[error("authentication required")]
    Unauthenticated,
    #[error("forbidden (RLS rejected): {0}")]
    Forbidden(String),
    #[error("server returned {status}: {body}")]
    Server { status: u16, body: String },
    #[error("decode response: {0}")]
    Decode(#[from] serde_json::Error),
}
```

- [ ] **Step 4: Write `client.rs`.**

```rust
use crate::error::ClientError;
use reqwest::Client as Http;
use std::sync::{Arc, Mutex};
use url::Url;

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    base: Url,
    anon_key: String,
    http: Http,
    session: Mutex<Option<Session>>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: uuid::Uuid,
}

impl Client {
    pub fn rest_url(&self, table: &str) -> Url {
        self.inner.base.join(&format!("rest/v1/{}", table)).expect("valid table name")
    }

    pub fn rpc_url(&self, name: &str) -> Url {
        self.inner.base.join(&format!("rest/v1/rpc/{}", name)).expect("valid rpc name")
    }

    pub fn anon_key(&self) -> &str {
        &self.inner.anon_key
    }

    pub fn http(&self) -> &Http {
        &self.inner.http
    }

    pub fn session(&self) -> Option<Session> {
        self.inner.session.lock().expect("poisoned").clone()
    }

    pub(crate) fn set_session(&self, s: Option<Session>) {
        *self.inner.session.lock().expect("poisoned") = s;
    }
}

#[derive(Default)]
pub struct ClientBuilder {
    url: Option<String>,
    anon_key: Option<String>,
}

impl ClientBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }

    pub fn anon_key(mut self, key: impl Into<String>) -> Self {
        self.anon_key = Some(key.into());
        self
    }

    pub fn build(self) -> Result<Client, ClientError> {
        let url = self.url.ok_or_else(|| ClientError::Config("url is required".into()))?;
        let anon_key = self.anon_key.ok_or_else(|| ClientError::Config("anon_key is required".into()))?;
        let mut base = Url::parse(&url)?;
        // Ensure base ends with '/' so .join() puts segments after it correctly.
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let http = Http::builder().build()?;
        Ok(Client {
            inner: Arc::new(Inner {
                base,
                anon_key,
                http,
                session: Mutex::new(None),
            }),
        })
    }
}
```

- [ ] **Step 5: Update `lib.rs`** — uncomment the `pub use` lines for `Client`, `ClientBuilder`, `ClientError`.

- [ ] **Step 6: Run.**

```bash
cargo test -p pdm-client --test request_shaping
```

Expected: 5 tests, all pass.

- [ ] **Step 7: Commit.**

```bash
git add crates/pdm-client/src/{client,error,lib}.rs crates/pdm-client/tests/request_shaping.rs
git commit -m "feat(pdm-client): Client + ClientBuilder + ClientError; URL construction tests"
```

---

### Task 13: Auth — sign in, refresh, sign out

**Files:**
- Modify: `crates/pdm-client/src/auth.rs`
- Create: `crates/pdm-client/tests/auth_request_shaping.rs`

- [ ] **Step 1: Write failing tests** for request *shaping* only (no network):

`crates/pdm-client/tests/auth_request_shaping.rs`:

```rust
use pdm_client::{Client, ClientBuilder};
use pdm_client::auth::{SignInRequest, build_sign_in_body, build_sign_in_url};

#[test]
fn sign_in_url_is_under_auth_v1_token_grant_type_password() {
    let c = ClientBuilder::new()
        .url("https://example.supabase.co")
        .anon_key("anon")
        .build()
        .unwrap();
    let u = build_sign_in_url(&c);
    assert_eq!(
        u.as_str(),
        "https://example.supabase.co/auth/v1/token?grant_type=password"
    );
}

#[test]
fn sign_in_body_serializes_to_email_and_password() {
    let body = build_sign_in_body(&SignInRequest {
        email: "me@example.com".into(),
        password: "hunter2".into(),
    });
    assert_eq!(body["email"], "me@example.com");
    assert_eq!(body["password"], "hunter2");
}
```

- [ ] **Step 2: Run, confirm failure** (modules don't exist).

- [ ] **Step 3: Write `auth.rs`.**

```rust
use crate::client::{Client, Session};
use crate::error::ClientError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct SignInRequest {
    pub email: String,
    pub password: String,
}

pub fn build_sign_in_url(c: &Client) -> Url {
    let mut u = c.rest_url("");
    u.set_path("auth/v1/token");
    u.set_query(Some("grant_type=password"));
    u
}

pub fn build_sign_in_body(req: &SignInRequest) -> Value {
    serde_json::json!({ "email": req.email, "password": req.password })
}

#[derive(Debug, Deserialize)]
struct GoTrueResponse {
    access_token: String,
    refresh_token: String,
    user: GoTrueUser,
}

#[derive(Debug, Deserialize)]
struct GoTrueUser {
    id: uuid::Uuid,
}

impl Client {
    pub async fn sign_in(&self, req: SignInRequest) -> Result<Session, ClientError> {
        let url = build_sign_in_url(self);
        let body = build_sign_in_body(&req);
        let res = self
            .http()
            .post(url)
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(ClientError::Server { status, body });
        }
        let parsed: GoTrueResponse = res.json().await?;
        let s = Session {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            user_id: parsed.user.id,
        };
        self.set_session(Some(s.clone()));
        Ok(s)
    }

    pub async fn sign_out(&self) -> Result<(), ClientError> {
        // Best-effort: server has a /logout endpoint that revokes refresh tokens,
        // but for client purposes clearing the local session is sufficient.
        self.set_session(None);
        Ok(())
    }
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-client/src/auth.rs crates/pdm-client/tests/auth_request_shaping.rs
git commit -m "feat(pdm-client): sign_in / sign_out + GoTrue request shaping"
```

---

### Task 14: Domain reads — vaults, folders, files, versions

**Files:**
- Modify: `crates/pdm-client/src/{vaults,folders,files,versions}.rs`
- Create: `crates/pdm-client/tests/reads_request_shaping.rs`

- [ ] **Step 1: Write failing tests** verifying URLs and headers for each read endpoint.

```rust
use pdm_client::{Client, ClientBuilder};
use pdm_client::vaults::list_vaults_url;
use pdm_client::folders::list_folders_url;
use pdm_client::files::list_files_url;
use pdm_client::versions::list_versions_url;
use pdm_core::{FileId, FolderId, VaultId};

fn mkclient() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn list_vaults_hits_rest_v1_vaults() {
    let u = list_vaults_url(&mkclient());
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/vaults?select=*");
}

#[test]
fn list_folders_filters_by_vault_id() {
    let v = VaultId::new();
    let u = list_folders_url(&mkclient(), v);
    let s = u.as_str();
    assert!(s.starts_with("https://example.supabase.co/rest/v1/folders?"));
    assert!(s.contains("vault_id=eq."));
    assert!(s.contains(&v.to_string()));
    assert!(s.contains("select=*"));
}

#[test]
fn list_files_filters_by_folder_id() {
    let f = FolderId::new();
    let u = list_files_url(&mkclient(), f);
    let s = u.as_str();
    assert!(s.contains("folder_id=eq."));
    assert!(s.contains(&f.to_string()));
}

#[test]
fn list_versions_filters_by_file_id_and_orders_desc() {
    let f = FileId::new();
    let u = list_versions_url(&mkclient(), f);
    let s = u.as_str();
    assert!(s.contains("file_id=eq."));
    assert!(s.contains(&f.to_string()));
    assert!(s.contains("order=version_num.desc"));
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write each module.**

`crates/pdm-client/src/vaults.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::Vault;
use url::Url;

pub fn list_vaults_url(c: &Client) -> Url {
    let mut u = c.rest_url("vaults");
    u.set_query(Some("select=*"));
    u
}

impl Client {
    pub async fn list_vaults(&self) -> Result<Vec<Vault>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_vaults_url(self))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

`crates/pdm-client/src/folders.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{Folder, VaultId};
use url::Url;

pub fn list_folders_url(c: &Client, vault_id: VaultId) -> Url {
    let mut u = c.rest_url("folders");
    u.set_query(Some(&format!("vault_id=eq.{}&select=*", vault_id)));
    u
}

impl Client {
    pub async fn list_folders(&self, vault_id: VaultId) -> Result<Vec<Folder>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_folders_url(self, vault_id))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

`crates/pdm-client/src/files.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{File, FolderId};
use url::Url;

pub fn list_files_url(c: &Client, folder_id: FolderId) -> Url {
    let mut u = c.rest_url("files");
    u.set_query(Some(&format!("folder_id=eq.{}&select=*", folder_id)));
    u
}

impl Client {
    pub async fn list_files(&self, folder_id: FolderId) -> Result<Vec<File>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_files_url(self, folder_id))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

`crates/pdm-client/src/versions.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{FileId, Version};
use url::Url;

pub fn list_versions_url(c: &Client, file_id: FileId) -> Url {
    let mut u = c.rest_url("versions");
    u.set_query(Some(&format!("file_id=eq.{}&select=*&order=version_num.desc", file_id)));
    u
}

impl Client {
    pub async fn list_versions(&self, file_id: FileId) -> Result<Vec<Version>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_versions_url(self, file_id))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

- [ ] **Step 4: Run.**

```bash
cargo test -p pdm-client
```

Expected: all request-shaping tests pass.

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-client/src/{vaults,folders,files,versions}.rs \
        crates/pdm-client/tests/reads_request_shaping.rs
git commit -m "feat(pdm-client): list_vaults / list_folders / list_files / list_versions"
```

---

### Task 15: Lock operations — acquire / release / list active

**Files:**
- Modify: `crates/pdm-client/src/locks.rs`
- Create: `crates/pdm-client/tests/locks_request_shaping.rs`

- [ ] **Step 1: Write failing test.**

```rust
use pdm_client::{Client, ClientBuilder};
use pdm_client::locks::{
    acquire_lock_url, list_active_locks_url, release_lock_url,
    build_acquire_lock_body,
};
use pdm_core::{FileId, LockId, UserId};

fn c() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn acquire_lock_posts_to_locks_table() {
    let u = acquire_lock_url(&c());
    assert_eq!(u.as_str(), "https://example.supabase.co/rest/v1/locks");
}

#[test]
fn acquire_lock_body_has_file_id_and_user_id() {
    let f = FileId::new();
    let u = UserId::new();
    let body = build_acquire_lock_body(f, u);
    assert_eq!(body["file_id"], serde_json::json!(f));
    assert_eq!(body["user_id"], serde_json::json!(u));
}

#[test]
fn release_lock_url_filters_by_lock_id() {
    let l = LockId::new();
    let url = release_lock_url(&c(), l);
    let s = url.as_str();
    assert!(s.starts_with("https://example.supabase.co/rest/v1/locks?"));
    assert!(s.contains("id=eq."));
    assert!(s.contains(&l.to_string()));
}

#[test]
fn list_active_locks_filters_by_released_at_is_null() {
    let url = list_active_locks_url(&c());
    let s = url.as_str();
    assert!(s.contains("released_at=is.null"));
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `locks.rs`.**

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{FileId, Lock, LockId, UserId};
use serde_json::{json, Value};
use url::Url;

pub fn acquire_lock_url(c: &Client) -> Url {
    c.rest_url("locks")
}

pub fn build_acquire_lock_body(file_id: FileId, user_id: UserId) -> Value {
    json!({ "file_id": file_id, "user_id": user_id })
}

pub fn release_lock_url(c: &Client, lock_id: LockId) -> Url {
    let mut u = c.rest_url("locks");
    u.set_query(Some(&format!("id=eq.{}", lock_id)));
    u
}

pub fn list_active_locks_url(c: &Client) -> Url {
    let mut u = c.rest_url("locks");
    u.set_query(Some("select=*&released_at=is.null"));
    u
}

impl Client {
    pub async fn acquire_lock(&self, file_id: FileId) -> Result<Lock, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = build_acquire_lock_body(file_id, UserId::from(session.user_id));
        let res = self
            .http()
            .post(acquire_lock_url(self))
            .header("apikey", self.anon_key())
            .header("Prefer", "return=representation")
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        let mut locks: Vec<Lock> = res.json().await?;
        locks.pop().ok_or(ClientError::Server { status: 200, body: "expected exactly one lock".into() })
    }

    pub async fn release_lock(&self, lock_id: LockId) -> Result<(), ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = json!({ "released_at": chrono::Utc::now() });
        let res = self
            .http()
            .patch(release_lock_url(self, lock_id))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(())
    }

    pub async fn list_active_locks(&self) -> Result<Vec<Lock>, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .get(list_active_locks_url(self))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-client/src/locks.rs crates/pdm-client/tests/locks_request_shaping.rs
git commit -m "feat(pdm-client): acquire_lock / release_lock / list_active_locks"
```

---

### Task 16: RPC wrappers — `check_in`, `cancel_checkout`, `force_unlock`

**Files:**
- Modify: `crates/pdm-client/src/{check_in,cancel,force_unlock}.rs`
- Create: `crates/pdm-client/tests/rpc_request_shaping.rs`

- [ ] **Step 1: Write failing test.**

```rust
use pdm_client::{Client, ClientBuilder};
use pdm_client::check_in::{check_in_url, build_check_in_body};
use pdm_client::cancel::{cancel_checkout_url, build_cancel_body};
use pdm_client::force_unlock::{force_unlock_url, build_force_unlock_body};
use pdm_core::{FileId, LockId, Sha256};

fn c() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn check_in_url_is_rpc_pdm_check_in() {
    assert_eq!(
        check_in_url(&c()).as_str(),
        "https://example.supabase.co/rest/v1/rpc/pdm_check_in"
    );
}

#[test]
fn check_in_body_uses_p_prefixed_param_names() {
    let f = FileId::new();
    let s: Sha256 = "a".repeat(64).parse().unwrap();
    let body = build_check_in_body(f, &s, 1234, Some("first cut"));
    assert_eq!(body["p_file_id"], serde_json::json!(f));
    assert_eq!(body["p_sha256"], serde_json::json!(s));
    assert_eq!(body["p_size"], 1234);
    assert_eq!(body["p_comment"], "first cut");
}

#[test]
fn check_in_body_passes_null_for_missing_comment() {
    let f = FileId::new();
    let s: Sha256 = "a".repeat(64).parse().unwrap();
    let body = build_check_in_body(f, &s, 1, None);
    assert!(body["p_comment"].is_null());
}

#[test]
fn cancel_checkout_url_and_body() {
    let f = FileId::new();
    assert_eq!(
        cancel_checkout_url(&c()).as_str(),
        "https://example.supabase.co/rest/v1/rpc/pdm_cancel_checkout"
    );
    let body = build_cancel_body(f);
    assert_eq!(body["p_file_id"], serde_json::json!(f));
}

#[test]
fn force_unlock_url_and_body() {
    let l = LockId::new();
    assert_eq!(
        force_unlock_url(&c()).as_str(),
        "https://example.supabase.co/rest/v1/rpc/pdm_force_unlock"
    );
    let body = build_force_unlock_body(l, "left for the day");
    assert_eq!(body["p_lock_id"], serde_json::json!(l));
    assert_eq!(body["p_reason"], "left for the day");
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write each module.**

`crates/pdm-client/src/check_in.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::{FileId, Sha256, Version};
use serde_json::{json, Value};
use url::Url;

pub fn check_in_url(c: &Client) -> Url {
    c.rpc_url("pdm_check_in")
}

pub fn build_check_in_body(file_id: FileId, sha256: &Sha256, size: u64, comment: Option<&str>) -> Value {
    json!({
        "p_file_id": file_id,
        "p_sha256": sha256,
        "p_size": size,
        "p_comment": comment,
    })
}

impl Client {
    pub async fn check_in(
        &self,
        file_id: FileId,
        sha256: &Sha256,
        size: u64,
        comment: Option<&str>,
    ) -> Result<Version, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = build_check_in_body(file_id, sha256, size, comment);
        let res = self
            .http()
            .post(check_in_url(self))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

`crates/pdm-client/src/cancel.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::FileId;
use serde_json::{json, Value};
use url::Url;

pub fn cancel_checkout_url(c: &Client) -> Url {
    c.rpc_url("pdm_cancel_checkout")
}

pub fn build_cancel_body(file_id: FileId) -> Value {
    json!({ "p_file_id": file_id })
}

impl Client {
    pub async fn cancel_checkout(&self, file_id: FileId) -> Result<(), ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .post(cancel_checkout_url(self))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&build_cancel_body(file_id))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(())
    }
}
```

`crates/pdm-client/src/force_unlock.rs`:

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::LockId;
use serde_json::{json, Value};
use url::Url;

pub fn force_unlock_url(c: &Client) -> Url {
    c.rpc_url("pdm_force_unlock")
}

pub fn build_force_unlock_body(lock_id: LockId, reason: &str) -> Value {
    json!({ "p_lock_id": lock_id, "p_reason": reason })
}

impl Client {
    pub async fn force_unlock(&self, lock_id: LockId, reason: &str) -> Result<(), ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .post(force_unlock_url(self))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&build_force_unlock_body(lock_id, reason))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-client/src/{check_in,cancel,force_unlock}.rs \
        crates/pdm-client/tests/rpc_request_shaping.rs
git commit -m "feat(pdm-client): pdm_check_in / pdm_cancel_checkout / pdm_force_unlock RPC wrappers"
```

---

### Task 17: Storage signed URL helpers

**Files:**
- Modify: `crates/pdm-client/src/storage.rs`
- Create: `crates/pdm-client/tests/storage_request_shaping.rs`

- [ ] **Step 1: Write failing test.**

```rust
use pdm_client::{Client, ClientBuilder};
use pdm_client::storage::{create_signed_upload_url_url, create_signed_download_url_url};
use pdm_core::Sha256;

fn c() -> Client {
    ClientBuilder::new().url("https://example.supabase.co").anon_key("k").build().unwrap()
}

#[test]
fn signed_upload_url_endpoint() {
    let s: Sha256 = "a".repeat(64).parse().unwrap();
    let u = create_signed_upload_url_url(&c(), &s);
    assert_eq!(
        u.as_str(),
        format!("https://example.supabase.co/storage/v1/object/upload/sign/vault-objects/{}", s.storage_path())
    );
}

#[test]
fn signed_download_url_endpoint() {
    let s: Sha256 = "b".repeat(64).parse().unwrap();
    let u = create_signed_download_url_url(&c(), &s);
    assert_eq!(
        u.as_str(),
        format!("https://example.supabase.co/storage/v1/object/sign/vault-objects/{}", s.storage_path())
    );
}
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `storage.rs`.**

```rust
use crate::client::Client;
use crate::error::ClientError;
use pdm_core::Sha256;
use serde::Deserialize;
use serde_json::json;
use url::Url;

pub const BUCKET: &str = "vault-objects";

pub fn create_signed_upload_url_url(c: &Client, sha: &Sha256) -> Url {
    let mut u = c.rest_url("");
    u.set_path(&format!("storage/v1/object/upload/sign/{}/{}", BUCKET, sha.storage_path()));
    u
}

pub fn create_signed_download_url_url(c: &Client, sha: &Sha256) -> Url {
    let mut u = c.rest_url("");
    u.set_path(&format!("storage/v1/object/sign/{}/{}", BUCKET, sha.storage_path()));
    u
}

#[derive(Debug, Deserialize)]
pub struct SignedUrl {
    pub url: String,
}

impl Client {
    pub async fn create_signed_upload_url(&self, sha: &Sha256) -> Result<SignedUrl, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let res = self
            .http()
            .post(create_signed_upload_url_url(self, sha))
            .header("apikey", self.anon_key())
            .bearer_auth(&session.access_token)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }

    pub async fn create_signed_download_url(&self, sha: &Sha256, expires_seconds: u64) -> Result<SignedUrl, ClientError> {
        let session = self.session().ok_or(ClientError::Unauthenticated)?;
        let body = json!({ "expiresIn": expires_seconds });
        let res = self
            .http()
            .post(create_signed_download_url_url(self, sha))
            .header("apikey", self.anon_key())
            .header("Content-Type", "application/json")
            .bearer_auth(&session.access_token)
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(ClientError::Server { status: res.status().as_u16(), body: res.text().await.unwrap_or_default() });
        }
        Ok(res.json().await?)
    }
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit.**

```bash
git add crates/pdm-client/src/storage.rs crates/pdm-client/tests/storage_request_shaping.rs
git commit -m "feat(pdm-client): create_signed_upload_url + create_signed_download_url for vault-objects"
```

---

### Task 18: Plan-completion review

- [ ] **Step 1: Run the full Rust test suite.**

```bash
cargo test --workspace
```

Expected: every test in `pdm-core`, `pdm-sw-parser`, `pdm-client`, plus the existing `helios-*` crates' tests, all pass. (No Docker is required for any of Plan 2's tests.)

- [ ] **Step 2: Run `cargo clippy --workspace -- -D warnings`** to surface any quality issues.

If clippy reports issues, fix them in place; commit each fix as `style(pdm-*): clippy nit — <description>`.

- [ ] **Step 3: Update the roadmap.**

In `docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`, change Plan 2's status from `not started` to:

`code complete @ <SHORT_SHA>`

Where `<SHORT_SHA>` is `git rev-parse --short HEAD`.

- [ ] **Step 4: Final commit.**

```bash
git add docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md
git commit -m "chore(roadmap): mark Plan 2 (shared Rust crates) complete"
```

- [ ] **Step 5: DO NOT push.** Per the roadmap, no remote pushes until Plan 4 lands at the earliest.

---

## What Plan 3 picks up

Plan 3 (`2026-05-07-helios-vault-3-shell.md`) consumes `pdm-client` from the Tauri side and introduces the suite-wide login. After Plan 3, the Helios desktop app reorganizes into `modules/logs/` (existing UI relocated) + `modules/vault/` (new, gated by `<RequireAuth>`), and a new `packages/auth/` provides the JS-side identity layer.
