import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PropertiesPanel } from "../../src/modules/vault/components/PropertiesPanel";

const useFilePropertiesMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/modules/vault/data/useFileProperties", () => ({
  useFileProperties: (...a: unknown[]) => useFilePropertiesMock(...(a as [])),
}));

const ver = (over: any = {}) => ({
  id: "v1", file_id: "f1", version_num: 1, sha256: "s", size_bytes: 1, author_id: null,
  comment: null, parent_version_id: null, revision: null, properties: null, created_at: "x", ...over,
});

describe("<PropertiesPanel>", () => {
  it("shows resolved properties as name/value rows", () => {
    useFilePropertiesMock.mockReturnValue({
      props: [{ name: "PartNo", value: "ABC-1" }, { name: "Material", value: "7075-T6" }],
      loading: false,
    });
    render(<PropertiesPanel version={ver() as any} fileName="p.sldprt" folderId={null} vaultRoot="/v" folders={[]} />);
    expect(screen.getByText("PartNo")).toBeInTheDocument();
    expect(screen.getByText("ABC-1")).toBeInTheDocument();
    expect(screen.getByText("Material")).toBeInTheDocument();
    expect(screen.getByText("7075-T6")).toBeInTheDocument();
  });

  it("shows a reading state while resolving", () => {
    useFilePropertiesMock.mockReturnValue({ props: null, loading: true });
    render(<PropertiesPanel version={ver() as any} fileName="p.sldprt" folderId={null} vaultRoot="/v" folders={[]} />);
    expect(screen.getByText(/reading/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no custom properties", () => {
    useFilePropertiesMock.mockReturnValue({ props: [], loading: false });
    render(<PropertiesPanel version={ver() as any} fileName="p.sldprt" folderId={null} vaultRoot="/v" folders={[]} />);
    expect(screen.getByText(/no custom properties/i)).toBeInTheDocument();
  });

  it("renders nothing when no version is selected", () => {
    useFilePropertiesMock.mockReturnValue({ props: null, loading: false });
    const { container } = render(<PropertiesPanel version={null} fileName={null} folderId={null} vaultRoot={null} folders={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
