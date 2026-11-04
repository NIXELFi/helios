/**
 * ANSYS solver output is kept out of the Vault.
 *
 * A Workbench project is `<name>.wbpj` plus a `<name>_files/` tree. Inside it,
 * `dpN/SYS[-n]/MECH/` is the Mechanical solver directory: everything there
 * (file.rst, ds.dat, solve.out, file.err, MatML.xml, cleanup-ansys-*.bat, ...)
 * is rewritten on every solve. A single result file runs to hundreds of MB to
 * GB (the Nov 2026 upright solve put a 906 MB file.rst and a 291 MB ds.dat in
 * SDM27), every teammate's auto-sync then pulls it, and the solver streaming
 * into a synced folder floods the folder watcher. The model itself lives in
 * `dpN/global/MECH/SYS.mechdb` and the engineering data in `dpN/SYS/ENGD/`,
 * which stay vaultable, as do the .wbpj, design points and journals.
 *
 * `_ProjectScratch/` (Workbench's temporary solve folder, which held 961 MB
 * file0.full matrices in Oct 2026) is all scratch too.
 *
 * Outside Workbench, standalone MAPDL runs leave result and scratch files with
 * ANSYS-only extensions, flagged anywhere. `.rst` is also reStructuredText, so
 * it only counts under a `_files` tree or as MAPDL's default `file.rst`.
 *
 * Someone who really needs a solve in the Vault zips it, and a .zip is never
 * matched here.
 */

export const ANSYS_SOLVER_OUTPUT_NOTE =
  "ANSYS solver output can't be added to the Vault. If it needs to be in the Vault, zip it up into a .zip file and add that instead.";

const MAPDL_ONLY_EXTENSIONS = new Set([
  "rth", "rmg", "rfl", "rstp", "esav", "emat", "full", "mode", "osav", "page", "ldhi",
]);

function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/** True iff `relativePath` (vault-relative, either separator) is ANSYS solver output. */
export function isAnsysSolverOutput(relativePath: string): boolean {
  const segs = segmentsOf(relativePath);
  const name = segs[segs.length - 1];
  if (!name) return false;
  const dirs = segs.slice(0, -1);
  const inWorkbenchTree = dirs.some((d) => d.endsWith("_files"));

  // Workbench's temporary solve area: <project folder>/_ProjectScratch/ScrXXXX/
  if (dirs.includes("_projectscratch")) return true;

  // <project>_files/dpN/SYS[-n]/MECH/<anything>
  for (let i = 0; i + 3 < dirs.length; i++) {
    if (
      dirs[i]!.endsWith("_files") &&
      /^dp\d+$/.test(dirs[i + 1]!) &&
      /^sys(-\d+)?$/.test(dirs[i + 2]!) &&
      dirs[i + 3] === "mech"
    ) {
      return true;
    }
  }

  if (/^cleanup-ansys-.*\.bat$/.test(name)) return true;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (MAPDL_ONLY_EXTENSIONS.has(ext)) return true;
  if (ext === "rst" && (inWorkbenchTree || name === "file.rst")) return true;
  return false;
}

/** Split candidates into the ones that may be added and the solver output that may not. */
export function partitionSolverOutput<T extends { relativePath: string }>(
  files: readonly T[],
): { allowed: T[]; blocked: T[] } {
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const f of files) (isAnsysSolverOutput(f.relativePath) ? blocked : allowed).push(f);
  return { allowed, blocked };
}
