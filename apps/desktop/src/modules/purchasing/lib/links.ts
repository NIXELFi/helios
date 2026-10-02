// Product links typed into Abacus, made safe to open.

/** A product link to open: http(s) as typed, or a bare "mouser.com/..." with https added. Anything else isn't opened. */
export function linkHref(v: string): string | null {
  const t = v.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) return `https://${t}`;
  return null;
}
