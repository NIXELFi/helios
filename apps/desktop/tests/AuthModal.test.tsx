import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AuthShell } from "../src/auth/AuthShell";
import { AuthModal } from "../src/auth/AuthModal";
import { clearConnection, saveConnection } from "../src/auth/connection";

// Control the client AuthShell builds so we can assert on sign-in / sign-up
// calls without a real Supabase backend.
const signInWithPassword = vi.fn();
const signUp = vi.fn();

vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
  return {
    ...actual,
    createSupabaseClient: () =>
      ({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signInWithPassword,
          signUp,
        },
      } as any),
  };
});

function renderModal() {
  return render(
    <AuthShell>
      <AuthModal open onClose={() => {}} />
    </AuthShell>,
  );
}

describe("<AuthModal>", () => {
  beforeEach(() => {
    clearConnection();
    signInWithPassword.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
    signUp.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
    // Belt-and-suspenders: ensure no env-var connection bleeds in.
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
  });

  it("starts on the Connect step when no connection is saved", () => {
    renderModal();
    expect(screen.getByText(/connect to supabase/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/supabase url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/anon key/i)).toBeInTheDocument();
  });

  it("rejects an invalid URL before saving the connection", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/supabase url/i), { target: { value: "not-a-url" } });
    fireEvent.change(screen.getByLabelText(/anon key/i), { target: { value: "key123" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/valid url/i);
  });

  it("advances to the Sign in step after a valid connection", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/supabase url/i), { target: { value: "https://abc.supabase.co" } });
    fireEvent.change(screen.getByLabelText(/anon key/i), { target: { value: "key123" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    });
  });

  it("starts on the Sign in step when a connection already exists", () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByText(/connect to supabase/i)).not.toBeInTheDocument();
  });

  it("calls signInWithPassword with the entered credentials", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledWith({ email: "u@example.com", password: "hunter2" });
    });
  });

  it("passes the display name into signUp metadata", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    // Flip to the Sign up tab.
    fireEvent.click(screen.getByRole("button", { name: /need an account\? sign up/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "hunter2" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Nick M." } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith({
        email: "new@example.com",
        password: "hunter2",
        options: { data: { display_name: "Nick M." } },
      });
    });
  });

  it("surfaces a sign-in error", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: "Invalid login credentials" } });
    renderModal();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid login credentials/i);
    });
  });
});
