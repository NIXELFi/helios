import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regression guard for the v3.7.1/v3.7.2 bug where useDownloadVersion's atomic
// temp-write switched to `plugin:fs|rename` (+ `remove` for cleanup) but the
// Tauri capability ACL never granted those commands — so downloads failed at
// runtime with "Command plugin:fs|rename not allowed by ACL". Vitest mocks
// @tauri-apps/plugin-fs, so the ACL is invisible to the rest of the suite;
// this test reads the real capability file and asserts every fs command the
// app invokes is granted. If you start calling a new plugin:fs command, add
// its permission here AND in capabilities/default.json.
const REQUIRED_FS_PERMISSIONS = [
  "fs:allow-read-file",
  "fs:allow-read-dir",
  "fs:allow-write-file",
  "fs:allow-mkdir",
  "fs:allow-rename", // useDownloadVersion: temp .part -> dest (atomic write)
  "fs:allow-remove", // useDownloadVersion: cleanup of orphaned temp on failure
  "fs:allow-stat",
];

describe("Tauri fs capability ACL", () => {
  it("grants every fs command the app invokes (incl. rename + remove for atomic downloads)", () => {
    const capPath = resolve(__dirname, "../src-tauri/capabilities/default.json");
    const cap = JSON.parse(readFileSync(capPath, "utf8")) as { permissions: unknown[] };
    const granted = new Set(cap.permissions.filter((p): p is string => typeof p === "string"));
    for (const perm of REQUIRED_FS_PERMISSIONS) {
      expect(granted.has(perm), `capabilities/default.json must grant ${perm}`).toBe(true);
    }
  });
});
