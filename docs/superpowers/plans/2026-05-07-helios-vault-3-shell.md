# Helios Vault — Plan 3: Suite Shell + Login

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the suite-wide identity layer to Helios. After this plan, the existing Helios desktop app gains a new "Vault" entry in a left rail, gated behind a Supabase login. Logs continues to render exactly as before — no auth, no migration, identical UX.

**Architecture:** New `packages/auth/` provides a Supabase JS wrapper, `useUser`/`useSession` hooks, and a `RequireAuth` route guard. `apps/desktop/src/` gains `modules/vault/` (Vault entry + login pane + post-login placeholder home) and `shell/` (the left rail / module picker). `App.tsx` is wrapped in `SupabaseAuthProvider`, but the Logs module renders unconditionally — Vault is the only consumer of `RequireAuth`. **No existing files in `apps/desktop/src/{components,lib,workspaces}` move or change** — the additive structure preserves every Logs test and the daily Logs UX.

**Tech Stack:** React 18, TypeScript, `@supabase/supabase-js`, Tailwind, Vitest + jsdom + `@testing-library/react`.

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plans 1, 2 (the spec, schema, and Rust client are referenced but not consumed yet — Plan 3 only uses the Supabase JS client).

---

## File Structure

### New files

```
packages/
  auth/
    package.json
    tsconfig.json
    vitest.config.ts
    src/
      index.ts                       ← public API
      client.ts                      ← createSupabaseClient() factory
      provider.tsx                   ← <SupabaseAuthProvider>
      hooks.ts                       ← useUser, useSession, useAuthLoading
      RequireAuth.tsx                ← route guard
    tests/
      setup.ts                       ← jsdom matchMedia stub
      provider.test.tsx
      hooks.test.tsx
      RequireAuth.test.tsx

apps/desktop/
  src/
    modules/
      vault/
        index.tsx                    ← <VaultModule /> — wraps everything below in <RequireAuth>
        LoginPane.tsx                ← email + password form
        VaultHome.tsx                ← post-login placeholder until Plan 4
    shell/
      ModulePicker.tsx               ← left rail: Logs (active by default) + Vault (NEW badge)
  tests/
    LoginPane.test.tsx
    ModulePicker.test.tsx
    VaultModule.test.tsx
    auth-integration.test.tsx        ← <App /> renders Logs without login when Vault never clicked
```

### Modified files

```
package.json                                ← add @testing-library + jsdom workspace deps if not already there
apps/desktop/package.json                   ← add @helios/auth workspace dep
apps/desktop/src/App.tsx                    ← wrap in <SupabaseAuthProvider>, render <ModulePicker>, route Logs vs Vault
apps/desktop/src/main.tsx                   ← (potentially) configure auth env at startup
apps/desktop/.env.example                   ← VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (for dev)
apps/desktop/vite.config.ts                 ← (verify nothing needs changing for env var pickup; Vite handles VITE_* by default)
```

### Files NOT touched

`apps/desktop/src/{components,lib,workspaces}/**` — every existing Logs source file. `apps/desktop/tests/**` — every existing Logs test continues to pass without import changes. `crates/**`, `infra/**`, `docs/**` — out of scope.

---

## Conventions used throughout

- **TDD per task.** Failing test → run-and-confirm-fail → implementation → run-and-confirm-pass → commit.
- **Auth provider tests use mocked Supabase clients.** No network, no Docker. The `@supabase/supabase-js` `createClient()` returns an object whose `auth.*` and `realtime` surfaces we mock with `vi.fn()`.
- **`apps/desktop/.env.local` is not committed.** Uses `.env.example` as a template. Auth provider falls back to a recognizable stub URL (`http://localhost:0`) when env is missing — useful in tests, harmless in dev where the login simply fails until the user populates `.env.local`.
- **No `git push`.** Local commits only. Roadmap policy: no remote pushes until Plan 4 lands.
- **Visual design defaults are placeholders.** The login pane and module picker use minimal Tailwind; the user can iterate on visuals later. Functional behavior is what we validate.

---

## Task 0: Scaffold `packages/auth/`

**Files:**
- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/auth/vitest.config.ts`
- Create: `packages/auth/src/index.ts` (empty stub)
- Create: `packages/auth/tests/setup.ts`

- [ ] **Step 1: Create `packages/auth/package.json`.**

```json
{
  "name": "@helios/auth",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "react": "^18.3.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  },
  "peerDependencies": {
    "react": "^18.3.0"
  }
}
```

- [ ] **Step 2: Create `packages/auth/tsconfig.json`.**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

(If `tsconfig.base.json` doesn't exist or has incompatible settings, leave the `extends` line out and self-contain the config.)

- [ ] **Step 3: Create `packages/auth/vitest.config.ts`.**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create `packages/auth/src/index.ts`.**

```ts
// Filled in by subsequent tasks.
export {};
```

- [ ] **Step 5: Create `packages/auth/tests/setup.ts`.**

```ts
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia; some Tailwind / RTL paths hit it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}
```

- [ ] **Step 6: Install workspace deps and verify.**

```bash
cd /Users/nmurray/Developer/helios
pnpm install
cd packages/auth
pnpm typecheck
pnpm test
```

`pnpm install` should pick up the new package automatically (the root `pnpm-workspace.yaml` already globs `packages/*`). `pnpm typecheck` should pass with zero errors (the stub index.ts has no errors). `pnpm test` should report "no test files found" or "0 passed" — that's fine for the scaffold.

- [ ] **Step 7: Commit.**

```bash
git add packages/auth
git commit -m "feat(auth): scaffold @helios/auth package"
```

---

## Task 1: `createSupabaseClient` factory

**Files:**
- Create: `packages/auth/src/client.ts`
- Modify: `packages/auth/src/index.ts`
- Create: `packages/auth/tests/client.test.ts`

- [ ] **Step 1: Write failing test** at `packages/auth/tests/client.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseClient } from "../src/client";

describe("createSupabaseClient", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a client when both URL and anon key are provided explicitly", () => {
    const c = createSupabaseClient({
      url: "https://example.supabase.co",
      anonKey: "anon-k",
    });
    expect(c).toBeDefined();
    expect(c.auth).toBeDefined();
  });

  it("reads from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY when args omitted", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://from-env.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "env-key");
    const c = createSupabaseClient();
    expect(c).toBeDefined();
  });

  it("throws when no URL is configured", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    expect(() => createSupabaseClient()).toThrow(/SUPABASE_URL/);
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

```bash
cd /Users/nmurray/Developer/helios/packages/auth
pnpm test client.test.ts
```

- [ ] **Step 3: Write `packages/auth/src/client.ts`.**

```ts
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
  // import.meta.env is only available under bundlers like Vite. Use a typeof
  // guard so this also works under Vitest (which provides it) and Node.
  const env: Record<string, string | undefined> =
    (typeof import.meta !== "undefined" && (import.meta as any).env) || {};

  const url = args.url ?? env.VITE_SUPABASE_URL ?? "";
  const anonKey = args.anonKey ?? env.VITE_SUPABASE_ANON_KEY ?? "";

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
```

- [ ] **Step 4: Update `packages/auth/src/index.ts`.**

```ts
export { createSupabaseClient, type SupabaseConfig } from "./client";
```

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add packages/auth/src/client.ts packages/auth/src/index.ts packages/auth/tests/client.test.ts
git commit -m "feat(auth): createSupabaseClient factory with env-var fallback"
```

---

## Task 2: `<SupabaseAuthProvider>` + `useUser` / `useSession` / `useAuthLoading`

**Files:**
- Create: `packages/auth/src/provider.tsx`
- Create: `packages/auth/src/hooks.ts`
- Modify: `packages/auth/src/index.ts`
- Create: `packages/auth/tests/provider.test.tsx`

- [ ] **Step 1: Write failing test.**

`packages/auth/tests/provider.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useUser, useSession, useAuthLoading } from "../src";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(initialSession: any = null): SupabaseClient {
  let listeners: any[] = [];
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: initialSession },
        error: null,
      }),
      onAuthStateChange: (cb: any) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: vi.fn().mockResolvedValue({ error: null }),
      // Helper used by tests below to drive a state-change event.
      __emit: (event: string, session: any) => {
        listeners.forEach((cb) => cb(event, session));
      },
    },
  } as any;
}

function Probe() {
  const user = useUser();
  const session = useSession();
  const loading = useAuthLoading();
  return (
    <div>
      <span data-testid="loading">{loading ? "loading" : "idle"}</span>
      <span data-testid="user">{user ? user.id : "none"}</span>
      <span data-testid="hasSession">{session ? "yes" : "no"}</span>
    </div>
  );
}

describe("SupabaseAuthProvider", () => {
  it("starts in loading state, then transitions to idle/no-user when no session", async () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <Probe />
      </SupabaseAuthProvider>,
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("loading");
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("idle");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(screen.getByTestId("hasSession")).toHaveTextContent("no");
  });

  it("hydrates user when initial session exists", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "user-123", email: "u@example.com" },
    };
    const client = mockClient(session);
    render(
      <SupabaseAuthProvider client={client}>
        <Probe />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("idle");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("user-123");
    expect(screen.getByTestId("hasSession")).toHaveTextContent("yes");
  });

  it("updates state when onAuthStateChange fires SIGNED_IN", async () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <Probe />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("loading")).toHaveTextContent("idle");
    });
    expect(screen.getByTestId("user")).toHaveTextContent("none");

    (client.auth as any).__emit("SIGNED_IN", {
      access_token: "a",
      refresh_token: "r",
      user: { id: "user-456", email: "u@example.com" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("user")).toHaveTextContent("user-456");
    });
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `packages/auth/src/provider.tsx`.**

```tsx
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
```

- [ ] **Step 4: Write `packages/auth/src/hooks.ts`.**

```ts
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
```

- [ ] **Step 5: Update `packages/auth/src/index.ts`.**

```ts
export { createSupabaseClient, type SupabaseConfig } from "./client";
export { SupabaseAuthProvider } from "./provider";
export { useUser, useSession, useAuthLoading, useSupabaseClient } from "./hooks";
```

- [ ] **Step 6: Run.** Expect 3 tests pass.

- [ ] **Step 7: Commit.**

```bash
git add packages/auth/src/{provider.tsx,hooks.ts,index.ts} packages/auth/tests/provider.test.tsx
git commit -m "feat(auth): SupabaseAuthProvider + useUser/useSession/useAuthLoading hooks"
```

---

## Task 3: `<RequireAuth>` route guard

**Files:**
- Create: `packages/auth/src/RequireAuth.tsx`
- Modify: `packages/auth/src/index.ts`
- Create: `packages/auth/tests/RequireAuth.test.tsx`

- [ ] **Step 1: Write failing test.**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, RequireAuth } from "../src";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(session: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  } as any;
}

describe("<RequireAuth>", () => {
  it("renders fallback while loading", () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <RequireAuth fallback={<div>signing in…</div>} unauthenticated={<div>login</div>}>
          <div>secret</div>
        </RequireAuth>
      </SupabaseAuthProvider>,
    );
    expect(screen.getByText("signing in…")).toBeInTheDocument();
  });

  it("renders unauthenticated when there is no session", async () => {
    const client = mockClient(null);
    render(
      <SupabaseAuthProvider client={client}>
        <RequireAuth fallback={<div>l</div>} unauthenticated={<div>login</div>}>
          <div>secret</div>
        </RequireAuth>
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("login")).toBeInTheDocument();
    });
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("renders children when there is a session", async () => {
    const client = mockClient({
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    });
    render(
      <SupabaseAuthProvider client={client}>
        <RequireAuth fallback={<div>l</div>} unauthenticated={<div>login</div>}>
          <div>secret</div>
        </RequireAuth>
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("secret")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `packages/auth/src/RequireAuth.tsx`.**

```tsx
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
```

- [ ] **Step 4: Update `packages/auth/src/index.ts`** — add `export { RequireAuth } from "./RequireAuth";`.

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add packages/auth/src/RequireAuth.tsx packages/auth/src/index.ts packages/auth/tests/RequireAuth.test.tsx
git commit -m "feat(auth): RequireAuth route guard"
```

---

## Task 4: `LoginPane` component

**Files:**
- Create: `apps/desktop/src/modules/vault/LoginPane.tsx`
- Create: `apps/desktop/tests/LoginPane.test.tsx`

The LoginPane lives in the desktop app (not in `@helios/auth`) because it consumes Helios styling. Tests use `@testing-library/react` against a mocked Supabase client.

- [ ] **Step 1: Add `@helios/auth` as a workspace dep in `apps/desktop/package.json`.**

In the `dependencies` block of `apps/desktop/package.json`, add:

```json
"@helios/auth": "workspace:*",
```

Run `pnpm install` from the repo root to wire it up.

- [ ] **Step 2: Write failing test.**

`apps/desktop/tests/LoginPane.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import { LoginPane } from "../src/modules/vault/LoginPane";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(signInImpl: any = vi.fn()): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithPassword: signInImpl,
    },
  } as any;
}

function renderWith(client: SupabaseClient) {
  return render(
    <SupabaseAuthProvider client={client}>
      <LoginPane />
    </SupabaseAuthProvider>,
  );
}

describe("<LoginPane>", () => {
  it("renders email + password fields and a sign-in button", () => {
    renderWith(mockClient());
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("calls signInWithPassword with the entered credentials", async () => {
    const signIn = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
    renderWith(mockClient(signIn));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({ email: "u@example.com", password: "hunter2" });
    });
  });

  it("shows an error message when sign-in fails", async () => {
    const signIn = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { message: "Invalid login credentials" },
    });
    renderWith(mockClient(signIn));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByText(/invalid login credentials/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run, confirm failure.**

```bash
cd /Users/nmurray/Developer/helios/apps/desktop
pnpm test tests/LoginPane.test.tsx
```

The desktop's existing vitest config may not be set up for jsdom + RTL. Check `apps/desktop/vitest.config.ts`:

```bash
cat /Users/nmurray/Developer/helios/apps/desktop/vitest.config.ts
```

If it's not configured for jsdom, update it:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
```

If `apps/desktop/tests/setup.ts` doesn't exist, create it (matches the workspace-management plan's pattern):

```ts
import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList;
}
```

Verify the existing tests still pass after this config change:

```bash
cd /Users/nmurray/Developer/helios/apps/desktop
pnpm test
```

If existing tests start failing because of the jsdom switch, investigate. (Should not happen — earlier `v2_changes/25-workspace-management.md` already added jsdom to this workspace per its design doc; the config may already be correct.)

- [ ] **Step 4: Write `LoginPane`.**

`apps/desktop/src/modules/vault/LoginPane.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useSupabaseClient } from "@helios/auth";

export function LoginPane() {
  const client = useSupabaseClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
      }
      // On success, the SupabaseAuthProvider will pick up SIGNED_IN via
      // onAuthStateChange; no explicit redirect needed.
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-100">
      <form
        onSubmit={onSubmit}
        className="w-80 space-y-4 rounded-lg border border-zinc-700 bg-zinc-800 p-6 shadow-lg"
      >
        <h2 className="text-lg font-semibold">Sign in to Helios Vault</h2>
        <p className="text-sm text-zinc-400">
          Vault requires an account. Logs continues to work without one. Ask your
          team admin to invite you if you don't have one yet.
        </p>
        <div className="space-y-1">
          <label htmlFor="login-email" className="block text-sm">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm focus:border-yellow-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="login-password" className="block text-sm">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm focus:border-yellow-500 focus:outline-none"
          />
        </div>
        {error ? (
          <div role="alert" className="text-sm text-red-400">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-yellow-500 px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-yellow-400 disabled:bg-zinc-600"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Run.** Expect 3 LoginPane tests pass and existing Logs tests still pass.

```bash
pnpm test
```

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/package.json \
        apps/desktop/vitest.config.ts \
        apps/desktop/tests/setup.ts \
        apps/desktop/src/modules/vault/LoginPane.tsx \
        apps/desktop/tests/LoginPane.test.tsx
git commit -m "feat(desktop/vault): LoginPane component"
```

(Skip files in the `git add` list that you didn't actually modify.)

---

## Task 5: Vault module entry — `<VaultModule>` + `<VaultHome>` placeholder

**Files:**
- Create: `apps/desktop/src/modules/vault/VaultHome.tsx`
- Create: `apps/desktop/src/modules/vault/index.tsx`
- Create: `apps/desktop/tests/VaultModule.test.tsx`

- [ ] **Step 1: Write failing test.**

`apps/desktop/tests/VaultModule.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import { VaultModule } from "../src/modules/vault";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(session: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithPassword: vi.fn(),
    },
  } as any;
}

describe("<VaultModule>", () => {
  it("shows the LoginPane when not authenticated", async () => {
    render(
      <SupabaseAuthProvider client={mockClient(null)}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });
  });

  it("shows the VaultHome placeholder when authenticated", async () => {
    const session = {
      access_token: "a",
      refresh_token: "r",
      user: { id: "u", email: "u@x.com" },
    };
    render(
      <SupabaseAuthProvider client={mockClient(session)}>
        <VaultModule />
      </SupabaseAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/vault/i)).toBeInTheDocument();
    });
    // The placeholder home contains a hint about Plan 4 / coming soon.
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `VaultHome`.**

`apps/desktop/src/modules/vault/VaultHome.tsx`:

```tsx
import { useUser, useSupabaseClient } from "@helios/auth";

export function VaultHome() {
  const user = useUser();
  const client = useSupabaseClient();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-900 text-zinc-100">
      <h1 className="text-2xl font-semibold">Helios Vault</h1>
      <p className="text-sm text-zinc-400">
        Signed in as <span className="font-mono">{user?.email}</span>
      </p>
      <p className="max-w-md text-center text-sm text-zinc-500">
        Vault browse, history, and admin views are coming soon (Plan 4).
      </p>
      <button
        onClick={() => void client.auth.signOut()}
        className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        Sign out
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Write `VaultModule`.**

`apps/desktop/src/modules/vault/index.tsx`:

```tsx
import { RequireAuth } from "@helios/auth";
import { LoginPane } from "./LoginPane";
import { VaultHome } from "./VaultHome";

export function VaultModule() {
  return (
    <RequireAuth
      fallback={
        <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-400">
          Loading…
        </div>
      }
      unauthenticated={<LoginPane />}
    >
      <VaultHome />
    </RequireAuth>
  );
}
```

- [ ] **Step 5: Run, expect pass.**

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/modules/vault \
        apps/desktop/tests/VaultModule.test.tsx
git commit -m "feat(desktop/vault): VaultModule entry + VaultHome placeholder"
```

---

## Task 6: `<ModulePicker>` left rail

**Files:**
- Create: `apps/desktop/src/shell/ModulePicker.tsx`
- Create: `apps/desktop/tests/ModulePicker.test.tsx`

- [ ] **Step 1: Write failing test.**

`apps/desktop/tests/ModulePicker.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ModulePicker } from "../src/shell/ModulePicker";

describe("<ModulePicker>", () => {
  it("renders Logs (active) and Vault (with NEW badge) entries", () => {
    render(<ModulePicker active="logs" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /logs/i })).toBeInTheDocument();
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toBeInTheDocument();
    expect(screen.getByText(/new/i)).toBeInTheDocument();
  });

  it("highlights the active module via aria-current", () => {
    render(<ModulePicker active="vault" onSelect={() => {}} />);
    const vaultBtn = screen.getByRole("button", { name: /vault/i });
    expect(vaultBtn).toHaveAttribute("aria-current", "page");
    const logsBtn = screen.getByRole("button", { name: /logs/i });
    expect(logsBtn).not.toHaveAttribute("aria-current", "page");
  });

  it("calls onSelect when an entry is clicked", () => {
    const onSelect = vi.fn();
    render(<ModulePicker active="logs" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /vault/i }));
    expect(onSelect).toHaveBeenCalledWith("vault");
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Write `ModulePicker`.**

```tsx
export type ModuleId = "logs" | "vault";

export function ModulePicker(props: {
  active: ModuleId;
  onSelect: (id: ModuleId) => void;
}) {
  const { active, onSelect } = props;
  return (
    <nav className="flex w-44 flex-col gap-1 border-r border-zinc-800 bg-zinc-950 p-2">
      <button
        type="button"
        aria-current={active === "logs" ? "page" : undefined}
        onClick={() => onSelect("logs")}
        className={
          "rounded px-3 py-2 text-left text-sm " +
          (active === "logs"
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-900")
        }
      >
        Logs
      </button>
      <button
        type="button"
        aria-current={active === "vault" ? "page" : undefined}
        onClick={() => onSelect("vault")}
        className={
          "flex items-center justify-between rounded px-3 py-2 text-left text-sm " +
          (active === "vault"
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-900")
        }
      >
        <span>Vault</span>
        <span className="ml-2 rounded bg-yellow-500 px-1.5 py-0.5 text-xs font-bold text-zinc-900">
          NEW
        </span>
      </button>
    </nav>
  );
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/shell/ModulePicker.tsx apps/desktop/tests/ModulePicker.test.tsx
git commit -m "feat(desktop/shell): ModulePicker left rail with Logs and Vault (NEW)"
```

---

## Task 7: Wire `<App>` — auth provider, module router, no-op for unauthenticated Logs

**Files:**
- Modify: `apps/desktop/src/App.tsx` (wrap in provider + add module router)
- Modify: `apps/desktop/src/main.tsx` (verify entry — likely no change needed)
- Create: `apps/desktop/.env.example`
- Create: `apps/desktop/tests/auth-integration.test.tsx`

- [ ] **Step 1: Write failing integration test.**

`apps/desktop/tests/auth-integration.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@helios/auth", async () => {
  const actual = await vi.importActual<typeof import("@helios/auth")>("@helios/auth");
  // Override createSupabaseClient to return a controllable mock.
  return {
    ...actual,
    createSupabaseClient: () =>
      ({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signInWithPassword: vi.fn(),
        },
      } as any),
  };
});

// Import after the mock so App picks it up.
import App from "../src/App";

describe("App auth integration", () => {
  it("opens to Logs and never shows the login pane unless Vault is clicked", async () => {
    render(<App />);
    // Logs is active by default. The Helios header / loading screen should be present.
    // We don't assert on specific Logs DOM (varies); we assert that the LoginPane is NOT visible.
    await waitFor(() => {
      // Wait for Auth provider to settle.
      expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    });
  });

  it("shows the login pane when Vault is selected from the left rail", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /vault/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /vault/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Modify `apps/desktop/src/App.tsx`.**

The existing `App.tsx` is a single large component that renders the entire Logs UI directly. We will:

1. Wrap whatever it currently exports (the existing component, still rendering the Logs UI) inside a new top-level component that:
   - Initializes a Supabase client via `createSupabaseClient()` (lazily, so import errors due to missing env don't crash; on import error, `client` is `null` and Vault is disabled).
   - Provides it via `<SupabaseAuthProvider>`.
   - Renders the `<ModulePicker>` on the left and the active module on the right.
   - Defaults `active` to `"logs"`.

The simplest refactor: rename the current default-exported component from `App` to `LogsApp` (it already renders the entire logs UI), then introduce a new default `App` component that orchestrates modules.

Open `apps/desktop/src/App.tsx`. At the bottom of the file, find `export default function App(...) { ... }` (or similar). Rename it to `LogsApp` (still default-export-friendly because we'll re-export below).

Then ADD at the bottom of the file:

```tsx
import { useState, useMemo } from "react";
import { SupabaseAuthProvider, createSupabaseClient } from "@helios/auth";
import { ModulePicker, type ModuleId } from "./shell/ModulePicker";
import { VaultModule } from "./modules/vault";

function tryCreateClient() {
  try {
    return createSupabaseClient();
  } catch {
    return null;
  }
}

function HeliosShell() {
  const [active, setActive] = useState<ModuleId>("logs");
  const client = useMemo(tryCreateClient, []);

  return (
    <div className="flex h-screen w-screen">
      <ModulePicker active={active} onSelect={setActive} />
      <main className="flex-1">
        {active === "logs" ? (
          <LogsApp />
        ) : client ? (
          <SupabaseAuthProvider client={client}>
            <VaultModule />
          </SupabaseAuthProvider>
        ) : (
          <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-400">
            Vault is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
            <code className="ml-1">.env.local</code>.
          </div>
        )}
      </main>
    </div>
  );
}

export default HeliosShell;
```

NOTE: If the original file ALREADY has a `default` export, change THAT line to `export default LogsApp;` after renaming the inner function — actually, since we want `HeliosShell` to be the default export now, the original `export default App` line should be removed (or changed to `export { LogsApp }` / `function LogsApp(...)`). The end result must be:
- `LogsApp` is a non-default named function/export at the top, containing what was the original App.
- `HeliosShell` is the new default export.

If `App.tsx` is too tangled to do a clean rename in this task, an alternative is to leave `App.tsx` alone and create a NEW `apps/desktop/src/Shell.tsx` that imports `App` (the existing one) and uses it as `LogsApp`. Then change `apps/desktop/src/main.tsx` to import `Shell` instead of `App`. This keeps the diff minimal.

**Recommended approach:** create `apps/desktop/src/Shell.tsx` with HeliosShell, change `main.tsx`'s import. Don't touch App.tsx.

`apps/desktop/src/Shell.tsx`:

```tsx
import { useState, useMemo } from "react";
import { SupabaseAuthProvider, createSupabaseClient } from "@helios/auth";
import { ModulePicker, type ModuleId } from "./shell/ModulePicker";
import { VaultModule } from "./modules/vault";
import LogsApp from "./App";

function tryCreateClient() {
  try {
    return createSupabaseClient();
  } catch {
    return null;
  }
}

export default function HeliosShell() {
  const [active, setActive] = useState<ModuleId>("logs");
  const client = useMemo(tryCreateClient, []);

  return (
    <div className="flex h-screen w-screen">
      <ModulePicker active={active} onSelect={setActive} />
      <main className="flex-1">
        {active === "logs" ? (
          <LogsApp />
        ) : client ? (
          <SupabaseAuthProvider client={client}>
            <VaultModule />
          </SupabaseAuthProvider>
        ) : (
          <div className="flex h-full items-center justify-center bg-zinc-900 text-zinc-400">
            Vault is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
            <code className="ml-1">.env.local</code>.
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Modify `apps/desktop/src/main.tsx`** — change the import from `./App` to `./Shell`.

Open `apps/desktop/src/main.tsx`. Replace its import line for App with:

```tsx
import App from "./Shell";
```

Or — equivalently — leave the variable name as `App`:

```tsx
import App from "./Shell";  // App is the suite shell; it renders Logs by default.
```

The render call (`createRoot(...).render(<App />)`) stays the same.

- [ ] **Step 5: Create `apps/desktop/.env.example`.**

```
# Helios Vault Supabase config (required only for the Vault module to function).
# Logs works without these.
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

Add `apps/desktop/.env.local` to `.gitignore` if not already covered.

- [ ] **Step 6: Update the integration test** so the mock for `createSupabaseClient` returns a real-ish client even when env is missing — the production `tryCreateClient` returns `null` on error, but the TEST should mock to return a working stub. The test file in Step 1 already does this via `vi.mock("@helios/auth", ...)`. Good.

But the test imports `App` from `../src/App` — we should change it to `../src/Shell`:

```tsx
import App from "../src/Shell";
```

(Update Step 1's test file accordingly.)

- [ ] **Step 7: Run.** Expect both integration tests pass and existing tests still pass.

```bash
cd /Users/nmurray/Developer/helios/apps/desktop
pnpm test
```

If existing Logs tests fail because something broke during the wrap — investigate and fix. The most likely failure mode is that an existing test imports `App` from `../src/App` and expects it to render the full Logs UI; that should still work because we didn't change `App.tsx`.

- [ ] **Step 8: Commit.**

```bash
git add apps/desktop/src/Shell.tsx \
        apps/desktop/src/main.tsx \
        apps/desktop/.env.example \
        apps/desktop/tests/auth-integration.test.tsx
git commit -m "feat(desktop): suite shell with ModulePicker; Vault gated behind login, Logs unaffected"
```

---

## Task 8: Plan-completion review

- [ ] **Step 1: Run the full pnpm test suite.**

```bash
cd /Users/nmurray/Developer/helios
pnpm test
```

Expect:
- Every existing Logs test passes (zero regressions).
- All `@helios/auth` tests pass: provider(3) + RequireAuth(3) + client(3) = 9.
- All new desktop tests pass: LoginPane(3) + ModulePicker(3) + VaultModule(2) + auth-integration(2) = 10.

- [ ] **Step 2: Run pnpm typecheck and lint.**

```bash
pnpm typecheck
pnpm lint
```

If lint reports issues in new code, fix in place; commit each as `style(...): lint nit — <description>`. Pre-existing lint issues are not your scope.

- [ ] **Step 3: Smoke-check the Tauri app.**

```bash
pnpm dev
```

The app should launch. Verify in the running window:
- Default view is the Logs UI (left rail shows Logs as active).
- Clicking "Vault" in the left rail shows EITHER (a) the login pane if env is configured, or (b) the "Vault is not configured" fallback if not.
- Clicking back to "Logs" returns to the existing Logs UI.

Stop dev with Ctrl+C.

- [ ] **Step 4: Update the roadmap.**

In `docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`, change Plan 3's status from `not started` to `code complete @ <SHORT_SHA>`. Use the placeholder + amend pattern, or two-commit pattern, same as Plans 1 and 2.

- [ ] **Step 5: Final commit.**

```bash
git add docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md
git commit -m "chore(roadmap): mark Plan 3 (suite shell + login) complete"
```

- [ ] **Step 6: Confirm no push.**

```bash
git status
git log feat/helios-vault-1-backend --oneline | head -25
```

---

## What Plan 4 picks up

Plan 4 (`2026-05-07-helios-vault-4-vault-ui.md`) replaces the `<VaultHome>` placeholder with the real Vault module screens: Browse (folder tree + file table with live lock state via Supabase Realtime), File detail, History viewer, Search, Who-has-what, Admin → Users, Admin → Vaults, Settings. Most screens render with mocked Supabase data in tests; the live integration is validated when the user runs the app against a real Supabase project.
