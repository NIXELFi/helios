export { createSupabaseClient, type SupabaseConfig } from "./client";
export { SupabaseAuthProvider } from "./provider";
export {
  useUser,
  useSession,
  useAuthLoading,
  useSupabaseClient,
  useSupabaseClientOrNull,
} from "./hooks";
export { RequireAuth } from "./RequireAuth";
// Re-export the supabase-js types host apps need so they don't have to
// pull `@supabase/supabase-js` into their own package.json just for type
// imports. Runtime supabase access still goes through the client returned
// by `useSupabaseClient()`.
export type { Session, SupabaseClient, User } from "@supabase/supabase-js";
