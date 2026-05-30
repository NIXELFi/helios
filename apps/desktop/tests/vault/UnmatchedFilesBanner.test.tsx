import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UnmatchedFilesBanner } from "../../src/modules/vault/components/UnmatchedFilesBanner";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    },
    rpc: vi.fn().mockResolvedValue({ data: {}, error: null }),
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "files") {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "fi1", name: "part.sldprt" }, error: null }),
            }),
          }),
        };
      }
      if (table === "locks") {
        return {
          insert: () => Promise.resolve({ data: { id: "l1" }, error: null }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

// Variant whose add_and_lock RPC fails, so every useAddLocalFile().run(...)
// resolves to { ok: false } — used to exercise the per-row failure path.
function failingClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: {
      from: () => ({
        list: vi.fn().mockResolvedValue({ data: [], error: null }),
        upload: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "permission denied" } }),
    from: vi.fn().mockImplementation(() => ({
      select: () => Promise.resolve({ data: [], error: null }),
    })),
  } as any;
}

const unmatched = [
  { basename: "new.sldprt", relativePath: "new.sldprt", absolutePath: "/vault/new.sldprt", sha256: "a", sizeBytes: 1 },
  { basename: "other.sldprt", relativePath: "other.sldprt", absolutePath: "/vault/other.sldprt", sha256: "b", sizeBytes: 1 },
];

function wrap(children: React.ReactNode) {
  const c = mockClient();
  return <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;
}

describe("<UnmatchedFilesBanner>", () => {
  it("renders nothing when unmatched list is empty", () => {
    const { container } = render(
      wrap(<UnmatchedFilesBanner vaultId="v1" folders={[]} unmatched={[]} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when vaultId is undefined", () => {
    const { container } = render(
      wrap(<UnmatchedFilesBanner vaultId={undefined} folders={[]} unmatched={unmatched} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders count and action buttons when there are unmatched files", () => {
    render(
      wrap(<UnmatchedFilesBanner vaultId="v1" folders={[]} unmatched={unmatched} />),
    );
    expect(screen.getByText(/2 local files not in vault/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add all to vault/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show/i })).toBeInTheDocument();
  });

  it("expanding the list shows file relative paths", () => {
    render(
      wrap(<UnmatchedFilesBanner vaultId="v1" folders={[]} unmatched={unmatched} />),
    );
    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    expect(screen.getByText("new.sldprt")).toBeInTheDocument();
    expect(screen.getByText("other.sldprt")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^add$/i })).toHaveLength(2);
  });

  it("surfaces a per-row error when a single Add fails", async () => {
    // addOne used to ignore r.ok === false entirely — only addAll aggregated
    // failures — so a failed single-row Add gave the user no feedback. It now
    // surfaces a message naming the file that failed.
    render(
      <SupabaseAuthProvider client={failingClient()}>
        <UnmatchedFilesBanner vaultId="v1" folders={[]} unmatched={unmatched} />
      </SupabaseAuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    const addButtons = screen.getAllByRole("button", { name: /^add$/i });
    await act(async () => { fireEvent.click(addButtons[0]); });
    await waitFor(() =>
      expect(screen.getByText(/failed to add "new\.sldprt"/i)).toBeInTheDocument(),
    );
  });
});
