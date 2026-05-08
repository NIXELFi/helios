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
  client: SupabaseClient;
  session: Session | null;
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function SupabaseAuthProvider(props: {
  client: SupabaseClient;
  children: ReactNode;
}) {
  const { client, children } = props;
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
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
