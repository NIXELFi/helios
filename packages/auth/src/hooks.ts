import type { SupabaseClient } from "@supabase/supabase-js";
import { useAuthInternal } from "./provider";

export function useUser() {
  return useAuthInternal().user;
}

export function useSession() {
  return useAuthInternal().session;
}

export function useAuthLoading() {
  return useAuthInternal().loading;
}

/** Direct access to the Supabase client. Throws if no connection has been
 *  configured yet — callers that need to render even when disconnected
 *  should use `useSupabaseClientOrNull()` instead. */
export function useSupabaseClient(): SupabaseClient {
  const c = useAuthInternal().client;
  if (!c) {
    throw new Error(
      "Supabase client is not available — useSupabaseClient() was called " +
      "before a connection was configured. Gate the calling component on " +
      "useUser() / useSupabaseClientOrNull() to avoid this.",
    );
  }
  return c;
}

/** Safe variant — returns `null` while the host app has no connection. */
export function useSupabaseClientOrNull(): SupabaseClient | null {
  return useAuthInternal().client;
}
