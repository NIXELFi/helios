import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RestoreVersionButton } from "../../src/modules/vault/components/RowActions";

const roCalls = vi.hoisted(() => [] as Array<{ path: string; readonly: boolean }>);
vi.mock("../../src/modules/vault/data/fs-readonly", () => ({
  setReadonly: (path: string, readonly: boolean) => { roCalls.push({ path, readonly }); return Promise.resolve(); },
  flipSwReadonly: vi.fn(),
}));
const dlCalls = vi.hoisted(() => [] as Array<{ sha: string; dest: string }>);
const dlResult = vi.hoisted(() => ({ ok: true }));
vi.mock("../../src/modules/vault/data/useDownloadVersion", () => ({
  useDownloadVersion: () => ({
    run: (sha: string, dest: string) => { dlCalls.push({ sha, dest }); return Promise.resolve(dlResult.ok); },
    loading: false, error: null,
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue("/tmp/fake.sldprt"),
  save: vi.fn().mockResolvedValue("/tmp/picked-save.sldprt"),
}));

let capturedRpc: { name: string; args: any } | null = null;

const RESTORED_ROW = {
  id: "v3", file_id: "f1", version_num: 3, sha256: "sha-old",
  size_bytes: 4, author_id: "u1", comment: "Restored from v2", parent_version_id: "v2", created_at: "2026-06-10",
};

function mockClient(rpcError: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => {
      capturedRpc = { name, args };
      return Promise.resolve({ data: rpcError ? null : RESTORED_ROW, error: rpcError });
    },
  } as any;
}

function wrap(client: SupabaseClient, children: React.ReactNode) {
  return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
}

const v2 = {
  id: "v2", file_id: "f1", version_num: 2, sha256: "sha-old",
  size_bytes: 4, author_id: "u1", comment: "older rev", parent_version_id: null, created_at: "2026-01-01",
};

describe("RestoreVersionButton (SW-PDM rollback — non-destructive)", () => {
  beforeEach(() => { capturedRpc = null; roCalls.length = 0; dlCalls.length = 0; dlResult.ok = true; });

  it("renders nothing when the version has no sha256", () => {
    const { container } = render(wrap(mockClient(),
      <RestoreVersionButton version={{ ...v2, sha256: "" } as any} fileId={"f1" as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} />));
    expect(container.querySelector("button")).toBeNull();
  });

  it("confirms first, calls pdm_restore_version, then materializes the restored content read-only", async () => {
    const onDone = vi.fn();
    render(wrap(mockClient(),
      <RestoreVersionButton version={v2 as any} fileId={"f1" as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} onDone={onDone} />));
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    // Nothing happens server-side until the confirm is accepted.
    expect(capturedRpc).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /restore as latest/i }));
    await waitFor(() => expect(capturedRpc?.name).toBe("pdm_restore_version"));
    expect(capturedRpc?.args).toMatchObject({ p_file_id: "f1", p_version_id: "v2" });
    // Local copy gets the restored bytes and goes read-only (the RPC released
    // the lock — this is a check-in, not a check-out).
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-old", dest: "/v/a.bin" }));
    expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("surfaces the RPC error (e.g. no lock held) and offers Retry; no download happens", async () => {
    render(wrap(mockClient({ message: "check the file out first — restoring a version checks in that version's content" }),
      <RestoreVersionButton version={v2 as any} fileId={"f1" as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} />));
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /restore as latest/i }));
    const btn = await screen.findByRole("button", { name: /retry/i });
    expect(btn).toHaveAttribute("title", expect.stringContaining("check the file out"));
    expect(dlCalls).toHaveLength(0);
    expect(roCalls).toHaveLength(0);
  });

  it("still signals done when the local materialization fails (vault row is already correct)", async () => {
    dlResult.ok = false;
    const onDone = vi.fn();
    render(wrap(mockClient(),
      <RestoreVersionButton version={v2 as any} fileId={"f1" as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} onDone={onDone} />));
    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /restore as latest/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(roCalls).toHaveLength(0); // failed download never flips read-only
  });
});
