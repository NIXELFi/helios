/* An install that never lands must not become an auto-update loop.
 *
 * A team member's laptop launched the installer, came back on the old
 * version, found the same update and launched it again, every ~30 s and at
 * every boot, until the machine fell over. These pin the bookkeeping that
 * lets auto-update notice and stand down. */
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_INSTALL_ATTEMPT_LIMIT,
  autoInstallAllowed,
  failedInstallAttempts,
  forgetSettledAttempts,
  recordInstallAttempt,
  retractInstallAttempt,
} from "../update-attempts";

afterEach(() => localStorage.clear());

describe("update install attempts", () => {
  it("stops auto-install after the limit of hand-offs that didn't land", () => {
    for (let i = 0; i < AUTO_INSTALL_ATTEMPT_LIMIT; i++) {
      expect(autoInstallAllowed("6.7.1", "6.7.0")).toBe(true);
      recordInstallAttempt("6.7.1", "6.7.0");
    }
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(AUTO_INSTALL_ATTEMPT_LIMIT);
    expect(autoInstallAllowed("6.7.1", "6.7.0")).toBe(false);
  });

  it("a newer release gets its own fresh tries", () => {
    recordInstallAttempt("6.7.1", "6.7.0");
    recordInstallAttempt("6.7.1", "6.7.0");
    expect(autoInstallAllowed("6.7.2", "6.7.0")).toBe(true);
  });

  it("an attempt from a different version doesn't count against this one", () => {
    recordInstallAttempt("6.7.1", "6.6.2");
    recordInstallAttempt("6.7.1", "6.6.2");
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(0);
    recordInstallAttempt("6.7.1", "6.7.0"); // restarts the count
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(1);
  });

  it("a hand-off that never happened (download threw) is taken back", () => {
    recordInstallAttempt("6.7.1", "6.7.0");
    recordInstallAttempt("6.7.1", "6.7.0");
    retractInstallAttempt("6.7.1", "6.7.0");
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(1);
    retractInstallAttempt("6.7.1", "6.7.0");
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(0);
    expect(localStorage.getItem("helios.updater.installAttempts")).toBeNull();
  });

  it("forgets an update once it has landed", () => {
    recordInstallAttempt("6.7.1", "6.7.0");
    forgetSettledAttempts("6.7.1");
    expect(localStorage.getItem("helios.updater.installAttempts")).toBeNull();
  });

  it("keeps the record while still stuck on the old version", () => {
    recordInstallAttempt("6.7.1", "6.7.0");
    forgetSettledAttempts("6.7.0");
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(1);
  });

  it("survives junk in storage", () => {
    localStorage.setItem("helios.updater.installAttempts", "{not json");
    expect(autoInstallAllowed("6.7.1", "6.7.0")).toBe(true);
    recordInstallAttempt("6.7.1", "6.7.0");
    expect(failedInstallAttempts("6.7.1", "6.7.0")).toBe(1);
  });
});
