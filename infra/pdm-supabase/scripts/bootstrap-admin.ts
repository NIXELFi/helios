#!/usr/bin/env tsx
/**
 * One-shot: create or promote the OWNER (the super-user that can hand out
 * admin roles). Subsequent admins/editors/viewers are granted from the
 * in-app Admin panel, not this script.
 *
 * Usage:
 *   pnpm bootstrap:admin -- --email me@example.com [--password 'temp123'] [--role owner|admin]
 *
 * `--role` defaults to `owner`. Pass `--role admin` if you only want a plain
 * admin (rare — the owner is what the hybrid permission model expects to exist
 * exactly once). If --password is omitted and the user doesn't exist, a random
 * temporary password is generated and printed once; change it on first login.
 */
import { config } from "dotenv";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

// Node < 22 has no native WebSocket; supabase-js v2.105+ instantiates a
// RealtimeClient at createClient() time even when realtime isn't used.
(globalThis as any).WebSocket ??= WebSocket;

config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg("email");
  if (!email) {
    console.error("usage: bootstrap-admin -- --email <email> [--password <pw>]");
    process.exit(2);
  }
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  const svc = createClient(url, serviceKey, {
    auth: { persistSession: false },
    db: { schema: "pdm" }, // pdm.user_roles, not public.user_roles
  });

  // Find or create the user.
  const { data: list, error: listErr } = await svc.auth.admin.listUsers();
  if (listErr) throw listErr;
  let user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

  if (!user) {
    const password = arg("password") ?? randomBytes(12).toString("base64url");
    const { data, error } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    user = data.user!;
    console.log(`Created auth user: ${user.email} (id=${user.id})`);
    if (!arg("password")) {
      console.log(`Temporary password (change on first login): ${password}`);
    }
  } else {
    console.log(`Found existing auth user: ${user.email} (id=${user.id})`);
  }

  // Upsert into pdm.user_roles. Defaults to 'owner' — the super-user the
  // hybrid permission model expects (only the owner can grant the admin role).
  const role = arg("role") ?? "owner";
  if (!["owner", "admin", "editor", "viewer"].includes(role)) {
    console.error(`Invalid --role '${role}'. Use owner | admin | editor | viewer.`);
    process.exit(2);
  }
  const { error: roleErr } = await svc
    .from("user_roles")
    .upsert({ user_id: user.id, role }, { onConflict: "user_id" });
  if (roleErr) throw roleErr;
  console.log(`Granted role=${role} to ${user.email}.`);

  console.log("\nDone. The user can now log in via Helios and manage roles from the Admin panel.");
}

main().catch((e) => { console.error(e); process.exit(1); });
