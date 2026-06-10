import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider, useAuthLoading } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BulkActionBar } from "../../src/modules/vault/components/BulkActionBar";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

function mockClient(isAdmin = false, lockError: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin" || name === "pdm_is_admin_in")
        return Promise.resolve({ data: isAdmin, error: null });
      // pdm_cancel_checkout
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from: () => ({
        download: vi.fn().mockResolvedValue({ data: new Blob([new Uint8Array([1])]), error: null }),
      }),
    },
    from: (table: string) => {
      if (table === "locks") {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: lockError
                    ? null
                    : { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
                  error: lockError,
                }),
            }),
          }),
        };
      }
      if (table === "files") {
        return {
          delete: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

function wrap(client: SupabaseClient) {
  return ({ children }: { children: ReactNode }) => (
    <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>
  );
}

/** A deferred promise whose resolution we control from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Client whose storage `download` blocks on a caller-controlled deferred, so a
 * test can suspend the bulk-download loop mid-flight (after item 1 starts,
 * before it resolves) and observe what happens on unmount. `download` is a
 * spy so the test can assert how many items the loop actually started.
 */
function controllableDownloadClient(gate: Promise<unknown>) {
  const download = vi.fn().mockImplementation(async () => {
    await gate;
    return { data: new Blob([new Uint8Array([1])]), error: null };
  });
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) =>
      name === "pdm_is_admin"
        ? Promise.resolve({ data: false, error: null })
        : Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({ download }) },
    from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
  } as any;
  return { client, download };
}

describe("<BulkActionBar>", () => {
  it("renders nothing when no files are selected", () => {
    const { container } = render(
      <SupabaseAuthProvider client={mockClient()}>
        <BulkActionBar selectedIds={[]} onClear={() => {}} onDone={() => {}} />
      </SupabaseAuthProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows Check Out / Cancel Checkout for all users; Delete only for admin", async () => {
    // vaultId is required: the Delete gate is the PER-VAULT admin check
    // (useIsVaultAdmin), matching what pdm_delete_file actually authorizes.
    const Comp = ({ isAdmin }: { isAdmin: boolean }) => (
      <SupabaseAuthProvider client={mockClient(isAdmin)}>
        <BulkActionBar selectedIds={["f1", "f2"]} onClear={() => {}} onDone={() => {}} vaultId={"v1" as any} />
      </SupabaseAuthProvider>
    );

    // Non-admin
    const { rerender } = render(<Comp isAdmin={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /check out/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /cancel checkout/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();

    // Admin
    rerender(<Comp isAdmin={true} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument());
  });

  it("bulk delete shows confirmation modal before running", async () => {
    render(
      <SupabaseAuthProvider client={mockClient(true)}>
        <BulkActionBar selectedIds={["f1"]} onClear={() => {}} onDone={() => {}} vaultId={"v1" as any} />
      </SupabaseAuthProvider>,
    );
    // Wait for admin status to resolve
    await waitFor(() => expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    // Confirmation modal appears — and is honest: it's a soft delete to the
    // Deleted tab, not a permanent destruction of versions/history.
    await waitFor(() => expect(screen.getByText(/move to this vault.s deleted tab/i)).toBeInTheDocument());
    // Cancel button inside the modal closes it
    const cancelBtns = screen.getAllByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtns[0]);
    await waitFor(() => expect(screen.queryByText(/this cannot be undone/i)).toBeNull());
  });

  it("Check In Changes button appears when selected files have modified local copies", () => {
    const files = [
      { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: null, created_at: "x" },
    ];
    const localFiles = [
      { basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/vault/frame.sldprt", sha256: "abc", sizeBytes: 1 },
    ];
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <BulkActionBar
          selectedIds={["f1"]}
          onClear={() => {}}
          onDone={() => {}}
          files={files as any}
          localFiles={localFiles}
          versionsByFileId={new Map()}
        />
      </SupabaseAuthProvider>,
    );
    expect(screen.getByRole("button", { name: /check in changes/i })).toBeInTheDocument();
  });

  it("Check In Changes button does not appear when no local files are provided", () => {
    const files = [
      { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: null, created_at: "x" },
    ];
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <BulkActionBar
          selectedIds={["f1"]}
          onClear={() => {}}
          onDone={() => {}}
          files={files as any}
          localFiles={null}
          versionsByFileId={new Map()}
        />
      </SupabaseAuthProvider>,
    );
    expect(screen.queryByRole("button", { name: /check in changes/i })).toBeNull();
  });

  it("Get Latest button appears when at least one selected file is vault-only and vaultRoot is set", () => {
    const files = [
      { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: "ver1", created_at: "x" },
    ];
    const versions = new Map([
      ["f1", [{ id: "ver1", file_id: "f1", version_num: 1, sha256: "abc123", size_bytes: 10, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
    ]);
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <BulkActionBar
          selectedIds={["f1"]}
          onClear={() => {}}
          onDone={() => {}}
          files={files as any}
          localFiles={[]}
          versionsByFileId={versions as any}
          vaultRoot="/Users/me/Vault"
          folders={[]}
        />
      </SupabaseAuthProvider>,
    );
    // f1 is vault-only (no local match), has a version sha, and vaultRoot is set → show Get Latest
    expect(screen.getByRole("button", { name: /get latest/i })).toBeInTheDocument();
  });

  it("bulk check out reports success status after running", async () => {
    const onDone = vi.fn();
    const c = mockClient(false);
    const wrapper = wrap(c);
    // Wait for auth to be ready
    const { result: authResult } = renderHook(() => useAuthLoading(), { wrapper });
    await waitFor(() => expect(authResult.current).toBe(false));

    render(
      <SupabaseAuthProvider client={c}>
        <BulkActionBar selectedIds={["f1", "f2"]} onClear={() => {}} onDone={onDone} />
      </SupabaseAuthProvider>,
    );
    const checkOutBtn = await screen.findByRole("button", { name: /check out/i });
    await act(async () => { fireEvent.click(checkOutBtn); });
    await waitFor(() => expect(screen.getByText(/checked out 2\/2/i)).toBeInTheDocument());
    expect(onDone).toHaveBeenCalled();
  });

  it("disables Check Out when every selected row is already locked by another user", async () => {
    // Regression guard for the 2026-05-25 audit fix: clicking Check Out
    // used to fire `acquireLock.run` on every selected file regardless of
    // existing lock state, producing a cryptic "0/3 (3 failed)" toast
    // because the server rejects with a unique-constraint error. Per-row
    // gating in the bar now disables the button when nothing's eligible.
    const c = mockClient(false);
    const locks = [
      { id: "l1", file_id: "f1", user_id: "other-user", acquired_at: "x", released_at: null, force_released_by: null },
      { id: "l2", file_id: "f2", user_id: "other-user", acquired_at: "x", released_at: null, force_released_by: null },
    ];
    const { result: authResult } = renderHook(() => useAuthLoading(), { wrapper: wrap(c) });
    await waitFor(() => expect(authResult.current).toBe(false));

    render(
      <SupabaseAuthProvider client={c}>
        <BulkActionBar
          selectedIds={["f1", "f2"]}
          onClear={() => {}}
          onDone={() => {}}
          locks={locks as any}
          currentUserId="u1"
        />
      </SupabaseAuthProvider>,
    );
    const checkOutBtn = await screen.findByRole("button", { name: /check out/i });
    expect(checkOutBtn).toBeDisabled();
    expect(checkOutBtn).toHaveAttribute("title", expect.stringMatching(/already locked/i));
  });

  it("disables Cancel Checkout when no selected row is locked by the current user", async () => {
    const c = mockClient(false);
    const locks = [
      { id: "l1", file_id: "f1", user_id: "other-user", acquired_at: "x", released_at: null, force_released_by: null },
    ];
    const { result: authResult } = renderHook(() => useAuthLoading(), { wrapper: wrap(c) });
    await waitFor(() => expect(authResult.current).toBe(false));

    render(
      <SupabaseAuthProvider client={c}>
        <BulkActionBar
          selectedIds={["f1"]}
          onClear={() => {}}
          onDone={() => {}}
          locks={locks as any}
          currentUserId="u1"
        />
      </SupabaseAuthProvider>,
    );
    const cancelBtn = await screen.findByRole("button", { name: /cancel checkout/i });
    expect(cancelBtn).toBeDisabled();
  });

  it("Check Out only runs on rows the user CAN check out — reports skipped + locked-by-other counts", async () => {
    // Mixed selection: one unlocked (gets checked out), one held by user
    // (skipped as "already yours"), one held by another user (skipped as
    // "locked by other user"). Net status is "Checked out 1/3 (...)".
    const c = mockClient(false);
    const locks = [
      { id: "l1", file_id: "f2", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
      { id: "l2", file_id: "f3", user_id: "other-user", acquired_at: "x", released_at: null, force_released_by: null },
    ];
    const { result: authResult } = renderHook(() => useAuthLoading(), { wrapper: wrap(c) });
    await waitFor(() => expect(authResult.current).toBe(false));

    render(
      <SupabaseAuthProvider client={c}>
        <BulkActionBar
          selectedIds={["f1", "f2", "f3"]}
          onClear={() => {}}
          onDone={() => {}}
          locks={locks as any}
          currentUserId="u1"
        />
      </SupabaseAuthProvider>,
    );
    const checkOutBtn = await screen.findByRole("button", { name: /check out/i });
    expect(checkOutBtn).not.toBeDisabled();
    await act(async () => { fireEvent.click(checkOutBtn); });
    await waitFor(() => expect(screen.getByText(/checked out 1\/3/i)).toBeInTheDocument());
    expect(screen.getByText(/1 locked by other user/i)).toBeInTheDocument();
    expect(screen.getByText(/1 already yours/i)).toBeInTheDocument();
  });

  it("the status span is an aria-live region so results are announced", async () => {
    const c = mockClient(false);
    const { result: authResult } = renderHook(() => useAuthLoading(), { wrapper: wrap(c) });
    await waitFor(() => expect(authResult.current).toBe(false));
    render(
      <SupabaseAuthProvider client={c}>
        <BulkActionBar selectedIds={["f1", "f2"]} onClear={() => {}} onDone={() => {}} />
      </SupabaseAuthProvider>,
    );
    const checkOutBtn = await screen.findByRole("button", { name: /check out/i });
    await act(async () => { fireEvent.click(checkOutBtn); });
    const live = await screen.findByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent(/checked out 2\/2/i);
  });

  it("Get Latest loop aborts on unmount — stops starting downloads for remaining files", async () => {
    // V6: the bulk loops had no AbortController, so they kept downloading and
    // calling setState after the component unmounted. The loop now bails on
    // the abort signal; once unmounted, no further file is downloaded.
    const gate = deferred<void>();
    const { client, download } = controllableDownloadClient(gate.promise);
    const { result: authResult } = renderHook(() => useAuthLoading(), { wrapper: wrap(client) });
    await waitFor(() => expect(authResult.current).toBe(false));

    const files = [
      { id: "f1", vault_id: "v", folder_id: null, name: "a.sldprt", latest_version_id: "v1", created_at: "x" },
      { id: "f2", vault_id: "v", folder_id: null, name: "b.sldprt", latest_version_id: "v2", created_at: "x" },
    ];
    const versions = new Map([
      ["f1", [{ id: "v1", file_id: "f1", version_num: 1, sha256: "aa", size_bytes: 1, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
      ["f2", [{ id: "v2", file_id: "f2", version_num: 1, sha256: "bb", size_bytes: 1, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
    ]);

    const { unmount } = render(
      <SupabaseAuthProvider client={client}>
        <BulkActionBar
          selectedIds={["f1", "f2"]}
          onClear={() => {}}
          onDone={() => {}}
          files={files as any}
          localFiles={[]}
          versionsByFileId={versions as any}
          vaultRoot="/Users/me/Vault"
          folders={[]}
        />
      </SupabaseAuthProvider>,
    );

    const getLatest = await screen.findByRole("button", { name: /get latest/i });
    await act(async () => { fireEvent.click(getLatest); });
    // The first download is in flight (blocked on the gate); the second hasn't
    // started yet because the loop awaits each download in turn.
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));

    // Unmount mid-flight, then release the in-flight download and let every
    // queued microtask + macrotask settle. With the abort guard the loop
    // returns after the first download; without it, it would fall through to
    // start the second file's download.
    unmount();
    await act(async () => {
      gate.resolve();
      // Flush the full async chain (arrayBuffer → gunzip → sha verify → loop).
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The loop saw the abort after the first download resolved and returned —
    // it never started the second file's download.
    expect(download).toHaveBeenCalledTimes(1);
  });
});
