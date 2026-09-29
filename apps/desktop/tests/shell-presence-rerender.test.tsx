import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The Shell keeps every visited module mounted. Presence used to be React
// state on the Shell, so every realtime presence sync/join/leave (a teammate
// opening Helios, switching module, a socket blip) re-rendered the Shell and
// every mounted module tree under it, on every client -- even when the roster
// had not changed at all. This pins both halves of the fix: an unchanged
// roster notifies no one, and a changed one re-renders the roster panel only.

// LogsApp calls this once per render, so it counts the Logs module's renders.
const logsRenders = vi.fn();
vi.mock("../src/App", () => ({
  default: () => {
    logsRenders();
    return <div data-testid="logs-app">Logs</div>;
  },
}));
vi.mock("../src/modules/vault", () => ({ VaultModule: () => <div>Vault</div> }));
vi.mock("../src/modules/cfd", () => ({ CfdModule: () => <div>CFD</div> }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("dev") }));

// Presence handlers the Shell registered on "presence:helios", and the state
// the fake channel reports on each sync.
const presenceHandlers: Array<() => void> = [];
let presenceState: Record<string, unknown[]> = {};

function fakeChannel(name: string) {
  const ch: Record<string, unknown> = {};
  Object.assign(ch, {
    on: (type: string, _filter: unknown, cb: () => void) => {
      if (name === "presence:helios" && type === "presence") presenceHandlers.push(cb);
      return ch;
    },
    // Only the presence channel "joins"; the release-signal channels stay
    // quiet so nothing else fires during the test.
    subscribe: (cb?: (status: string) => void) => {
      if (name === "presence:helios") cb?.("SUBSCRIBED");
      return ch;
    },
    track: () => Promise.resolve("ok"),
    untrack: () => Promise.resolve("ok"),
    presenceState: () => presenceState,
  });
  return ch;
}

let authCallback: ((event: string, session: unknown) => void) | null = null;

vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
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
        // useMyRole: an admin, so the Shell shows the presence roster.
        from: () => ({
          select: () => ({
            eq: () => Promise.resolve({ data: [{ role: "admin", vault_id: null }], error: null }),
          }),
        }),
        schema: () => ({
          rpc: (fn: string) =>
            Promise.resolve({ data: fn === "is_org_member" ? true : [], error: null }),
        }),
        rpc: () => Promise.resolve({ data: [], error: null }),
        channel: (name: string) => fakeChannel(name),
        removeChannel: () => {},
      } as any),
  };
});

import App from "../src/Shell";

// The full suite runs ~300 files in parallel; the Shell's boot (auth, role,
// org probe) can take well over waitFor's 1 s default under that load.
const SLOW = { timeout: 10_000 };

function fireSync() {
  act(() => {
    for (const h of presenceHandlers) h();
  });
}

const meta = (user_id: string, name: string, module: string, online_at: number) => ({
  user_id, name, subteam: null, module, online_at,
});

afterEach(() => {
  cleanup();
  authCallback = null;
  presenceHandlers.length = 0;
  presenceState = {};
  logsRenders.mockClear();
});

describe("Shell presence fan-out", () => {
  it("an unchanged roster does not re-render a mounted module; a changed one only updates the panel", async () => {
    localStorage.setItem(
      "helios:supabase-connection",
      JSON.stringify({ url: "https://example.supabase.co", anonKey: "anon-key" }),
    );
    // Land on Logs even when signed in.
    localStorage.setItem("helios:prefs", JSON.stringify({ landing: "logs" }));

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("logs-app")).toBeInTheDocument(), SLOW);
    await waitFor(() => expect(authCallback).not.toBeNull(), SLOW);
    act(() => authCallback!("SIGNED_IN", { user: { id: "u1", email: "nick@example.com", user_metadata: {} } }));
    await waitFor(() => expect(presenceHandlers.length).toBeGreaterThan(0), SLOW);

    // First real roster: me. The admin-gated panel renders it.
    presenceState = { u1: [meta("u1", "Nick", "logs", 100)] };
    fireSync();
    await waitFor(() => expect(screen.getByText(/1 on Helios|On Helios/)).toBeInTheDocument(), SLOW);
    // Let role / org-access / version settle so the baseline is quiet.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const before = logsRenders.mock.calls.length;

    // The same roster again, as a fresh object -- what Supabase hands us on
    // every heartbeat re-sync. Sync, join and leave all run the same handler.
    for (let i = 0; i < 5; i++) {
      presenceState = { u1: [meta("u1", "Nick", "logs", 100)] };
      fireSync();
    }
    expect(logsRenders.mock.calls.length).toBe(before);

    // A teammate joins: the roster really changes and the panel shows them,
    // but the hidden-or-not Logs tree still does not re-render.
    presenceState = {
      u1: [meta("u1", "Nick", "logs", 100)],
      u2: [meta("u2", "Tim Coughlin", "pm", 200)],
    };
    fireSync();
    await waitFor(() => expect(screen.getAllByText(/Tim Coughlin/).length).toBeGreaterThan(0), SLOW);
    expect(logsRenders.mock.calls.length).toBe(before);
  }, 30_000);
});
