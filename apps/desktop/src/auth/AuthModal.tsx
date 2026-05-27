import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useConnection, useHeliosAuth } from "./AuthShell";
import { validateConnectionFields, type SupabaseConnection } from "./connection";

interface Props {
  open: boolean;
  onClose: () => void;
}

type ModalStep = "connect" | "signin" | "signup";

/** Top-level auth dialog for Helios. Two layers:
 *  1. "Connect" — collect Supabase URL + anon key (only needed once per
 *     install). Skipped if a connection is already saved.
 *  2. "Sign in" / "Sign up" — email + password against the connected
 *     project. Self-signup is enabled per the v1 product call; sign-up
 *     additionally collects an optional display name stored in
 *     user_metadata.display_name and rendered in the sidebar pill.
 *
 *  Both steps stay in this single component so the user can flip between
 *  Sign-in and Sign-up without losing what they typed, and so the
 *  "change connection" affordance is always one click away from the
 *  credentials step.
 */
export function AuthModal({ open, onClose }: Props) {
  const { connection, setConnection } = useConnection();
  const { client } = useHeliosAuth();

  // Modal step is derived from connection state on first open, but the
  // user can also flip between signin / signup manually after that.
  const [step, setStep] = useState<ModalStep>(connection ? "signin" : "connect");
  useEffect(() => {
    if (open) setStep(connection ? "signin" : "connect");
  }, [open, connection]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[min(92vw,440px)] rounded-md border border-helios-line bg-helios-panel text-helios-text shadow-xl">
        <header className="flex items-center justify-between border-b border-helios-line bg-helios-base px-4 py-2">
          <div className="min-w-0">
            <div id="auth-modal-title" className="text-[11px] uppercase tracking-wider text-asu-gold">
              {step === "connect" && "Connect to Supabase"}
              {step === "signin" && "Sign in"}
              {step === "signup" && "Create account"}
            </div>
            <div className="mt-0.5 text-[10px] text-[#5A5F66]">
              {step === "connect" && "Paste the URL + anon key from your Supabase project."}
              {step === "signin" && connection && new URL(connection.url).host}
              {step === "signup" && connection && new URL(connection.url).host}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-0.5 text-[11px] text-helios-text hover:border-asu-gold"
            onClick={onClose}
          >Close ✕</button>
        </header>

        <div className="p-4">
          {step === "connect" && (
            <ConnectStep
              initial={connection}
              onConnect={(c) => {
                setConnection(c);
                setStep("signin");
              }}
            />
          )}
          {step === "signin" && client && (
            <CredentialsStep
              mode="signin"
              client={client}
              onSwitchMode={() => setStep("signup")}
              onChangeConnection={() => setStep("connect")}
              onDone={onClose}
            />
          )}
          {step === "signup" && client && (
            <CredentialsStep
              mode="signup"
              client={client}
              onSwitchMode={() => setStep("signin")}
              onChangeConnection={() => setStep("connect")}
              onDone={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step: Connect (collect Supabase URL + anon key)
// ──────────────────────────────────────────────────────────────────────

function ConnectStep(props: {
  initial: SupabaseConnection | null;
  onConnect: (c: SupabaseConnection) => void;
}) {
  const [url, setUrl] = useState(props.initial?.url ?? "");
  const [anonKey, setAnonKey] = useState(props.initial?.anonKey ?? "");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const check = validateConnectionFields(url, anonKey);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setError(null);
    props.onConnect({ url: url.trim(), anonKey: anonKey.trim() });
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <p className="text-xs text-helios-dim">
        Helios connects to a Supabase project of your choosing. The URL + anon key
        come from your project admin (the ASU SDM team for the production vault,
        or your own Supabase dashboard if you're running your own).
      </p>
      <Field label="Supabase URL" value={url} onChange={setUrl} placeholder="https://abc123.supabase.co" autoFocus />
      <Field label="Anon key" value={anonKey} onChange={setAnonKey} placeholder="eyJhbGc…" />
      {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      <p className="text-[10px] text-[#5A5F66]">
        The anon key is safe to store on this machine — Supabase enforces
        permissions on the server side via Row-Level Security.
      </p>
      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base hover:bg-yellow-300"
        >
          Connect
        </button>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step: Sign in / Sign up
// ──────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@helios/auth";

function CredentialsStep(props: {
  mode: "signin" | "signup";
  client: SupabaseClient;
  onSwitchMode: () => void;
  onChangeConnection: () => void;
  onDone: () => void;
}) {
  const { mode, client, onSwitchMode, onChangeConnection, onDone } = props;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset error/info chrome when the user flips between sign-in / sign-up.
  useEffect(() => {
    setError(null);
    setInfo(null);
  }, [mode]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          setError(error.message);
          return;
        }
        // On success the AuthShell picks up SIGNED_IN via
        // onAuthStateChange; close the modal so the user sees the sidebar
        // pill update.
        onDone();
      } else {
        // Sign-up. Display name (optional) lands in user_metadata so the
        // sidebar pill can prefer it over the bare email.
        const { error, data } = await client.auth.signUp({
          email,
          password,
          options: {
            data: displayName.trim()
              ? { display_name: displayName.trim() }
              : undefined,
          },
        });
        if (error) {
          setError(error.message);
          return;
        }
        // If the project requires email confirmation, Supabase returns a
        // user but no session. Surface that so the user knows to check
        // their inbox before they can sign in.
        if (data.session) {
          onDone();
        } else {
          setInfo("Account created. Check your email for a confirmation link, then sign in.");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <Field
        label="Email"
        value={email}
        onChange={setEmail}
        type="email"
        autoComplete="username"
        required
        autoFocus
      />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        required
      />
      {mode === "signup" && (
        <p className="-mt-1 text-[10px] text-[#5A5F66]">
          Use a strong password — most Helios vaults require at least 12 characters.
        </p>
      )}
      {mode === "signup" && (
        <Field
          label="Display name (optional)"
          value={displayName}
          onChange={setDisplayName}
          placeholder="e.g. Nick M."
        />
      )}
      {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      {info && <p className="text-xs text-asu-gold">{info}</p>}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onSwitchMode}
          className="text-[11px] text-helios-dim hover:text-asu-gold"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base hover:bg-yellow-300 disabled:opacity-50"
        >
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </div>
      <div className="pt-2 text-right">
        <button
          type="button"
          onClick={onChangeConnection}
          className="text-[10px] text-[#5A5F66] hover:text-asu-gold"
        >
          Change Supabase connection…
        </button>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Small primitives
// ──────────────────────────────────────────────────────────────────────

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const { label, value, onChange, type = "text", ...rest } = props;
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] uppercase tracking-wider text-helios-dim">{label}</span>
      <input
        {...rest}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] text-helios-text outline-none focus:border-asu-gold"
      />
    </label>
  );
}
