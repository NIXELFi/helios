import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { useConnection, useHeliosAuth } from "./AuthShell";
import { validateConnectionFields, type SupabaseConnection } from "./connection";

interface Props {
  open: boolean;
  onClose: () => void;
}

type ModalStep = "connect" | "signin" | "signup" | "forgot" | "reset";

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
  // Carries the email from the "forgot" step into the "reset" step so the
  // user doesn't retype it alongside the code.
  const [forgotEmail, setForgotEmail] = useState("");
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
              {step === "forgot" && "Reset password"}
              {step === "reset" && "Enter reset code"}
            </div>
            <div className="mt-0.5 text-[10px] text-[#5A5F66]">
              {step === "connect" && "Paste the URL + anon key from your Supabase project."}
              {step === "forgot" && "We'll email you a 6-digit code."}
              {step === "reset" && "Check your email for the code."}
              {(step === "signin" || step === "signup") && connection && new URL(connection.url).host}
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
              onForgot={() => setStep("forgot")}
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
          {step === "forgot" && client && (
            <ForgotStep
              client={client}
              initialEmail={forgotEmail}
              onBack={() => setStep("signin")}
              onCodeSent={(email) => { setForgotEmail(email); setStep("reset"); }}
            />
          )}
          {step === "reset" && client && (
            <ResetStep
              client={client}
              email={forgotEmail}
              onBack={() => setStep("signin")}
              onResend={() => client.auth.resetPasswordForEmail(forgotEmail)}
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
  onForgot?: () => void;
  onDone: () => void;
}) {
  const { mode, client, onSwitchMode, onChangeConnection, onForgot, onDone } = props;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [subteam, setSubteam] = useState("");
  const [subteams, setSubteams] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset error/info chrome when the user flips between sign-in / sign-up.
  useEffect(() => {
    setError(null);
    setInfo(null);
  }, [mode]);

  // Load the managed subteam list for the sign-up picker. pdm.subteams is
  // readable by anon, so this works even though the user isn't signed in yet.
  useEffect(() => {
    if (mode !== "signup") return;
    let on = true;
    (async () => {
      const { data } = await (client.from("subteams") as any)
        .select("id,name,sort_order")
        .order("sort_order", { ascending: true });
      if (on && data) setSubteams(data as { id: string; name: string }[]);
    })();
    return () => { on = false; };
  }, [mode, client]);

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
        // Sign-up. Display name + subteam are mandatory and land in
        // user_metadata (display_name drives the sidebar pill; subteam shows
        // in the admin panel).
        if (!displayName.trim()) {
          setError("Display name is required.");
          return;
        }
        if (!subteam) {
          setError("Select your subteam.");
          return;
        }
        const { error, data } = await client.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName.trim(), subteam },
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
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          placeholder="e.g. Nick Murray"
        />
      )}
      {mode === "signup" && (
        <label className="block space-y-1">
          <span className="block text-[10px] uppercase tracking-wider text-helios-dim">Subteam</span>
          <select
            value={subteam}
            onChange={(e) => setSubteam(e.target.value)}
            aria-label="Subteam"
            className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-[12px] text-helios-text outline-none focus:border-asu-gold [&>option]:bg-helios-panel"
          >
            <option value="">Select your subteam…</option>
            {subteams.map((s) => (
              <option key={s.id} value={s.name}>{s.name}</option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      {info && <p className="text-xs text-asu-gold">{info}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <button
            type="button"
            onClick={onSwitchMode}
            className="text-[11px] text-helios-dim hover:text-asu-gold"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
          {mode === "signin" && onForgot && (
            <button
              type="button"
              onClick={onForgot}
              className="text-[11px] text-helios-dim hover:text-asu-gold"
            >
              Forgot password?
            </button>
          )}
        </div>
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
// Step: Forgot password — request an OTP code by email
// ──────────────────────────────────────────────────────────────────────

const MIN_PASSWORD_LEN = 12;

function ForgotStep(props: {
  client: SupabaseClient;
  initialEmail: string;
  onBack: () => void;
  onCodeSent: (email: string) => void;
}) {
  const { client, initialEmail, onBack, onCodeSent } = props;
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }
    setBusy(true);
    try {
      // Sends the recovery email. With the recovery template configured to
      // include {{ .Token }}, the email carries a 6-digit OTP the user types
      // on the next step — no web redirect, which is what makes this work in
      // a desktop app. We don't branch on the error to avoid leaking whether
      // an address is registered; we always advance to the code step.
      const { error: err } = await client.auth.resetPasswordForEmail(email.trim());
      if (err) {
        setError(err.message);
        return;
      }
      onCodeSent(email.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <p className="text-xs text-helios-dim">
        Enter the email on your account. We'll send a 6-digit code to reset your
        password — you'll type it on the next screen.
      </p>
      <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="username" autoFocus />
      {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="text-[11px] text-helios-dim hover:text-asu-gold">
          Back to sign in
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base hover:bg-yellow-300 disabled:opacity-50"
        >
          {busy ? "…" : "Send code"}
        </button>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step: Reset — verify the OTP code and set a new password
// ──────────────────────────────────────────────────────────────────────

function ResetStep(props: {
  client: SupabaseClient;
  email: string;
  onBack: () => void;
  onResend: () => Promise<unknown>;
  onDone: () => void;
}) {
  const { client, email, onBack, onResend, onDone } = props;
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    // Accept 4–10 digits rather than hard-coding 6, so the flow survives a
    // project whose mailer_otp_length differs from ours. verifyOtp rejects
    // wrong codes anyway; this guard just catches obvious fat-fingers.
    if (!/^\d{4,10}$/.test(code.trim())) {
      setError("Enter the numeric code from your email.");
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      setError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      // Verify the recovery OTP → this returns a session (signs the user in).
      const { error: vErr } = await client.auth.verifyOtp({
        email,
        token: code.trim(),
        type: "recovery",
      });
      if (vErr) {
        setError(vErr.message);
        return;
      }
      // Now authorized — set the new password on the freshly-recovered session.
      const { error: uErr } = await client.auth.updateUser({ password });
      if (uErr) {
        setError(uErr.message);
        return;
      }
      // User is now signed in with the new password; close the modal.
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      await onResend();
      setInfo("A new code is on its way.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <p className="text-xs text-helios-dim">
        Enter the 6-digit code sent to{" "}
        <span className="text-helios-text">{email}</span> and choose a new password.
      </p>
      <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" autoFocus />
      <Field label="New password" value={password} onChange={setPassword} type="password" autoComplete="new-password" />
      <Field label="Confirm new password" value={confirm} onChange={setConfirm} type="password" autoComplete="new-password" />
      <p className="-mt-1 text-[10px] text-[#5A5F66]">At least {MIN_PASSWORD_LEN} characters.</p>
      {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      {info && <p className="text-xs text-asu-gold">{info}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <button type="button" onClick={onBack} className="text-[11px] text-helios-dim hover:text-asu-gold">
            Back to sign in
          </button>
          <button type="button" onClick={resend} disabled={busy} className="text-[11px] text-helios-dim hover:text-asu-gold disabled:opacity-50">
            Resend code
          </button>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base hover:bg-yellow-300 disabled:opacity-50"
        >
          {busy ? "…" : "Reset password"}
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
