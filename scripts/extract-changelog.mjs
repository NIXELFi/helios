#!/usr/bin/env node
// Usage: node scripts/extract-changelog.mjs v4.4.0   (the leading "v" is optional)
//
// Prints the CHANGELOG.md section body for that version to stdout — used by the
// Release workflow to build the GitHub release body and the Slack message.
//
// Falls back to a generic one-liner (and still exits 0) if the section is
// missing, so the workflow never hard-fails HERE. The real gate is
// scripts/check-versions.mjs, which FAILS the release when the tagged version
// has no CHANGELOG.md section — that is what enforces "add your changelog".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const raw = process.argv[2] || "";
const version = raw.replace(/^v/, "");
const fallback = `Release ${raw || version}. See CHANGELOG.md for details.`;

let text;
try {
  text = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
} catch {
  console.log(fallback);
  process.exit(0);
}

const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headRe = new RegExp(`^##\\s*\\[${esc}\\]`);
const lines = text.split("\n");

let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (headRe.test(lines[i])) { start = i; break; }
}
if (start === -1) {
  console.log(fallback);
  process.exit(0);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i])) { end = i; break; }
}

const body = lines.slice(start + 1, end).join("\n").trim();
console.log(body || fallback);
