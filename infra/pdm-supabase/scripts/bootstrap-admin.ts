#!/usr/bin/env tsx
/**
 * One-shot: create or promote the first admin user.
 *
 * Usage:
 *   pnpm bootstrap:admin -- --email me@example.com [--password 'temp123']
 *
 * If --password is omitted and the user doesn't exist, a random temporary
 * password is generated and printed once. The admin must change it on first login.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

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

  const svc = createClient(url, serviceKey, { auth: { persistSession: false } });

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

  // Upsert into pdm.user_roles with role=admin.
  const { error: roleErr } = await svc
    .from("user_roles")
    .upsert({ user_id: user.id, role: "admin" }, { onConflict: "user_id" });
  if (roleErr) throw roleErr;
  console.log(`Granted role=admin to ${user.email}.`);

  console.log("\nDone. The user can now log in via Helios and access all admin operations.");
}

main().catch((e) => { console.error(e); process.exit(1); });
