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
      },
    },
  },
} satisfies Config;
