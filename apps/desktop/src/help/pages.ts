/**
 * Loads the wiki markdown files at build time via Vite's glob import.
 * Source of truth lives in `docs/wiki/` so the same content renders on
 * GitHub and in-app.
 */

// Eager raw import of every wiki markdown file. The path is relative
// to this module; vite.config.ts whitelists "../../docs/wiki" under
// `server.fs.allow` so the dev server can read it.
const modules = import.meta.glob("../../../../docs/wiki/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export interface WikiPage {
  slug: string;
  title: string;
  order: number;
  content: string;
}

function deriveTitle(slug: string, content: string): string {
  const m = /^#\s+(.+)$/m.exec(content);
  if (m) return m[1]!.trim();
  if (slug === "README") return "Home";
  return slug.replace(/^\d+-/, "").replace(/-/g, " ");
}

function deriveOrder(slug: string): number {
  if (slug === "README") return 0;
  const m = /^(\d+)-/.exec(slug);
  return m ? Number(m[1]) : 999;
}

export const WIKI_PAGES: WikiPage[] = Object.entries(modules)
  .map(([path, content]) => {
    const slug = path.split("/").pop()!.replace(/\.md$/, "");
    return {
      slug,
      title: deriveTitle(slug, content),
      order: deriveOrder(slug),
      content,
    };
  })
  .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

export function getPage(slug: string): WikiPage | undefined {
  return WIKI_PAGES.find((p) => p.slug === slug);
}

export const HOME_SLUG = "README";
