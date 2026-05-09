import type { ReactNode } from "react";
import { useAuthInternal } from "./provider";

export function RequireAuth(props: {
  /** Rendered while the auth provider is hydrating. */
  fallback: ReactNode;
  /** Rendered when there is no active session. Typically the LoginPane. */
  unauthenticated: ReactNode;
  /** Rendered when authenticated. */
  children: ReactNode;
}) {
  const { fallback, unauthenticated, children } = props;
  const { loading, user } = useAuthInternal();
  if (loading) return <>{fallback}</>;
  if (!user) return <>{unauthenticated}</>;
  return <>{children}</>;
}
