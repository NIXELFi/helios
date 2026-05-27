import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
  // Override createSupabaseClient to return a controllable mock.
  return {
    ...actual,
    createSupabaseClient: () =>
      ({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signInWithPassword: vi.fn(),
        },
      } as any),
  };
});

// Import after the mock so Shell picks it up.
import App from "../src/Shell";

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
});
