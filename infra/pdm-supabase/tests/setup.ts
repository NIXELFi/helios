import { config } from "dotenv";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

config();

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    "Missing SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY. Run `pnpm db:status` and copy values into .env.",
  );
}

export const serviceClient = (): SupabaseClient =>
  createClient(url, serviceKey, { auth: { persistSession: false } });

export const anonClient = (): SupabaseClient =>
  createClient(url, anonKey, { auth: { persistSession: false } });

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

/** Wipes all pdm data (but keeps schema + auth users). Run between tests. */
export async function resetPdmTables(): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.rpc("pdm_test_reset");
  if (error && !error.message.includes("does not exist")) throw error;
}

/** Deletes every auth user (and cascades to user_roles). */
export async function resetAuthUsers(): Promise<void> {
  const svc = serviceClient();
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
