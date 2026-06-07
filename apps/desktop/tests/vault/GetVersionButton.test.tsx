import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GetVersionButton } from "../../src/modules/vault/components/RowActions";

// Capture the real-vault read-only transitions + the per-version download.
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

function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  } as any;
}

function wrap(children: React.ReactNode) {
  return <SupabaseAuthProvider client={mockClient()}>{children}</SupabaseAuthProvider>;
}

const v2 = {
  id: "v2", file_id: "f1", version_num: 2, sha256: "sha-old",
  size_bytes: 4, author_id: "u1", comment: "older rev", parent_version_id: null, created_at: "2026-01-01",
};

describe("GetVersionButton (SW-PDM Get Version — non-destructive)", () => {
  beforeEach(() => { roCalls.length = 0; dlCalls.length = 0; dlResult.ok = true; });

  it("renders a Get button with type=button", () => {
    render(wrap(<GetVersionButton version={v2 as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} />));
    const btn = screen.getByRole("button", { name: /^get$/i });
    expect(btn).toHaveAttribute("type", "button");
  });

  it("renders nothing when the version has no sha256", () => {
    const { container } = render(wrap(<GetVersionButton version={{ ...v2, sha256: "" } as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} />));
    expect(container.querySelector("button")).toBeNull();
  });

  it("into-vault: confirms first, then downloads THAT version's sha to the local path and re-applies read-only", async () => {
    const onDone = vi.fn();
    render(wrap(<GetVersionButton version={v2 as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} onDone={onDone} />));
    fireEvent.click(screen.getByRole("button", { name: /^get$/i }));
    // Nothing destructive until the confirm is accepted (it overwrites the local copy).
    expect(dlCalls).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: /get this version/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-old", dest: "/v/a.bin" }));
    // A non-checked-out copy stays read-only after the get.
    expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("into-vault: nests folder path under the vault root", async () => {
    const folders = [{ id: "fl1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" }];
    render(wrap(<GetVersionButton version={v2 as any} fileName="a.bin" folderId={"fl1" as any} vaultRoot="/v" folders={folders as any} />));
    fireEvent.click(screen.getByRole("button", { name: /^get$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /get this version/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-old", dest: "/v/chassis/a.bin" }));
  });

  it("no vault folder: opens a save dialog and downloads to the picked path (never forces read-only)", async () => {
    const onDone = vi.fn();
    render(wrap(<GetVersionButton version={v2 as any} fileName="a.bin" folderId={null} vaultRoot={null} folders={[]} onDone={onDone} />));
    fireEvent.click(screen.getByRole("button", { name: /^get$/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-old", dest: "/tmp/picked-save.sldprt" }));
    expect(roCalls).toHaveLength(0); // a user-chosen path outside the vault is left as-is
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("into-vault: does NOT re-apply read-only or signal done when the download fails", async () => {
    dlResult.ok = false;
    const onDone = vi.fn();
    render(wrap(<GetVersionButton version={v2 as any} fileName="a.bin" folderId={null} vaultRoot="/v" folders={[]} onDone={onDone} />));
    fireEvent.click(screen.getByRole("button", { name: /^get$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /get this version/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-old", dest: "/v/a.bin" }));
    expect(roCalls).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });
});
