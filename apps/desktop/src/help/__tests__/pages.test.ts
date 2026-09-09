import { describe, it, expect } from "vitest";
import { WIKI_INDEX, HOME_SLUG, loadPage, loadAllPages } from "../pages";

describe("wiki page index", () => {
  it("lists Home first with a slug-derived title", () => {
    expect(WIKI_INDEX[0]).toMatchObject({ slug: "README", title: "Home", order: 0 });
  });

  it("derives numbered titles from the slug alone, in order", () => {
    const first = WIKI_INDEX[1]!;
    expect(first.slug).toBe("01-getting-started");
    expect(first.title).toBe("Getting started");
    expect(WIKI_INDEX.find((p) => p.slug === "09-modules-vault-logs")?.title)
      .toBe("Modules vault logs");
    expect(first.order).toBe(1);
    const orders = WIKI_INDEX.map((p) => p.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("carries no page content", () => {
    for (const meta of WIKI_INDEX) {
      expect(meta).not.toHaveProperty("content");
    }
  });

  it("HOME_SLUG points at the home page", () => {
    expect(HOME_SLUG).toBe("README");
    expect(WIKI_INDEX.some((p) => p.slug === HOME_SLUG)).toBe(true);
  });
});

describe("loadPage", () => {
  it("resolves content and upgrades the title from the H1", async () => {
    const page = await loadPage("README");
    expect(page?.slug).toBe("README");
    expect(page?.title).toBe("Helios Wiki");
    expect(page?.content).toContain("# Helios Wiki");
  });

  it("returns the same object on a second call (memoised)", async () => {
    const a = await loadPage("01-getting-started");
    const b = await loadPage("01-getting-started");
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a?.title).toBe("Getting started");
  });

  it("resolves undefined for an unknown slug", async () => {
    expect(await loadPage("no-such-page")).toBeUndefined();
  });
});

describe("loadAllPages", () => {
  it("loads every indexed page, in index order, with content", async () => {
    const pages = await loadAllPages();
    expect(pages.map((p) => p.slug)).toEqual(WIKI_INDEX.map((p) => p.slug));
    for (const p of pages) expect(p.content.length).toBeGreaterThan(0);
  });
});
