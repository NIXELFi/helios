# Assembly References (Contains / Where-Used) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a SolidWorks file is checked in, extract its child references and record them in `pdm.refs` (version-pinned), then surface "Contains" (children) and "Where Used" (parents) in the desktop UI — the CAD-defining PDM capability currently scaffolded but dead.

**Architecture:** The existing (orphaned) Rust `pdm-sw-parser` crate parses `.sldasm`/`.sldprt`/`.slddrw` CFB containers into reference path hints. We expose it as a Tauri command `parse_sw_refs(path)` (client already has the bytes at check-in — no edge function needed). After a successful check-in, the client parses the file, then calls a new `SECURITY DEFINER` RPC `pdm_record_refs(parent_version_id, child_hints[])` that resolves each hint to a child file in the same vault (by basename) and inserts a ref pinned to that child's current latest version. Read side: plain client queries on the RLS-readable `pdm.refs` table power Contains/Where-Used panels.

**Tech Stack:** Rust (Tauri command + `pdm-sw-parser`), Postgres/Supabase (migration + plpgsql RPC), React/TypeScript (hooks + UI), vitest, cargo test.

---

## File Structure

- **Rust command:** `apps/desktop/src-tauri/src/commands/parse_refs.rs` (new) — wraps `pdm_sw_parser::parse_refs`. Registered in `commands/mod.rs` + `lib.rs`. Dep added in `src-tauri/Cargo.toml`.
- **SQL migration:** `infra/pdm-supabase/supabase/migrations/20260530120000_pdm_refs_record_rpc.sql` (new) — adds `pdm.refs.child_version_id`, the `pdm.record_refs` function, the `public.pdm_record_refs` proxy, and grants. Test: `infra/pdm-supabase/tests/rpc-record-refs.test.ts`.
- **Client write:** `apps/desktop/src/modules/vault/data/useRecordRefs.ts` (new) — parse + record after check-in. Wired into `components/RowActions.tsx` (`CheckInButton`). Test: `tests/vault/useRecordRefs.test.tsx`.
- **Client read:** `apps/desktop/src/modules/vault/data/useReferences.ts` (new) — `useContains(versionId)` + `useWhereUsed(fileId)`. Test: `tests/vault/useReferences.test.tsx`.
- **UI:** `apps/desktop/src/modules/vault/components/ReferencesPanel.tsx` (new), wired into `screens/FileDetailPanel.tsx`. Test: `tests/vault/ReferencesPanel.test.tsx`.

Resolution rule: a hint resolves to a child file iff exactly one file in the parent's vault has `lower(name) = lower(basename(hint))`. Zero or ambiguous → store the raw hint with `child_file_id = NULL` (shown as "unresolved"). Pin `child_version_id = child.latest_version_id` at record time (SW-PDM "referenced version").

---

## Task 1: Tauri `parse_sw_refs` command (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/commands/parse_refs.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:73-90` (invoke_handler)

- [ ] **Step 1: Add the dependency.** In `apps/desktop/src-tauri/Cargo.toml` under `[dependencies]`, after `cfd-core = ...`:

```toml
pdm-sw-parser = { path = "../../../crates/pdm-sw-parser" }
```

- [ ] **Step 2: Write the failing test + command.** Create `apps/desktop/src-tauri/src/commands/parse_refs.rs`:

```rust
//! Parse a SolidWorks file's child references (path hints) from disk.
//!
//! Wraps the `pdm-sw-parser` crate so the Vault client can extract assembly →
//! part / drawing → model references at check-in time, then persist them via
//! the `pdm_record_refs` RPC. Best-effort: unreadable / non-CFB files yield an
//! empty list rather than an error, so callers never block a check-in on a
//! parse miss. A read failure (path gone) IS surfaced so the caller can log it.

use std::fs;

/// Read `path` and return the referenced part/sub-assembly/model path hints
/// found inside (raw strings as they appear in the SW file — resolution to
/// vault files happens server-side in `pdm.record_refs`).
#[tauri::command]
pub fn parse_sw_refs(path: String) -> Result<Vec<String>, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(pdm_sw_parser::parse_refs(&bytes)
        .into_iter()
        .map(|r| r.path)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_cfb_with_refs(payload: &[u8]) -> String {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut comp = cfb::CompoundFile::create(cursor).unwrap();
            comp.create_stream("External References").unwrap().write_all(payload).unwrap();
            comp.flush().unwrap();
        }
        let mut p = std::env::temp_dir();
        p.push(format!("helios_refs_test_{}.sldasm", std::process::id()));
        fs::write(&p, &buf).unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn returns_ref_path_hints_from_a_sw_file() {
        let mut payload: Vec<u8> = Vec::new();
        payload.extend_from_slice(b"\x00\x00..\\parts\\frame-rail.sldprt\x00");
        payload.extend_from_slice(b"junk\xff\xff..\\hardware\\m6-bolt.sldprt\x00");
        let path = write_cfb_with_refs(&payload);

        let refs = parse_sw_refs(path.clone()).unwrap();
        assert!(refs.iter().any(|p| p.ends_with("frame-rail.sldprt")));
        assert!(refs.iter().any(|p| p.ends_with("m6-bolt.sldprt")));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn errors_on_missing_path() {
        assert!(parse_sw_refs("/nope/missing.sldasm".to_string()).is_err());
    }
}
```

This requires `cfb` as a dev-dependency of the desktop crate. Add to `apps/desktop/src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
cfb = { workspace = true }
```

- [ ] **Step 3: Register the module.** In `apps/desktop/src-tauri/src/commands/mod.rs` add:

```rust
pub mod parse_refs;
```

- [ ] **Step 4: Register the command.** In `apps/desktop/src-tauri/src/lib.rs` invoke_handler list (after `commands::set_readonly::set_path_readonly,`):

```rust
            commands::parse_refs::parse_sw_refs,
```

- [ ] **Step 5: Run the Rust tests.**

Run (from repo root, with cargo on PATH — `export PATH="$HOME/.cargo/bin:$PATH"`):
`cargo test -p helios-desktop parse_sw_refs`
Expected: 2 tests pass. (`returns_ref_path_hints_from_a_sw_file`, `errors_on_missing_path`.)

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/commands/parse_refs.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(vault): parse_sw_refs Tauri command (wraps pdm-sw-parser)"
```

---

## Task 2: `pdm_record_refs` RPC + `child_version_id` (SQL)

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260530120000_pdm_refs_record_rpc.sql`
- Create: `infra/pdm-supabase/tests/rpc-record-refs.test.ts`

- [ ] **Step 1: Write the migration.** Create `infra/pdm-supabase/supabase/migrations/20260530120000_pdm_refs_record_rpc.sql`:

```sql
-- Assembly references: let a check-in record its child references.
-- pdm.refs already exists (parent_version_id, child_path_hint, child_file_id);
-- add version pinning, then a SECURITY DEFINER RPC the client calls after a
-- successful check_in. Clients still cannot write pdm.refs directly (RLS).

alter table pdm.refs
  add column if not exists child_version_id uuid references pdm.versions(id) on delete set null;

-- Record (replace) the references for a parent version the caller just authored.
-- Each hint is resolved to a file in the SAME vault by basename (case-insensitive);
-- a UNIQUE basename match pins child_file_id + child_version_id (the child's
-- current latest version). Zero / ambiguous matches keep the raw hint with NULL
-- child ids ("unresolved"). Returns the number of ref rows written.
create or replace function pdm.record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language plpgsql
security definer
set search_path = pdm, public
as $$
declare
  v_caller uuid := auth.uid();
  v_vault_id uuid;
  v_hint text;
  v_base text;
  v_child_file uuid;
  v_child_ver uuid;
  v_match_count int;
  v_written int := 0;
begin
  if v_caller is null then
    raise exception 'authentication required';
  end if;

  -- Only the author of the parent version may record its references (the
  -- version was just created by this caller's check_in / add_and_lock).
  select f.vault_id into v_vault_id
  from pdm.versions v
  join pdm.files f on f.id = v.file_id
  where v.id = p_parent_version_id and v.author_id = v_caller;

  if v_vault_id is null then
    raise exception 'not authorized to record refs for version % (not author or not found)', p_parent_version_id;
  end if;

  -- Idempotent: clear any prior refs for this parent version, then re-insert.
  delete from pdm.refs where parent_version_id = p_parent_version_id;

  foreach v_hint in array coalesce(p_child_hints, array[]::text[]) loop
    -- basename: last segment after '/' or '\'.
    v_base := regexp_replace(v_hint, '^.*[\\/]', '');
    if v_base is null or length(trim(v_base)) = 0 then
      continue;
    end if;

    select count(*) into v_match_count
    from pdm.files
    where vault_id = v_vault_id and lower(name) = lower(v_base);

    v_child_file := null;
    v_child_ver := null;
    if v_match_count = 1 then
      select id, latest_version_id into v_child_file, v_child_ver
      from pdm.files
      where vault_id = v_vault_id and lower(name) = lower(v_base);
    end if;

    -- PK is (parent_version_id, child_path_hint); a SW file can list the same
    -- hint once, but guard against dupes in the input array.
    insert into pdm.refs (parent_version_id, child_path_hint, child_file_id, child_version_id)
    values (p_parent_version_id, v_hint, v_child_file, v_child_ver)
    on conflict (parent_version_id, child_path_hint) do update
      set child_file_id = excluded.child_file_id,
          child_version_id = excluded.child_version_id;
    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

-- Public-schema proxy so PostgREST exposes it as rpc/pdm_record_refs.
create or replace function public.pdm_record_refs(
  p_parent_version_id uuid,
  p_child_hints text[]
) returns int
language sql
security definer
set search_path = pdm, public
as $$ select pdm.record_refs(p_parent_version_id, p_child_hints); $$;

revoke all on function public.pdm_record_refs(uuid, text[]) from public, anon;
grant execute on function public.pdm_record_refs(uuid, text[]) to authenticated;
revoke all on function pdm.record_refs(uuid, text[]) from public, anon;
grant execute on function pdm.record_refs(uuid, text[]) to authenticated;
```

- [ ] **Step 2: Write the failing integration test.** Create `infra/pdm-supabase/tests/rpc-record-refs.test.ts` (follow the harness in `rpc-check-in.test.ts` — `beforeEach` calls `pdm.test_reset()`, helpers create a user/vault/file/version + acquire lock). Core assertions:

```ts
// (Pseudocode skeleton — adapt to the exact helpers in rpc-check-in.test.ts)
it("records a resolved child ref pinned to the child's latest version", async () => {
  // Arrange: vault V; child file "frame-rail.sldprt" checked in (=> latest version cv);
  //          parent file "asm.sldasm" checked in by the same user (=> version pv).
  // Act:
  const { data, error } = await asUser.rpc("pdm_record_refs", {
    p_parent_version_id: pv,
    p_child_hints: ["..\\parts\\frame-rail.sldprt"],
  });
  expect(error).toBeNull();
  expect(data).toBe(1);
  // Assert: a refs row with child_file_id = childFileId and child_version_id = cv.
  const { data: rows } = await service.from("refs").select("*").eq("parent_version_id", pv);
  expect(rows).toHaveLength(1);
  expect(rows[0].child_file_id).toBe(childFileId);
  expect(rows[0].child_version_id).toBe(cv);
});

it("keeps an unresolved hint (no matching file) with NULL child ids", async () => {
  const { data } = await asUser.rpc("pdm_record_refs", {
    p_parent_version_id: pv,
    p_child_hints: ["..\\parts\\does-not-exist.sldprt"],
  });
  expect(data).toBe(1);
  const { data: rows } = await service.from("refs").select("*").eq("parent_version_id", pv);
  expect(rows[0].child_file_id).toBeNull();
});

it("rejects recording refs for a version the caller did not author", async () => {
  const { error } = await otherUser.rpc("pdm_record_refs", { p_parent_version_id: pv, p_child_hints: [] });
  expect(error).not.toBeNull();
});

it("is idempotent — re-recording replaces, does not duplicate", async () => {
  await asUser.rpc("pdm_record_refs", { p_parent_version_id: pv, p_child_hints: ["a.sldprt"] });
  await asUser.rpc("pdm_record_refs", { p_parent_version_id: pv, p_child_hints: ["a.sldprt", "b.sldprt"] });
  const { data: rows } = await service.from("refs").select("*").eq("parent_version_id", pv);
  expect(rows).toHaveLength(2);
});
```

- [ ] **Step 3: Reset the DB + run the test.**

Run (from `infra/pdm-supabase`, local Supabase up via `pnpm db:start`):
`pnpm db:reset && pnpm test:run -- rpc-record-refs`
Expected: all assertions pass.

- [ ] **Step 4: Commit.**

```bash
git add infra/pdm-supabase/supabase/migrations/20260530120000_pdm_refs_record_rpc.sql infra/pdm-supabase/tests/rpc-record-refs.test.ts
git commit -m "feat(vault): pdm_record_refs RPC + child_version_id pinning"
```

---

## Task 3: Client write — `useRecordRefs` + wire into check-in

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useRecordRefs.ts`
- Create: `apps/desktop/tests/vault/useRecordRefs.test.tsx`
- Modify: `apps/desktop/src/modules/vault/components/RowActions.tsx` (`CheckInButton`)

- [ ] **Step 1: Write the failing test.** Create `apps/desktop/tests/vault/useRecordRefs.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useRecordRefs } from "../../src/modules/vault/data/useRecordRefs";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

let rpcArgs: { name: string; args: any } | null = null;
function mockClient(): SupabaseClient {
  return {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    rpc: (name: string, args: any) => { rpcArgs = { name, args }; return Promise.resolve({ data: 1, error: null }); },
  } as any;
}
const wrap = ({ children }: { children: ReactNode }) => <SupabaseAuthProvider client={mockClient()}>{children}</SupabaseAuthProvider>;

describe("useRecordRefs", () => {
  beforeEach(() => { rpcArgs = null; invokeMock.mockReset(); });

  it("parses a SW file then records the hints via pdm_record_refs", async () => {
    invokeMock.mockResolvedValue(["..\\parts\\frame.sldprt"]);
    const { result } = renderHook(() => useRecordRefs(), { wrapper: wrap });
    await result.current.run("ver-1", "/v/asm.sldasm", "asm.sldasm");
    expect(invokeMock).toHaveBeenCalledWith("parse_sw_refs", { path: "/v/asm.sldasm" });
    expect(rpcArgs?.name).toBe("pdm_record_refs");
    expect(rpcArgs?.args).toEqual({ p_parent_version_id: "ver-1", p_child_hints: ["..\\parts\\frame.sldprt"] });
  });

  it("skips non-SolidWorks files entirely (no parse, no rpc)", async () => {
    const { result } = renderHook(() => useRecordRefs(), { wrapper: wrap });
    await result.current.run("ver-1", "/v/log.csv", "log.csv");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(rpcArgs).toBeNull();
  });

  it("is best-effort: a parse failure does not throw and does not call the rpc", async () => {
    invokeMock.mockRejectedValue(new Error("read fail"));
    const { result } = renderHook(() => useRecordRefs(), { wrapper: wrap });
    await expect(result.current.run("ver-1", "/v/asm.sldasm", "asm.sldasm")).resolves.toBeUndefined();
    expect(rpcArgs).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails** (module missing).
Run: `npx vitest run tests/vault/useRecordRefs.test.tsx`
Expected: FAIL — cannot find `useRecordRefs`.

- [ ] **Step 3: Implement the hook.** Create `apps/desktop/src/modules/vault/data/useRecordRefs.ts`:

```ts
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSupabaseClient } from "@helios/auth";
import type { VersionId } from "./types";

// File types that carry SolidWorks references worth parsing.
const SW_REF_EXTS = [".sldasm", ".slddrw", ".sldprt"];

function isSwFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SW_REF_EXTS.some((e) => lower.endsWith(e));
}

/**
 * After a successful check-in, parse the file's child references (via the
 * `parse_sw_refs` Tauri command) and persist them with `pdm_record_refs`.
 * Best-effort: references are auxiliary metadata, so any failure (parse miss,
 * RPC error) is swallowed — it must never fail the check-in the user just did.
 */
export function useRecordRefs() {
  const client = useSupabaseClient();
  const run = useCallback(
    async (parentVersionId: VersionId, localPath: string, fileName: string): Promise<void> => {
      if (!isSwFile(fileName)) return;
      try {
        const hints = await invoke<string[]>("parse_sw_refs", { path: localPath });
        await client.rpc("pdm_record_refs", {
          p_parent_version_id: parentVersionId,
          p_child_hints: hints ?? [],
        });
      } catch (e) {
        console.warn(`[vault] recording refs for ${fileName} failed (non-fatal):`, e);
      }
    },
    [client],
  );
  return { run };
}
```

- [ ] **Step 4: Run it — verify it passes.**
Run: `npx vitest run tests/vault/useRecordRefs.test.tsx`
Expected: 3 pass.

- [ ] **Step 5: Wire into `CheckInButton`.** In `apps/desktop/src/modules/vault/components/RowActions.tsx`:
  - Import: `import { useRecordRefs } from "../data/useRecordRefs";`
  - In `CheckInButton`, capture the source path. Change `readBytes` to also return the path, store it in a ref/state, and after a successful `checkIn.run` call `recordRefs.run(result.id, path, fileName ?? <derived>)`. Concretely, add near the top of `CheckInButton`:

```tsx
  const recordRefs = useRecordRefs();
  const pathRef = useRef<string | null>(null);
```
  In `readBytes`, set `pathRef.current = localFile.absolutePath` (local case) or `= path` (dialog case) before reading. In `submit`, after `if (result) {`:

```tsx
      // Record assembly references (best-effort, non-blocking on the result).
      const refName = localFile?.basename ?? fileName ?? "";
      if (pathRef.current && refName) void recordRefs.run(result.id, pathRef.current, refName);
```

- [ ] **Step 6: Run the full RowActions + check-in tests.**
Run: `npx vitest run tests/vault/RowActions.test.tsx tests/vault/useRecordRefs.test.tsx`
Expected: all pass (the existing RowActions tests must stay green — `recordRefs` is best-effort and the existing tests don't assert on it; ensure `@tauri-apps/api/core` is mocked or harmless in that file — add `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }))` to `RowActions.test.tsx` if it errors).

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/modules/vault/data/useRecordRefs.ts apps/desktop/tests/vault/useRecordRefs.test.tsx apps/desktop/src/modules/vault/components/RowActions.tsx
git commit -m "feat(vault): record assembly refs after check-in"
```

---

## Task 4: Client read — `useContains` + `useWhereUsed`

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useReferences.ts`
- Create: `apps/desktop/tests/vault/useReferences.test.tsx`

- [ ] **Step 1: Write the failing test.** Create `apps/desktop/tests/vault/useReferences.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useContains, useWhereUsed } from "../../src/modules/vault/data/useReferences";

// refs rows + files lookup. `in()` returns the matching files.
function mockClient(opts: { refs?: any[]; files?: any[]; versions?: any[] } = {}): SupabaseClient {
  const { refs = [], files = [], versions = [] } = opts;
  return {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, _v: string) => Promise.resolve({ data: table === "refs" ? refs : [], error: null }),
        in: (_c: string, ids: string[]) => Promise.resolve({
          data: (table === "files" ? files : versions).filter((r: any) => ids.includes(r.id)),
          error: null,
        }),
      }),
    }),
  } as any;
}
const wrap = (client: SupabaseClient) => ({ children }: { children: ReactNode }) =>
  <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;

describe("useContains", () => {
  it("lists child refs of a version, resolving file names", async () => {
    const refs = [{ parent_version_id: "pv", child_path_hint: "..\\frame.sldprt", child_file_id: "cf1", child_version_id: "cv1" }];
    const files = [{ id: "cf1", name: "frame.sldprt", folder_id: null, vault_id: "v1", latest_version_id: "cv1", created_at: "x" }];
    const { result } = renderHook(() => useContains("pv"), { wrapper: wrap(mockClient({ refs, files })) });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].childName).toBe("frame.sldprt");
    expect(result.current.data?.[0].resolved).toBe(true);
  });

  it("marks an unresolved hint", async () => {
    const refs = [{ parent_version_id: "pv", child_path_hint: "..\\ghost.sldprt", child_file_id: null, child_version_id: null }];
    const { result } = renderHook(() => useContains("pv"), { wrapper: wrap(mockClient({ refs })) });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].resolved).toBe(false);
    expect(result.current.data?.[0].childName).toMatch(/ghost\.sldprt/);
  });
});

describe("useWhereUsed", () => {
  it("lists parent files that reference a file", async () => {
    const refs = [{ parent_version_id: "pv1", child_path_hint: "x", child_file_id: "cf1", child_version_id: "cv1" }];
    const versions = [{ id: "pv1", file_id: "pf1", version_num: 2, sha256: "s", size_bytes: 1, author_id: null, comment: null, parent_version_id: null, created_at: "x" }];
    const files = [{ id: "pf1", name: "asm.sldasm", folder_id: null, vault_id: "v1", latest_version_id: "pv1", created_at: "x" }];
    const { result } = renderHook(() => useWhereUsed("cf1"), { wrapper: wrap(mockClient({ refs, versions, files })) });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(result.current.data?.[0].parentName).toBe("asm.sldasm");
  });
});
```

- [ ] **Step 2: Run it — verify it fails** (module missing).
Run: `npx vitest run tests/vault/useReferences.test.tsx`
Expected: FAIL — cannot find `useReferences`.

- [ ] **Step 3: Implement.** Create `apps/desktop/src/modules/vault/data/useReferences.ts`:

```ts
import { useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, VersionId } from "./types";

export interface ContainsRow {
  childPathHint: string;
  childFileId: FileId | null;
  childVersionId: VersionId | null;
  childName: string;   // resolved file name, or the hint's basename when unresolved
  resolved: boolean;
}
export interface WhereUsedRow {
  parentFileId: FileId;
  parentVersionId: VersionId;
  parentName: string;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Children referenced BY a parent version ("Contains"). */
export function useContains(versionId: VersionId | null) {
  const client = useSupabaseClient();
  const [data, setData] = useState<ContainsRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!versionId) { setData(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      const { data: refs, error: e1 } = await (client.from("refs") as any)
        .select("child_path_hint,child_file_id,child_version_id").eq("parent_version_id", versionId);
      if (!alive) return;
      if (e1) { setError(e1); setData(null); setLoading(false); return; }
      const fileIds = (refs ?? []).map((r: any) => r.child_file_id).filter(Boolean);
      let names = new Map<string, string>();
      if (fileIds.length) {
        const { data: files } = await (client.from("files") as any).select("id,name").in("id", fileIds);
        for (const f of files ?? []) names.set(f.id, f.name);
      }
      if (!alive) return;
      setData((refs ?? []).map((r: any): ContainsRow => ({
        childPathHint: r.child_path_hint,
        childFileId: r.child_file_id,
        childVersionId: r.child_version_id,
        childName: r.child_file_id ? (names.get(r.child_file_id) ?? basename(r.child_path_hint)) : basename(r.child_path_hint),
        resolved: !!r.child_file_id,
      })));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [client, versionId]);
  return { data, loading, error };
}

/** Parents that reference a given file ("Where Used"). */
export function useWhereUsed(fileId: FileId | null) {
  const client = useSupabaseClient();
  const [data, setData] = useState<WhereUsedRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!fileId) { setData(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      const { data: refs, error: e1 } = await (client.from("refs") as any)
        .select("parent_version_id").eq("child_file_id", fileId);
      if (!alive) return;
      if (e1) { setError(e1); setData(null); setLoading(false); return; }
      const verIds = Array.from(new Set((refs ?? []).map((r: any) => r.parent_version_id)));
      if (!verIds.length) { setData([]); setLoading(false); return; }
      const { data: versions } = await (client.from("versions") as any).select("id,file_id").in("id", verIds);
      const fileIds = Array.from(new Set((versions ?? []).map((v: any) => v.file_id)));
      const { data: files } = await (client.from("files") as any).select("id,name").in("id", fileIds);
      if (!alive) return;
      const fileName = new Map<string, string>(); for (const f of files ?? []) fileName.set(f.id, f.name);
      setData((versions ?? []).map((v: any): WhereUsedRow => ({
        parentFileId: v.file_id, parentVersionId: v.id, parentName: fileName.get(v.file_id) ?? "(unknown)",
      })));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [client, fileId]);
  return { data, loading, error };
}
```

- [ ] **Step 4: Run it — verify it passes.**
Run: `npx vitest run tests/vault/useReferences.test.tsx`
Expected: 3 pass.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/vault/data/useReferences.ts apps/desktop/tests/vault/useReferences.test.tsx
git commit -m "feat(vault): useContains + useWhereUsed reference hooks"
```

---

## Task 5: UI — References panel in the file detail

**Files:**
- Create: `apps/desktop/src/modules/vault/components/ReferencesPanel.tsx`
- Create: `apps/desktop/tests/vault/ReferencesPanel.test.tsx`
- Modify: `apps/desktop/src/modules/vault/screens/FileDetailPanel.tsx` (render the panel under history)

- [ ] **Step 1: Write the failing test.** Create `apps/desktop/tests/vault/ReferencesPanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ReferencesPanel } from "../../src/modules/vault/components/ReferencesPanel";

vi.mock("../../src/modules/vault/data/useReferences", () => ({
  useContains: () => ({ data: [{ childPathHint: "..\\frame.sldprt", childFileId: "cf1", childVersionId: "cv1", childName: "frame.sldprt", resolved: true }], loading: false, error: null }),
  useWhereUsed: () => ({ data: [{ parentFileId: "pf1", parentVersionId: "pv1", parentName: "asm.sldasm" }], loading: false, error: null }),
}));

describe("<ReferencesPanel>", () => {
  it("shows Contains children and Where-Used parents", () => {
    render(<ReferencesPanel versionId={"pv" as any} fileId={"cf1" as any} />);
    expect(screen.getByText(/contains/i)).toBeInTheDocument();
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText(/where used/i)).toBeInTheDocument();
    expect(screen.getByText("asm.sldasm")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it — verify it fails.**
Run: `npx vitest run tests/vault/ReferencesPanel.test.tsx`
Expected: FAIL — cannot find `ReferencesPanel`.

- [ ] **Step 3: Implement.** Create `apps/desktop/src/modules/vault/components/ReferencesPanel.tsx`:

```tsx
import { useContains, useWhereUsed } from "../data/useReferences";
import type { FileId, VersionId } from "../data/types";

interface Props { versionId: VersionId | null; fileId: FileId | null; }

/** SW-PDM Contains / Where-Used for the selected file's latest version. */
export function ReferencesPanel({ versionId, fileId }: Props) {
  const contains = useContains(versionId);
  const whereUsed = useWhereUsed(fileId);
  return (
    <div className="border-t border-helios-line text-sm">
      <section className="p-3">
        <h4 className="mb-1 text-xs uppercase tracking-wider text-helios-dim">Contains</h4>
        {!contains.data || contains.data.length === 0 ? (
          <p className="text-helios-dim">No references.</p>
        ) : (
          <ul className="space-y-0.5">
            {contains.data.map((c) => (
              <li key={c.childPathHint} className={c.resolved ? "text-helios-text" : "text-helios-dim italic"}>
                {c.childName}{!c.resolved && " (unresolved)"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="p-3">
        <h4 className="mb-1 text-xs uppercase tracking-wider text-helios-dim">Where Used</h4>
        {!whereUsed.data || whereUsed.data.length === 0 ? (
          <p className="text-helios-dim">Not used by any assembly.</p>
        ) : (
          <ul className="space-y-0.5">
            {whereUsed.data.map((w) => <li key={w.parentVersionId} className="text-helios-text">{w.parentName}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run it — verify it passes.**
Run: `npx vitest run tests/vault/ReferencesPanel.test.tsx`
Expected: 1 pass.

- [ ] **Step 5: Wire into `FileDetailPanel`.** In `FileDetailLoader` (`screens/FileDetailPanel.tsx`), under the history `<div>`, render the panel using the selected file's latest version. The loader already has `data` (versions, newest-first) and `fileId`; the latest version is `data?.[0]?.id`. Add:

```tsx
import { ReferencesPanel } from "../components/ReferencesPanel";
// ...inside the returned <aside>, after the history <div>:
<ReferencesPanel versionId={data?.[0]?.id ?? null} fileId={fileId} />
```

- [ ] **Step 6: Run the desktop suite + typecheck.**
Run: `npx vitest run && npx tsc --noEmit`
Expected: all green, exit 0.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/modules/vault/components/ReferencesPanel.tsx apps/desktop/tests/vault/ReferencesPanel.test.tsx apps/desktop/src/modules/vault/screens/FileDetailPanel.tsx
git commit -m "feat(vault): Contains / Where-Used references panel"
```

---

## Follow-ups (out of scope here, note for later)

- **Initial add (`add_and_lock`) refs:** `useAddLocalFile` creates version 1 without recording refs. Wire `useRecordRefs` there too once check-in path is proven.
- **Import path refs:** `pdm.import_version` (service role, `author_id` NULL) doesn't record refs; a service-role variant of `record_refs` could backfill migrated assemblies.
- **Reference-aware get/checkout:** "open assembly → pull all referenced parts" (get traverses the ref tree). Builds on this data.
- **Re-resolution:** unresolved hints stay unresolved if the child is added later; a periodic/triggered re-resolve would link them.
```
