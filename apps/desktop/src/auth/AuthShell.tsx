import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SupabaseAuthProvider,
  createSupabaseClient,
  useUser,
  useAuthLoading,
  useSupabaseClientOrNull,
  type SupabaseClient,
  type User,
} from "@helios/auth";

import {
  clearConnection as clearStoredConnection,
  loadConnection,
  resolveBootConnection,
  saveConnection,
  type SupabaseConnection,
} from "./connection";

interface ConnectionState {
  connection: SupabaseConnection | null;
  /** Set a new Supabase connection (URL + anon key). Replaces any existing
   *  saved connection; subsequent sign-ins will target the new project. */
  setConnection: (c: SupabaseConnection) => void;
  /** Wipe the saved connection AND sign out, returning the app to a
   *  fully-disconnected state. */
  disconnect: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

export function AuthShell({ children }: { children: ReactNode }) {
  const [connection, setConnectionState] = useState<SupabaseConnection | null>(
    () => resolveBootConnection(),
  );

  // Re-create the client whenever the connection changes. We memo on the
  // connection identity so the SupabaseAuthProvider only re-mounts when the
  // user actually swaps Supabase projects, not on every render.
  const client = useMemo<SupabaseClient | null>(() => {
    if (!connection) return null;
    try {
      return createSupabaseClient({
        url: connection.url,
        anonKey: connection.anonKey,
      });
    } catch {
      return null;
    }
  }, [connection]);

  const setConnection = useCallback((c: SupabaseConnection) => {
    saveConnection(c);
    setConnectionState(c);
  }, []);

  const disconnect = useCallback(async () => {
    if (client) {
      try {
        await client.auth.signOut();
      } catch {
        // Best-effort; the user wants to be disconnected regardless of
        // whether the network round-trip succeeds.
      }
    }
    clearStoredConnection();
    setConnectionState(null);
  }, [client]);

  const connectionValue = useMemo<ConnectionState>(
    () => ({
      connection,
      setConnection,
      disconnect,
    }),
    [connection, setConnection, disconnect],
  );

  return (
    <ConnectionContext.Provider value={connectionValue}>
      <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionState {
  const v = useContext(ConnectionContext);
  if (!v) throw new Error("useConnection must be used inside <AuthShell>");
  return v;
}

/** Convenience aggregate hook for components that just need to know "what
 *  state is the auth system in?" — most of the chrome (sidebar pill,
 *  Vault gate) reads this. */
export interface HeliosAuthState {
  /** True if a Supabase URL + anon key are configured. False until the
   *  user has gone through the Connect step at least once. */
  hasConnection: boolean;
  /** Current logged-in user, or null. */
  user: User | null;
  /** True during the brief window between mount and the first
   *  getSession() resolving. */
  loading: boolean;
  /** Live Supabase client; null when there's no connection. */
  client: SupabaseClient | null;
}

export function useHeliosAuth(): HeliosAuthState {
  const user = useUser();
  const loading = useAuthLoading();
  const client = useSupabaseClientOrNull();
  const { connection } = useConnection();
  return {
    hasConnection: connection !== null,
    user,
    loading,
    client,
  };
}

/** Display name preferred over email. Falls back to the local part of the
 *  email, then to "user" so the sidebar pill always has something to show. */
export function userDisplayName(user: User | null): string {
  if (!user) return "";
  const meta = user.user_metadata as Record<string, unknown> | undefined;
  const dn = typeof meta?.display_name === "string" ? meta.display_name.trim() : "";
  if (dn) return dn;
  if (user.email) {
    const at = user.email.indexOf("@");
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return "user";
}

// Re-exported so callers don't have to chase `./connection` for the type.
export type { SupabaseConnection };

// Surfaced for tests that need to push fixtures directly into localStorage.
export { loadConnection, saveConnection, clearStoredConnection };
