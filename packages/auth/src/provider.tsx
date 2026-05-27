import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";

interface AuthState {
  /** Live Supabase client, or `null` when the host app has no
   *  connection configured yet. Components that need the client should
   *  prefer `useSupabaseClientOrNull()` and gracefully degrade. */
  client: SupabaseClient | null;
  session: Session | null;
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function SupabaseAuthProvider(props: {
  /** May be `null` when the host hasn't collected Supabase URL + anon
   *  key from the user yet. In that mode the provider stays mounted but
   *  reports no session and no user, so consumer hooks resolve cleanly
   *  instead of throwing. */
  client: SupabaseClient | null;
  children: ReactNode;
}) {
  const { client, children } = props;
  const [session, setSession] = useState<Session | null>(null);
  // When there's no client there's no session work to do — keep loading=false
  // so the UI doesn't sit on a spinner forever. With a client we start in
  // loading=true and flip to false after getSession() resolves.
  const [loading, setLoading] = useState<boolean>(() => client !== null);

  useEffect(() => {
    if (!client) {
      setSession(null);
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    client.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;
      setSession(newSession ?? null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<AuthState>(
    () => ({
      client,
      session,
      user: session?.user ?? null,
      loading,
    }),
    [client, session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Internal: returns the full auth state. */
export function useAuthInternal(): AuthState {
  const v = useContext(AuthContext);
  if (!v) {
    throw new Error("useAuth* hooks must be used inside <SupabaseAuthProvider>");
  }
  return v;
}
