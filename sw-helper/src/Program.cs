using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using SolidWorks.Interop.sldworks;

namespace HeliosSwReadonly
{
    /// <summary>
    /// Flip a SOLIDWORKS document's in-session read-only state from OUTSIDE
    /// SOLIDWORKS, so the Helios desktop app can make a checked-out file editable
    /// (and re-protect it on check-in) even when the SOLIDWORKS add-in isn't
    /// installed / is disabled / is broken.
    ///
    /// Usage:  HeliosSwReadonly.exe "&lt;full path&gt;" &lt;rw|ro&gt;
    ///   rw → make writable (clears the open doc's read-only state) — on check-out
    ///   ro → make read-only — on check-in / cancel
    ///
    /// Exit codes: 0 = handled or nothing to do (SW not running / doc not open);
    /// 1 = unexpected error; 2 = bad args. Always best-effort — the on-disk
    /// read-only bit (set by the desktop app) is the real guarantee; this only
    /// fixes the "already open in SOLIDWORKS" case.
    /// </summary>
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length < 2 || string.IsNullOrEmpty(args[0])) return 2;
                string target = Norm(args[0]);
                bool readOnly = args[1].Equals("ro", StringComparison.OrdinalIgnoreCase) || args[1] == "1";

                var sw = ConnectToSolidWorks();
                Diag($"target={target} want-ro={readOnly} connected={sw != null}");
                if (sw == null) return 0; // SW not running — nothing to flip

                if (!(sw.GetDocuments() is object[] docs)) { Diag("GetDocuments: none"); return 0; }
                // Canonical form of the target for robust comparison (resolves
                // mapped drives, UNC paths, 8.3 names, trailing separators).
                string targetCanon = TryCanon(target);
                // Filename-only fallback for when GetFullPath can't resolve a UNC
                // or mapped drive from a different session context.
                string targetFile = System.IO.Path.GetFileName(args[0]).ToLowerInvariant();
                Diag($"open docs={docs.Length} targetCanon={targetCanon} targetFile={targetFile}");
                foreach (var o in docs)
                {
                    if (!(o is IModelDoc2 doc)) continue;
                    string path;
                    try { path = doc.GetPathName(); } catch { continue; }
                    Diag($"  doc: {path}");
                    if (string.IsNullOrEmpty(path)) continue;
                    // Primary match: canonical path comparison handles UNC / mapped
                    // drive / 8.3 / mixed-slash variants pointing to the same file.
                    // Fallback: exact normalised string (original behaviour), then
                    // filename-only match as a last resort for unusual path forms.
                    string pathNorm   = Norm(path);
                    string pathCanon  = TryCanon(pathNorm);
                    string pathFile   = System.IO.Path.GetFileName(path).ToLowerInvariant();
                    bool matched = (targetCanon != null && pathCanon != null && targetCanon == pathCanon)
                                || pathNorm == target
                                || (!string.IsNullOrEmpty(targetFile) && pathFile == targetFile);
                    if (!matched) continue;

                    bool isReadOnly;
                    try { isReadOnly = doc.IsOpenedReadOnly(); } catch { isReadOnly = !readOnly; }
                    Diag($"  MATCH wasReadOnly={isReadOnly}");
                    if (isReadOnly != readOnly)
                    {
                        try { doc.SetReadOnlyState(readOnly); Diag("  flipped"); } catch (Exception ex) { Diag("  flip failed: " + ex.Message); }
                    }
                    return 0;
                }
                Diag("no match (not open)");
                return 0; // not open in SOLIDWORKS
            }
            catch
            {
                return 1;
            }
        }

        private static string Norm(string p) =>
            (p ?? "").Replace('/', '\\').TrimEnd('\\').ToLowerInvariant();

        /// <summary>Return the canonical (GetFullPath) form of a path for
        /// identity comparison across UNC, mapped drives, and 8.3 name variants,
        /// or null if the path cannot be resolved (e.g. file doesn't exist).</summary>
        private static string TryCanon(string p)
        {
            if (string.IsNullOrEmpty(p)) return null;
            try { return System.IO.Path.GetFullPath(p).TrimEnd('\\').ToLowerInvariant(); }
            catch { return null; }
        }

        /// <summary>Append a line to %TEMP%\helios_sw_helper.log when
        /// HELIOS_SW_HELPER_DEBUG is set — for diagnosing the COM connect/flip
        /// without a debugger. No-op otherwise.</summary>
        private static void Diag(string msg)
        {
            if (System.Environment.GetEnvironmentVariable("HELIOS_SW_HELPER_DEBUG") == null) return;
            try
            {
                var f = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "helios_sw_helper.log");
                System.IO.File.AppendAllText(f, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + System.Environment.NewLine);
            }
            catch { }
        }

        /// <summary>Get the running SOLIDWORKS, or null if none. Tries the ProgID
        /// (GetActiveObject) first, then a Running Object Table scan as a fallback
        /// for cases where the ProgID→ROT lookup misses.</summary>
        private static ISldWorks ConnectToSolidWorks()
        {
            try
            {
                if (Marshal.GetActiveObject("SldWorks.Application") is ISldWorks sw) return sw;
            }
            catch { /* not in ROT under the ProgID — try a raw scan */ }

            try
            {
                if (GetRunningObjectTable(0, out var rot) != 0 || rot == null) return null;
                rot.EnumRunning(out var en);
                if (en == null) return null;
                en.Reset();
                var monikers = new IMoniker[1];
                while (en.Next(1, monikers, IntPtr.Zero) == 0 && monikers[0] != null)
                {
                    string name = null;
                    try
                    {
                        if (CreateBindCtx(0, out var ctx) == 0 && ctx != null)
                            monikers[0].GetDisplayName(ctx, null, out name);
                    }
                    catch { }
                    if (!string.IsNullOrEmpty(name) &&
                        name.IndexOf("sldworks", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        try
                        {
                            if (rot.GetObject(monikers[0], out var obj) == 0 && obj is ISldWorks found)
                                return found;
                        }
                        catch { }
                    }
                }
            }
            catch { }
            return null;
        }

        [DllImport("ole32.dll")]
        private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable prot);

        [DllImport("ole32.dll")]
        private static extern int CreateBindCtx(int reserved, out IBindCtx ppbc);
    }
}
