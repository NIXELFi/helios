import { useState } from "react";
import type { FormEvent } from "react";
import type { SupabaseClient } from "@helios/auth";

interface Props {
  open: boolean;
  /** Live Supabase client for the signed-in session. The update authorizes
   *  off the current session — Supabase doesn't require the old password
   *  (secure_password_change is off in our config). */
  client: SupabaseClient | null;
  onClose: () => void;
}

// Minimum that matches the Supabase project's `minimum_password_length`.
// Server still enforces it; this is just an early, friendly guard.
const MIN_LEN = 12;

/** Self-service "change my password" for the signed-in user. Reached from the
 *  sidebar user-pill dropdown. */
export function ChangePasswordModal({ open, client, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  function reset() {
    setPassword("");
    setConfirm("");
    setError(null);
    setDone(false);
    setBusy(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LEN) {
      setError(`Password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (!client) {
      setError("Not connected.");
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await client.auth.updateUser({ password });
      if (err) {
        setError(err.message);
        return;
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-pw-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="w-[min(92vw,400px)] rounded-md border border-helios-line bg-helios-panel text-helios-text shadow-xl">
        <header className="flex items-center justify-between border-b border-helios-line bg-helios-base px-4 py-2">
          <div id="change-pw-title" className="text-[11px] uppercase tracking-wider text-asu-gold">
            Change password
          </div>
          <button
            type="button"
            aria-label="Close"
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text hover:border-asu-gold"
            onClick={close}
          >Close ✕</button>
        </header>

        <div className="p-4">
          {done ? (
            <div className="space-y-3">
              <p className="text-sm text-helios-text">Password updated.</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base hover:bg-yellow-300"
                >Done</button>
              </div>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={onSubmit}>
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-helios-dim">New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] text-helios-text outline-none focus:border-asu-gold"
                />
              </label>
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-helios-dim">Confirm new password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] text-helios-text outline-none focus:border-asu-gold"
                />
              </label>
              <p className="text-[10px] text-[#5A5F66]">At least {MIN_LEN} characters.</p>
              {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base hover:bg-yellow-300 disabled:opacity-50"
                >{busy ? "…" : "Update password"}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
