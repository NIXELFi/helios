import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WhoHasWhatScreen } from "../../src/modules/vault/screens/WhoHasWhatScreen";
import { resetLockOverlay } from "../../src/modules/vault/data/lock-overlay";

// The optimistic lock overlay is a module singleton; a force-unlock in one test
// leaves an entry that would hide the lock row in the next. Reset between tests.
// localStorage holds the active-vault id (useActiveVault) — clear so a vault id
// persisted by one test doesn't reorder groups in the next.
beforeEach(() => {
  resetLockOverlay();
  localStorage.clear();
});

/**
 * Mock client for the redesigned cross-vault screen. Tables exercised:
 *   vaults  — select() → all vaults (names for the group headers)
 *   locks   — select().is().order().range (paginated, cross-vault)
 *   files   — select().in("id", ids) (lock-file resolution, deleted included)
 *   folders — select().is().order().order().range (cross-vault, paginated)
 */
function mockClient(
  locks: any[],
  opts: {
    vaults?: any[];
    files?: any[];
    folders?: any[];
    isAdmin?: boolean;
    users?: any[] | null;
    filesHang?: boolean;
    filesError?: { message: string };
    foldersError?: { message: string };
    /** Rows for pdm_list_active_checkouts. Omitted = RPC not deployed
     *  (PGRST202), which exercises the legacy client-side join. */
    checkouts?: any[];
  } = {},
): SupabaseClient {
  const {
    vaults = [{ id: "v1", name: "sdm26", created_at: "2026-01-01T00:00:00Z", created_by: "u1" }],
    files = [],
    folders = [],
    isAdmin = false,
    users = null,
    filesHang = false,
    filesError,
    foldersError,
    checkouts,
  } = opts;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "vaults") {
        return { select: () => Promise.resolve({ data: vaults, error: null }) };
      }
      if (table === "locks") {
        return {
          select: () => ({
            is: () => ({
              order: () => ({ range: (from: number, to: number) => Promise.resolve({ data: locks.slice(from, to + 1), error: null }) }),
            }),
          }),
        };
      }
      if (table === "files") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              filesHang
                ? new Promise(() => {})
                : filesError
                  ? Promise.resolve({ data: null, error: filesError })
                  : Promise.resolve({ data: files.filter((f) => ids.includes(f.id)), error: null }),
          }),
        };
      }
      if (table === "folders") {
        return {
          select: () => ({
            is: () => {
              const node: any = {
                order: () => node,
                range: (from: number, to: number) =>
                  foldersError
                    ? Promise.resolve({ data: null, error: foldersError })
                    : Promise.resolve({ data: folders.slice(from, to + 1), error: null }),
              };
              return node;
            },
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    rpc: (name: string) => {
      if (name === "pdm_list_active_checkouts") {
        return checkouts !== undefined
          ? Promise.resolve({ data: checkouts, error: null })
          : Promise.resolve({
              data: null,
              error: { code: "PGRST202", message: "Could not find the function pdm.pdm_list_active_checkouts" },
            });
      }
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

function lock(id: string, fileId: string, userId: string, acquiredAt?: string) {
  return {
    id,
    file_id: fileId,
    user_id: userId,
    acquired_at: acquiredAt ?? new Date().toISOString(),
    released_at: null,
    force_released_by: null,
  };
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

  it("renders one row per active lock with resolved paths under the vault header", async () => {
    const folders = [
      { id: "folder-chassis", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" },
      { id: "folder-sub", vault_id: "v1", parent_id: "folder-chassis", name: "subframe", created_at: "x" },
    ];
    const files = [
      { id: "file-1", vault_id: "v1", folder_id: "folder-sub", name: "frame.sldprt", deleted_at: null },
    ];
    const locks = [
      lock("l1", "file-1", "00000000-0000-0000-0000-000000000abc", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()),
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files, folders })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );

    // Path appears under the vault's group header; raw UUID does not.
    expect(await screen.findByText("chassis/subframe/frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText("sdm26")).toBeInTheDocument();
    expect(screen.queryByText("file-1")).toBeNull();

    // Short user id appears (raw UUID does not).
    expect(screen.getByText("00000000")).toBeInTheDocument();
    expect(screen.queryByText("00000000-0000-0000-0000-000000000abc")).toBeNull();

    // Relative time appears (not the raw ISO timestamp).
    expect(screen.getByText(/h ago/)).toBeInTheDocument();
  });

  it("groups checkouts from different vaults under their own vault headers", async () => {
    const vaults = [
      { id: "v1", name: "sdm26", created_at: "2026-01-01T00:00:00Z", created_by: "u1" },
      { id: "v2", name: "sdm27", created_at: "2026-02-01T00:00:00Z", created_by: "u1" },
    ];
    const files = [
      { id: "f-a", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null },
      { id: "f-b", vault_id: "v2", folder_id: null, name: "b.sldprt", deleted_at: null },
    ];
    const locks = [lock("l1", "f-a", "u-a"), lock("l2", "f-b", "u-b")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { vaults, files })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText("a.sldprt")).toBeInTheDocument();
    expect(screen.getByText("b.sldprt")).toBeInTheDocument();
    expect(screen.getByText("sdm26")).toBeInTheDocument();
    expect(screen.getByText("sdm27")).toBeInTheDocument();
    // Nothing is filtered out anymore — both vaults' checkouts are visible.
    expect(screen.queryByText(/nothing checked out/i)).toBeNull();
  });

  it("NO-FLASH: shows Loading (not unfiltered rows, not the empty state) while lock files resolve", async () => {
    // The old screen rendered every cross-vault lock while the active vault's
    // files loaded, then filtered — a visible flash that often ended on a
    // false "Nothing checked out". Now the screen holds Loading until the
    // locks' own files are resolved.
    const locks = [lock("l1", "FILEAAAA-1111-2222-3333-444455556666", "USERBBBB-7777-8888-9999-aaaabbbbcccc")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { filesHang: true })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
    expect(screen.queryByText("FILEAAAA")).toBeNull();
    expect(screen.queryByText(/nothing checked out/i)).toBeNull();
  });

  it("LEGACY: a lock whose file can't be resolved lands under 'Private drafts or other vaults'", async () => {
    // Pre-RPC servers can't distinguish a private draft from a foreign vault;
    // the checkout must still be visible rather than silently dropped.
    const locks = [lock("l1", "FILEAAAA-1111-2222-3333-444455556666", "u-x")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files: [] })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText("FILEAAAA")).toBeInTheDocument();
    expect(screen.getByText("Private drafts or other vaults")).toBeInTheDocument();
    expect(screen.queryByText(/nothing checked out/i)).toBeNull();
  });

  it("RPC: resolves draft checkouts — named drafts get a tag, foreign drafts a private placeholder", async () => {
    // The pdm_list_active_checkouts RPC resolves locks server-side, so draft
    // checkouts group under their REAL vault instead of "Other vaults"
    // (the regression this RPC exists to fix: files_read draft privacy hid
    // those rows from the client-side join).
    const checkouts = [
      {
        lock_id: "l1", file_id: "f1", file_name: "Electronics Rack.SLDPRT",
        vault_id: "v1", vault_name: "SDM27", folder_id: null,
        user_id: "u-a", acquired_at: new Date().toISOString(), is_draft: true, deleted_at: null,
      },
      {
        lock_id: "l2", file_id: "f2", file_name: null, // someone else's draft, name redacted
        vault_id: "v1", vault_name: "SDM27", folder_id: null,
        user_id: "u-b", acquired_at: new Date().toISOString(), is_draft: true, deleted_at: null,
      },
      {
        lock_id: "l3", file_id: "f3", file_name: "frame.sldprt",
        vault_id: "v2", vault_name: "SDM26", folder_id: null,
        user_id: "u-c", acquired_at: new Date().toISOString(), is_draft: false, deleted_at: null,
      },
    ];
    render(
      <SupabaseAuthProvider client={mockClient([], { checkouts })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    // Real vault groups, no "Other vaults" bucket.
    expect(await screen.findByText("SDM27")).toBeInTheDocument();
    expect(screen.getByText("SDM26")).toBeInTheDocument();
    expect(screen.queryByText(/other vaults/i)).toBeNull();
    // Named draft shows its name + a draft tag.
    expect(screen.getByText("Electronics Rack.SLDPRT")).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    // Redacted draft shows the private placeholder, not a hex id.
    expect(screen.getByText("Private draft")).toBeInTheDocument();
    // Published file renders normally.
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
  });

  it("RPC: empty result shows the empty state", async () => {
    render(
      <SupabaseAuthProvider client={mockClient([], { checkouts: [] })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/nothing checked out/i)).toBeInTheDocument());
  });

  it("labels a soft-deleted locked file instead of dropping it", async () => {
    const files = [
      { id: "f-del", vault_id: "v1", folder_id: null, name: "gone.sldprt", deleted_at: "2026-06-01T00:00:00Z" },
    ];
    const locks = [lock("l1", "f-del", "u-a")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText("gone.sldprt")).toBeInTheDocument();
    expect(screen.getByText(/in recycle bin/i)).toBeInTheDocument();
  });

  it("LOW: surfaces a files query error (paths no longer silently degrade)", async () => {
    const locks = [lock("l1", "file-1", "u-a")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { filesError: { message: "files boom" } })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/files boom/i)).toBeInTheDocument());
    // Rows still render with the short-id fallback — degraded, not hidden.
    expect(await screen.findByText("file-1")).toBeInTheDocument();
  });

  it("shows Force unlock button on each row when admin", async () => {
    const files = [{ id: "f-1", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null }];
    const locks = [lock("l1", "f-1", "u-a")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files, isAdmin: true })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /force unlock/i })).toBeInTheDocument());
  });

  it("hides Force unlock button when not admin", async () => {
    const files = [{ id: "f-1", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null }];
    const locks = [lock("l1", "f-1", "u-a")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("a.sldprt")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /force unlock/i })).toBeNull();
  });

  it("C1-MISS: Force unlock opens an in-app reason modal instead of window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const files = [{ id: "file-1", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null }];
    const locks = [lock("l1", "file-1", "u-a")];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files, isAdmin: true })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /force unlock/i });
    await act(async () => { fireEvent.click(btn); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("C1-MISS: confirming the reason modal calls pdm_force_unlock with the typed reason", async () => {
    const files = [{ id: "file-1", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null }];
    const locks = [lock("l1", "file-1", "u-a")];
    const c = mockClient(locks, { files, isAdmin: true });
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
    const confirm = within(dialog).getByRole("button", { name: /^force unlock$/i });
    await act(async () => { fireEvent.click(confirm); });
    await waitFor(() =>
      expect(rpcSpy).toHaveBeenCalledWith("pdm_force_unlock", { p_lock_id: "l1", p_reason: "stale lock, owner on leave" }),
    );
  });

  it("C1-MISS: an empty reason does NOT call pdm_force_unlock", async () => {
    const files = [{ id: "file-1", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null }];
    const locks = [lock("l1", "file-1", "u-a")];
    const c = mockClient(locks, { files, isAdmin: true });
    const rpcSpy = vi.spyOn(c, "rpc");
    render(
      <SupabaseAuthProvider client={c}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /force unlock/i });
    await act(async () => { fireEvent.click(btn); });
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /^force unlock$/i });
    await act(async () => { fireEvent.click(confirm); });
    expect(rpcSpy).not.toHaveBeenCalledWith("pdm_force_unlock", expect.anything());
  });

  it("V21: resolves the holder user_id to a display name via the users list", async () => {
    const holder = "00000000-0000-0000-0000-0000000000aa";
    const files = [{ id: "file-1", vault_id: "v1", folder_id: null, name: "a.sldprt", deleted_at: null }];
    const locks = [lock("l1", "file-1", holder, new Date(Date.now() - 3600_000).toISOString())];
    const users = [
      { user_id: holder, email: "alice@sdm.com", display_name: "Alice A", subteam: null, role: "editor", granted_at: "x", created_at: "x" },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(locks, { files, isAdmin: true, users })}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText("Alice A")).toBeInTheDocument();
    expect(screen.queryByText("00000000")).toBeNull();
  });
});
