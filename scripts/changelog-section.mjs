// Shared CHANGELOG.md section parser.
//
// Three scripts need to answer "what is the body of section X?" — the release
// gate (check-versions.mjs), the release-body/Slack extractor
// (extract-changelog.mjs), and the [Unreleased] promoter (bump-version.mjs).
// They used to each carry their own regex, which let the gate pass on a section
// that the extractor then read as empty (shipping a release with zero notes).
// One parser, one answer.

/** Regex matching a `## [<version>]` heading. `version` is escaped for you. */
export function headingRegex(version, flags = "") {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s*\\[${esc}\\]`, flags);
}

/**
 * Body of the `## [version]` section (everything up to the next `## ` heading),
 * trimmed. Returns null when there is no such heading at all — distinct from
 * "" which means the heading exists but carries no notes.
 */
export function sectionBody(text, version) {
  const headRe = headingRegex(version);
  const lines = text.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** True when a section body carries at least one `- ` bullet — the minimum bar
 *  for release notes worth posting to GitHub + Slack. */
export function hasEntries(body) {
  return typeof body === "string" && /^\s*[-*]\s+\S/m.test(body);
}
