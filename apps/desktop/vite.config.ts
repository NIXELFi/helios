import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "esnext", minify: "esbuild" },
  resolve: {
    alias: {
      "@helios/store": path.resolve(__dirname, "../../packages/store/src"),
      "@helios/lib": path.resolve(__dirname, "../../packages/lib/src"),
      "@helios/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@helios/widgets": path.resolve(__dirname, "../../packages/widgets/src"),
    },
  },
});
