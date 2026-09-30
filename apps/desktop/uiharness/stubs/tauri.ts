// Harness stubs for the Tauri IPC surface. Not shipped — see uiharness/README.
const DIRTY = new URLSearchParams(location.search).get("dirty") === "1";

const CLEAN_TEXTS: Record<string, string> = {
  "manifest.json": "{}",
  "dist/index.html": "<!doctype html><body></body>",
  "dist/app.js": "import { ready, storage } from '@helios/plugin-sdk';\nawait ready();\nstorage.set('a',1);",
};

const DIRTY_TEXTS: Record<string, string> = {
  "manifest.json": "{}",
  "dist/index.html": "<!doctype html><body></body>",
  "dist/app.js": "fetch('/api/data');\nlocalStorage.setItem('x','1');",
};

const PACKED = {
  stagedPath: "C:/Users/nmurray/AppData/Roaming/helios/plugins/~publish/9f2c.hplugin",
  sha256: "9f2c1b7e4d5a6c8f0e1d2b3a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
  bytes: 184_320,
  manifest: {
    format: 1,
    id: "aero.downforce-calculator",
    name: "Downforce Calculator",
    version: "1.3.0",
    description: "Computes downforce and centre of pressure from speed and aero coefficients.",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions: DIRTY ? [] : ["storage"],
  },
  entries: ["dist/app.js", "dist/index.html", "dist/style.css", "manifest.json"],
  texts: DIRTY ? DIRTY_TEXTS : CLEAN_TEXTS,
  warnings: [] as string[],
  largest: [["dist/app.js", 142_000]] as [string, number][],
};

export function invoke(cmd: string): Promise<unknown> {
  if (cmd === "pack_plugin_bundle") return Promise.resolve(PACKED);
  if (cmd === "inspect_plugin_bundle")
    return Promise.resolve({ manifest: PACKED.manifest, texts: CLEAN_TEXTS });
  return Promise.resolve(undefined);
}
