import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@helios/auth": path.resolve(__dirname, "../../packages/auth/src"),
      "@helios/store": path.resolve(__dirname, "../../packages/store/src"),
      "@helios/lib": path.resolve(__dirname, "../../packages/lib/src"),
      "@helios/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@helios/widgets": path.resolve(__dirname, "../../packages/widgets/src"),
    },
  },
});
