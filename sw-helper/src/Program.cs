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
        // Single file (original form, kept for compatibility):
        //   HeliosSwReadonly.exe "<full path>" <rw|ro>
        // Batch (one process and one COM connection for a whole bulk action):
        //   HeliosSwReadonly.exe --batch <rw|ro> <list file> <result file>
        //   <list file>: UTF-8, one full path per line.
        //   <result file>: written as UTF-8 lines. First "sw<TAB>running|none",
        //   then one "<status><TAB><path>" per input path, where status is
        //   not-open | already | flipped | reloaded | failed-dirty | failed | ambiguous.
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length >= 4 && args[0] == "--batch")
                {
                    bool ro = IsRo(args[1]);
                    var paths = new System.Collections.Generic.List<string>();
                    foreach (var line in System.IO.File.ReadAllLines(args[2], System.Text.Encoding.UTF8))
                        if (!string.IsNullOrWhiteSpace(line)) paths.Add(line.Trim());
                    var lines = Run(paths, ro);
                    System.IO.File.WriteAllLines(args[3], lines, new System.Text.UTF8Encoding(false));
                    return 0;
                }
                if (args.Length < 2 || string.IsNullOrEmpty(args[0])) return 2;
                Run(new System.Collections.Generic.List<string> { args[0] }, IsRo(args[1]));
                return 0;
            }
            catch (Exception ex)
            {
                Diag("fatal: " + ex);
                return 1;
            }
        }

        private static bool IsRo(string mode) =>
            mode.Equals("ro", StringComparison.OrdinalIgnoreCase) || mode == "1";

        private sealed class OpenDoc
        {
            public IModelDoc2 Doc;
            public string Norm;
            public string Canon;
            public string File;
        }

        private static System.Collections.Generic.List<string> Run(System.Collections.Generic.List<string> targets, bool readOnly)
        {
            var output = new System.Collections.Generic.List<string>();
            var sw = ConnectToSolidWorks();
            Diag($"targets={targets.Count} want-ro={readOnly} connected={sw != null}");
            output.Add(sw == null ? "sw	none" : "sw	running");
            if (sw == null)
            {
                foreach (var t in targets) output.Add("not-open	" + t);
                return output;
            }

            // Snapshot the open documents once for the whole batch.
            var open = new System.Collections.Generic.List<OpenDoc>();
            if (sw.GetDocuments() is object[] docs)
            {
                foreach (var o in docs)
                {
                    if (!(o is IModelDoc2 doc)) continue;
                    string path;
                    try { path = doc.GetPathName(); } catch { continue; }
                    if (string.IsNullOrEmpty(path)) continue;
                    string n = Norm(path);
                    open.Add(new OpenDoc { Doc = doc, Norm = n, Canon = TryCanon(n), File = System.IO.Path.GetFileName(path).ToLowerInvariant() });
                    Diag($"  open: {path}");
                }
            }

            foreach (var target in targets)
            {
                string status;
                try { status = FlipOne(open, target, readOnly); }
                catch (Exception ex) { Diag("  error: " + ex.Message); status = "failed"; }
                Diag($"  {status}: {target}");
                output.Add(status + "	" + target);
            }
            return output;
        }

        private static string FlipOne(System.Collections.Generic.List<OpenDoc> open, string target, bool readOnly)
        {
            string norm = Norm(target);
            string canon = TryCanon(norm);
            string file = System.IO.Path.GetFileName(target).ToLowerInvariant();

            // Match by full path (canonical form handles UNC / mapped drives /
            // 8.3 names). Fall back to the file name only when exactly ONE open
            // document has that name: two "bracket.sldprt" from different
            // folders must never flip the wrong one.
            OpenDoc match = null;
            foreach (var d in open)
            {
                if ((canon != null && d.Canon != null && canon == d.Canon) || d.Norm == norm) { match = d; break; }
            }
            if (match == null && !string.IsNullOrEmpty(file))
            {
                var byName = open.FindAll(d => d.File == file);
                if (byName.Count > 1) return "ambiguous";
                if (byName.Count == 1) match = byName[0];
            }
            if (match == null) return "not-open";

            var doc = match.Doc;
            if (SafeIsReadOnly(doc, !readOnly) == readOnly) return "already";

            // SetReadOnlyState flips the session state in place (no reload, the
            // feature tree and any unsaved edits stay). It can refuse while
            // SOLIDWORKS is busy (rebuilding, a dialog open), so try a few times
            // and CHECK the outcome: the old helper ignored the result, so a
            // refused flip left a checked-out file read-only with no sign of it.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try { doc.SetReadOnlyState(readOnly); } catch (Exception ex) { Diag("  SetReadOnlyState threw: " + ex.Message); }
                if (SafeIsReadOnly(doc, !readOnly) == readOnly) return "flipped";
                System.Threading.Thread.Sleep(400);
            }

            if (readOnly) return "failed";

            // Still read-only. Reloading from the (now writable) file opens it
            // read-write, but throws away in-memory edits, so only when there
            // are none.
            bool dirty;
            try { dirty = doc.GetSaveFlag(); } catch { dirty = true; }
            if (dirty) return "failed-dirty";
            string path;
            try { path = doc.GetPathName(); } catch { return "failed"; }
            try
            {
                // ReloadOrReplace(ReadOnly, ReplaceFileName, DontSave)
                doc.ReloadOrReplace(false, path, true);
            }
            catch (Exception ex) { Diag("  ReloadOrReplace threw: " + ex.Message); return "failed"; }
            return SafeIsReadOnly(doc, true) ? "failed" : "reloaded";
        }

        private static bool SafeIsReadOnly(IModelDoc2 doc, bool fallback)
        {
            try { return doc.IsOpenedReadOnly(); } catch { return fallback; }
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
