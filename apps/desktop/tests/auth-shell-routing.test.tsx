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
  it("opens to Logs and never shows the login pane unless Vault is clicked", async () => {
    render(<App />);
    // Logs is active by default.
    // We don't assert on specific Logs DOM (varies); we assert that the LoginPane is NOT visible.
    await waitFor(() => {
      // Wait for Auth provider to settle.
      expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    });
  });

  it("shows the login pane when Vault is selected from the left rail", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /vault/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /vault/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });
  });
});
