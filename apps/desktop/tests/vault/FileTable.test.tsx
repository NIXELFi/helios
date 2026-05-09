import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FileTable } from "../../src/modules/vault/components/FileTable";

// Mock Tauri plugins so tests don't need a real Tauri runtime.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue("/tmp/fake.sldprt"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

const files = [
  { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: "ver1", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", folder_id: null, name: "wheel.sldprt", latest_version_id: null, created_at: "2026-01-01" },
];

function mockClient(overrides: Partial<SupabaseClient> = {}): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "locks") {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
                  error: null,
                }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    ...overrides,
  } as any;
}

function wrap(client: SupabaseClient, children: React.ReactNode) {
  return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
}

describe("<FileTable>", () => {
  it("renders one row per file", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={() => {}} />,
      ),
    );
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText("wheel.sldprt")).toBeInTheDocument();
  });

  it("emits onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={onSelect} />,
      ),
    );
    fireEvent.click(screen.getByText("frame.sldprt"));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });

  it("shows 'Locked by me' badge when current user holds the lock", () => {
    const locks = [{ id: "l1", file_id: "f1", user_id: "u", acquired_at: "x", released_at: null, force_released_by: null }];
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={locks as any} currentUserId="u" onSelect={() => {}} />,
      ),
    );
    expect(screen.getByText(/locked by me/i)).toBeInTheDocument();
  });

  it("Check Out button appears on a non-locked file when canEdit", async () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" canEdit={true} onSelect={() => {}} />,
      ),
    );
    // One Check Out per unlocked file
    const btns = await screen.findAllByRole("button", { name: /check out/i });
    expect(btns.length).toBe(2);
  });

  it("Check Out button is hidden when canEdit is false", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" canEdit={false} onSelect={() => {}} />,
      ),
    );
    expect(screen.queryByRole("button", { name: /check out/i })).toBeNull();
  });

  it("Locked-by-me row shows Check In and Cancel buttons", () => {
    const locks = [{ id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null }];
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={locks as any} currentUserId="u1" canEdit={true} onSelect={() => {}} />,
      ),
    );
    expect(screen.getByRole("button", { name: /check in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("Click on action button does not trigger row onSelect", async () => {
    const onSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" canEdit={true} onSelect={onSelect} />,
      ),
    );
    const btns = await screen.findAllByRole("button", { name: /check out/i });
    fireEvent.click(btns[0]);
    // onSelect must NOT be called
    expect(onSelect).not.toHaveBeenCalled();
  });
});
