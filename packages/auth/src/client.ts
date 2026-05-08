import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConfig {
  url?: string;
  anonKey?: string;
}

/**
 * Constructs a configured Supabase client.
 *
 * Resolution order:
 *   1. Explicit `args.url` / `args.anonKey` (used by tests + when the host app
 *      already has the values in hand).
 *   2. Vite env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
 *
 * Throws if neither produces a non-empty URL.
 */
export function createSupabaseClient(args: SupabaseConfig = {}): SupabaseClient {
  // Read directly from import.meta.env so Vitest's vi.stubEnv patches are
  // reflected at call time. Both Vite (production) and Vitest set up
  // import.meta.env; it is always available in these environments.
  const url = args.url ?? import.meta.env.VITE_SUPABASE_URL ?? "";
  const anonKey = args.anonKey ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

  if (!url) {
    throw new Error(
      "SUPABASE_URL is not configured. Provide it explicitly or set VITE_SUPABASE_URL.",
    );
  }
  if (!anonKey) {
    throw new Error(
      "SUPABASE_ANON_KEY is not configured. Provide it explicitly or set VITE_SUPABASE_ANON_KEY.",
    );
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The Tauri host stores the refresh token in the OS keychain via a
      // separate mechanism; for now, persistSession in localStorage is the
      // baseline and can be tightened in a follow-up.
    },
  });
}
