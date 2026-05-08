# Helios Vault — Plan 5: `parse-refs` Edge Function

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `.sldasm` / `.sldprt` check-in automatically populates `pdm.refs` with parent → child reference rows. Run by a Supabase Edge Function (Deno) that loads `pdm-sw-parser` as WebAssembly. Includes a 6-hour retry cron for failed parses.

**Architecture:** A WASM build of `pdm-sw-parser` (using `wasm-bindgen` + `wasm-pack`) lives at `crates/pdm-sw-parser/pkg/` (gitignored — built on demand). A Deno function under `infra/pdm-supabase/supabase/functions/parse-refs/` imports the WASM, downloads the version's bytes from Storage on each invocation, parses references, inserts `pdm.refs` rows. Postgres trigger publishes a webhook to the function on `pdm.versions` insert. A Postgres cron retries any version whose ref-count is zero and whose age is between 1 and 7 days, every 6 hours.

**Tech Stack:** Rust → WASM (`wasm-bindgen`, `wasm-pack`), Deno (Supabase Edge runtime), Supabase Storage + Postgres functions.

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plans 1, 2.

---

## File Structure

### New files

```
crates/pdm-sw-parser/
  Cargo.toml                                ← gain wasm32 target + cdylib lib
  src/wasm.rs                               ← wasm-bindgen exports of parse_refs

infra/pdm-supabase/
  supabase/functions/parse-refs/
    index.ts                                ← Deno entry point
    deno.json
    pdm_sw_parser_bg.wasm                   ← built from crate; checked in (small)
    pdm_sw_parser.js                        ← wasm-bindgen JS shim (checked in)
  supabase/migrations/
    20260508000000_pdm_parse_refs_webhook.sql
    20260508000100_pdm_parse_refs_cron.sql
  scripts/
    build-parse-refs-wasm.sh                ← cargo + wasm-pack build pipeline
  tests/
    parse-refs.test.ts                      ← integration test against running edge function
```

### Modified files

```
crates/pdm-sw-parser/Cargo.toml             ← add [lib] crate-type=["cdylib","rlib"]; wasm-bindgen optional dep
infra/pdm-supabase/package.json             ← add scripts: deploy:parse-refs, build:wasm
infra/pdm-supabase/.gitignore               ← exclude crates/pdm-sw-parser/pkg/ except checked-in pkg files
```

---

## Conventions

- Edge function tests run only when Docker + Supabase CLI are available (Docker Desktop required to spin up the local edge runtime).
- WASM build script is shippable on macOS / Linux / WSL; Windows can run via WSL.
- Local commits only. No remote pushes during this plan.

---

## Task 0: Add WASM build target to `pdm-sw-parser`

**Files:**
- Modify: `crates/pdm-sw-parser/Cargo.toml`
- Create: `crates/pdm-sw-parser/src/wasm.rs`
- Modify: `crates/pdm-sw-parser/src/lib.rs` (gate the wasm module behind a feature flag)

- [ ] **Step 1: Modify Cargo.toml.**

```toml
[package]
name = "pdm-sw-parser"
version.workspace = true
edition.workspace = true
license.workspace = true

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
pdm-core = { path = "../pdm-core" }
serde = { workspace = true }
thiserror = { workspace = true }
cfb = { workspace = true }
wasm-bindgen = { version = "0.2", optional = true }
serde-wasm-bindgen = { version = "0.6", optional = true }

[dev-dependencies]
serde_json = { workspace = true }
cfb = { workspace = true }

[features]
default = []
wasm = ["dep:wasm-bindgen", "dep:serde-wasm-bindgen"]
```

- [ ] **Step 2: Add `wasm.rs` module** (only compiled with the `wasm` feature):

```rust
//! WASM-friendly entry point for the parse-refs edge function.
//! Built with `wasm-pack build --features wasm --target deno --out-dir pkg`.

use wasm_bindgen::prelude::*;
use crate::parse_refs as native_parse_refs;

#[wasm_bindgen]
pub fn parse_refs(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let hints = native_parse_refs(bytes);
    serde_wasm_bindgen::to_value(&hints).map_err(|e| JsValue::from_str(&e.to_string()))
}
```

- [ ] **Step 3: Update `lib.rs` to include the wasm module under the feature.**

Append to `crates/pdm-sw-parser/src/lib.rs`:

```rust
#[cfg(feature = "wasm")]
pub mod wasm;
```

- [ ] **Step 4: Verify `cargo build --features wasm` works** for the host target. (Cross-compile to `wasm32-unknown-unknown` is done in Task 1 via wasm-pack.)

```bash
cargo build -p pdm-sw-parser --features wasm
```

If the `cfb` crate doesn't support wasm32, expect a build failure here. Workaround: gate the cfb-using code paths to only compile under non-wasm targets, OR replace `cfb` with a wasm-friendly fork. (Spend at most 1 hour investigating — if blocked, escalate to the user with a clear summary; cfb 0.10 likely DOES support wasm32 because it's pure Rust without OS calls.)

- [ ] **Step 5: Commit.** `feat(pdm-sw-parser): add wasm feature with wasm-bindgen entry point`.

---

## Task 1: WASM build script

**Files:**
- Create: `infra/pdm-supabase/scripts/build-parse-refs-wasm.sh`
- Modify: `infra/pdm-supabase/package.json` (add `build:wasm` script)

- [ ] **Step 1: Write the script.**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Builds pdm-sw-parser as a Deno-compatible WASM module and copies the artifacts
# into the parse-refs edge function's directory.
#
# Prereqs: rustup target add wasm32-unknown-unknown; cargo install wasm-pack.

cd "$(dirname "$0")/.."
ROOT="$(pwd)/../.."

cd "$ROOT/crates/pdm-sw-parser"
wasm-pack build --features wasm --target deno --out-dir pkg

DEST="$ROOT/infra/pdm-supabase/supabase/functions/parse-refs"
mkdir -p "$DEST"
cp pkg/pdm_sw_parser_bg.wasm "$DEST/"
cp pkg/pdm_sw_parser.js "$DEST/"
cp pkg/pdm_sw_parser.d.ts "$DEST/" 2>/dev/null || true

echo "WASM built and copied to $DEST"
```

- [ ] **Step 2: `chmod +x infra/pdm-supabase/scripts/build-parse-refs-wasm.sh`.**

- [ ] **Step 3: Add `package.json` script.** In `infra/pdm-supabase/package.json` `scripts` block:

```json
"build:wasm": "bash scripts/build-parse-refs-wasm.sh"
```

- [ ] **Step 4: Run the build** (locally, requires `wasm-pack`). Verify outputs in `supabase/functions/parse-refs/`.

```bash
cd /Users/nmurray/Developer/helios/infra/pdm-supabase
pnpm build:wasm
ls supabase/functions/parse-refs/   # should show pdm_sw_parser_bg.wasm + .js
```

If `wasm-pack` is not installed, install it: `cargo install wasm-pack` (one-time, ~2 min compile).

- [ ] **Step 5: Commit.** `feat(pdm-supabase): build script for parse-refs WASM artifact`.

---

## Task 2: Deno edge function

**Files:**
- Create: `infra/pdm-supabase/supabase/functions/parse-refs/index.ts`
- Create: `infra/pdm-supabase/supabase/functions/parse-refs/deno.json`

- [ ] **Step 1: Write `index.ts`.**

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// @ts-expect-error — generated by wasm-pack, no type decls
import init, { parse_refs } from "./pdm_sw_parser.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

let wasmReady: Promise<void> | null = null;
async function ensureWasm() {
  if (!wasmReady) {
    const wasmBytes = await Deno.readFile(
      new URL("./pdm_sw_parser_bg.wasm", import.meta.url),
    );
    wasmReady = init(wasmBytes).then(() => undefined);
  }
  await wasmReady;
}

interface Payload {
  /** Either a single version_id (typical webhook) or an array (batch retry). */
  version_id?: string;
  version_ids?: string[];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body: Payload = await req.json();
  const ids = body.version_ids ?? (body.version_id ? [body.version_id] : []);
  if (ids.length === 0) return new Response("no version_id(s) supplied", { status: 400 });

  await ensureWasm();
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const results: Array<{ version_id: string; refs: number; error?: string }> = [];
  for (const versionId of ids) {
    try {
      const refs = await processVersion(versionId, supa);
      results.push({ version_id: versionId, refs });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supa.from("audit_log").insert({
        action: "parse_refs_failed",
        target_type: "version",
        target_id: versionId,
        payload: { error: msg },
      });
      results.push({ version_id: versionId, refs: 0, error: msg });
    }
  }
  return new Response(JSON.stringify(results), {
    headers: { "content-type": "application/json" },
  });
});

async function processVersion(versionId: string, supa: any): Promise<number> {
  const { data: ver, error: vErr } = await supa
    .from("versions").select("id,sha256,file_id").eq("id", versionId).single();
  if (vErr || !ver) throw new Error(`version not found: ${vErr?.message ?? "unknown"}`);

  const path = `${ver.sha256.slice(0, 2)}/${ver.sha256}`;
  const { data: file, error: dErr } = await supa.storage.from("vault-objects").download(path);
  if (dErr || !file) throw new Error(`storage download: ${dErr?.message}`);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const hints = parse_refs(bytes) as { path: string }[];
  if (hints.length === 0) return 0;

  const rows = hints.map((h) => ({
    parent_version_id: ver.id,
    child_path_hint: h.path,
    child_file_id: null,
  }));
  const { error: insErr } = await supa.from("refs").upsert(rows, {
    onConflict: "parent_version_id,child_path_hint",
  });
  if (insErr) throw new Error(`refs insert: ${insErr.message}`);

  // Post-pass: try to resolve child_file_id by basename match.
  for (const row of rows) {
    const basename = row.child_path_hint.split(/[\\\/]/).pop() ?? row.child_path_hint;
    const { data: matches } = await supa.from("files").select("id").eq("name", basename);
    if (matches?.length === 1) {
      await supa.from("refs").update({ child_file_id: matches[0].id })
        .eq("parent_version_id", row.parent_version_id)
        .eq("child_path_hint", row.child_path_hint);
    }
  }

  return hints.length;
}
```

- [ ] **Step 2: Write `deno.json`.**

```json
{
  "imports": {
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2.45.0"
  }
}
```

- [ ] **Step 3: Local serve test.**

```bash
cd /Users/nmurray/Developer/helios/infra/pdm-supabase
supabase functions serve parse-refs
```

In another terminal: `curl -X POST http://localhost:54321/functions/v1/parse-refs -H 'content-type: application/json' -d '{"version_id":"<some-real-version-id>"}'` — expect a JSON response with refs count.

(Requires Docker + a running local Supabase. Skip if Docker is unavailable; the function still deploys via `supabase functions deploy parse-refs` and runs in the cloud.)

- [ ] **Step 4: Commit.** `feat(pdm-supabase): parse-refs edge function (Deno + WASM pdm-sw-parser)`.

---

## Task 3: Postgres webhook → edge function

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260508000000_pdm_parse_refs_webhook.sql`

- [ ] **Step 1: Write the migration.**

```sql
-- Trigger function: invokes the parse-refs edge function asynchronously.
-- Uses pg_net (enabled by default in Supabase).
create or replace function pdm.trg_parse_refs_on_version_insert()
returns trigger
language plpgsql
security definer
as $$
declare
  v_url text;
  v_anon_key text;
begin
  -- Only fire for SolidWorks files.
  if (split_part(
       (select name from pdm.files where id = NEW.file_id),
       '.',
       array_length(string_to_array(
         (select name from pdm.files where id = NEW.file_id),
         '.'
       ), 1)
     ) not in ('sldasm', 'sldprt'))
  then
    return NEW;
  end if;

  v_url := current_setting('app.parse_refs_url', true);
  v_anon_key := current_setting('app.parse_refs_key', true);
  if v_url is null then
    -- Configuration not set in this environment; silently skip.
    -- (Local dev without configured edge function is a valid state.)
    return NEW;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || coalesce(v_anon_key, '')
    ),
    body := jsonb_build_object('version_id', NEW.id)::text
  );
  return NEW;
end;
$$;

create trigger versions_parse_refs_after_insert
  after insert on pdm.versions
  for each row execute function pdm.trg_parse_refs_on_version_insert();

-- The two settings above are configured per-environment via:
--   alter database postgres set app.parse_refs_url = 'https://<project>.functions.supabase.co/parse-refs';
--   alter database postgres set app.parse_refs_key = '<anon-or-service-role-key>';
-- (or via Supabase dashboard's "Database settings → Custom Postgres parameters" UI.)
```

- [ ] **Step 2: Apply locally** with `pnpm db:reset`. Verify the trigger exists. (Configure the settings only in the production / staging Supabase dashboards.)

- [ ] **Step 3: Commit.** `feat(pdm): trigger parse-refs edge function on version insert`.

---

## Task 4: Retry cron

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260508000100_pdm_parse_refs_cron.sql`

- [ ] **Step 1: Write the migration.**

```sql
-- Every 6 hours, find versions of SolidWorks files whose refs have not been
-- populated, ages 1-7 days, and re-trigger the edge function.
create extension if not exists pg_cron;

select cron.schedule(
  'pdm_parse_refs_retry',
  '0 */6 * * *', -- at the top of every 6th hour
  $$
    select pdm.trg_parse_refs_on_version_insert_retry();
  $$
);

create or replace function pdm.trg_parse_refs_on_version_insert_retry()
returns void
language plpgsql
security definer
as $$
declare
  v_url text := current_setting('app.parse_refs_url', true);
  v_key text := current_setting('app.parse_refs_key', true);
  v_ids uuid[];
begin
  if v_url is null then return; end if;

  select array_agg(v.id) into v_ids
  from pdm.versions v
    join pdm.files f on f.id = v.file_id
    left join pdm.refs r on r.parent_version_id = v.id
  where r.parent_version_id is null
    and (f.name like '%.sldasm' or f.name like '%.sldprt')
    and v.created_at between now() - interval '7 days' and now() - interval '1 day';

  if v_ids is null or array_length(v_ids, 1) = 0 then return; end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || coalesce(v_key, '')
    ),
    body := jsonb_build_object('version_ids', v_ids)::text
  );
end;
$$;
```

- [ ] **Step 2: Note** that `pg_cron` is auto-enabled in Supabase. Locally, the cron may not fire on the same schedule as production; that's fine.

- [ ] **Step 3: Commit.** `feat(pdm): pg_cron retry of parse-refs every 6 hours for unparsed SW versions`.

---

## Task 5: Plan-completion review

- [ ] **Step 1: `pnpm test` from `infra/pdm-supabase/`** — ensure existing integration tests still pass (Plan 1 tests).
- [ ] **Step 2: `cargo test --features wasm -p pdm-sw-parser`** — ensure host-target build still works under the new feature.
- [ ] **Step 3: Update roadmap.** Plan 5 → `code complete @ <SHA>; deploy + WASM build pending Docker + wasm-pack`.
- [ ] **Step 4: Commit.** `chore(roadmap): mark Plan 5 (parse-refs edge function) complete`.

---

## Production deployment (after Docker + Supabase project exist)

1. `cd infra/pdm-supabase && pnpm build:wasm` to build the WASM artifact.
2. `supabase login && supabase link --project-ref <ref>`.
3. `supabase functions deploy parse-refs`.
4. In the Supabase dashboard: set `app.parse_refs_url` to `https://<project>.functions.supabase.co/parse-refs` and `app.parse_refs_key` to the service-role key.
5. Verify by checking in a `.sldasm` file and watching `pdm.refs` populate.

---

## What's deferred

- **Reference resolution improvements.** Ambiguous matches (multiple files with the same basename across folders) are left unresolved in v1. A future plan could add path-prefix scoring.
- **Notifications on persistent parse failures.** The audit log records `parse_refs_failed` events; an admin-side UI surface for them is Plan 4b territory.
