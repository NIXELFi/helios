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
        // Theme tokens — channel triplets on :root in src/styles.css, swapped
        // under [data-theme="light"]. The `<alpha-value>` form keeps /50-style
        // opacity modifiers working. Imperative code reads the same values via
        // tc() from @helios/ui.
        "helios-base":    "rgb(var(--helios-base) / <alpha-value>)",
        "helios-panel":   "rgb(var(--helios-panel) / <alpha-value>)",
        "helios-strip":   "rgb(var(--helios-strip) / <alpha-value>)",
        "helios-deep":    "rgb(var(--helios-deep) / <alpha-value>)",
        "helios-line":    "rgb(var(--helios-line) / <alpha-value>)",
        "helios-grid":    "rgb(var(--helios-grid) / <alpha-value>)",
        "helios-text":    "rgb(var(--helios-text) / <alpha-value>)",
        "helios-dim":     "rgb(var(--helios-dim) / <alpha-value>)",
        "helios-muted":   "rgb(var(--helios-muted) / <alpha-value>)",
        "helios-on-gold": "rgb(var(--helios-on-gold) / <alpha-value>)",
        "asu-gold":       "rgb(var(--asu-gold) / <alpha-value>)",
        "asu-maroon":     "rgb(var(--asu-maroon) / <alpha-value>)",
        // Semantic status palette — same in both themes by design.
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
