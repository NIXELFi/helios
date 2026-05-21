// Path helpers — basename + ellipsizing display.

export function basename(p: string): string {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

export function displayPath(p: string, maxLen = 60): string {
  if (!p) return "";
  if (p.length <= maxLen) return p;
  const base = basename(p);
  if (base.length + 3 >= maxLen) return base;
  return "…" + p.slice(-(maxLen - 1));
}
