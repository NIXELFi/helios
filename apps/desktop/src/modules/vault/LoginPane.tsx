import { useState, type FormEvent } from "react";
import { useSupabaseClient } from "@helios/auth";

export function LoginPane() {
  const client = useSupabaseClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
      }
      // On success, the SupabaseAuthProvider will pick up SIGNED_IN via
      // onAuthStateChange; no explicit redirect needed.
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-100">
      <form
        onSubmit={onSubmit}
        className="w-80 space-y-4 rounded-lg border border-zinc-700 bg-zinc-800 p-6 shadow-lg"
      >
        <h2 className="text-lg font-semibold">Sign in to Helios Vault</h2>
        <p className="text-sm text-zinc-400">
          Vault requires an account. Logs continues to work without one. Ask your
          team admin to invite you if you don't have one yet.
        </p>
        <div className="space-y-1">
          <label htmlFor="login-email" className="block text-sm">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm focus:border-yellow-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="login-password" className="block text-sm">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm focus:border-yellow-500 focus:outline-none"
          />
        </div>
        {error ? (
          <div role="alert" className="text-sm text-red-400">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-yellow-500 px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-yellow-400 disabled:bg-zinc-600"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
