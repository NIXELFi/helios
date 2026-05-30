import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HistoryScreen } from "../../src/modules/vault/screens/HistoryScreen";

interface Opts {
  // null → folders query never resolves (stays loading). Otherwise resolves
  // with this error (or empty data on null-error).
  foldersError?: any;
  foldersHang?: boolean;
  // Folders/files/locks/users to drive the holder-name wiring test.
  folders?: any[];
  files?: any[];
  locks?: any[];
  users?: any[];
}

function mockClient(opts: Opts = {}): SupabaseClient {
  const {
    foldersError = null,
    foldersHang = false,
    folders = [],
    files = [],
    locks = [],
    users = [],
  } = opts;
  // range() must honor (from,to) slicing — fetchAllRows pages until it sees a
  // short page, so a source that ignores range and always returns the full
  // array loops until the runaway guard trips.
  const okChain = (data: any[]) => ({
    select: () => ({
      eq: () => ({ order: () => { const node: any = { order: () => node, range: (from: number, to: number) => Promise.resolve({ data: data.slice(from, to + 1), error: null }) }; return node; } }),
    }),
  });
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "v", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "locks") {
        // useLocks: .select().is().order().range() — paginated via fetchAllRows,
        // so range() must slice (an always-full source loops to the guard).
        return {
          select: () => ({
            is: () => ({ order: () => ({ range: (from: number, to: number) => Promise.resolve({ data: locks.slice(from, to + 1), error: null }) }) }),
          }),
        };
      }
      if (table === "folders") {
        if (foldersHang) {
          return { select: () => ({ eq: () => ({ order: () => { const node: any = { order: () => node, range: () => new Promise(() => {}) }; return node; } }) }) };
        }
        if (foldersError) {
          return { select: () => ({ eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: null, error: foldersError }) }; return node; } }) }) };
        }
        return okChain(folders);
      }
      if (table === "files") return okChain(files);
      return okChain([]);
    }),
    rpc: (name: string) => {
      if (name === "pdm_admin_list_users") return Promise.resolve({ data: users, error: null });
      return Promise.resolve({ data: false, error: null });
    },
  } as any;
}

describe("<HistoryScreen>", () => {
  it("shows 'Pick a folder' empty state initially", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/pick a folder/i)).toBeInTheDocument());
    expect(screen.getByText(/pick a file to see its history/i)).toBeInTheDocument();
  });

  it("V18: shows a folders loading state distinct from the empty copy", async () => {
    render(
      <SupabaseAuthProvider client={mockClient({ foldersHang: true })}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/loading folders/i)).toBeInTheDocument());
  });

  it("V18: surfaces a folders query error", async () => {
    render(
      <SupabaseAuthProvider client={mockClient({ foldersError: { message: "folders boom" } })}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/folders boom/i)).toBeInTheDocument());
  });

  it("LOW: wires holder names so a locked-by-other row reads 'Locked by <name>'", async () => {
    // HistoryScreen passed no holderEmailById → generic "Locked by other".
    // Now it resolves the holder via useVaultUsers (display_name-first).
    const folders = [{ id: "fold-1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" }];
    const files = [{ id: "file-1", vault_id: "v1", folder_id: "fold-1", name: "frame.sldprt", latest_version_id: null, created_at: "x" }];
    const locks = [
      // Locked by someone OTHER than the current user (u1).
      { id: "l1", file_id: "file-1", user_id: "u-other", acquired_at: "x", released_at: null, force_released_by: null },
    ];
    const users = [
      { user_id: "u-other", email: "alice@sdm.com", display_name: "Alice A", subteam: null, role: "editor", granted_at: "x", created_at: "x" },
    ];
    render(
      <SupabaseAuthProvider client={mockClient({ folders, files, locks, users })}>
        <HistoryScreen />
      </SupabaseAuthProvider>,
    );
    // Pick the folder so the file table loads.
    const folderRow = await screen.findByRole("button", { name: "chassis" });
    await act(async () => { fireEvent.click(folderRow); });
    // The locked-by-other row names the holder by display name, not the
    // generic fallback.
    expect(await screen.findByText(/Locked by Alice A/i)).toBeInTheDocument();
    expect(screen.queryByText(/Locked by other/i)).toBeNull();
  });
});
