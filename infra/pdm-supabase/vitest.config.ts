import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10_000,
    hookTimeout: 30_000,
    fileParallel: false,
    sequence: { concurrent: false },
  },
});
