export const theme = {
  colors: {
    base:   "#0E0E10",
    panel:  "#16171B",
    line:   "#2A2C32",
    text:   "#D8DCE2",
    dim:    "#7B8088",
    maroon: "#8C1D40",
    gold:   "#FFC627",
    chartGrid: "#23252B",
    chartAxis: "#5A5F66",
  },
  font: {
    sans: 'Inter, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
} as const;

/** 12-color trace palette tuned for dark backgrounds. */
export const tracePalette = [
  "#FFB800", "#4FC3F7", "#66BB6A", "#FF8A65",
  "#BA68C8", "#9CCC65", "#26A69A", "#EF5350",
  "#5C6BC0", "#FFCA28", "#26C6DA", "#AB47BC",
] as const;
