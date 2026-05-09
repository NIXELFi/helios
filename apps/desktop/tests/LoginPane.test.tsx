import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import { LoginPane } from "../src/modules/vault/LoginPane";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(signInImpl: any = vi.fn()): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithPassword: signInImpl,
    },
  } as any;
}

function renderWith(client: SupabaseClient) {
  return render(
    <SupabaseAuthProvider client={client}>
      <LoginPane />
    </SupabaseAuthProvider>,
  );
}

describe("<LoginPane>", () => {
  it("renders email + password fields and a sign-in button", () => {
    renderWith(mockClient());
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("calls signInWithPassword with the entered credentials", async () => {
    const signIn = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
    renderWith(mockClient(signIn));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({ email: "u@example.com", password: "hunter2" });
    });
  });

  it("shows an error message when sign-in fails", async () => {
    const signIn = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { message: "Invalid login credentials" },
    });
    renderWith(mockClient(signIn));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByText(/invalid login credentials/i)).toBeInTheDocument();
    });
  });
});
