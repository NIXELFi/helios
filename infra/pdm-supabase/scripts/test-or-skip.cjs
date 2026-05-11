#!/usr/bin/env node
// Run vitest only when integration test env is configured. The tests in this
// package hit a real Supabase database (cloud or local) and need credentials.
//
// Behavior by environment:
//   * Local dev (CI != "true"): skip with exit 0 if creds are missing, so
//     contributors without supabase set up aren't blocked from running
//     `pnpm -r test`.
//   * CI (CI == "true"): exit 1 if creds are missing. Silently skipping in
//     CI hides regressions — if CI is meant to run these integration tests,
//     the workflow MUST provide SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. If
//     a given CI workflow does not want these tests, it should not invoke
//     this script (i.e. skip the pdm-supabase package).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dotenvExists = fs.existsSync(path.join(__dirname, "..", ".env"));
const envSet = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
const isCI = process.env.CI === "true";

if (!dotenvExists && !envSet) {
  if (isCI) {
    console.error(
      "[@helios/pdm-supabase] CI run is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n" +
      "  CI must provide these env vars to run the integration tests, or the\n" +
      "  workflow must exclude this package from `pnpm -r test`. Silent skip\n" +
      "  is disabled in CI to avoid hiding regressions."
    );
    process.exit(1);
  }
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
