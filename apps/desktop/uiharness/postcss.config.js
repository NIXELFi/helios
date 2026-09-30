// Points Tailwind at the harness config (absolute content globs). Harness only.
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export default {
  plugins: { tailwindcss: { config: path.resolve(here, "tailwind.config.ts") }, autoprefixer: {} },
};
