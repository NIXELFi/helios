import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ReferencesPanel } from "../../src/modules/vault/components/ReferencesPanel";

vi.mock("../../src/modules/vault/data/useReferences", () => ({
  useContains: () => ({
    data: [{ childPathHint: "..\\frame.sldprt", childFileId: "cf1", childVersionId: "cv1", childName: "frame.sldprt", resolved: true }],
    loading: false, error: null,
  }),
  useWhereUsed: () => ({
    data: [{ parentFileId: "pf1", parentVersionId: "pv1", parentName: "asm.sldasm" }],
    loading: false, error: null,
  }),
}));

describe("<ReferencesPanel>", () => {
  it("shows Contains children and Where-Used parents", () => {
    render(<ReferencesPanel versionId={"pv" as any} fileId={"cf1" as any} />);
    expect(screen.getByText(/contains/i)).toBeInTheDocument();
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText(/where used/i)).toBeInTheDocument();
    expect(screen.getByText("asm.sldasm")).toBeInTheDocument();
  });
});
