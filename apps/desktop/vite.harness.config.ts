import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Screenshot harness only — never part of a shipped build. Aliases the IO edges
// (Tauri IPC, Supabase auth, the org + review data hooks) to stubs so the real
// components render with no backend, and the result can be looked at.
const stub = (f: string) => path.resolve(__dirname, "uiharness/stubs", f);

export default defineConfig({
  root: path.resolve(__dirname, "uiharness"),
  plugins: [react()],
  server: { port: 1421, strictPort: true, fs: { allow: ["..", "../../.."] } },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: stub("tauri.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: stub("dialog.ts") },
      { find: "@tauri-apps/plugin-fs", replacement: stub("fs.ts") },
      { find: "@helios/auth", replacement: stub("auth.ts") },
      { find: "../../org/data/useOrgData", replacement: stub("useOrgData.ts") },
      { find: "../../../org/data/useOrgData", replacement: stub("useOrgData.ts") },
      { find: "../data/useReview", replacement: stub("useReview.ts") },
      {
        find: "@helios/plugin-sdk",
        replacement: path.resolve(__dirname, "../../packages/plugin-sdk/src"),
      },
      { find: "@helios/ui", replacement: path.resolve(__dirname, "../../packages/ui/src") },
      { find: "@helios/lib", replacement: path.resolve(__dirname, "../../packages/lib/src") },
    ],
  },
});
