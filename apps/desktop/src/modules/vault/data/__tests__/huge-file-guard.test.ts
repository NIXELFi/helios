import { beforeEach, describe, expect, it } from "vitest";
import {
  HUGE_FILE_BYTES,
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

  it("asks, and remembers the answer for the same file + content", async () => {
    subscribeHugeUploads(() => {});
    const p = confirmHugeUpload(big("a"));
    await flush();
    expect(currentHugeUpload()?.key).toBe("a");
    answerHugeUpload("a", false);
    await expect(p).resolves.toBe(false);
    // auto-add re-scans: no second dialog
    await expect(confirmHugeUpload(big("a"))).resolves.toBe(false);
    expect(currentHugeUpload()).toBeNull();
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
