import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useUser, useSession, useAuthLoading } from "../src";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(initialSession: any = null): SupabaseClient {
  let listeners: any[] = [];
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: initialSession },
        error: null,
      }),
      onAuthStateChange: (cb: any) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: vi.fn().mockResolvedValue({ error: null }),
      // Helper used by tests below to drive a state-change event.
      __emit: (event: string, session: any) => {
        listeners.forEach((cb) => cb(event, session));
      },
    },
  } as any;
}

function Probe() {
  const user = useUser();
  const session = useSession();
  const loading = useAuthLoading();
  return (
    <div>
      <span data-testid="loading">{loading ? "loading" : "idle"}</span>
      <span data-testid="user">{user ? user.id : "none"}</span>
      <span data-testid="hasSession">{session ? "yes" : "no"}</span>
    </div>
  );
}

describe("SupabaseAuthProvider", () => {
  it("starts in loading state, then transitions to idle/no-user when no session", async () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <Probe />
      </SupabaseAuthProvider>,
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("loading");
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("idle");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(screen.getByTestId("hasSession")).toHaveTextContent("no");
  });

  it("hydrates user when initial session exists", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "user-123", email: "u@example.com" },
    };
    const client = mockClient(session);
    render(
      <SupabaseAuthProvider client={client}>
        <Probe />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("idle");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("user-123");
    expect(screen.getByTestId("hasSession")).toHaveTextContent("yes");
  });

  it("updates state when onAuthStateChange fires SIGNED_IN", async () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <Probe />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("idle");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("none");

    (client.auth as any).__emit("SIGNED_IN", {
      access_token: "a",
      refresh_token: "r",
      user: { id: "user-456", email: "u@example.com" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("user")).toHaveTextContent("user-456");
    });
  });
});
