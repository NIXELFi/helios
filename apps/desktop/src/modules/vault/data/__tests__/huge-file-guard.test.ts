import { beforeEach, describe, expect, it } from "vitest";
import {
  HUGE_FILE_BYTES,
  HUGE_FILE_WARNING,
  checkHugeUpload,
  answerHugeUpload,
  confirmHugeUpload,
  currentHugeUpload,
  resetHugeUploadGuard,
  subscribeHugeUploads,
} from "../huge-file-guard";

const big = (key: string) => ({ key, name: `${key}.wbpz`, bytes: HUGE_FILE_BYTES + 1, action: "add" as const });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetHugeUploadGuard());

describe("huge-file warning", () => {
  it("small files never ask", async () => {
    subscribeHugeUploads(() => {});
    await expect(confirmHugeUpload({ ...big("a"), bytes: HUGE_FILE_BYTES })).resolves.toBe(true);
    expect(currentHugeUpload()).toBeNull();
  });

  it("without a dialog host it warns in the console but goes ahead (never a hard limit)", async () => {
    await expect(confirmHugeUpload(big("a"))).resolves.toBe(true);
  });

  it("asks every time: a \"no\" isn't remembered", async () => {
    subscribeHugeUploads(() => {});
    const p = confirmHugeUpload(big("a"));
    await flush();
    expect(currentHugeUpload()?.key).toBe("a");
    answerHugeUpload("a", false);
    await expect(p).resolves.toBe(false);
    const again = confirmHugeUpload(big("a"));
    await flush();
    expect(currentHugeUpload()?.key).toBe("a"); // asked again
    answerHugeUpload("a", true);
    await expect(again).resolves.toBe(true);
  });

  it("background sources never open a dialog; they get the warning text", async () => {
    subscribeHugeUploads(() => {});
    const auto = await checkHugeUpload({ ...big("a"), source: "auto" });
    const bridge = await checkHugeUpload({ ...big("b"), action: "check in", source: "bridge" });
    expect(currentHugeUpload()).toBeNull();
    expect(auto.ok).toBe(false);
    expect(!auto.ok && auto.error).toContain(HUGE_FILE_WARNING);
    expect(!bridge.ok && bridge.error).toMatch(/check in it from the Helios Vault window/);
  });

  it("a declined user check-in says the checkout is kept", async () => {
    subscribeHugeUploads(() => {});
    const p = checkHugeUpload({ ...big("c"), action: "check in", source: "user" });
    await flush();
    answerHugeUpload("c", false);
    const r = await p;
    expect(!r.ok && r.error).toMatch(/still have it checked out/);
  });

  it("confirm-then-close (ConfirmDialog calls both) answers only the shown file", async () => {
    subscribeHugeUploads(() => {});
    const a = confirmHugeUpload(big("a"));
    const b = confirmHugeUpload(big("b"));
    answerHugeUpload("a", true);
    answerHugeUpload("a", false); // the trailing onClose
    await expect(a).resolves.toBe(true);
    expect(currentHugeUpload()?.key).toBe("b");
    answerHugeUpload("b", true);
    await expect(b).resolves.toBe(true);
  });

  it("the same file asked twice shares one dialog", async () => {
    subscribeHugeUploads(() => {});
    const p1 = confirmHugeUpload(big("a"));
    const p2 = confirmHugeUpload(big("a"));
    answerHugeUpload("a", true);
    await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
    expect(currentHugeUpload()).toBeNull();
  });
});
