// Harness Tailwind config: the app's theme, but with content globs made absolute
// so they still resolve when vite's root is uiharness/ rather than apps/desktop/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import base from "../tailwind.config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  ...base,
  content: [
    path.resolve(here, "index.html"),
    path.resolve(here, "main.tsx"),
    path.resolve(here, "../src/**/*.{ts,tsx}"),
    path.resolve(here, "../../../packages/**/src/**/*.{ts,tsx}"),
  ],
};
