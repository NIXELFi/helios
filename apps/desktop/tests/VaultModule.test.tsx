import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import { VaultModule } from "../src/modules/vault";

describe("<VaultModule>", () => {
  it("shows a loading notice while the session resolves", () => {
    // Auth gating moved to the Shell (sidebar pill + Vault grey-out); the
    // module itself only renders a loading notice until getSession()
    // resolves. A never-resolving getSession keeps loading=true.
    const c = {
      auth: {
        getSession: () => new Promise(() => {}),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    } as any;
    render(
      <SupabaseAuthProvider client={c}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows the Vault sub-navigation when authenticated AND granted a role", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    };
    // The module gate (useVaultAccess) now asks the pdm_has_vault_access
    // probe — a single boolean covering legacy rows AND capability grants.
    // BrowseScreen's useMyRole still reads user_roles via the mock chain.
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signInWithPassword: vi.fn(),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "vaults") return { select: () => Promise.resolve({ data: [], error: null }) };
        if (table === "folders") return { select: () => ({ eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }) }) };
        if (table === "files") return { select: () => ({ eq: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }) }) };
        if (table === "locks") return { select: () => ({ is: () => ({ order: () => { const node: any = { order: () => node, range: () => Promise.resolve({ data: [], error: null }) }; return node; } }) }) };
        if (table === "user_roles") return { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [{ role: "admin" }], error: null }) }) }) };
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }),
      rpc: (name: string) =>
        Promise.resolve({ data: name === "pdm_has_vault_access", error: null }),
    } as any;
    render(
      <SupabaseAuthProvider client={c}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /checkouts/i })).toBeInTheDocument();
  });

  it("shows a 'not authorized yet' notice when the signed-in user has no role", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "newbie@x.com" },
    };
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "user_roles") return { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) };
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }),
      rpc: () => Promise.resolve({ data: false, error: null }),
    } as any;
    render(
      <SupabaseAuthProvider client={c}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/isn't authorized yet/i)).toBeInTheDocument();
    });
    // Surfaces the email so the user knows which account to get granted.
    expect(screen.getByText(/newbie@x\.com/)).toBeInTheDocument();
    // The vault sub-nav must NOT render for a role-less user.
    expect(screen.queryByRole("button", { name: /browse/i })).not.toBeInTheDocument();
  });

  it("surfaces a backend error from the role lookup", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    };
    const c = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: vi.fn().mockImplementation((_table: string) => {
        return { select: () => Promise.resolve({ data: [], error: null }) };
      }),
      rpc: () =>
        Promise.resolve({ data: null, error: { message: "function pdm_has_vault_access does not exist" } }),
    } as any;
    render(
      <SupabaseAuthProvider client={c}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/couldn't verify vault access/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/pdm_has_vault_access does not exist/i)).toBeInTheDocument();
  });
});
