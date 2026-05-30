import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FileDetailPanel } from "../../src/modules/vault/screens/FileDetailPanel";

// The detail panel now renders GetVersionButton per version, which pulls in
// the Tauri dialog/fs plugins. Mock them so rendering never touches a real
// Tauri runtime (the buttons aren't clicked in these tests).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/modules/vault/data/fs-readonly", () => ({
  setReadonly: vi.fn().mockResolvedValue(undefined),
}));
// The panel renders ReferencesPanel (Contains / Where-Used); stub the data
// hooks so this suite's lightweight mock client doesn't need the refs chains.
// ReferencesPanel has its own dedicated test.
vi.mock("../../src/modules/vault/data/useReferences", () => ({
  useContains: () => ({ data: [], loading: false, error: null }),
  useWhereUsed: () => ({ data: [], loading: false, error: null }),
}));
const setRevRun = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "vv1", revision: 1 }));
vi.mock("../../src/modules/vault/data/useSetRevision", () => ({
  useSetRevision: () => ({ run: setRevRun, loading: false, error: null }),
}));

function mockClient(versions: any[] = []): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "versions") {
        // useVersions: .select().eq().order().range()
        return {
          select: () => ({
            eq: () => ({ order: () => ({ range: (from: number, to: number) => Promise.resolve({ data: versions.slice(from, to + 1), error: null }) }) }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as any;
}

const files = [
  { id: "file-1", vault_id: "v1", folder_id: "fl1", name: "frame.sldprt", latest_version_id: null, created_at: "x" },
];

describe("<FileDetailPanel>", () => {
  it("shows the placeholder when no file is selected", () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <FileDetailPanel fileId={null} files={files as any} />
      </SupabaseAuthProvider>,
    );
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it("V13: shows the selected file's NAME in the header", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <FileDetailPanel fileId={"file-1" as any} files={files as any} />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("frame.sldprt")).toBeInTheDocument());
  });

  it("shows a Get button per version when a vault folder + folders are provided", async () => {
    const versions = [
      { id: "vv1", file_id: "file-1", version_num: 1, sha256: "s1", size_bytes: 1, author_id: null, comment: "first", parent_version_id: null, created_at: "2026-01-01" },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(versions)}>
        <FileDetailPanel fileId={"file-1" as any} files={files as any} vaultRoot="/v" folders={[]} />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByRole("button", { name: /^get$/i })).toBeInTheDocument();
  });

  it("offers Set Revision to editors and calls the RPC with the file id", async () => {
    setRevRun.mockClear();
    const versions = [
      { id: "vv1", file_id: "file-1", version_num: 1, sha256: "s1", size_bytes: 1, author_id: null, comment: "first", parent_version_id: null, revision: null, created_at: "2026-01-01" },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(versions)}>
        <FileDetailPanel fileId={"file-1" as any} files={files as any} vaultRoot="/v" folders={[]} canEdit />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /set revision/i });
    fireEvent.click(btn);
    await waitFor(() => expect(setRevRun).toHaveBeenCalledWith("file-1"));
  });

  it("hides Set Revision when the user cannot edit", async () => {
    const versions = [
      { id: "vv1", file_id: "file-1", version_num: 1, sha256: "s1", size_bytes: 1, author_id: null, comment: "first", parent_version_id: null, revision: null, created_at: "2026-01-01" },
    ];
    render(
      <SupabaseAuthProvider client={mockClient(versions)}>
        <FileDetailPanel fileId={"file-1" as any} files={files as any} />
      </SupabaseAuthProvider>,
    );
    await screen.findByRole("button", { name: /^get$/i }).catch(() => null);
    expect(screen.queryByRole("button", { name: /set revision/i })).toBeNull();
  });

  it("V13: handles a selectedFile that no longer exists in the file list", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <FileDetailPanel fileId={"deleted-file" as any} files={files as any} />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    // It must NOT show the generic "no versions yet" empty state for a file
    // that simply doesn't exist.
    expect(screen.queryByText(/no versions yet/i)).toBeNull();
  });
});
