import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WhoHasWhatScreen } from "../../src/modules/vault/screens/WhoHasWhatScreen";

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
          order: () => ({ range: () => Promise.resolve({ data: rows, error: null }) }),
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
): SupabaseClient {
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
              order: () => ({ range: () => Promise.resolve({ data: rows, error: null }) }),
            }),
          }),
        };
      }
      if (table === "folders") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ range: () => Promise.resolve({ data: folders, error: null }) }),
            }),
          }),
        };
      }
      if (table === "files") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ range: () => Promise.resolve({ data: files, error: null }) }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
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

  it("does NOT blank when locks exist but their file_id isn't in the active vault's file list", async () => {
    // Repro of the bug surfaced during manual smoke-testing on 2026-05-25:
    // useLocks is cross-vault (no vault_id filter), useAllFiles is scoped to
    // the active vault. If a lock's file_id isn't in the loaded files list —
    // either because it belongs to a different vault, the file was deleted,
    // or files are still loading — the screen used to filter the lock out
    // entirely, producing "shows for 2 seconds then goes blank" once
    // useAllFiles resolved.
    //
    // Correct behavior: render the lock anyway, fall back to a short file_id
    // display, so the user still sees that something is checked out.
    const folders: any[] = []; // active vault has no folders
    const files: any[] = [];   // active vault has no files
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
      <SupabaseAuthProvider client={mockResolvedClient(locks, files, folders)}>
        <WhoHasWhatScreen />
      </SupabaseAuthProvider>,
    );
    // Row renders with shortId fallback for BOTH file and user.
    expect(await screen.findByText("FILEAAAA")).toBeInTheDocument();
    expect(screen.getByText("USERBBBB")).toBeInTheDocument();
    expect(screen.queryByText(/nothing checked out/i)).toBeNull();
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
});
