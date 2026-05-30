import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BrowseScreen } from "../../src/modules/vault/screens/BrowseScreen";

// Mock Tauri fs plugin — vault folder scan won't run in tests (path is null).
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

function buildMockClient(isAdmin = false): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "sdm26", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "folders") return {
        select: () => ({
          eq: () => ({
            order: () => {
              const node: any = {
                order: () => node,
                range: (from: number, to: number) => Promise.resolve({
                  data: [{ id: "f1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" }].slice(from, to + 1),
                  error: null,
                }),
              };
              return node;
            },
          }),
        }),
      };
      if (table === "files") return {
        select: () => ({
          eq: () => ({
            order: () => {
              const node: any = {
                order: () => node,
                range: (from: number, to: number) => Promise.resolve({
                  data: [{ id: "fi1", vault_id: "v1", folder_id: "f1", name: "frame.sldprt", latest_version_id: null, created_at: "x" }].slice(from, to + 1),
                  error: null,
                }),
              };
              return node;
            },
          }),
        }),
      };
      if (table === "locks") return {
        select: () => ({ is: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }) }),
      };
      if (table === "user_roles") return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
      if (table === "versions") return {
        select: () => ({
          in: () => ({
            order: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
          }),
        }),
      };
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

/** Client whose `folders` query fails, so the folder-tree error state shows
 *  instead of a permanent "Loading folders…" spinner (H1). */
function buildFoldersErrorClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "sdm26", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "folders") return {
        select: () => ({
          eq: () => ({
            order: () => {
              const node: any = {
                order: () => node,
                range: () => Promise.resolve({ data: null, error: { message: "boom: folders unavailable" } }),
              };
              return node;
            },
          }),
        }),
      };
      if (table === "files") return {
        select: () => ({
          eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
        }),
      };
      if (table === "locks") return { select: () => ({ is: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }) }) };
      if (table === "user_roles") return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
      if (table === "versions") return {
        select: () => ({
          in: () => ({
            order: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
          }),
        }),
      };
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

/** Client with a root file locked by another user (u2) plus a vault-users RPC
 *  that resolves u2's email, so the FileTable renders "Locked by …" (H17). */
function buildLockHolderClient(): SupabaseClient {
  const rootFile = { id: "fi9", vault_id: "v1", folder_id: null, name: "rocker.sldprt", latest_version_id: null, created_at: "x" };
  const lock = { id: "lk1", file_id: "fi9", user_id: "u2", acquired_at: "x", released_at: null, force_released_by: null };
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: false, error: null });
      if (name === "pdm_admin_list_users") return Promise.resolve({
        data: [
          { user_id: "u2", email: "alice@x.com", display_name: "Alice", subteam: null, role: "editor", granted_at: "x", created_at: "x" },
        ],
        error: null,
      });
      return Promise.resolve({ data: null, error: null });
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "sdm26", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "folders") return {
        select: () => ({
          eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
        }),
      };
      if (table === "files") return {
        select: () => ({
          eq: () => ({
            order: () => {
              const node: any = {
                order: () => node,
                range: (from: number, to: number) => Promise.resolve({ data: [rootFile].slice(from, to + 1), error: null }),
              };
              return node;
            },
          }),
        }),
      };
      if (table === "locks") return {
        select: () => ({ is: () => ({ order: () => { const node: any = { order: () => node, range: (from: number, to: number) => Promise.resolve({ data: [lock].slice(from, to + 1), error: null }) }; return node; } }) }),
      };
      if (table === "user_roles") return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
      if (table === "versions") return {
        select: () => ({
          in: () => ({
            order: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
          }),
        }),
      };
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

/** Client that returns no vaults so the empty-vault branch is hit. */
function buildEmptyVaultClient(isAdmin: boolean): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [], error: null }) };
      if (table === "folders" || table === "files") return {
        select: () => ({
          eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
        }),
      };
      if (table === "locks") return { select: () => ({ is: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }) }) };
      if (table === "user_roles") return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
      if (table === "versions") return {
        select: () => ({
          in: () => ({
            order: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }),
          }),
        }),
      };
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

describe("<BrowseScreen>", () => {
  it("renders vault name + folder tree, then files after folder click", async () => {
    const c = buildMockClient();
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("sdm26")).toBeInTheDocument());
    // The folder name renders in the tree row. (The expand chevron is a
    // separate button whose aria-label also contains "chassis", so target the
    // name text node directly rather than an ambiguous role+name query.)
    await waitFor(() => expect(screen.getByText("chassis")).toBeInTheDocument());
    fireEvent.click(screen.getByText("chassis"));
    await waitFor(() => expect(screen.getAllByText("frame.sldprt").length).toBeGreaterThan(0));
  });

  it("auto mode without a sync folder shows an actionable 'set folder' prompt (not a blank toolbar)", async () => {
    // Repro of the reported bug: a vault in AUTO download mode but with no
    // Helios root configured. The old gate rendered VaultSyncSection only when
    // (vaultFolderPath && autoSyncEnabled) and the Manual pill only when
    // (!autoSyncEnabled) — so auto-mode-without-folder rendered NOTHING, and
    // useAutoSync silently no-op'd on `!vaultRoot`. The feature looked dead.
    localStorage.setItem("helios.vault.downloadMode", JSON.stringify({ v1: "auto" }));
    localStorage.removeItem("helios.vault.localFolder");
    try {
      const c = buildMockClient();
      render(
        <SupabaseAuthProvider client={c}>
          <BrowseScreen />
        </SupabaseAuthProvider>,
      );
      await waitFor(() => expect(screen.getByText("sdm26")).toBeInTheDocument());
      // The dead-zone must surface an explanation + a way to fix it.
      await waitFor(() => expect(screen.getByText(/no sync folder set/i)).toBeInTheDocument());
      expect(screen.getByRole("button", { name: /set folder/i })).toBeInTheDocument();
    } finally {
      localStorage.removeItem("helios.vault.downloadMode");
    }
  });

  it("shows the FileDetailPanel placeholder when no file is selected", async () => {
    const c = buildMockClient();
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/select a file/i)).toBeInTheDocument());
  });

  it("empty-vault state points an admin to the NavRail switcher", async () => {
    // Vault creation moved out of BrowseScreen — the switcher in the NavRail
    // owns it now. BrowseScreen just shows a hint when there's no active vault.
    const c = buildEmptyVaultClient(true);
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/vault switcher in the top-left/i)).toBeInTheDocument(),
    );
    expect(screen.queryByPlaceholderText(/vault name/i)).toBeNull();
  });

  it("empty-vault state for a non-admin points to contact an admin", async () => {
    const c = buildEmptyVaultClient(false);
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/contact an admin/i)).toBeInTheDocument());
  });

  it("shows an inline error + retry when the folder query fails (H1)", async () => {
    // A failed folders query must surface an error with a retry affordance,
    // not sit on the permanent "Loading folders…" placeholder.
    const c = buildFoldersErrorClient();
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/folders unavailable|couldn't load folders/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // Loading placeholder must be gone (loading vs error are distinct states).
    expect(screen.queryByText(/loading folders/i)).toBeNull();
  });

  it("clears the checkbox multi-selection when the folder context changes (V10)", async () => {
    const c = buildMockClient();
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    // Open the chassis folder and select its file via the row checkbox.
    await waitFor(() => expect(screen.getByText("chassis")).toBeInTheDocument());
    fireEvent.click(screen.getByText("chassis"));
    await waitFor(() => expect(screen.getByLabelText("Select frame.sldprt")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select frame.sldprt"));
    // The bulk action bar surfaces the live selection count.
    await waitFor(() => expect(screen.getByText("1 selected")).toBeInTheDocument());
    // Navigating to a different folder context (the vault root) must drop the
    // now-meaningless selection rather than carrying stale ids across.
    fireEvent.click(screen.getByText("Vault root"));
    await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
  });

  it("resolves the lock-holder email into the FileTable (H17)", async () => {
    // A root file locked by u2 + a vault-users RPC that maps u2 → alice@x.com
    // should render "Locked by alice@x.com", not the generic "Locked by other".
    const c = buildLockHolderClient();
    render(
      <SupabaseAuthProvider client={c}>
        <BrowseScreen />
      </SupabaseAuthProvider>,
    );
    // rocker.sldprt appears in both the folder tree and the file table, so use
    // the getAllBy variant; the holder label is unique to the file table.
    await waitFor(() => expect(screen.getAllByText("rocker.sldprt").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/Locked by alice@x\.com/i)).toBeInTheDocument());
  });
});
