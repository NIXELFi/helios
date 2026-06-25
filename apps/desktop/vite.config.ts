import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Allow serving the monorepo-root pnpm store so @fontsource .woff2 files
    // (resolved under ../../node_modules/.pnpm/…) load in dev. Production
    // bundles fonts at build time, so this is dev-only.
    fs: { allow: [".", "../../docs/wiki", "../../node_modules"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "esnext", minify: "esbuild" },
  resolve: {
    alias: {
      "@helios/store": path.resolve(__dirname, "../../packages/store/src"),
      "@helios/lib": path.resolve(__dirname, "../../packages/lib/src"),
      "@helios/plugin-sdk": path.resolve(__dirname, "../../packages/plugin-sdk/src"),
      "@helios/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@helios/widgets": path.resolve(__dirname, "../../packages/widgets/src"),
      "@helios/pm-ui": path.resolve(__dirname, "../../packages/pm-ui/src"),
      "@pm": path.resolve(__dirname, "src/modules/pm"),
    },
  },
});
