/**
 * Loads the wiki markdown files via Vite's glob import. Source of truth lives
 * in `docs/wiki/` so the same content renders on GitHub and in-app.
 *
 * The glob is deliberately NOT eager: an eager glob inlined every wiki page
 * (tens of thousands of words of markdown) into the app's main chunk, so every
 * launch paid to parse help text almost nobody opens. Each page is now its own
 * lazily-fetched chunk. What the app needs before anything is opened — the
 * sidebar list — is derived from the FILENAMES alone in `WIKI_INDEX`; titles
 * are upgraded to the page's own `# ` heading once its content arrives.
 */

// Path is relative to this module; vite.config.ts whitelists "../../docs/wiki"
// under `server.fs.allow` so the dev server can read it.
const modules = import.meta.glob("../../../../docs/wiki/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

/** What the sidebar can show before any page has been fetched. */
export interface WikiPageMeta {
  slug: string;
  title: string;
  order: number;
}

export interface WikiPage extends WikiPageMeta {
  content: string;
}

/** Title from the slug alone — all we know before the page is fetched. Close
 *  enough to the real heading that the sidebar doesn't visibly change when the
 *  page's own `# ` title arrives ("01-getting-started" → "Getting started"). */
function titleFromSlug(slug: string): string {
  if (slug === HOME_SLUG) return "Home";
  const words = slug.replace(/^\d+-/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Title from the page's own first `# ` heading, falling back to the slug. */
function titleFromContent(slug: string, content: string): string {
  const m = /^#\s+(.+)$/m.exec(content);
  return m ? m[1]!.trim() : titleFromSlug(slug);
}

function deriveOrder(slug: string): number {
  if (slug === HOME_SLUG) return 0;
  const m = /^(\d+)-/.exec(slug);
  return m ? Number(m[1]) : 999;
}

export const HOME_SLUG = "README";

const loaders = new Map<string, () => Promise<string>>();

export const WIKI_INDEX: WikiPageMeta[] = Object.entries(modules)
  .map(([path, load]) => {
    const slug = path.split("/").pop()!.replace(/\.md$/, "");
    loaders.set(slug, load);
    return { slug, title: titleFromSlug(slug), order: deriveOrder(slug) };
  })
  .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

/** Resolved pages, memoised per slug so re-opening a page is instant and the
 *  identity stays stable (HelpModal renders markdown keyed on this object). */
const cache = new Map<string, WikiPage>();
const inFlight = new Map<string, Promise<WikiPage | undefined>>();

export function getLoadedPage(slug: string): WikiPage | undefined {
  return cache.get(slug);
}

export function loadPage(slug: string): Promise<WikiPage | undefined> {
  const cached = cache.get(slug);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(slug);
  if (pending) return pending;
  const load = loaders.get(slug);
  if (!load) return Promise.resolve(undefined);
  const p = load()
    .then((content) => {
      const page: WikiPage = {
        slug,
        title: titleFromContent(slug, content),
        order: deriveOrder(slug),
        content,
      };
      cache.set(slug, page);
      inFlight.delete(slug);
      return page;
    })
    .catch((e) => {
      inFlight.delete(slug);
      console.error(`[helios/help] failed to load wiki page ${slug}:`, e);
      return undefined;
    });
  inFlight.set(slug, p);
  return p;
}

/** Every page, in index order. Used only by full-text search, which is the one
 *  feature that genuinely needs all the content — and only once the user types. */
export async function loadAllPages(): Promise<WikiPage[]> {
  const pages = await Promise.all(WIKI_INDEX.map((m) => loadPage(m.slug)));
  return pages.filter((p): p is WikiPage => p !== undefined);
}
