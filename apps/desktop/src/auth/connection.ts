// User-supplied Supabase connection — URL + anon key. Persisted in
// localStorage so the user only enters them once. Anon keys are designed
// to be safe in client-side JS (Supabase RLS gates actual data access),
// so localStorage is appropriate; we don't need the OS keychain here.
//
// Lives in the desktop app (not @helios/auth) because deciding WHERE to
// source the credentials from is a host-app concern; the package just
// takes them as args.

export interface SupabaseConnection {
  url: string;
  anonKey: string;
}

const STORAGE_KEY = "helios:supabase-connection";

export function loadConnection(): SupabaseConnection | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SupabaseConnection>;
    if (typeof parsed.url !== "string" || typeof parsed.anonKey !== "string") {
      return null;
    }
    if (!parsed.url.trim() || !parsed.anonKey.trim()) return null;
    return { url: parsed.url.trim(), anonKey: parsed.anonKey.trim() };
  } catch {
    return null;
  }
}

export function saveConnection(c: SupabaseConnection): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ url: c.url.trim(), anonKey: c.anonKey.trim() }),
  );
}

export function clearConnection(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Sanity-check a URL string before we try to instantiate a client. The
 *  real validation happens when Supabase rejects bad creds, but this
 *  catches the easy fat-finger cases ("htttps://", missing scheme, etc.)
 *  before we save anything to localStorage. */
export function validateConnectionFields(
  url: string,
  anonKey: string,
): { ok: true } | { ok: false; reason: string } {
  if (!url.trim()) return { ok: false, reason: "Supabase URL is required." };
  if (!anonKey.trim()) return { ok: false, reason: "Anon key is required." };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "Supabase URL is not a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Supabase URL must start with https:// or http://." };
  }
  return { ok: true };
}

/** Resolve the connection that should be live at boot.
 *
 *  Deliberately localStorage-ONLY: the shipped app ships with no knowledge
 *  of any Supabase project. Each user enters their URL + anon key once via
 *  the auth modal's Connect step (handed out privately, outside the app),
 *  and it persists here across restarts. There is intentionally no
 *  build-time / env-var default — baking one in would couple every install
 *  to a single project and defeat the point of a per-user connection. */
export function resolveBootConnection(): SupabaseConnection | null {
  return loadConnection();
}
