// A board is separated by what you drove with, not by what you said.
//
// The simulator's settings screen has a profile dropdown, and it used to be
// the only thing that decided which leaderboard a time landed on. That is a
// self-reported field on a ranked list, which is to say a free record for
// anybody who reads it: the controller profile reads an axis, a wheel base
// has axes, so pick Controller, steer the wheel anyway, and the controller
// record is yours.
//
// The simulator now writes `detectedInput`, set by the branch of its input
// loop that actually produced the steering command each frame and classified
// from the device rather than the profile. These checks are about the
// precedence between the two, which is the part Helios owns.

import { describe, it, expect } from "vitest";
import { deviceClass, DEVICE_CLASSES, type SimRun } from "../api";

/** Only the two fields the classifier reads. */
function run(detectedInput: string | null, profile: string | null) {
  return { detectedInput, profile } as Pick<SimRun, "profile" | "detectedInput">;
}

describe("which board a run belongs on", () => {
  it("believes the device over the dropdown", () => {
    // THE CHEAT, both directions.
    expect(deviceClass(run("wheel", "gamepad-xbox"))).toBe("wheel");
    expect(deviceClass(run("controller", "wheel"))).toBe("controller");
    expect(deviceClass(run("keyboard", "wheel"))).toBe("keyboard");
  });

  it("agrees with itself when the driver was honest", () => {
    expect(deviceClass(run("wheel", "wheel"))).toBe("wheel");
    expect(deviceClass(run("controller", "gamepad-ps"))).toBe("controller");
    expect(deviceClass(run("keyboard", "keyboard"))).toBe("keyboard");
  });

  it("falls back to the profile for a run recorded before it measured", () => {
    // Every run driven before this existed. They are not thrown off the
    // boards; the profile is all anybody ever had for them, and it was the
    // honest answer for all of them until somebody had a reason to lie.
    expect(deviceClass(run(null, "wheel"))).toBe("wheel");
    expect(deviceClass(run(null, "Wheel and pedals"))).toBe("wheel");
    expect(deviceClass(run(null, "gamepad-xbox"))).toBe("controller");
    expect(deviceClass(run(null, "Keyboard and mouse"))).toBe("keyboard");
  });

  it("does not invent a class out of nothing", () => {
    expect(deviceClass(run(null, null))).toBe("unknown");
    expect(deviceClass(run(null, ""))).toBe("unknown");
    // A profile this build has never heard of is its own class, not quietly
    // folded into one of the three.
    expect(deviceClass(run(null, "hotas"))).toBe("unknown");
  });

  it("ignores a detected value it does not recognise", () => {
    // A newer simulator inventing a fourth class, or an edited manifest. It
    // does not get to skip the profile fallback by being unreadable.
    expect(deviceClass(run("trackball", "wheel"))).toBe("wheel");
    expect(deviceClass(run("", "gamepad-xbox"))).toBe("controller");
    expect(deviceClass(run("wheel; drop table", "gamepad-xbox"))).toBe("controller");
  });

  it("is case insensitive, because the manifest is somebody else's file", () => {
    expect(deviceClass(run("Wheel", "gamepad-xbox"))).toBe("wheel");
    expect(deviceClass(run("KEYBOARD", "wheel"))).toBe("keyboard");
  });

  it("names every class it can return", () => {
    // The tab bar renders from this list; a class with no entry renders as a
    // tab with no name.
    for (const d of ["wheel", "controller", "keyboard", "unknown"] as const) {
      expect(DEVICE_CLASSES.find((c) => c.id === d)).toBeTruthy();
    }
  });
});
