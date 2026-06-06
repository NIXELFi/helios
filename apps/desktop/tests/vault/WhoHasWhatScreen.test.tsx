import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WhoHasWhatScreen } from "../../src/modules/vault/screens/WhoHasWhatScreen";
import { resetLockOverlay } from "../../src/modules/vault/data/lock-overlay";

// The optimistic lock overlay is a module singleton; a force-unlock in one test
// leaves an entry that would hide the lock row in the next. Reset between tests.
beforeEach(() => resetLockOverlay());

function mockClient(rows: any[], isAdmin = false): SupabaseClient {
  // Minimal mock: only the locks query is exercised, no active vault is
  // resolved, so the screen falls back to short-id rendering. Used by the
  // pre-resolution tests below.
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({
        is: () => ({
          order: () => ({ range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }) }),
        }),
      }),
    }),
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

/** Mock that ALSO returns a vault + files + folders so the screen resolves
 *  file_id → "folder/path/name.ext". Exercises the path-resolution code
 *  added by the 2026-05-25 audit fix. */
function mockResolvedClient(
  rows: any[],
  files: any[],
  folders: any[],
  isAdmin = false,
  users: any[] | null = null,
  extra: { filesHang?: boolean; filesError?: { message: string }; foldersError?: { message: string } } = {},
): SupabaseClient {
  const { filesHang = false, filesError, foldersError } = extra;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "vaults") {
        return {
          select: () => Promise.resolve({
            data: [{ id: "v1", name: "sdm26", created_at: "2026-01-01T00:00:00Z", created_by: "u1" }],
            error: null,
          }),
        };
      }
      if (table === "locks") {
        return {
          select: () => ({
            is: () => ({
              order: () => ({ range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }) }),
            }),
          }),
        };
      }
      if (table === "folders") {
        return {
          select: () => ({
            // useFolders adds .is("deleted_at", null) before the .order() chain.
            eq: () => ({
              is: () => ({
                order: () => {
                  const node: any = { order: () => node, range: (from: number, to: number) =>
                    foldersError
                      ? Promise.resolve({ data: null, error: foldersError })
                      : Promise.resolve({ data: folders.slice(from, to + 1), error: null }) };
                  return node;
                },
              }),
            }),
          }),
        };
      }
      if (table === "files") {
        return {
          select: () => ({
            eq: () => ({
              // useAllFiles adds .is("deleted_at", null) before .order().
              is: () => {
                const node: any = { order: () => node, range: (from: number, to: number) =>
                  filesHang
                    ? new Promise(() => {})
                    : filesError
                      ? Promise.resolve({ data: null, error: filesError })
                      : Promise.resolve({ data: files.slice(from, to + 1), error: null }) };
                return node;
              },
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      if (name === "pdm_admin_list_users") {
        // Non-admins get a raised error from the RPC; admins get the list.
        return users
          ? Promise.resolve({ data: users, error: null })
          : Promise.resolve({ data: null, error: { code: "P0001", message: "not an admin" } });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

describe("<WhoHasWhatScreen>", () => {
  it("shows empty state when no active locks", async () => {
    render(
      <SupabaseAuthProvider client={mockClient([])}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/nothing checked out/i)).toBeInTheDocument());
  });

  it("renders one row per active lock", async () => {
    const locks = [
      { id: "l1", file_id: "fileA", user_id: "alice", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
      { id: "l2", file_id: "fileB", user_id: "bob", acquired_at: "2026-01-02", released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    // Wait on a data-dependent string, not the static "Active checkouts"
    // header which renders before useLocks resolves. CI runners take longer
    // to flush async state and would race the immediate getByText calls.
    expect(await screen.findByText("fileA")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("fileB")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows Force unlock button on each row when admin", async () => {
    const locks = [
      { id: "l1", file_id: "fileA", user_id: "alice", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks, true)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /force unlock/i })).toBeInTheDocument());
  });

  it("hides Force unlock button when not admin", async () => {
    const locks = [
      { id: "l1", file_id: "fileA", user_id: "alice", acquired_at: "2026-01-01", released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks, false)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("fileA")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /force unlock/i })).toBeNull();
  });

  it("does NOT blank while files are still LOADING (keeps locks until load resolves)", async () => {
    // Repro of the bug surfaced during manual smoke-testing on 2026-05-25:
    // useLocks is cross-vault (no vault_id filter), useAllFiles is scoped to
    // the active vault. While files are still LOADING we must keep every lock
    // so the screen doesn't "show for 2 seconds then go blank" once useAllFiles
    // resolves. (Distinct from the loaded-empty case below, which DOES filter.)
    // We model loading by hanging the files query so it never resolves.
    const folders: any[] = [];
    const files: any[] = [];
    const locks = [
      {
        id: "l1",
        file_id: "FILEAAAA-1111-2222-3333-444455556666", // not in `files`
        user_id: "USERBBBB-7777-8888-9999-aaaabbbbcccc",
        acquired_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        released_at: null,
        force_released_by: null,
      },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders, false, null, { filesHang: true })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    // Row renders with shortId fallback for BOTH file and user while loading.
    expect(await screen.findByText("FILEAAAA")).toBeInTheDocument();
    expect(screen.getByText("USERBBBB")).toBeInTheDocument();
    expect(screen.queryByText(/nothing checked out/i)).toBeNull();
  });

  it("LOW: surfaces a files query error (paths no longer silently degrade)", async () => {
    const folders = [{ id: "f-root", vault_id: "v1", parent_id: null, name: "root", created_at: "x" }];
    const locks = [
      { id: "l1", file_id: "file-1", user_id: "u-a", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, [], folders, false, null, { filesError: { message: "files boom" } })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/files boom/i)).toBeInTheDocument());
  });

  it("resolves file_id → human-readable path when the vault context is loaded", async () => {
    // Regression guard for the 2026-05-25 audit fix: the screen used to show
    // raw UUIDs for file_id and user_id, making it unusable for its stated
    // purpose. Now it joins active-vault files + folders to render
    // "folder/path/name.ext" instead.
    const folders = [
      { id: "folder-chassis", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" },
      { id: "folder-sub", vault_id: "v1", parent_id: "folder-chassis", name: "subframe", created_at: "x" },
    ];
    const files = [
      { id: "file-1", vault_id: "v1", folder_id: "folder-sub", name: "frame.sldprt", latest_version_id: null, created_at: "x" },
    ];
    const locks = [
      {
        id: "l1",
        file_id: "file-1",
        user_id: "00000000-0000-0000-0000-000000000abc",
        acquired_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
        released_at: null,
        force_released_by: null,
      },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );

    // Path appears, raw UUID does not.
    expect(await screen.findByText("chassis/subframe/frame.sldprt")).toBeInTheDocument();
    expect(screen.queryByText("file-1")).toBeNull();

    // Short user id appears (raw UUID does not).
    expect(screen.getByText("00000000")).toBeInTheDocument();
    expect(screen.queryByText("00000000-0000-0000-0000-000000000abc")).toBeNull();

    // Relative time appears (not the raw ISO timestamp).
    expect(screen.getByText(/h ago/)).toBeInTheDocument();
  });

  it("H12: filters out locks for files NOT in the active vault once its files are loaded", async () => {
    // useLocks is cross-vault. When the active vault has its OWN files loaded,
    // a lock whose file_id isn't among them belongs to a different vault and
    // must NOT be shown under "{activeVault} checkouts". (Distinct from the
    // "no files loaded" case above, which keeps showing locks as a fallback.)
    const folders = [
      { id: "f-root", vault_id: "v1", parent_id: null, name: "root", created_at: "x" },
    ];
    const files = [
      { id: "mine-1", vault_id: "v1", folder_id: "f-root", name: "mine.sldprt", latest_version_id: null, created_at: "x" },
    ];
    const locks = [
      // In-vault lock — should render.
      { id: "l1", file_id: "mine-1", user_id: "u-a", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
      // Cross-vault lock — file_id not in this vault's files — should be hidden.
      { id: "l2", file_id: "OTHERVAULT-9999", user_id: "u-b", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText("root/mine.sldprt")).toBeInTheDocument();
    // The cross-vault lock's short file id must NOT appear.
    expect(screen.queryByText("OTHERVAU")).toBeNull();
  });

  it("C1-MISS: Force unlock opens an in-app reason modal instead of window.prompt", async () => {
    // window.prompt is a no-op in the Tauri webview — it returns null, so the
    // old force-unlock click was DEAD. The button must now open an in-app
    // modal that collects the reason. Assert prompt is never touched.
    const promptSpy = vi.spyOn(window, "prompt");
    const folders = [{ id: "f-root", vault_id: "v1", parent_id: null, name: "root", created_at: "x" }];
    const files = [{ id: "file-1", vault_id: "v1", folder_id: "f-root", name: "a.sldprt", latest_version_id: null, created_at: "x" }];
    const locks = [
      { id: "l1", file_id: "file-1", user_id: "u-a", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders, true)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /force unlock/i });
    await act(async () => { fireEvent.click(btn); });
    // An in-app dialog appears; window.prompt was never called.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("C1-MISS: confirming the reason modal calls pdm_force_unlock with the typed reason", async () => {
    const folders = [{ id: "f-root", vault_id: "v1", parent_id: null, name: "root", created_at: "x" }];
    const files = [{ id: "file-1", vault_id: "v1", folder_id: "f-root", name: "a.sldprt", latest_version_id: null, created_at: "x" }];
    const locks = [
      { id: "l1", file_id: "file-1", user_id: "u-a", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
    ];
    const c = mockResolvedClient(locks, files, folders, true);
    const rpcSpy = vi.spyOn(c, "rpc");
    render(
      <SupabaseAuthProvider client={c}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /force unlock/i });
    await act(async () => { fireEvent.click(btn); });
    const dialog = screen.getByRole("dialog");
    const textbox = within(dialog).getByRole("textbox");
    await act(async () => { fireEvent.change(textbox, { target: { value: "stale lock, owner on leave" } }); });
    // Confirm submits the reason (scoped to the dialog — the row button shares
    // the "Force unlock" label).
    const confirm = within(dialog).getByRole("button", { name: /^force unlock$/i });
    await act(async () => { fireEvent.click(confirm); });
    await waitFor(() =>
      expect(rpcSpy).toHaveBeenCalledWith("pdm_force_unlock", { p_lock_id: "l1", p_reason: "stale lock, owner on leave" }),
    );
  });

  it("C1-MISS: an empty reason does NOT call pdm_force_unlock", async () => {
    const folders = [{ id: "f-root", vault_id: "v1", parent_id: null, name: "root", created_at: "x" }];
    const files = [{ id: "file-1", vault_id: "v1", folder_id: "f-root", name: "a.sldprt", latest_version_id: null, created_at: "x" }];
    const locks = [
      { id: "l1", file_id: "file-1", user_id: "u-a", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
    ];
    const c = mockResolvedClient(locks, files, folders, true);
    const rpcSpy = vi.spyOn(c, "rpc");
    render(
      <SupabaseAuthProvider client={c}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /force unlock/i });
    await act(async () => { fireEvent.click(btn); });
    // Confirm with no reason typed → blocked (submit disabled / no-op).
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /^force unlock$/i });
    await act(async () => { fireEvent.click(confirm); });
    expect(rpcSpy).not.toHaveBeenCalledWith("pdm_force_unlock", expect.anything());
  });

  it("LOW: an active vault with genuinely zero files hides cross-vault locks (loaded-empty ≠ loading)", async () => {
    // useLocks is cross-vault. The OLD code kept ALL locks whenever `files` was
    // null OR empty — so a vault that genuinely has no files showed every
    // cross-vault lock under its header. Distinguish loading (files===null)
    // from loaded-empty (files===[]) via useAllFiles' `loading`. With files
    // loaded-empty, a lock whose file_id isn't local must be hidden.
    const folders: any[] = [];
    const files: any[] = []; // vault genuinely empty (loaded, not loading)
    const locks = [
      { id: "l1", file_id: "OTHERVAULT-FILE", user_id: "u-x", acquired_at: new Date().toISOString(), released_at: null, force_released_by: null },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    // Once files resolve to empty, the cross-vault lock is filtered out and the
    // empty-state copy shows instead of the foreign lock's short id.
    await waitFor(() => expect(screen.getByText(/nothing checked out/i)).toBeInTheDocument());
    expect(screen.queryByText("OTHERVAU")).toBeNull();
  });

  it("V21: resolves the holder user_id to a display name via the users list", async () => {
    const folders = [{ id: "f-root", vault_id: "v1", parent_id: null, name: "root", created_at: "x" }];
    const files = [{ id: "file-1", vault_id: "v1", folder_id: "f-root", name: "a.sldprt", latest_version_id: null, created_at: "x" }];
    const holder = "00000000-0000-0000-0000-0000000000aa";
    const locks = [
      { id: "l1", file_id: "file-1", user_id: holder, acquired_at: new Date(Date.now() - 3600_000).toISOString(), released_at: null, force_released_by: null },
    ];
    const users = [
      { user_id: holder, email: "alice@sdm.com", display_name: "Alice A", subteam: null, role: "editor", granted_at: "x", created_at: "x" },
    ];
    render(
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders, true, users)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    // Display name (or email) shown instead of the opaque 8-char id.
    expect(await screen.findByText("Alice A")).toBeInTheDocument();
    expect(screen.queryByText("00000000")).toBeNull();
  });
});
