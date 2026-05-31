import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SettingsScreen } from "../../src/modules/vault/screens/SettingsScreen";

// Mock Tauri dialog so tests don't require a real Tauri runtime.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue("/Users/me/SDM26-Vault"),
}));

function mockClient(role: string | null = "editor", isAdmin = false): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "test@sdm.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    rpc: (name: string) => {
      if (name === "pdm_is_admin") return Promise.resolve({ data: isAdmin, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === "user_roles") {
        // useMyRole now filters to the global row: .eq().is("vault_id", null).maybeSingle()
        const result = Promise.resolve({ data: role ? { role } : null, error: null });
        return {
          select: () => ({
            eq: () => ({
              is: () => ({ maybeSingle: () => result }),
              maybeSingle: () => result,
            }),
          }),
        };
      }
      if (table === "vaults") {
        // Settings shows a per-vault local-folder picker, so a vault must exist
        // for the picker to be enabled.
        return {
          select: () => Promise.resolve({
            data: [{
              id: "v1", name: "SDM26",
              created_at: "2026-05-11T18:32:17.728358+00:00",
              created_by: "u1",
            }],
            error: null,
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

describe("<SettingsScreen>", () => {
  beforeEach(() => localStorage.clear());

  it("renders signed-in email and role", async () => {
    render(
      <SupabaseAuthProvider client={mockClient("editor")}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("test@sdm.com")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("editor")).toBeInTheDocument());
  });

  it("sign out button calls client.auth.signOut", async () => {
    const c = mockClient("editor");
    render(
      <SupabaseAuthProvider client={c}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /sign out/i });
    await act(async () => { fireEvent.click(btn); });
    expect(c.auth.signOut).toHaveBeenCalled();
  });

  it("H5: a failed sign-out is caught and surfaced, not left unhandled", async () => {
    const c = mockClient("editor");
    (c.auth.signOut as any) = vi.fn().mockRejectedValue(new Error("network down"));
    render(
      <SupabaseAuthProvider client={c}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: /sign out/i });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });

  it("H5: Auto/Manual toggle exposes aria-pressed reflecting the active mode", async () => {
    render(
      <SupabaseAuthProvider client={mockClient("editor")}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    // Default mode for an unset vault is "manual".
    const autoBtn = await screen.findByRole("button", { name: /auto — download everything/i });
    const manualBtn = screen.getByRole("button", { name: /manual — download on click/i });
    expect(manualBtn).toHaveAttribute("aria-pressed", "true");
    expect(autoBtn).toHaveAttribute("aria-pressed", "false");

    await act(async () => { fireEvent.click(autoBtn); });
    expect(autoBtn).toHaveAttribute("aria-pressed", "true");
    expect(manualBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("pick Helios folder button stores a single root in localStorage", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <SettingsScreen />
      </SupabaseAuthProvider>,
    );
    const pickBtn = await screen.findByRole("button", { name: /pick helios folder/i });
    await act(async () => { fireEvent.click(pickBtn); });
    await waitFor(() => {
      // Shared-root model: a single string at this key, not a JSON map.
      expect(localStorage.getItem("helios.vault.localFolder")).toBe("/Users/me/SDM26-Vault");
    });
    expect(await screen.findByText("/Users/me/SDM26-Vault")).toBeInTheDocument();
  });
});
