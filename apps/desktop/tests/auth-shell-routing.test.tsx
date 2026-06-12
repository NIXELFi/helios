import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Stub the Logs app so this test only exercises Shell's routing logic
// (default active module, switching to Vault) without pulling in Tauri
// runtime calls or maplibre-gl that won't work in jsdom.
//
// Note: this is NOT a Supabase integration test — createSupabaseClient is
// mocked. We only verify Shell routes between Logs and the Vault login pane
// based on auth state.
vi.mock("../src/App", () => ({
  default: () => <div data-testid="logs-app">Logs</div>,
}));

// Stub the heavy modules so we can assert *whether* they mount without
// pulling in Supabase queries / CFD state. A mounted VaultModule renders its
// testid; if it's not in the tree the module isn't mounted.
vi.mock("../src/modules/vault", () => ({
  VaultModule: () => <div data-testid="vault-module">Vault</div>,
}));
vi.mock("../src/modules/cfd", () => ({
  CfdModule: () => <div data-testid="cfd-module">CFD</div>,
}));

// Captures the latest onAuthStateChange callback so a test can push a
// signed-in session in and out, driving the provider's user state.
let authCallback: ((event: string, session: unknown) => void) | null = null;

function makeFakeUser() {
  return { id: "u1", email: "nick@example.com", user_metadata: {} };
}

// useMyRole's user_roles lookup is routed through this so individual tests can
// control what role (and how quickly) each user resolves to.
let roleResolver: (userId: string) => Promise<{ data: { role: string } | null; error: unknown }>
  = () => Promise.resolve({ data: null, error: null });

vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
  // Override createSupabaseClient to return a controllable mock.
  return {
    ...actual,
    createSupabaseClient: () =>
      ({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
            authCallback = cb;
            return { data: { subscription: { unsubscribe: () => { authCallback = null; } } } };
          },
          signInWithPassword: vi.fn(),
        },
        // useMyRole queries user_roles on sign-in; route through roleResolver.
        // It no longer uses .maybeSingle() (that errors for multi-role users) —
        // it awaits .eq() and reads an ARRAY of rows. Adapt the single-role
        // resolver into that array shape so the existing test bodies stand.
        from: () => ({
          select: () => ({
            eq: (_col: string, userId: string) =>
              roleResolver(userId).then((r) => ({
                data: r.data ? [{ role: r.data.role, vault_id: null }] : [],
                error: r.error,
              })),
          }),
        }),
      } as any),
  };
});

// Import after the mock so Shell picks it up.
import App from "../src/Shell";
import { AuthShell, useMyRole } from "../src/auth/AuthShell";

afterEach(() => {
  cleanup();
  authCallback = null;
  roleResolver = () => Promise.resolve({ data: null, error: null });
});

describe("Shell auth-based routing", () => {
  it("opens to Logs with the auth modal closed", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("logs-app")).toBeInTheDocument();
    });
    // The auth modal is not open on boot.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Logged out → the sidebar shows a Sign in pill.
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });

  it("opens the auth modal when the greyed-out Vault button is clicked", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /vault/i })).toBeInTheDocument();
    });
    // Logged out → Vault is disabled; clicking it routes to the auth modal
    // instead of navigating into the module.
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(vaultBtn);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  // S1: signing out while on Vault must clear "vault" from the visited set so
  // a subsequent sign-in does NOT silently remount VaultModule (and fire its
  // Supabase queries) while it's hidden. Without the fix, VaultModule stays in
  // the visited set and re-renders hidden the instant the user signs back in.
  it("does not remount VaultModule hidden after sign-out → sign-in (S1)", async () => {
    // A live connection is required for the provider to wire onAuthStateChange.
    localStorage.setItem(
      "helios:supabase-connection",
      JSON.stringify({ url: "https://example.supabase.co", anonKey: "anon-key" }),
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("logs-app")).toBeInTheDocument();
    });
    await waitFor(() => expect(authCallback).not.toBeNull());

    // Sign in.
    act(() => {
      authCallback!("SIGNED_IN", { user: makeFakeUser() });
    });

    // Navigate into Vault — now it's the active module and gets mounted.
    await waitFor(() => {
      const vaultBtn = screen.getByRole("button", { name: /vault/i });
      expect(vaultBtn).not.toHaveAttribute("aria-disabled", "true");
    });
    fireEvent.click(screen.getByRole("button", { name: /vault/i }));
    await waitFor(() => {
      expect(screen.getByTestId("vault-module")).toBeInTheDocument();
    });

    // Sign out — Shell should bounce to Logs AND drop Vault from visited.
    act(() => {
      authCallback!("SIGNED_OUT", null);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("vault-module")).not.toBeInTheDocument();
    });

    // Sign back in. The active module is Logs (we were bounced), so Vault must
    // NOT silently mount in the background.
    act(() => {
      authCallback!("SIGNED_IN", { user: makeFakeUser() });
    });
    // Give any stray effect a tick to (incorrectly) remount the module.
    await waitFor(() => {
      expect(screen.getByTestId("logs-app")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("vault-module")).not.toBeInTheDocument();
  });
});

// S4: useMyRole must not show the previous user's role during the in-flight
// window after the user changes — it should reset to null before the new fetch
// resolves.
describe("useMyRole role reset on user change (S4)", () => {
  function RoleProbe() {
    const role = useMyRole();
    return <div data-testid="role">{role ?? "none"}</div>;
  }

  it("resets role to null when the signed-in user changes", async () => {
    localStorage.setItem(
      "helios:supabase-connection",
      JSON.stringify({ url: "https://example.supabase.co", anonKey: "anon-key" }),
    );

    // First user resolves to "admin" immediately.
    roleResolver = () => Promise.resolve({ data: { role: "admin" }, error: null });

    render(
      <AuthShell>
        <RoleProbe />
      </AuthShell>,
    );
    await waitFor(() => expect(authCallback).not.toBeNull());

    // Sign in user u1 → role becomes "admin".
    act(() => authCallback!("SIGNED_IN", { user: { id: "u1", user_metadata: {} } }));
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("admin"));

    // Switch to user u2 whose role fetch is deferred. The hook must clear the
    // stale "admin" before u2's fetch resolves.
    let resolveU2: ((v: { data: { role: string } | null; error: unknown }) => void) | undefined;
    roleResolver = () => new Promise((r) => { resolveU2 = r; });
    act(() => authCallback!("SIGNED_IN", { user: { id: "u2", user_metadata: {} } }));

    // In-flight window: role must NOT still read "admin".
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("none"));

    // Now resolve u2's role.
    act(() => resolveU2?.({ data: { role: "viewer" }, error: null }));
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("viewer"));
  });

  // ROLE-FLICKER: onAuthStateChange hands a NEW user object on benign events
  // (incl. the hourly TOKEN_REFRESHED) with the SAME id. The role must NOT be
  // reset/refetched on those — keying on user.id means the role tag doesn't
  // blink. We assert both: the role never drops back to "none", and the fetch
  // does not fire a second time.
  it("does NOT reset or refetch role on a token refresh for the same user id", async () => {
    localStorage.setItem(
      "helios:supabase-connection",
      JSON.stringify({ url: "https://example.supabase.co", anonKey: "anon-key" }),
    );

    let fetches = 0;
    roleResolver = () => {
      fetches += 1;
      return Promise.resolve({ data: { role: "admin" }, error: null });
    };

    render(
      <AuthShell>
        <RoleProbe />
      </AuthShell>,
    );
    await waitFor(() => expect(authCallback).not.toBeNull());

    // Initial sign-in resolves to "admin".
    act(() => authCallback!("SIGNED_IN", { user: { id: "u1", user_metadata: {} } }));
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("admin"));
    expect(fetches).toBe(1);

    // A TOKEN_REFRESHED with a brand-new user object (same id) must be a no-op
    // for the role: no reset to "none", no second fetch.
    act(() =>
      authCallback!("TOKEN_REFRESHED", {
        user: { id: "u1", user_metadata: { display_name: "changed" } },
      }),
    );
    // Give any (incorrect) reset effect a tick to run.
    await Promise.resolve();
    expect(screen.getByTestId("role")).toHaveTextContent("admin");
    expect(fetches).toBe(1);
  });
});
