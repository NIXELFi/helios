# Helios Vault — Plan 4: Vault Module UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `<VaultHome>` placeholder with a real Vault module: a sub-navigation rail and four working screens — **Browse** (folder tree + file table), **History viewer** (per-file version list), **Who has what** (live list of active locks), and **File detail** (right-side panel that opens when a file is selected). Admin screens (Users, Vaults), Search, and Settings are deliberately out of scope here — they land in Plan 4b once Plan 5's `invite_user` edge function exists and there's a clearer UX direction.

**Architecture:** Add a `data/` directory of focused hooks that each wrap a single Supabase query (`useVaults`, `useFolders`, `useFiles`, `useVersions`, `useLocks`). Add a `screens/` directory with one component per route. Add a few atoms in `components/` (`LockBadge`, `FolderTree`, `FileTable`, `VersionList`). The `<VaultHome>` placeholder becomes a thin screen router driven by a sub-rail (`<NavRail>`). Every hook and screen is unit-testable with a mocked `SupabaseClient` — no Docker, no live Supabase needed during development.

**Tech Stack:** React 18, TypeScript, `@helios/auth` (already added in Plan 3), Tailwind, Vitest + jsdom + `@testing-library/react`.

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plan 3 (requires `<SupabaseAuthProvider>`, `useSupabaseClient`, and the existing `<VaultModule>` shell).

---

## File Structure

### New files

```
apps/desktop/src/modules/vault/
  data/
    types.ts               ← row-shape types (subset of pdm-core, JS-side)
    useVaults.ts           ← list_vaults
    useFolders.ts          ← list_folders, list_folder_tree
    useFiles.ts            ← list_files
    useVersions.ts         ← list_versions
    useLocks.ts            ← list_active_locks
  components/
    NavRail.tsx            ← Vault sub-nav: Browse / History / Who has what
    FolderTree.tsx         ← collapsible tree of folders
    FileTable.tsx          ← rows: name, latest version, lock-holder, lock-age
    LockBadge.tsx          ← visual badge: latest / out-of-date / locked-me / locked-other
    VersionList.tsx        ← chronological list of versions
  screens/
    BrowseScreen.tsx       ← left: tree, right: file table + detail panel
    HistoryScreen.tsx      ← per-file version history
    WhoHasWhatScreen.tsx   ← flat list of all active locks
    FileDetailPanel.tsx    ← shown when a file row is selected on Browse

apps/desktop/tests/vault/
  useVaults.test.ts
  useFolders.test.ts
  useFiles.test.ts
  useVersions.test.ts
  useLocks.test.ts
  NavRail.test.tsx
  FolderTree.test.tsx
  FileTable.test.tsx
  LockBadge.test.tsx
  VersionList.test.tsx
  BrowseScreen.test.tsx
  HistoryScreen.test.tsx
  WhoHasWhatScreen.test.tsx
  FileDetailPanel.test.tsx
```

### Modified files

```
apps/desktop/src/modules/vault/VaultHome.tsx     ← replaced: now a screen router that uses NavRail
apps/desktop/vitest.config.ts                     ← extend `test.include` to pick up tests/vault/**
```

### Files NOT touched

`apps/desktop/src/modules/vault/{index.tsx,LoginPane.tsx}`, `packages/auth/**`, `apps/desktop/src/{App,Shell,components,workspaces,lib}/**`. Logs UI, login flow, and existing tests are all preserved.

---

## Conventions used throughout

- **TDD per task.** Failing test → fail-confirm → impl → pass-confirm → commit.
- **Hook tests use a mock SupabaseClient.** Each test file sets up a client whose `.from(table).select(...)` chain returns a configurable promise. The hook under test sees that mock through `useSupabaseClient()`. No network. No Docker.
- **Each hook returns `{ data, loading, error, refetch }`** — a tiny common shape. No external query lib (TanStack Query, SWR) added; for this scale, hand-rolled `useEffect` + `useState` is fine and matches the rest of Helios.
- **Components are deliberately minimal Tailwind.** Visual polish is for a later pass; functional behavior is what we test.
- **No `git push`.** Local commits only. Per the roadmap, no remote pushes until Plan 4 lands at the earliest — and then only if Plans 5–7 are blocked. Default behavior: stay local.

---

## Task 0: Scaffold `data/` and shared types

**Files:**
- Create: `apps/desktop/src/modules/vault/data/types.ts`
- Modify: `apps/desktop/vitest.config.ts` (extend test include)

- [ ] **Step 1: Create `data/types.ts`** — JS-side mirrors of `pdm-core` types, kept here (rather than imported from a Rust crate) so the desktop app doesn't need to compile Rust to typecheck.

```ts
export type VaultId = string;
export type FolderId = string;
export type FileId = string;
export type VersionId = string;
export type LockId = string;
export type UserId = string;

export interface Vault {
  id: VaultId;
  name: string;
  created_at: string;
  created_by: UserId;
}

export interface Folder {
  id: FolderId;
  vault_id: VaultId;
  parent_id: FolderId | null;
  name: string;
  created_at: string;
}

export interface VaultFile {
  id: FileId;
  vault_id: VaultId;
  folder_id: FolderId | null;
  name: string;
  latest_version_id: VersionId | null;
  created_at: string;
}

export interface Version {
  id: VersionId;
  file_id: FileId;
  version_num: number;
  sha256: string;
  size_bytes: number;
  author_id: UserId;
  comment: string | null;
  parent_version_id: VersionId | null;
  created_at: string;
}

export interface Lock {
  id: LockId;
  file_id: FileId;
  user_id: UserId;
  acquired_at: string;
  released_at: string | null;
  force_released_by: UserId | null;
}

/** Common shape returned by every data hook. */
export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}
```

- [ ] **Step 2: Update `apps/desktop/vitest.config.ts`** — extend `test.include` to also pick up nested test directories. Current value:

```ts
include: ["tests/**/*.test.{ts,tsx}"],
```

That already matches `tests/vault/*.test.tsx` because `**/*` is recursive. No change needed.

(If for some reason the existing include glob is non-recursive, add an explicit entry: `"tests/**/*.test.{ts,tsx}", "tests/vault/**/*.test.{ts,tsx}"`. Verify by running `pnpm test` after creating the new directory in Task 1.)

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/modules/vault/data/types.ts
git commit -m "feat(desktop/vault): scaffold data/ types for Vault module hooks"
```

---

## Task 1: `useVaults` hook

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useVaults.ts`
- Create: `apps/desktop/tests/vault/useVaults.test.ts`

- [ ] **Step 1: Write failing test.**

```ts
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaults } from "../../src/modules/vault/data/useVaults";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(rows: any[], error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => ({
      select: () => Promise.resolve({ data: rows, error }),
    }),
  } as any;
}

function makeWrapper(client: SupabaseClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
  };
}

describe("useVaults", () => {
  it("returns vaults after the query resolves", async () => {
    const rows = [{ id: "v1", name: "sdm26", created_at: "2026-01-01", created_by: "u1" }];
    const { result } = renderHook(() => useVaults(), {
      wrapper: makeWrapper(mockClient(rows)),
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(rows);
    expect(result.current.error).toBeNull();
  });

  it("surfaces errors", async () => {
    const { result } = renderHook(() => useVaults(), {
      wrapper: makeWrapper(mockClient([], new Error("RLS blocked"))),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("RLS blocked");
  });
});
```

(Save with `.tsx` extension since it contains JSX. Rename to `useVaults.test.tsx`.)

- [ ] **Step 2: Run, confirm failure.**

```bash
cd /Users/nmurray/Developer/helios/apps/desktop
pnpm test useVaults.test.tsx
```

- [ ] **Step 3: Write `useVaults.ts`.**

```ts
import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { QueryResult, Vault } from "./types";

export function useVaults(): QueryResult<Vault[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Vault[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await (client.from("vaults") as any).select("*");
      if (!mounted) return;
      if (err) {
        setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
        setData(null);
      } else {
        setData(rows ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
```

- [ ] **Step 4: Run, expect 2 tests pass.**

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/vault/data/useVaults.ts \
        apps/desktop/tests/vault/useVaults.test.tsx
git commit -m "feat(desktop/vault): useVaults hook"
```

---

## Task 2: `useFolders` hook (filtered by vault)

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useFolders.ts`
- Create: `apps/desktop/tests/vault/useFolders.test.tsx`

- [ ] **Step 1: Write failing test.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useFolders } from "../../src/modules/vault/data/useFolders";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(filterAssertion: (col: string, val: any) => void, rows: any[]): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (_table: string) => ({
      select: () => ({
        eq: (col: string, val: any) => {
          filterAssertion(col, val);
          return Promise.resolve({ data: rows, error: null });
        },
      }),
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useFolders", () => {
  it("filters folders by vault_id", async () => {
    let observed: { col: string; val: any } | null = null;
    const c = mockClient((col, val) => { observed = { col, val }; }, [
      { id: "f1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "2026-01-01" },
    ]);
    const { result } = renderHook(() => useFolders("v1"), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(observed).toEqual({ col: "vault_id", val: "v1" });
    expect(result.current.data?.length).toBe(1);
  });

  it("returns null data while vault_id is undefined (no fetch)", () => {
    let called = false;
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => {
        called = true;
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      },
    } as any;
    const { result } = renderHook(() => useFolders(undefined), { wrapper: wrap(c) });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `useFolders.ts`.**

```ts
import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { Folder, QueryResult, VaultId } from "./types";

export function useFolders(vault_id: VaultId | undefined): QueryResult<Folder[]> {
  const client = useSupabaseClient();
  const [data, setData] = useState<Folder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!vault_id) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await (client.from("folders") as any)
        .select("*")
        .eq("vault_id", vault_id);
      if (!mounted) return;
      if (err) {
        setError(err instanceof Error ? err : new Error(String(err.message ?? err)));
        setData(null);
      } else {
        setData(rows ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [client, vault_id, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}
```

- [ ] **Step 4: Run, expect 2 tests pass.**

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/modules/vault/data/useFolders.ts \
        apps/desktop/tests/vault/useFolders.test.tsx
git commit -m "feat(desktop/vault): useFolders hook filtered by vault_id"
```

---

## Task 3: `useFiles` hook (filtered by folder)

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useFiles.ts`
- Create: `apps/desktop/tests/vault/useFiles.test.tsx`

Mirrors `useFolders` exactly except for the table name (`files`) and filter column (`folder_id`). Test should:

- Verify `from("files").select("*").eq("folder_id", folderId)` is the issued query.
- Verify the no-id-yet path: when `folder_id` is `undefined`, no fetch happens.
- Verify error surfacing.

Implementation pattern matches `useFolders`. Commit message: `feat(desktop/vault): useFiles hook filtered by folder_id`.

---

## Task 4: `useVersions` hook (filtered by file, ordered desc)

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useVersions.ts`
- Create: `apps/desktop/tests/vault/useVersions.test.tsx`

Same shape as `useFolders` / `useFiles`, but the query has an `.order("version_num", { ascending: false })` chain. Test:

```tsx
const c = {
  ...,
  from: () => ({
    select: () => ({
      eq: (col: string, val: any) => ({
        order: (col2: string, opts: { ascending: boolean }) => {
          observed = { eqCol: col, eqVal: val, orderCol: col2, ascending: opts.ascending };
          return Promise.resolve({ data: rows, error: null });
        },
      }),
    }),
  }),
} as any;
```

Then assert `observed.eqCol === "file_id"` and `observed.orderCol === "version_num"` and `observed.ascending === false`.

Implementation appends `.order("version_num", { ascending: false })` to the chain. Commit message: `feat(desktop/vault): useVersions hook filtered by file_id, ordered version_num desc`.

---

## Task 5: `useLocks` hook (active locks across the vault)

**Files:**
- Create: `apps/desktop/src/modules/vault/data/useLocks.ts`
- Create: `apps/desktop/tests/vault/useLocks.test.tsx`

The hook lists ALL currently-active locks (where `released_at IS NULL`). The Supabase client expresses this as `.is("released_at", null)`. Test:

```tsx
from: () => ({
  select: () => ({
    is: (col: string, val: any) => {
      observed = { col, val };
      return Promise.resolve({ data: rows, error: null });
    },
  }),
}),
```

Assert `observed === { col: "released_at", val: null }`.

Implementation:

```ts
const { data: rows, error: err } = await (client.from("locks") as any)
  .select("*")
  .is("released_at", null);
```

Commit message: `feat(desktop/vault): useLocks hook for active vault-wide locks`.

---

## Task 6: `LockBadge` atom

**Files:**
- Create: `apps/desktop/src/modules/vault/components/LockBadge.tsx`
- Create: `apps/desktop/tests/vault/LockBadge.test.tsx`

Visual badge with four states:
- `latest` — green dot, "Up to date"
- `out-of-date` — yellow arrow, "Out of date"
- `locked-by-me` — red lock with my color
- `locked-by-other` — red lock with other-user color, holder name in tooltip

- [ ] **Step 1: Test.**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LockBadge } from "../../src/modules/vault/components/LockBadge";

describe("<LockBadge>", () => {
  it("renders 'Up to date' when state is latest", () => {
    render(<LockBadge state="latest" />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });

  it("renders 'Locked by me' when state is locked-by-me", () => {
    render(<LockBadge state="locked-by-me" />);
    expect(screen.getByText(/locked by me/i)).toBeInTheDocument();
  });

  it("renders the holder name when state is locked-by-other", () => {
    render(<LockBadge state="locked-by-other" holderEmail="alice@x.com" />);
    expect(screen.getByText(/alice@x\.com/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implementation.**

```tsx
export type LockState = "latest" | "out-of-date" | "locked-by-me" | "locked-by-other";

export function LockBadge(props: { state: LockState; holderEmail?: string }) {
  const { state, holderEmail } = props;
  const color = {
    "latest": "bg-emerald-500/20 text-emerald-300 border-emerald-700",
    "out-of-date": "bg-yellow-500/20 text-yellow-300 border-yellow-700",
    "locked-by-me": "bg-red-500/30 text-red-200 border-red-700",
    "locked-by-other": "bg-red-500/20 text-red-300 border-red-700",
  }[state];
  const label = {
    "latest": "Up to date",
    "out-of-date": "Out of date",
    "locked-by-me": "Locked by me",
    "locked-by-other": holderEmail ? `Locked by ${holderEmail}` : "Locked by other",
  }[state];
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${color}`}>
      {label}
    </span>
  );
}
```

- [ ] **Step 3: Run, expect 3 tests pass.**

- [ ] **Step 4: Commit.** `feat(desktop/vault): LockBadge atom`.

---

## Task 7: `NavRail` — Vault sub-navigation

**Files:**
- Create: `apps/desktop/src/modules/vault/components/NavRail.tsx`
- Create: `apps/desktop/tests/vault/NavRail.test.tsx`

Same shape as the suite-level `<ModulePicker>` but for Vault sub-screens.

- [ ] **Step 1: Test.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavRail } from "../../src/modules/vault/components/NavRail";

describe("<NavRail>", () => {
  it("renders Browse / History / Who has what entries", () => {
    render(<NavRail active="browse" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /who has what/i })).toBeInTheDocument();
  });

  it("marks the active entry with aria-current", () => {
    render(<NavRail active="who" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /who has what/i })).toHaveAttribute("aria-current", "page");
  });

  it("calls onSelect on click", () => {
    const onSelect = vi.fn();
    render(<NavRail active="browse" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(onSelect).toHaveBeenCalledWith("history");
  });
});
```

- [ ] **Step 2: Implementation.**

```tsx
export type VaultScreenId = "browse" | "history" | "who";

const ENTRIES: { id: VaultScreenId; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "history", label: "History" },
  { id: "who", label: "Who has what" },
];

export function NavRail(props: { active: VaultScreenId; onSelect: (id: VaultScreenId) => void }) {
  const { active, onSelect } = props;
  return (
    <nav className="flex w-40 flex-col gap-1 border-r border-zinc-800 bg-zinc-950 p-2">
      {ENTRIES.map((e) => (
        <button
          key={e.id}
          type="button"
          aria-current={active === e.id ? "page" : undefined}
          onClick={() => onSelect(e.id)}
          className={
            "rounded px-3 py-2 text-left text-sm " +
            (active === e.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900")
          }
        >
          {e.label}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Run, expect 3 tests pass.**

- [ ] **Step 4: Commit.** `feat(desktop/vault): NavRail sub-navigation`.

---

## Task 8: `FolderTree` component

**Files:**
- Create: `apps/desktop/src/modules/vault/components/FolderTree.tsx`
- Create: `apps/desktop/tests/vault/FolderTree.test.tsx`

A collapsible tree that takes a flat list of `Folder` rows and renders a hierarchical view. Emits the selected folder id via `onSelect(folderId | null)` (where `null` means the vault root).

- [ ] **Step 1: Test.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FolderTree } from "../../src/modules/vault/components/FolderTree";
import type { Folder } from "../../src/modules/vault/data/types";

const folders: Folder[] = [
  { id: "f1", vault_id: "v", parent_id: null, name: "chassis", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", parent_id: "f1", name: "frame", created_at: "2026-01-01" },
  { id: "f3", vault_id: "v", parent_id: null, name: "powertrain", created_at: "2026-01-01" },
];

describe("<FolderTree>", () => {
  it("renders top-level folders", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /chassis/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /powertrain/i })).toBeInTheDocument();
  });

  it("does not render nested folders until parent is expanded", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /frame/i })).not.toBeInTheDocument();
  });

  it("expands children when parent is expanded", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByLabelText(/expand chassis/i));
    expect(screen.getByRole("button", { name: /frame/i })).toBeInTheDocument();
  });

  it("calls onSelect with the folder id when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<FolderTree folders={folders} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /chassis/i }));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });
});
```

- [ ] **Step 2: Implementation.**

```tsx
import { useState } from "react";
import type { Folder, FolderId } from "../data/types";

interface Props {
  folders: Folder[];
  selected: FolderId | null;
  onSelect: (id: FolderId | null) => void;
}

interface Node {
  folder: Folder;
  children: Node[];
}

function buildTree(folders: Folder[]): Node[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parent_id;
    const arr = byParent.get(key) ?? [];
    arr.push(f);
    byParent.set(key, arr);
  }
  function nodesFor(parentId: string | null): Node[] {
    return (byParent.get(parentId) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ folder: f, children: nodesFor(f.id) }));
  }
  return nodesFor(null);
}

export function FolderTree({ folders, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = buildTree(folders);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: Node, depth: number): React.ReactNode {
    const isExpanded = expanded.has(node.folder.id);
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.folder.id}>
        <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.folder.name}`}
              onClick={() => toggleExpanded(node.folder.id)}
              className="mr-1 w-4 text-xs text-zinc-500 hover:text-zinc-200"
            >
              {isExpanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="mr-1 inline-block w-4" />
          )}
          <button
            type="button"
            onClick={() => onSelect(node.folder.id)}
            aria-current={selected === node.folder.id ? "page" : undefined}
            className={
              "flex-1 truncate rounded px-2 py-0.5 text-left text-sm " +
              (selected === node.folder.id
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-300 hover:bg-zinc-900")
            }
          >
            {node.folder.name}
          </button>
        </div>
        {isExpanded ? node.children.map((c) => renderNode(c, depth + 1)) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 p-2">{tree.map((n) => renderNode(n, 0))}</div>
  );
}
```

- [ ] **Step 3: Run, expect 4 tests pass.**

- [ ] **Step 4: Commit.** `feat(desktop/vault): FolderTree component with collapse/expand`.

---

## Task 9: `FileTable` component

**Files:**
- Create: `apps/desktop/src/modules/vault/components/FileTable.tsx`
- Create: `apps/desktop/tests/vault/FileTable.test.tsx`

A table of files with columns: name, latest version comment, modified-at (relative time), lock state. Selected file is highlighted; clicking a row emits `onSelect(fileId)`.

- [ ] **Step 1: Test.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileTable } from "../../src/modules/vault/components/FileTable";

const files = [
  { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: "ver1", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", folder_id: null, name: "wheel.sldprt", latest_version_id: null, created_at: "2026-01-01" },
];

describe("<FileTable>", () => {
  it("renders one row per file", () => {
    render(<FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={() => {}} />);
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText("wheel.sldprt")).toBeInTheDocument();
  });

  it("emits onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("frame.sldprt"));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });

  it("shows 'Locked by me' badge when current user holds the lock", () => {
    const locks = [{ id: "l1", file_id: "f1", user_id: "u", acquired_at: "x", released_at: null, force_released_by: null }];
    render(<FileTable files={files} selected={null} locks={locks as any} currentUserId="u" onSelect={() => {}} />);
    expect(screen.getByText(/locked by me/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implementation.**

```tsx
import { LockBadge } from "./LockBadge";
import type { FileId, Lock, UserId, VaultFile } from "../data/types";

interface Props {
  files: VaultFile[];
  selected: FileId | null;
  locks: Lock[];
  currentUserId: UserId;
  onSelect: (id: FileId) => void;
}

function lockStateFor(file: VaultFile, locks: Lock[], me: UserId) {
  const lock = locks.find((l) => l.file_id === file.id && l.released_at === null);
  if (!lock) return "latest" as const;
  return lock.user_id === me ? ("locked-by-me" as const) : ("locked-by-other" as const);
}

export function FileTable({ files, selected, locks, currentUserId, onSelect }: Props) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-zinc-800 text-left text-zinc-400">
        <tr>
          <th className="px-3 py-2 font-normal">Name</th>
          <th className="px-3 py-2 font-normal">Status</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f) => {
          const isSel = selected === f.id;
          const state = lockStateFor(f, locks, currentUserId);
          return (
            <tr
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={
                "cursor-pointer border-b border-zinc-900 " +
                (isSel ? "bg-zinc-800" : "hover:bg-zinc-900")
              }
            >
              <td className="px-3 py-2 text-zinc-100">{f.name}</td>
              <td className="px-3 py-2">
                <LockBadge state={state} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Run, expect 3 tests pass.**

- [ ] **Step 4: Commit.** `feat(desktop/vault): FileTable component with LockBadge integration`.

---

## Task 10: `VersionList` component

**Files:**
- Create: `apps/desktop/src/modules/vault/components/VersionList.tsx`
- Create: `apps/desktop/tests/vault/VersionList.test.tsx`

A chronological list of versions with author + timestamp + comment. Clicking a row emits `onSelect(versionId)`.

- [ ] **Step 1: Test.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VersionList } from "../../src/modules/vault/components/VersionList";

const versions = [
  { id: "v3", file_id: "f", version_num: 3, sha256: "x", size_bytes: 100, author_id: "u", comment: "third", parent_version_id: "v2", created_at: "2026-03-01" },
  { id: "v2", file_id: "f", version_num: 2, sha256: "y", size_bytes: 100, author_id: "u", comment: "second", parent_version_id: "v1", created_at: "2026-02-01" },
  { id: "v1", file_id: "f", version_num: 1, sha256: "z", size_bytes: 100, author_id: "u", comment: "first", parent_version_id: null, created_at: "2026-01-01" },
];

describe("<VersionList>", () => {
  it("renders one row per version", () => {
    render(<VersionList versions={versions as any} onSelect={() => {}} />);
    expect(screen.getByText(/third/)).toBeInTheDocument();
    expect(screen.getByText(/second/)).toBeInTheDocument();
    expect(screen.getByText(/first/)).toBeInTheDocument();
  });

  it("displays version number prefix", () => {
    render(<VersionList versions={versions as any} onSelect={() => {}} />);
    expect(screen.getByText(/v3/i)).toBeInTheDocument();
    expect(screen.getByText(/v1/i)).toBeInTheDocument();
  });

  it("emits onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<VersionList versions={versions as any} onSelect={onSelect} />);
    fireEvent.click(screen.getByText(/third/));
    expect(onSelect).toHaveBeenCalledWith("v3");
  });
});
```

- [ ] **Step 2: Implementation.**

```tsx
import type { Version, VersionId } from "../data/types";

interface Props {
  versions: Version[];
  onSelect: (id: VersionId) => void;
}

export function VersionList({ versions, onSelect }: Props) {
  return (
    <ol className="divide-y divide-zinc-800 text-sm">
      {versions.map((v) => (
        <li
          key={v.id}
          onClick={() => onSelect(v.id)}
          className="cursor-pointer px-3 py-2 hover:bg-zinc-900"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-zinc-400">v{v.version_num}</span>
            <span className="text-xs text-zinc-500">{v.created_at}</span>
          </div>
          <div className="text-zinc-100">{v.comment ?? <em className="text-zinc-500">(no comment)</em>}</div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 3: Run, expect 3 tests pass.**

- [ ] **Step 4: Commit.** `feat(desktop/vault): VersionList component`.

---

## Task 11: `BrowseScreen` — assemble FolderTree + FileTable + FileDetailPanel

**Files:**
- Create: `apps/desktop/src/modules/vault/screens/BrowseScreen.tsx`
- Create: `apps/desktop/src/modules/vault/screens/FileDetailPanel.tsx`
- Create: `apps/desktop/tests/vault/BrowseScreen.test.tsx`
- Create: `apps/desktop/tests/vault/FileDetailPanel.test.tsx`

`BrowseScreen` uses `useVaults` to pick the (single) vault, `useFolders(vaultId)` for the tree, `useFiles(folderId)` for the right table, `useLocks()` for badges, `useUser()` for the current user id. State: which folder + file are selected.

`FileDetailPanel` shows a selected file's history (`useVersions(fileId)`).

- [ ] **Step 1: Tests.**

```tsx
// BrowseScreen.test.tsx — uses mocks via vi.mock for the data hooks and renders the integrated screen.
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";

const mockClient: SupabaseClient = {
  auth: {
    getSession: vi.fn().mockResolvedValue({
      data: { session: { user: { id: "u1", email: "u1@x.com" } } },
      error: null,
    }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
  from: vi.fn().mockImplementation((table: string) => {
    if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "sdm26", created_at: "x", created_by: "u1" }], error: null }) };
    if (table === "folders") return {
      select: () => ({
        eq: () => Promise.resolve({
          data: [{ id: "f1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" }],
          error: null,
        }),
      }),
    };
    if (table === "files") return {
      select: () => ({
        eq: () => Promise.resolve({
          data: [{ id: "fi1", vault_id: "v1", folder_id: "f1", name: "frame.sldprt", latest_version_id: null, created_at: "x" }],
          error: null,
        }),
      }),
    };
    if (table === "locks") return {
      select: () => ({ is: () => Promise.resolve({ data: [], error: null }) }),
    };
    return { select: () => Promise.resolve({ data: [], error: null }) };
  }),
} as any;

import { BrowseScreen } from "../../src/modules/vault/screens/BrowseScreen";

describe("<BrowseScreen>", () => {
  it("renders vault name, folder tree, and (after folder selection) file table", async () => {
    render(
      <SupabaseAuthProvider client={mockClient}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("chassis")).toBeInTheDocument();
    });
    // Click chassis to reveal files
    screen.getByText("chassis").click();
    await waitFor(() => {
      expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Implementation — `FileDetailPanel.tsx`.**

```tsx
import { useVersions } from "../data/useVersions";
import { VersionList } from "../components/VersionList";
import type { FileId } from "../data/types";

export function FileDetailPanel({ fileId }: { fileId: FileId | null }) {
  if (!fileId) {
    return (
      <aside className="flex h-full w-80 items-center justify-center border-l border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">
        Select a file to see its history.
      </aside>
    );
  }
  return <FileDetailLoader fileId={fileId} />;
}

function FileDetailLoader({ fileId }: { fileId: FileId }) {
  const { data, loading, error } = useVersions(fileId);
  return (
    <aside className="flex h-full w-80 flex-col border-l border-zinc-800 bg-zinc-950">
      <header className="border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
        History
      </header>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="p-3 text-sm text-red-400">{error.message}</div>
        ) : !data || data.length === 0 ? (
          <div className="p-3 text-sm text-zinc-500">No versions yet.</div>
        ) : (
          <VersionList versions={data} onSelect={() => {}} />
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Implementation — `BrowseScreen.tsx`.**

```tsx
import { useState } from "react";
import { useUser } from "@helios/auth";
import { useVaults } from "../data/useVaults";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useLocks } from "../data/useLocks";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { FileDetailPanel } from "./FileDetailPanel";
import type { FileId, FolderId } from "../data/types";

export function BrowseScreen() {
  const user = useUser();
  const { data: vaults } = useVaults();
  const vaultId = vaults?.[0]?.id;
  const { data: folders } = useFolders(vaultId);
  const [selectedFolder, setSelectedFolder] = useState<FolderId | null>(null);
  const { data: files } = useFiles(selectedFolder ?? undefined);
  const { data: locks } = useLocks();
  const [selectedFile, setSelectedFile] = useState<FileId | null>(null);

  return (
    <div className="flex h-full">
      <div className="flex w-64 flex-col border-r border-zinc-800 bg-zinc-950">
        <header className="border-b border-zinc-800 px-3 py-2 text-xs uppercase tracking-wider text-zinc-500">
          {vaults?.[0]?.name ?? "(no vault)"}
        </header>
        <div className="flex-1 overflow-auto">
          {folders ? (
            <FolderTree folders={folders} selected={selectedFolder} onSelect={setSelectedFolder} />
          ) : (
            <div className="p-3 text-sm text-zinc-500">Loading folders…</div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {selectedFolder ? (
          <FileTable
            files={files ?? []}
            selected={selectedFile}
            locks={locks ?? []}
            currentUserId={user?.id ?? ""}
            onSelect={setSelectedFile}
          />
        ) : (
          <div className="p-6 text-sm text-zinc-500">Select a folder to see its files.</div>
        )}
      </div>
      <FileDetailPanel fileId={selectedFile} />
    </div>
  );
}
```

- [ ] **Step 4: Run, expect tests pass.**

- [ ] **Step 5: Commit.** `feat(desktop/vault): BrowseScreen + FileDetailPanel`.

---

## Task 12: `HistoryScreen` — full history of any selected file

**Files:**
- Create: `apps/desktop/src/modules/vault/screens/HistoryScreen.tsx`
- Create: `apps/desktop/tests/vault/HistoryScreen.test.tsx`

A simpler screen: pick a file from a flat list (cross-vault), then show its version history wide.

- [ ] **Step 1: Test** — verifies the screen renders an empty state when no file is selected, and renders versions when one is selected. Use the same mocking pattern as BrowseScreen.

- [ ] **Step 2: Implementation.**

```tsx
import { useState } from "react";
import { useVaults } from "../data/useVaults";
import { useFolders } from "../data/useFolders";
import { useFiles } from "../data/useFiles";
import { useVersions } from "../data/useVersions";
import { FolderTree } from "../components/FolderTree";
import { FileTable } from "../components/FileTable";
import { VersionList } from "../components/VersionList";
import { useUser } from "@helios/auth";
import type { FileId, FolderId } from "../data/types";

export function HistoryScreen() {
  const user = useUser();
  const { data: vaults } = useVaults();
  const vaultId = vaults?.[0]?.id;
  const { data: folders } = useFolders(vaultId);
  const [folderId, setFolderId] = useState<FolderId | null>(null);
  const { data: files } = useFiles(folderId ?? undefined);
  const [fileId, setFileId] = useState<FileId | null>(null);
  const { data: versions } = useVersions(fileId ?? undefined);

  return (
    <div className="flex h-full">
      <div className="w-56 border-r border-zinc-800 bg-zinc-950 overflow-auto">
        {folders ? (
          <FolderTree folders={folders} selected={folderId} onSelect={setFolderId} />
        ) : null}
      </div>
      <div className="w-72 border-r border-zinc-800 overflow-auto">
        {folderId && files ? (
          <FileTable
            files={files}
            selected={fileId}
            locks={[]}
            currentUserId={user?.id ?? ""}
            onSelect={setFileId}
          />
        ) : (
          <div className="p-6 text-sm text-zinc-500">Pick a folder.</div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {fileId && versions ? (
          <VersionList versions={versions} onSelect={() => {}} />
        ) : (
          <div className="p-6 text-sm text-zinc-500">Pick a file to see its history.</div>
        )}
      </div>
    </div>
  );
}
```

`useVersions` will need to accept `undefined` and short-circuit (matching the pattern in `useFolders` / `useFiles`). If the original implementation didn't do that, update it now and add a test.

- [ ] **Step 3: Test, run, commit.** `feat(desktop/vault): HistoryScreen`.

---

## Task 13: `WhoHasWhatScreen` — flat list of all active locks

**Files:**
- Create: `apps/desktop/src/modules/vault/screens/WhoHasWhatScreen.tsx`
- Create: `apps/desktop/tests/vault/WhoHasWhatScreen.test.tsx`

- [ ] **Step 1: Test.**

```tsx
// Mock useLocks to return a couple of active locks; assert each shows up in the table.
```

- [ ] **Step 2: Implementation.**

```tsx
import { useLocks } from "../data/useLocks";

export function WhoHasWhatScreen() {
  const { data: locks, loading, error } = useLocks();

  return (
    <div className="h-full overflow-auto bg-zinc-900">
      <header className="border-b border-zinc-800 px-4 py-3 text-zinc-400">
        Active checkouts
      </header>
      <div className="p-2">
        {loading ? (
          <div className="p-4 text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-red-400">{error.message}</div>
        ) : !locks || locks.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">Nothing checked out right now.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-normal">File</th>
                <th className="px-3 py-2 font-normal">Holder</th>
                <th className="px-3 py-2 font-normal">Since</th>
              </tr>
            </thead>
            <tbody>
              {locks.map((l) => (
                <tr key={l.id} className="border-t border-zinc-800">
                  <td className="px-3 py-2 font-mono text-xs text-zinc-400">{l.file_id}</td>
                  <td className="px-3 py-2 text-zinc-200">{l.user_id}</td>
                  <td className="px-3 py-2 text-zinc-500">{l.acquired_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

(Joining `file_id` → `file.name` and `user_id` → `user.email` is a follow-up; for v1, raw IDs are acceptable.)

- [ ] **Step 3: Test, commit.** `feat(desktop/vault): WhoHasWhatScreen`.

---

## Task 14: Replace `<VaultHome>` with screen router

**Files:**
- Modify: `apps/desktop/src/modules/vault/VaultHome.tsx`

- [ ] **Step 1: Replace `VaultHome.tsx` content.**

```tsx
import { useState } from "react";
import { NavRail, type VaultScreenId } from "./components/NavRail";
import { BrowseScreen } from "./screens/BrowseScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { WhoHasWhatScreen } from "./screens/WhoHasWhatScreen";

export function VaultHome() {
  const [active, setActive] = useState<VaultScreenId>("browse");

  return (
    <div className="flex h-full">
      <NavRail active={active} onSelect={setActive} />
      <main className="flex-1 overflow-hidden">
        {active === "browse" ? <BrowseScreen /> : null}
        {active === "history" ? <HistoryScreen /> : null}
        {active === "who" ? <WhoHasWhatScreen /> : null}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Update the existing `VaultModule.test.tsx`** — the test that asserted `coming soon` no longer matches. Update to:

```tsx
it("shows the browse screen by default when authenticated", async () => {
  // ...same mockClient...
  render(...);
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run all desktop tests; expect every test passes including the updated VaultModule test and all new vault/* tests.**

- [ ] **Step 4: Commit.** `feat(desktop/vault): replace VaultHome placeholder with screen router`.

---

## Task 15: Plan-completion review

- [ ] **Step 1: Full pnpm test.**

```bash
cd /Users/nmurray/Developer/helios
pnpm test
```

Expect every test passes. Capture the new total.

- [ ] **Step 2: Typecheck + lint.**

```bash
pnpm typecheck
pnpm lint
```

- [ ] **Step 3: Update the roadmap** — Plan 4 status from `not started` to `code complete @ <SHORT_SHA>`. Same placeholder + amend (or two-commit) pattern as previous plans.

- [ ] **Step 4: Commit roadmap.**

```bash
git add docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md
git commit -m "chore(roadmap): mark Plan 4 (vault module UI) complete"
```

- [ ] **Step 5: Confirm no push.**

---

## What's deferred (Plan 4b)

These were explicitly cut from this plan to keep scope manageable. They become a follow-up plan once Plan 5 (`parse-refs` + `invite_user`) lands and the team has run the v1 UI for a bit:

- **Search screen** — Postgres ILIKE on `files.name` and `versions.comment`. Trivial UI, no architectural surprises.
- **Admin → Users screen** — depends on Plan 5's `invite_user` edge function.
- **Admin → Vaults screen** — single-vault for now; Plan 3 milestone says "one vault for everything," so this is mostly cosmetic until multi-vault is needed.
- **Settings screen** — sign out is already in `VaultHome`; nothing else has demand yet.
- **Realtime updates** — locks list re-fetches on user actions; live `pdm.locks` change subscriptions arrive when Plan 6's sync daemon does its thing.
- **File-name resolution in Who-has-what** — joining `file_id` → file name and `user_id` → user email needs a small `users_view` plus a couple of joined queries; not blocked, just deferred.

---

## What Plan 5 picks up

Plan 5 is the `parse-refs` Supabase Edge Function + the WASM build of `pdm-sw-parser`. After Plan 5, every `.sldasm` / `.sldprt` check-in gets references parsed and stored in `pdm.refs` automatically. Plan 5 is independent of Plans 3 and 4 — it can land any time after Plans 1 and 2.
