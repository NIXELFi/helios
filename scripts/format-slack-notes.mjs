#!/usr/bin/env node
// Usage: node scripts/format-slack-notes.mjs v4.4.0 <release-url>
//
// Emits a CLEAN, PLAIN-TEXT Slack message for a release. Slack Workflow Builder
// inserts a webhook trigger's variable as LITERAL text (no mrkdwn parsing), so
// dumping the GitHub-flavored-markdown changelog shows raw `###`, `**`, and
// backticks (see the v4.4.0 post). This strips that markup:
//   - section headings (### X) sit on their own line
//   - "- " bullets become "• "
//   - wrapped continuation lines are joined back onto their bullet
//   - **bold**, `code`, *emphasis*, and [text](url) markers are removed
//
// Because Slack shows the value verbatim, this script's stdout is EXACTLY what
// lands in the channel — run it locally to preview.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const rawTag = process.argv[2] || "";
const url = process.argv[3] || "";
const version = rawTag.replace(/^v/, "");

const stripInline = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1"); // *emphasis*

function changelogSection() {
  let text;
  try {
    text = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
  } catch {
    return "";
  }
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[${esc}\\]`).test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

const out = [`🚀 Helios ${rawTag || version} released`, ""];
for (const raw of changelogSection().split("\n")) {
  const line = raw.replace(/\s+$/, "");
  if (!line.trim()) continue;
  const heading = line.match(/^###\s+(.*)$/);
  if (heading) {
    if (out[out.length - 1] !== "") out.push("");
    out.push(stripInline(heading[1].trim()));
    continue;
  }
  const bullet = line.match(/^\s*-\s+(.*)$/);
  if (bullet) {
    out.push(`• ${stripInline(bullet[1].trim())}`);
    continue;
  }
  // Indented continuation of the previous wrapped bullet.
  if (out[out.length - 1].startsWith("• ")) {
    out[out.length - 1] += ` ${stripInline(line.trim())}`;
  } else {
    out.push(stripInline(line.trim()));
  }
}
while (out.length && out[out.length - 1] === "") out.pop();
if (url) out.push("", url);

console.log(out.join("\n"));
