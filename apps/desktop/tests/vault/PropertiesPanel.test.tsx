import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PropertiesPanel } from "../../src/modules/vault/components/PropertiesPanel";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/modules/vault/data/useRecordProperties", () => ({
  useRecordProperties: () => ({ run: runMock }),
}));

const ver = (over: any = {}) => ({
  id: "v1", file_id: "f1", version_num: 1, sha256: "s", size_bytes: 1, author_id: null,
  comment: null, parent_version_id: null, revision: null, properties: null, created_at: "x", ...over,
});

describe("<PropertiesPanel>", () => {
  beforeEach(() => runMock.mockReset());

  it("shows stored properties as name/value rows", () => {
    render(
      <PropertiesPanel
        version={ver({ properties: [{ name: "PartNo", value: "ABC-1" }, { name: "Material", value: "7075-T6" }] }) as any}
        fileName="p.sldprt" folderId={null} vaultRoot="/v" folders={[]} canEdit={false}
      />,
    );
    expect(screen.getByText("PartNo")).toBeInTheDocument();
    expect(screen.getByText("ABC-1")).toBeInTheDocument();
    expect(screen.getByText("Material")).toBeInTheDocument();
    expect(screen.getByText("7075-T6")).toBeInTheDocument();
    expect(runMock).not.toHaveBeenCalled(); // already stored → no backfill
  });

  it("lazily backfills from the local copy when an editor views a version with no properties", async () => {
    runMock.mockResolvedValue([{ name: "Description", value: "Bracket" }]);
    render(
      <PropertiesPanel
        version={ver({ properties: null }) as any}
        fileName="p.sldprt" folderId={null} vaultRoot="/v" folders={[]} canEdit
      />,
    );
    await waitFor(() => expect(runMock).toHaveBeenCalledWith("v1", "/v/p.sldprt", "p.sldprt"));
    expect(await screen.findByText("Description")).toBeInTheDocument();
    expect(screen.getByText("Bracket")).toBeInTheDocument();
  });

  it("does not backfill for a viewer (canEdit=false)", () => {
    render(
      <PropertiesPanel version={ver({ properties: null }) as any} fileName="p.sldprt" folderId={null} vaultRoot="/v" folders={[]} canEdit={false} />,
    );
    expect(runMock).not.toHaveBeenCalled();
    expect(screen.getByText(/no custom properties/i)).toBeInTheDocument();
  });
});
