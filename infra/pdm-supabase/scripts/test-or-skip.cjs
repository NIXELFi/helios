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
//
// Safety: refuses to run the suite if SUPABASE_URL points at a non-local
// host. The integration tests' beforeEach calls pdm.test_reset() which
// wipes pdm.* and auth.users; we don't want that to ever land on a hosted
// project just because a contributor's .env was misconfigured. To run the
// suite against a hosted test-only project, set
// PDM_ALLOW_HOSTED_TESTS=1 (and make sure that project has
// `ALTER DATABASE postgres SET app.environment = 'test'` set — the db-side
// guard in 20260511001200 will reject test_reset() otherwise).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Honor dotenv-style env loading from .env if present (vitest does this too,
// but we need SUPABASE_URL pre-spawn for the host check below).
const dotenvPath = path.join(__dirname, "..", ".env");
const dotenvExists = fs.existsSync(dotenvPath);
if (dotenvExists) {
  for (const line of fs.readFileSync(dotenvPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

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

// Host-shape safety check. The test suite calls pdm.test_reset() which wipes
// the project's pdm.* tables and auth.users. We refuse to do that against any
// host that isn't obviously local Supabase, unless the operator has explicitly
// opted in via PDM_ALLOW_HOSTED_TESTS=1.
const url = process.env.SUPABASE_URL ?? "";
const isLocalHost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|kong\.[^/]+|host\.docker\.internal)(:\d+)?(\/|$)/i.test(url);
if (!isLocalHost && process.env.PDM_ALLOW_HOSTED_TESTS !== "1") {
  console.error(
    `[@helios/pdm-supabase] refusing to run integration tests against non-local SUPABASE_URL:\n  ${url}\n\n` +
    "  The test suite's beforeEach calls pdm.test_reset() which wipes pdm.*\n" +
    "  and auth.users. Running against a hosted project would erase real data.\n\n" +
    "  To run against a local Supabase stack: `supabase start` and point .env\n" +
    "  at http://127.0.0.1:54321.\n\n" +
    "  To intentionally run against a hosted *test-only* project, set\n" +
    "  PDM_ALLOW_HOSTED_TESTS=1. (The db-side guard in migration\n" +
    "  20260511001200 still requires `ALTER DATABASE postgres SET\n" +
    "  app.environment = 'test'` on that project; production projects without\n" +
    "  that setting reject test_reset() automatically.)"
  );
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "vitest", "run"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  cwd: path.join(__dirname, ".."),
});
process.exit(result.status ?? 1);
