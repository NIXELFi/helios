import { config } from "dotenv";
import WebSocket from "ws";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

// Node < 22 has no native WebSocket; supabase-js v2.105+ instantiates a
// RealtimeClient at createClient() time. Provide ws as a global to avoid
// "Node.js 20 detected without native WebSocket support" at construction.
(globalThis as any).WebSocket ??= WebSocket;

config();

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    "Missing SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY. Run `pnpm db:status` and copy values into .env.",
  );
}

// db.schema sets the default schema for `.from(table)` calls. Our tables are
// all under `pdm`. Override per-call with `.schema('other')` if needed.
export const serviceClient = (): SupabaseClient =>
  createClient(url, serviceKey, {
    auth: { persistSession: false },
    db: { schema: "pdm" },
  });

export const anonClient = (): SupabaseClient =>
  createClient(url, anonKey, {
    auth: { persistSession: false },
    db: { schema: "pdm" },
  });

/** Creates a confirmed test user via the admin API and returns the User row. */
export async function createTestUser(
  email: string,
  password = "test-password-123",
): Promise<User> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!;
}

/** Returns a Supabase client signed in as the given user. */
export async function signInAs(
  email: string,
  password = "test-password-123",
): Promise<SupabaseClient> {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return c;
}

/** Sets a user's pdm role. Bypasses RLS via service role. */
export async function setRole(
  userId: string,
  role: "admin" | "editor" | "viewer",
): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.from("user_roles").upsert(
    { user_id: userId, role },
    { onConflict: "user_id" },
  ).select().single();
  if (error) throw error;
}

/** Wipes all pdm data via a single SQL RPC defined in
 *  20260508000100_pdm_test_reset.sql, plus storage objects via the Storage API. */
export async function resetPdmTables(): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.rpc("test_reset");
  if (error && !error.message.match(/does not exist|not found/i)) throw error;

  // Storage cleanup: list everything in vault-objects and remove. Supabase blocks
  // direct DELETE on storage.objects via trigger, so we use the Storage API.
  const { data: prefixes } = await svc.storage.from("vault-objects").list();
  if (prefixes && prefixes.length > 0) {
    for (const prefix of prefixes) {
      const { data: objs } = await svc.storage.from("vault-objects").list(prefix.name);
      if (objs && objs.length > 0) {
        const paths = objs.map((o) => `${prefix.name}/${o.name}`);
        await svc.storage.from("vault-objects").remove(paths);
      }
    }
  }
}

/** Deletes every auth user. Wipes pdm tables first to avoid FK violations
 *  on vaults.created_by / versions.author_id / etc. (none of which CASCADE
 *  to auth.users — only user_roles does). */
export async function resetAuthUsers(): Promise<void> {
  const svc = serviceClient();
  await resetPdmTables();
  const { data, error } = await svc.auth.admin.listUsers();
  if (error) throw error;
  for (const u of data.users) {
    await svc.auth.admin.deleteUser(u.id);
  }
}

/** Returns a unique email per test to avoid cross-test collisions. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@helios.test`;
}
