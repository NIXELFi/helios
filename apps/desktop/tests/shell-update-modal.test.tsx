import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect, useState } from "react";
import type { UpdaterAvailable, UpdaterState, UpdaterApi } from "../src/lib/use-updater";

// Stub heavy modules so the Shell test only exercises chrome / modal routing.
vi.mock("../src/App", () => ({ default: () => <div data-testid="logs-app">Logs</div> }));
vi.mock("../src/modules/vault", () => ({ VaultModule: () => <div data-testid="vault-module">Vault</div> }));
vi.mock("../src/modules/cfd", () => ({ CfdModule: () => <div data-testid="cfd-module">CFD</div> }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("3.7.0") }));

// ── Controllable updater mock ─────────────────────────────────────────────
// A module-level store the test drives; each mounted useUpdater subscribes so
// state changes re-render the Shell. recheck/installAndRelaunch are spies.
let updaterState: UpdaterState = { kind: "checking" };
const subscribers = new Set<(s: UpdaterState) => void>();
const recheck = vi.fn();
const installAndRelaunch = vi.fn(() => Promise.resolve());

function setUpdaterState(s: UpdaterState) {
  updaterState = s;
  act(() => {
    for (const fn of subscribers) fn(s);
  });
}

vi.mock("../src/lib/use-updater", () => ({
  useUpdater: (): UpdaterApi => {
    const [s, setS] = useState<UpdaterState>(updaterState);
    useEffect(() => {
      subscribers.add(setS);
      return () => { subscribers.delete(setS); };
    }, []);
    return { state: s, recheck, installAndRelaunch };
  },
}));

// ── Controllable auth mock (so we can stay logged out / open AuthModal) ────
vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
  return {
    ...actual,
    createSupabaseClient: () =>
      ({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signInWithPassword: vi.fn(),
        },
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        }),
      } as any),
  };
});

import App from "../src/Shell";

const update: UpdaterAvailable = {
  version: "3.8.0",
  currentVersion: "3.7.0",
  notes: "Notes",
  date: "2026-05-20",
  _handle: {} as UpdaterAvailable["_handle"],
};

beforeEach(() => {
  updaterState = { kind: "checking" };
  recheck.mockClear();
  installAndRelaunch.mockClear();
  // A saved connection so the Sign-in pill opens the credentials step rather
  // than the Connect step (either works, but this keeps the dialog labelled).
  localStorage.setItem(
    "helios:supabase-connection",
    JSON.stringify({ url: "https://example.supabase.co", anonKey: "anon-key" }),
  );
});

afterEach(() => {
  cleanup();
  subscribers.clear();
  localStorage.clear();
});

describe("Shell update-modal auto-open gating (MODAL-ESC)", () => {
  it("does not auto-open the UpdateModal on top of an open AuthModal; opens it once AuthModal closes", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("logs-app")).toBeInTheDocument());

    // Open the AuthModal via the Sign in pill.
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    // It's the auth dialog — the credentials step shows an email field.
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());

    // An update becomes available while the AuthModal is open. It must NOT
    // stack the UpdateModal on top.
    setUpdaterState({ kind: "available", update });
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();

    // Close the AuthModal (Escape). Only the auth modal closes (the update
    // modal wasn't open, so there's no double-close).
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument());

    // Now that no other modal is open, the queued update modal pops.
    await waitFor(() => expect(screen.getByText(/update available/i)).toBeInTheDocument());
    expect(screen.getByText(/Helios v3\.8\.0/)).toBeInTheDocument();
  });

  it("auto-opens the UpdateModal when an update is available and no other modal is open", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("logs-app")).toBeInTheDocument());
    setUpdaterState({ kind: "available", update });
    await waitFor(() => expect(screen.getByText(/update available/i)).toBeInTheDocument());
  });

  it("keeps the UpdateModal open with an error after a failed install (install-fail-silent)", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("logs-app")).toBeInTheDocument());
    setUpdaterState({ kind: "available", update });
    await waitFor(() => expect(screen.getByText(/update available/i)).toBeInTheDocument());

    // Click install, then the updater fails → offline.
    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    expect(installAndRelaunch).toHaveBeenCalledTimes(1);
    setUpdaterState({ kind: "offline", error: "bundle verification failed" });

    // The modal stays up with the failure surfaced (not silently unmounted).
    await waitFor(() => expect(screen.getByText(/update failed/i)).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/bundle verification failed/i);

    // "Try again" rechecks (installAndRelaunch is a no-op from offline).
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(recheck).toHaveBeenCalledTimes(1);
  });
});
