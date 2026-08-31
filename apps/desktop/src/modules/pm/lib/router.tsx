// Minimal in-memory router that mirrors the slice of the Next.js navigation API
// the PM views use (Link, usePathname, useRouter, useSearchParams). It lets the
// ported PM components run unchanged inside the Tauri shell — there is no real
// URL, just a path string held in React state. The PmModule reads the pathname
// to decide which view to render.

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

interface RouterState {
  path: string; // full path incl. query, e.g. "/team/aero-design/board?status=done"
  setPath: (next: string) => void;
}

const RouterContext = createContext<RouterState | null>(null);

export function PmRouterProvider({
  initialPath = "/table",
  children,
}: {
  initialPath?: string;
  children: ReactNode;
}) {
  const [path, setPath] = useState(initialPath);
  const value = useMemo<RouterState>(() => ({ path, setPath }), [path]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouterState(): RouterState {
  const v = useContext(RouterContext);
  if (!v) throw new Error("PM router used outside <PmRouterProvider>");
  return v;
}

function splitPath(full: string): { pathname: string; search: string } {
  const q = full.indexOf("?");
  return q >= 0
    ? { pathname: full.slice(0, q), search: full.slice(q) }
    : { pathname: full, search: "" };
}

export function usePathname(): string {
  return splitPath(useRouterState().path).pathname;
}

// Next's useSearchParams returns a ReadonlyURLSearchParams; a plain
// URLSearchParams is structurally compatible for our read-only usage.
export type ReadonlyURLSearchParams = URLSearchParams;

// Memoized on the query string, NOT rebuilt per call. Every view does
// `const filters = useMemo(() => parseFilters(sp), [sp])`; handing back a fresh
// URLSearchParams on each render made that memo (and every memo derived from it
// — filtered rows, grouping, selection sets) miss on EVERY render, so an
// unrelated store tick re-derived and re-rendered the whole view. The object is
// only ever read, so sharing one instance per query string is safe.
export function useSearchParams(): URLSearchParams {
  const search = splitPath(useRouterState().path).search;
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useRouter() {
  const { setPath } = useRouterState();
  return {
    push: (href: string, _opts?: { scroll?: boolean }) => setPath(href),
    replace: (href: string, _opts?: { scroll?: boolean }) => setPath(href),
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  };
}

// Drop-in for next/link's default export, scoped to string hrefs.
export function Link({
  href,
  children,
  onClick,
  ...rest
}: { href: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { setPath } = useRouterState();
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
        setPath(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
