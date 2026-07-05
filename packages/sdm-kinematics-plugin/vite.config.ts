import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// A plugin bundle must be a SINGLE self-contained HTML: the host loads the entry
// via the iframe's `srcdoc`, so there is no origin to fetch sibling JS/CSS from.
// vite-plugin-singlefile inlines every chunk + stylesheet into index.html. The
// build lands where the marketplace loader serves it:
// /plugins/sdm-kinematics/dist/ (same pipeline as the Lap Sim and COAST).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../apps/desktop/public/plugins/sdm-kinematics/dist",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    // A single-file bundle has no sibling chunks to preload, so drop Vite's
    // module-preload polyfill — it ships a dead `fetch()` that the plugin
    // compliance validator (rightly) flags as a network call.
    modulePreload: false,
  },
});
