import { defineConfig } from "vitest/config";

// Structural tests read migration SQL off disk and assert its shape. They need no
// database, so they deliberately do NOT load ./tests/setup.ts (which throws when
// SUPABASE_URL / keys are absent) and therefore run on any machine — including
// the ones with no Docker and so no local Supabase.
//
// Run: pnpm --filter @helios/pdm-supabase test:structure
export default defineConfig({
  test: {
    include: ["tests/**/*.structure.test.ts"],
  },
});
