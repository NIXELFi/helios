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
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
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
    const Comp = ({ isAdmin }: { isAdmin: boolean }) => (
      <SupabaseAuthProvider client={mockClient(isAdmin)}>
        <BulkActionBar selectedIds={["f1", "f2"]} onClear={() => {}} onDone={() => {}} />
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
        <BulkActionBar selectedIds={["f1"]} onClear={() => {}} onDone={() => {}} />
      </SupabaseAuthProvider>,
    );
    // Wait for admin status to resolve
    await waitFor(() => expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    // Confirmation modal appears
    await waitFor(() => expect(screen.getByText(/this cannot be undone/i)).toBeInTheDocument());
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
});
