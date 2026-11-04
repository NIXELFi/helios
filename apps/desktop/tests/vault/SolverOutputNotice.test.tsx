import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SolverOutputNotice } from "../../src/modules/vault/components/SolverOutputNotice";
import type { LocalFile } from "../../src/modules/vault/data/useLocalFolderScan";

function lf(name: string): LocalFile {
  const rel = `P_files/dp0/SYS/MECH/${name}`;
  return { basename: name, relativePath: rel, absolutePath: `/v/${rel}`, sha256: "x", sizeBytes: 1 };
}

describe("SolverOutputNotice", () => {
  it("renders nothing when no solver output is waiting", () => {
    const { container } = render(<SolverOutputNotice blocked={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("tells the user to zip it and names the files", () => {
    render(<SolverOutputNotice blocked={[lf("file.rst"), lf("ds.dat")]} />);
    expect(screen.getByText(/zip it up into a \.zip file/)).toBeTruthy();
    expect(screen.getByText(/Not added: 2 files \(file\.rst, ds\.dat\)/)).toBeTruthy();
  });

  it("stays dismissed until more solver output shows up", () => {
    const two = [lf("file.rst"), lf("ds.dat")];
    const { rerender, container } = render(<SolverOutputNotice blocked={two} />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(container.firstChild).toBeNull();
    rerender(<SolverOutputNotice blocked={[...two]} />);
    expect(container.firstChild).toBeNull();
    rerender(<SolverOutputNotice blocked={[...two, lf("solve.out")]} />);
    expect(screen.getByText(/Not added: 3 files/)).toBeTruthy();
  });
});
