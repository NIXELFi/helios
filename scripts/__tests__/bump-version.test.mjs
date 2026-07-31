import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion, promoteChangelog } from "../bump-version.mjs";

function makeRepo(initial) {
  const dir = mkdtempSync(join(tmpdir(), "helios-bump-"));
  mkdirSync(join(dir, "apps/desktop/src-tauri"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", version: initial.root }, null, 2) + "\n");
  writeFileSync(join(dir, "apps/desktop/package.json"), JSON.stringify({ name: "@helios/desktop", version: initial.desktop }, null, 2) + "\n");
  writeFileSync(join(dir, "apps/desktop/src-tauri/tauri.conf.json"), JSON.stringify({ productName: "Helios", version: initial.tauri }, null, 2) + "\n");
  writeFileSync(
    join(dir, "Cargo.toml"),
    `[workspace]
resolver = "2"

[workspace.package]
version = "${initial.cargo}"
edition = "2021"

[workspace.dependencies]
serde = "1"
`,
  );
  return dir;
}

test("bumps every file to the new version", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  bumpVersion("2.3.0", dir);
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const desktop = JSON.parse(readFileSync(join(dir, "apps/desktop/package.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(dir, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const cargo = readFileSync(join(dir, "Cargo.toml"), "utf8");
  assert.equal(root.version, "2.3.0");
  assert.equal(desktop.version, "2.3.0");
  assert.equal(tauri.version, "2.3.0");
  assert.match(cargo, /\[workspace\.package\][\s\S]*?\nversion = "2\.3\.0"/);
});

test("rejects non-semver", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  assert.throws(() => bumpVersion("not-a-version", dir), /bad version/);
});

test("accepts -rc suffixes", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  bumpVersion("2.3.0-rc.1", dir);
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(root.version, "2.3.0-rc.1");
});

const CHANGELOG_HEAD = "# Changelog\n\n";

test("promotes a populated [Unreleased]", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    CHANGELOG_HEAD + "## [Unreleased]\n\n### Fixed\n- A real fix.\n\n## [2.2.0] - 2026-01-01\n\n### Added\n- Old.\n",
  );
  assert.equal(promoteChangelog("2.3.0", dir, "2026-07-31"), true);
  const after = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.match(after, /## \[Unreleased\]\n\n## \[2\.3\.0\] - 2026-07-31\n\n### Fixed\n- A real fix\./);
});

// The release body + the Slack post are generated from the promoted section, so
// promoting nothing would ship a release with no notes. Refuse, loudly.
test("refuses to promote an empty [Unreleased]", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG_HEAD + "## [Unreleased]\n\n## [2.2.0] - 2026-01-01\n\n### Added\n- Old.\n");
  assert.throws(() => promoteChangelog("2.3.0", dir), /\[Unreleased\] section is empty/);
});

// A heading-only [Unreleased] (group headers, no bullets) is just as empty as
// far as the release notes are concerned.
test("refuses an [Unreleased] with headings but no entries", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG_HEAD + "## [Unreleased]\n\n### Fixed\n\n## [2.2.0] - 2026-01-01\n");
  assert.throws(() => promoteChangelog("2.3.0", dir), /\[Unreleased\] section is empty/);
});

// The refusal must land BEFORE any file is written, or the repo is left with
// bumped version fields and an un-promoted changelog.
test("an empty [Unreleased] aborts the bump without touching any file", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG_HEAD + "## [Unreleased]\n\n## [2.2.0] - 2026-01-01\n");
  assert.throws(() => bumpVersion("2.3.0", dir), /\[Unreleased\] section is empty/);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "0.0.1");
});

// Idempotence is unchanged: re-running the bump on an already-promoted
// changelog is a no-op, even though [Unreleased] is now (legitimately) empty.
test("already-promoted version is a no-op, not a refusal", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG_HEAD + "## [Unreleased]\n\n## [2.3.0] - 2026-07-31\n\n### Fixed\n- Already here.\n");
  assert.equal(promoteChangelog("2.3.0", dir), false);
  assert.equal(bumpVersion("2.3.0", dir), false);
});
