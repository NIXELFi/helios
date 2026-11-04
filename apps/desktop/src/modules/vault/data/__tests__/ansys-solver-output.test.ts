import { describe, it, expect } from "vitest";
import { isAnsysSolverOutput, partitionSolverOutput, ANSYS_SOLVER_OUTPUT_NOTE } from "../ansys-solver-output";

const UPRIGHT = "EV-Suspension/Upright/ANSYS/Upright V5 Ansys folder/Upright V5 Ansussy_files";
const LCA = "EV-Suspension/Steel Linkages/Ansys/Rear Suspension Lower Control Arms/RS-L-LCA Load Cases_files";

describe("isAnsysSolverOutput", () => {
  it("flags everything in a Workbench Mechanical solver directory", () => {
    for (const name of [
      "file.rst", "ds.dat", "solve.out", "file0.err", "file.cnd", "file.DSP", "file.mntr",
      "file.aapresults", "file.gst", "MatML.xml", "CAERep.xml", "cleanup-ansys-Landen-computer-20632.bat",
    ]) {
      expect(isAnsysSolverOutput(`${UPRIGHT}/dp1/SYS/MECH/${name}`)).toBe(true);
      expect(isAnsysSolverOutput(`${LCA}/dp0/SYS/MECH/${name}`)).toBe(true);
    }
    expect(isAnsysSolverOutput(`${LCA}/dp0/SYS-2/MECH/file.rst`)).toBe(true);
  });

  it("keeps the project file, the model database and engineering data", () => {
    expect(isAnsysSolverOutput("EV-Suspension/Steel Linkages/Ansys/Rear Suspension Lower Control Arms/RS-L-LCA Load Cases.wbpj")).toBe(false);
    expect(isAnsysSolverOutput(`${UPRIGHT}/dp1/global/MECH/SYS.mechdb`)).toBe(false);
    expect(isAnsysSolverOutput(`${UPRIGHT}/dp1/global/MECH/SYS.engd`)).toBe(false);
    expect(isAnsysSolverOutput(`${LCA}/dp0/SYS/ENGD/EngineeringData.xml`)).toBe(false);
    expect(isAnsysSolverOutput(`${LCA}/dp0/designPoint.wbdp`)).toBe(false);
    expect(isAnsysSolverOutput(`${LCA}/session_files/journal1.wbjn`)).toBe(false);
  });

  it("flags MAPDL result and scratch files outside Workbench", () => {
    for (const name of ["job.rth", "job.rmg", "job.rfl", "job.esav", "job.emat", "job.full", "job.mode", "job.osav", "job.page", "job.ldhi", "job.rstp"]) {
      expect(isAnsysSolverOutput(`FEA/runs/${name}`)).toBe(true);
    }
    expect(isAnsysSolverOutput("FEA/runs/file.rst")).toBe(true);
    expect(isAnsysSolverOutput("FEA/runs/cleanup-ansys-shop-pc-123.bat")).toBe(true);
  });

  it("leaves unrelated files alone, including a docs .rst and a zipped solve", () => {
    expect(isAnsysSolverOutput("Software/docs/README.rst")).toBe(false);
    expect(isAnsysSolverOutput("Chassis/frame.SLDPRT")).toBe(false);
    expect(isAnsysSolverOutput("Data/run.dat")).toBe(false);
    expect(isAnsysSolverOutput("EV-Suspension/Upright/ANSYS/Upright V5 results.zip")).toBe(false);
    expect(isAnsysSolverOutput("MECH/file.txt")).toBe(false);
  });

  it("accepts Windows separators and is case-insensitive", () => {
    expect(isAnsysSolverOutput("A\\Proj_files\\DP0\\sys\\mech\\ds.dat")).toBe(true);
    expect(isAnsysSolverOutput("FEA\\FILE.RST")).toBe(true);
  });
});

describe("partitionSolverOutput", () => {
  it("splits addable files from blocked solver output, preserving order", () => {
    const files = [
      { relativePath: "a.sldprt" },
      { relativePath: `${LCA}/dp0/SYS/MECH/file.rst` },
      { relativePath: "b.wbpj" },
    ];
    const { allowed, blocked } = partitionSolverOutput(files);
    expect(allowed.map((f) => f.relativePath)).toEqual(["a.sldprt", "b.wbpj"]);
    expect(blocked.map((f) => f.relativePath)).toEqual([`${LCA}/dp0/SYS/MECH/file.rst`]);
  });
});

describe("ANSYS_SOLVER_OUTPUT_NOTE", () => {
  it("tells people to zip it, in plain ASCII", () => {
    expect(ANSYS_SOLVER_OUTPUT_NOTE).toMatch(/zip/i);
    expect(ANSYS_SOLVER_OUTPUT_NOTE).toMatch(/^[\x20-\x7E]+$/);
  });
});
