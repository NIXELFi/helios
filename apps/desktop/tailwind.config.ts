import type { Config } from "tailwindcss";

export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/**/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "helios-base": "#0E0E10",
        "helios-panel": "#16171B",
        "helios-line": "#2A2C32",
        "helios-text": "#D8DCE2",
        "helios-dim":  "#9097A0",
        "asu-maroon": "#8C1D40",
        "asu-gold":   "#FFC627",
        // Semantic status palette — use these instead of scattering raw hexes.
        "helios-success": "#66BB6A",
        "helios-warn":    "#F5A623",
        "helios-danger":  "#EF5350",
        "helios-info":    "#42A5F5",
      },
      fontFamily: {
        // Match the self-hosted faces loaded in main.tsx. `font-sans` is the
        // app default (also set on <body>); `font-mono` is JetBrains Mono.
        sans: ['"Inter Variable"', "Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "monospace"],
        display: ['"Orbitron"', "system-ui", "sans-serif"],
      },
    },
  },
} satisfies Config;
