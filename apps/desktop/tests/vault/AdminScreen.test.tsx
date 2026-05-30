import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AdminScreen } from "../../src/modules/vault/screens/AdminScreen";

interface Opts {
  isAdmin?: boolean;
  isOwner?: boolean;
  users?: any[];
  subteams?: any[];
  // Per-RPC error injectors so a test can fail just set/revoke.
  setRoleError?: any;
  revokeError?: any;
  meId?: string;
}

const defaultUsers = [
  // A plain editor that "me" (admin1) can edit.
  { user_id: "u2", email: "bob@sdm.com", display_name: "Bob", subteam: "Aero", role: "editor", granted_at: "2026-01-02T00:00:00Z", created_at: "x" },
  // A user with no role (no access) — drives the "no role" wording check.
  { user_id: "u3", email: "carol@sdm.com", display_name: null, subteam: null, role: null, granted_at: null, created_at: "x" },
];

function mockClient(opts: Opts = {}): SupabaseClient {
  const {
    isAdmin = true,
    isOwner = false,
    users = defaultUsers,
    subteams = [{ id: "s1", name: "Aero", sort_order: 0, created_at: "x" }],
    setRoleError = null,
    revokeError = null,
    meId = "admin1",
  } = opts;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: meId, email: "me@sdm.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string) => {
      switch (name) {
        case "pdm_is_admin": return Promise.resolve({ data: isAdmin, error: null });
        case "pdm_is_owner": return Promise.resolve({ data: isOwner, error: null });
        case "pdm_admin_list_users": return Promise.resolve({ data: users, error: null });
        case "pdm_set_user_role": return Promise.resolve({ data: null, error: setRoleError });
        case "pdm_revoke_user_role": return Promise.resolve({ data: null, error: revokeError });
        case "pdm_create_subteam": return Promise.resolve({ data: null, error: null });
        case "pdm_delete_subteam": return Promise.resolve({ data: null, error: null });
        default: return Promise.resolve({ data: null, error: null });
      }
    },
    from: (table: string) => {
      if (table === "subteams") {
        return { select: () => ({ order: () => Promise.resolve({ data: subteams, error: null }) }) };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

describe("<AdminScreen>", () => {
  beforeEach(() => localStorage.clear());

  it("lists users with their roles", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <AdminScreen />
      </SupabaseAuthProvider>,
    );
    expect(await screen.findByText("bob@sdm.com")).toBeInTheDocument();
    expect(screen.getByText("carol@sdm.com")).toBeInTheDocument();
  });

  it("H3: surfaces the real server error message on a failed role change", async () => {
    // P0001 RAISE EXCEPTION → friendlyPgError passes the hand-authored body
    // through. Before the fix, AdminScreen read setRole.error?.message AFTER
    // the await — always the stale/previous value — so it showed the generic
    // "Failed to set role." Now it must show the server's real message.
    const c = mockClient({
      setRoleError: { code: "P0001", message: "only the owner may grant admin" },
    });
    render(
      <SupabaseAuthProvider client={c}>
        <AdminScreen />
      </SupabaseAuthProvider>,
    );
    await screen.findByText("bob@sdm.com");
    const select = screen.getByLabelText(/set role for bob@sdm.com/i) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "viewer" } });
    });
    expect(await screen.findByText(/only the owner may grant admin/i)).toBeInTheDocument();
    // The generic fallback must NOT appear.
    expect(screen.queryByText("Failed to set role.")).toBeNull();
  });

  it("H18: Revoke asks for confirmation before calling the RPC", async () => {
    const c = mockClient();
    const revokeSpy = vi.spyOn(c, "rpc");
    render(
      <SupabaseAuthProvider client={c}>
        <AdminScreen />
      </SupabaseAuthProvider>,
    );
    await screen.findByText("bob@sdm.com");
    const revokeBtn = screen.getAllByRole("button", { name: /^revoke$/i })[0];
    await act(async () => { fireEvent.click(revokeBtn); });

    // A confirm dialog appears; the RPC has NOT fired yet.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(revokeSpy).not.toHaveBeenCalledWith("pdm_revoke_user_role", expect.anything());

    // Confirm → RPC fires.
    const confirmBtn = screen.getByRole("button", { name: /revoke access/i });
    await act(async () => { fireEvent.click(confirmBtn); });
    await waitFor(() =>
      expect(revokeSpy).toHaveBeenCalledWith("pdm_revoke_user_role", { p_target: "u2" }),
    );
  });

  it("H18: cancelling the Revoke confirm does NOT call the RPC", async () => {
    const c = mockClient();
    const revokeSpy = vi.spyOn(c, "rpc");
    render(
      <SupabaseAuthProvider client={c}>
        <AdminScreen />
      </SupabaseAuthProvider>,
    );
    await screen.findByText("bob@sdm.com");
    const revokeBtn = screen.getAllByRole("button", { name: /^revoke$/i })[0];
    await act(async () => { fireEvent.click(revokeBtn); });
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await act(async () => { fireEvent.click(cancelBtn); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(revokeSpy).not.toHaveBeenCalledWith("pdm_revoke_user_role", expect.anything());
  });

  it("V17: standardizes 'no access' wording for a user with no role", async () => {
    render(
      <SupabaseAuthProvider client={mockClient()}>
        <AdminScreen />
      </SupabaseAuthProvider>,
    );
    await screen.findByText("carol@sdm.com");
    // The role badge for the no-role user reads "no access" — and the empty
    // select option uses the SAME wording (standardized). Neither of the old
    // divergent spellings should appear.
    expect(screen.getAllByText(/no access/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("— none —")).toBeNull();
    expect(screen.queryByText("(no role assigned)")).toBeNull();
  });
});
