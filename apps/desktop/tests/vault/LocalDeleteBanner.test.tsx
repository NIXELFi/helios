import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LocalDeleteBanner } from "../../src/modules/vault/components/LocalDeleteBanner";
import { notifyLocalDeleteBlocked } from "../../src/modules/vault/data/local-delete-events";
import { isDownloadTemp } from "../../src/modules/vault/data/useLocalFolderScan";

vi.mock("../../src/modules/vault/data/notify", () => ({ osNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: vi.fn(), readFile: vi.fn(), stat: vi.fn(), watchImmediate: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("<LocalDeleteBanner>", () => {
  it("collapses a big restore into a few names + 'and N more' instead of a wall of text", () => {
    render(<LocalDeleteBanner />);
    const names = Array.from({ length: 234 }, (_, i) => `part_${i}.SLDPRT`);
    act(() => notifyLocalDeleteBlocked(names));
    expect(screen.getByText(/234 files were missing from your local folder/)).toBeInTheDocument();
    expect(screen.queryByText(/part_233\.SLDPRT/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "and 229 more" }));
    expect(screen.getByText("part_233.SLDPRT")).toBeInTheDocument();
  });
});

describe("isDownloadTemp", () => {
  it("matches only <name>.<uuid>.part staging files", () => {
    expect(isDownloadTemp("48t #420 driven sprocket.SLDPRT.b0935473-36dd-48e2-994a-f18cb1caf54a.part")).toBe(true);
    expect(isDownloadTemp("engine.part")).toBe(false);
    expect(isDownloadTemp("frame.SLDPRT")).toBe(false);
  });
});
