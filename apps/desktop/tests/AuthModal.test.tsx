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
const resetPasswordForEmail = vi.fn();
const verifyOtp = vi.fn();
const updateUser = vi.fn();

// When true, createSupabaseClient throws so AuthShell yields a null client —
// used to exercise the "Connection failed" inline error (S7).
let clientShouldThrow = false;

vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
  return {
    ...actual,
    createSupabaseClient: () => {
      if (clientShouldThrow) throw new Error("bad creds");
      return ({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signInWithPassword,
          signUp,
          resetPasswordForEmail,
          verifyOtp,
          updateUser,
        },
        // The signup step loads the subteam picker from pdm.subteams.
        from: () => ({
          select: () => ({
            order: () => Promise.resolve({
              data: [{ id: "st1", name: "Engine", sort_order: 1 }],
              error: null,
            }),
          }),
        }),
      } as any);
    },
  };
});

function renderModal(props: Partial<{ open: boolean; onClose: () => void }> = {}) {
  const { open = true, onClose = () => {} } = props;
  return render(
    <AuthShell>
      <AuthModal open={open} onClose={onClose} />
    </AuthShell>,
  );
}

describe("<AuthModal>", () => {
  beforeEach(() => {
    clearConnection();
    clientShouldThrow = false;
    signInWithPassword.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
    signUp.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
    resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
    verifyOtp.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
    updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
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

  it("requires display name + subteam, then passes both into signUp metadata", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    // Flip to the Sign up tab.
    fireEvent.click(screen.getByRole("button", { name: /need an account\? sign up/i }));
    // Subteam picker is populated asynchronously from pdm.subteams.
    await screen.findByRole("option", { name: "Engine" });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    // Use a >= 12-char password so it clears the client-side length pre-check
    // (S2) and we exercise the metadata-passthrough path.
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "correcthorsebattery" } });
    // Submitting without a subteam is blocked.
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Nick M." } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/subteam/i);
    expect(signUp).not.toHaveBeenCalled();
    // Pick the subteam, then it goes through with both fields in metadata.
    fireEvent.change(screen.getByLabelText(/subteam/i), { target: { value: "Engine" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith({
        email: "new@example.com",
        password: "correcthorsebattery",
        options: { data: { display_name: "Nick M.", subteam: "Engine" } },
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

  it("forgot-password: requests an OTP code, then verifies it and sets a new password", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    // Go to the forgot step.
    fireEvent.click(screen.getByRole("button", { name: /forgot password\?/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    await waitFor(() =>
      expect(resetPasswordForEmail).toHaveBeenCalledWith("u@example.com"),
    );
    // Now on the reset step — enter code + new password.
    const code = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: "correcthorsebattery" } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: "correcthorsebattery" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    await waitFor(() => {
      expect(verifyOtp).toHaveBeenCalledWith({ email: "u@example.com", token: "123456", type: "recovery" });
    });
    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ password: "correcthorsebattery" });
    });
  });

  it("forgot-password: rejects a non-6-digit code before calling verifyOtp", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /forgot password\?/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    const code = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(code, { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: "correcthorsebattery" } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: "correcthorsebattery" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/numeric code/i);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  // ── S2: signup client-side password-length pre-check ──────────────────
  it("signup: rejects a password shorter than 12 chars before hitting the server", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /need an account\? sign up/i }));
    await screen.findByRole("option", { name: "Engine" });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Nick M." } });
    fireEvent.change(screen.getByLabelText(/subteam/i), { target: { value: "Engine" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 12/i);
    expect(signUp).not.toHaveBeenCalled();
  });

  // ── S3: ForgotStep always advances (anti-enumeration) ─────────────────
  it("forgot-password: advances to the reset step even when the server errors", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: { message: "User not found" } });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /forgot password\?/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "nobody@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    // Should advance to the reset (code) step regardless of the server error,
    // so we don't leak whether the address is registered.
    expect(await screen.findByLabelText(/6-digit code/i)).toBeInTheDocument();
  });

  // ── S5: double-submit guard (Enter re-entry) ──────────────────────────
  it("sign-in: a second submit while busy does not fire signInWithPassword twice", async () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    // Never resolves → handler stays busy.
    let resolve: ((v: unknown) => void) | undefined;
    signInWithPassword.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderModal();
    const form = screen.getByLabelText(/email/i).closest("form")!;
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "hunter2pw123" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    resolve?.({ data: { session: {} }, error: null });
  });

  // ── S6: field state resets across close → reopen ──────────────────────
  it("clears the typed password when the modal is closed and reopened", () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    const { rerender } = render(
      <AuthShell>
        <AuthModal open onClose={() => {}} />
      </AuthShell>,
    );
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret-typed-pw" } });
    expect(screen.getByLabelText(/^password$/i)).toHaveValue("secret-typed-pw");
    // Close, then reopen.
    rerender(
      <AuthShell>
        <AuthModal open={false} onClose={() => {}} />
      </AuthShell>,
    );
    rerender(
      <AuthShell>
        <AuthModal open onClose={() => {}} />
      </AuthShell>,
    );
    expect(screen.getByLabelText(/^password$/i)).toHaveValue("");
  });

  // ── S7a: malformed persisted URL must not crash render ────────────────
  it("does not crash when the saved connection URL is malformed (unguarded new URL)", () => {
    // Write localStorage directly with a string that survives loadConnection()
    // but breaks `new URL(...).host` in the header. Render must not throw.
    localStorage.setItem(
      "helios:supabase-connection",
      JSON.stringify({ url: "::::not-a-url", anonKey: "key123" }),
    );
    renderModal();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The credentials form is still rendered (we degrade gracefully).
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });

  // ── S7b: client === null on signin/signup renders an inline error ─────
  it("renders a connection-failed message when the client is null on the signin step", () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    // Force the AuthShell client to null by making createSupabaseClient throw.
    clientShouldThrow = true;
    renderModal();
    expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
    // No empty body: the sign-in submit button is absent because there's no client.
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
  });

  // ── X2: modal a11y — Escape closes ────────────────────────────────────
  it("closes on Escape", () => {
    saveConnection({ url: "https://abc.supabase.co", anonKey: "key123" });
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
