import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion } from "../bump-version.mjs";

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
