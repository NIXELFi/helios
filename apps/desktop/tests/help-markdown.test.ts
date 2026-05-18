import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/help/markdown";

describe("renderMarkdown", () => {
  it("renders headings with anchor ids", () => {
    expect(renderMarkdown("# Hello world")).toContain(
      '<h1 id="hello-world">Hello world</h1>',
    );
    expect(renderMarkdown("### Sub-section!")).toContain(
      '<h3 id="sub-section">Sub-section!</h3>',
    );
  });

  it("renders inline code and escapes html within", () => {
    const out = renderMarkdown("Use `<div>` inline.");
    expect(out).toContain("<code>&lt;div&gt;</code>");
  });

  it("renders fenced code blocks with a language class", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out).toContain('<pre><code class="language-ts">');
    expect(out).toContain("const x = 1;");
  });

  it("renders bold and italic", () => {
    expect(renderMarkdown("**bold** and *italic*")).toContain(
      "<strong>bold</strong>",
    );
    expect(renderMarkdown("**bold** and *italic*")).toContain(
      "<em>italic</em>",
    );
  });

  it("renders wiki-internal links with a data attribute", () => {
    const out = renderMarkdown("See [Widgets](04-widgets-reference.md).");
    expect(out).toContain('data-wiki-link="04-widgets-reference.md"');
    expect(out).toContain(">Widgets</a>");
  });

  it("opens external links in a new tab", () => {
    const out = renderMarkdown("[GitHub](https://github.com/example).");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it("renders unordered and ordered lists", () => {
    const ul = renderMarkdown("- one\n- two\n- three");
    expect(ul).toContain("<ul>");
    expect(ul.match(/<li>/g)!.length).toBe(3);

    const ol = renderMarkdown("1. one\n2. two");
    expect(ol).toContain("<ol>");
    expect(ol.match(/<li>/g)!.length).toBe(2);
  });

  it("renders pipe tables with alignment", () => {
    const md = "| H1 | H2 |\n|----|---:|\n| a  | 1  |\n| b  | 2  |";
    const out = renderMarkdown(md);
    expect(out).toContain("<table>");
    expect(out).toContain('<th style="text-align:left">H1</th>');
    expect(out).toContain('<th style="text-align:right">H2</th>');
    expect(out).toContain("<td");
    expect(out.match(/<tr>/g)!.length).toBe(3); // header + 2 body rows
  });

  it("renders blockquotes", () => {
    const out = renderMarkdown("> a note here");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("</blockquote>");
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdown("---")).toContain("<hr/>");
  });

  it("does not let html sneak past the escaper", () => {
    const out = renderMarkdown("plain <script>bad()</script> stuff");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders paragraphs that span multiple lines", () => {
    const out = renderMarkdown("first line\nsecond line");
    expect(out).toContain("<p>first line second line</p>");
  });
});
