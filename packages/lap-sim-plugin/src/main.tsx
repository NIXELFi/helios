import { createRoot } from "react-dom/client";
// Self-hosted fonts — same faces apps/desktop/src/main.tsx loads. vite-plugin-
// singlefile inlines the woff2 as data: URIs, so the variable Inter / JetBrains
// Mono (and Orbitron, for the display stack) are bundled into the single-file
// output for text rendering identical to the Helios desktop app — no runtime
// CDN/fetch (which the plugin compliance validator forbids).
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/900.css";
import { App } from "./App";
import "./styles.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
