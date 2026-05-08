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

/** Direct access to the Supabase client. */
export function useSupabaseClient() {
  return useAuthInternal().client;
}
