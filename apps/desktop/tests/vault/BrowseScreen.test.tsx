import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BrowseScreen } from "../../src/modules/vault/screens/BrowseScreen";

function buildMockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "u1@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "vaults") return { select: () => Promise.resolve({ data: [{ id: "v1", name: "sdm26", created_at: "x", created_by: "u1" }], error: null }) };
      if (table === "folders") return {
        select: () => ({
          eq: () => Promise.resolve({
            data: [{ id: "f1", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" }],
            error: null,
          }),
        }),
      };
      if (table === "files") return {
        select: () => ({
          eq: () => Promise.resolve({
            data: [{ id: "fi1", vault_id: "v1", folder_id: "f1", name: "frame.sldprt", latest_version_id: null, created_at: "x" }],
            error: null,
          }),
        }),
      };
      if (table === "locks") return {
        select: () => ({ is: () => Promise.resolve({ data: [], error: null }) }),
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
    await waitFor(() => expect(screen.getByRole("button", { name: /chassis/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /chassis/i }));
    await waitFor(() => expect(screen.getByText("frame.sldprt")).toBeInTheDocument());
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
});
