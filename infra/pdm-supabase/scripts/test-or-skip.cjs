#!/usr/bin/env node
// Run vitest only when integration test env is configured. The tests in this
// package hit a real Supabase database (cloud or local) and need credentials.
// In CI without those creds, we skip cleanly so the workflow can still
// validate everything else (root `pnpm test` shouldn't fail just because
// pdm-supabase's integration tests don't have backend access).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dotenvExists = fs.existsSync(path.join(__dirname, "..", ".env"));
const envSet = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!dotenvExists && !envSet) {
  console.log("[@helios/pdm-supabase] skipping integration tests — no SUPABASE_URL in env or .env file");
  process.exit(0);
}

// Use pnpm exec to find vitest in the workspace's hoisted node_modules.
const result = spawnSync("pnpm", ["exec", "vitest", "run"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  cwd: path.join(__dirname, ".."),
});
process.exit(result.status ?? 1);
