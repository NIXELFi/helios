import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // *.structure.test.ts assert migration SQL shape and need no database — they
    // run under vitest.structure.config.ts so they work without credentials.
    exclude: ["**/node_modules/**", "**/*.structure.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests share a database — must run strictly serially. The original
    // `fileParallel: false` was a typo (the real option is `fileParallelism`).
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
