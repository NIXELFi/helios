import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, RequireAuth } from "../src";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(session: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  } as any;
}

describe("<RequireAuth>", () => {
  it("renders fallback while loading", () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <RequireAuth fallback={<div>signing in…</div>} unauthenticated={<div>login</div>}>
          <div>secret</div>
        </RequireAuth>
      </SupabaseAuthProvider>,
    );
    expect(screen.getByText("signing in…")).toBeInTheDocument();
  });

  it("renders unauthenticated when there is no session", async () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <RequireAuth fallback={<div>l</div>} unauthenticated={<div>login</div>}>
          <div>secret</div>
        </RequireAuth>
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("login")).toBeInTheDocument();
    });
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("renders children when there is a session", async () => {
    const client = mockClient({
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    });
    render(
      <SupabaseAuthProvider client={client}>
        <RequireAuth fallback={<div>l</div>} unauthenticated={<div>login</div>}>
          <div>secret</div>
        </RequireAuth>
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("secret")).toBeInTheDocument();
    });
  });
});
