using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using Microsoft.Win32.SafeHandles;
using SolidWorks.Interop.sldworks;

namespace HeliosSwReadonly
{
    /// <summary>
    /// Flip a SOLIDWORKS document's in-session read-only state from OUTSIDE
    /// SOLIDWORKS, so the Helios desktop app can make a checked-out file editable
    /// (and re-protect it on check-in) even when the SOLIDWORKS add-in isn't
    /// installed / is disabled / is broken.
    ///
    /// Usage:  HeliosSwReadonly.exe "&lt;full path&gt;" &lt;rw|rwr|ro&gt;
    ///   rw  → make writable in place (keeps the in-memory model) — on check-out
    ///   rwr → make writable by RELOADING from disk — on a check-out that just
    ///         downloaded newer bytes, so the user edits the new version, not the
    ///         older one SOLIDWORKS still has in memory
    ///   ro  → make read-only — on check-in / cancel
    ///
    /// Exit codes: 0 = handled or nothing to do (SW not running / doc not open);
    /// 1 = unexpected error; 2 = bad args. Always best-effort — the on-disk
    /// read-only bit (set by the desktop app) is the real guarantee; this only
    /// fixes the "already open in SOLIDWORKS" case.
    /// </summary>
    internal static class Program
    {
        private enum Mode { Rw, Rwr, Ro }

        // Single file (original form, kept for compatibility):
        //   HeliosSwReadonly.exe "<full path>" <rw|rwr|ro>
        // Batch (one process and one COM connection for a whole bulk action):
        //   HeliosSwReadonly.exe --batch <rw|rwr|ro> <list file> <result file>
        //   <list file>: UTF-8, one full path per line.
        //   <result file>: UTF-8 lines, each written and flushed as soon as it is
        //   known, so a helper killed part-way leaves the results it got to.
        //   First "sw<TAB>running|none", then one "<status><TAB><path>" per
        //   input path, where status is
        //     not-open | already | flipped | reloaded | failed | ambiguous
        //     failed-dirty  (rw: still read-only, has unsaved changes)
        //     stale-dirty   (rwr: open with unsaved changes, so not reloaded)
        //     flipped-dirty (ro: made read-only, but had unsaved changes)
        [STAThread]
        private static int Main(string[] args)
        {
            // Retry calls a busy SOLIDWORKS rejects (rebuilding, modal dialog)
            // instead of failing them at once with RPC_E_SERVERCALL_RETRYLATER.
            IOleMessageFilter previousFilter = null;
            bool filterRegistered = false;
            try { filterRegistered = CoRegisterMessageFilter(new RetryMessageFilter(), out previousFilter) == 0; }
            catch (Exception ex) { Diag("message filter: " + ex.Message); }
            try
            {
                if (args.Length >= 4 && args[0] == "--batch")
                {
                    var mode = ParseMode(args[1]);
                    var paths = new List<string>();
                    foreach (var line in File.ReadAllLines(args[2], Encoding.UTF8))
                        if (!string.IsNullOrWhiteSpace(line)) paths.Add(line.TrimEnd('\r'));
                    using (var fs = new FileStream(args[3], FileMode.Create, FileAccess.Write, FileShare.Read))
                    using (var w = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" })
                    {
                        Run(paths, mode, line => { w.WriteLine(line); fs.Flush(true); });
                    }
                    return 0;
                }
                if (args.Length < 2 || string.IsNullOrEmpty(args[0])) return 2;
                Run(new List<string> { args[0] }, ParseMode(args[1]), _ => { });
                return 0;
            }
            catch (Exception ex)
            {
                Diag("fatal: " + ex);
                return 1;
            }
            finally
            {
                if (filterRegistered)
                {
                    try { CoRegisterMessageFilter(previousFilter, out _); } catch { }
                }
            }
        }

        private static Mode ParseMode(string mode)
        {
            if (mode.Equals("ro", StringComparison.OrdinalIgnoreCase) || mode == "1") return Mode.Ro;
            if (mode.Equals("rwr", StringComparison.OrdinalIgnoreCase)) return Mode.Rwr;
            return Mode.Rw;
        }

        private sealed class OpenDoc
        {
            public IModelDoc2 Doc;
            public string Path;
            public string Norm;
            public bool IdResolved;
            public string Id;
        }

        private static void Run(List<string> targets, Mode mode, Action<string> emit)
        {
            var sw = ConnectToSolidWorks();
            Diag($"targets={targets.Count} mode={mode} connected={sw != null}");
            emit(sw == null ? "sw\tnone" : "sw\trunning");
            if (sw == null)
            {
                foreach (var t in targets) emit("not-open\t" + t);
                return;
            }

            // Snapshot the open documents once for the whole batch.
            var open = new List<OpenDoc>();
            object docsObj = null;
            try { docsObj = sw.GetDocuments(); } catch (Exception ex) { Diag("GetDocuments threw: " + ex.Message); }
            if (docsObj is object[] docs)
            {
                foreach (var o in docs)
                {
                    if (!(o is IModelDoc2 doc)) continue;
                    string path;
                    try { path = doc.GetPathName(); } catch { continue; }
                    if (string.IsNullOrEmpty(path)) continue;
                    open.Add(new OpenDoc { Doc = doc, Path = path, Norm = Norm(path) });
                    Diag($"  open: {path}");
                }
            }

            foreach (var target in targets)
            {
                string status;
                try { status = FlipOne(sw, open, target, mode); }
                catch (Exception ex) { Diag("  error: " + ex.Message); status = "failed"; }
                Diag($"  {status}: {target}");
                emit(status + "\t" + target);
            }
        }

        /// <summary>The open document that IS this file: same normalized full
        /// path, or the same file on disk (volume serial + file index) reached
        /// through another path form (mapped drive vs UNC, 8.3 short name,
        /// hard link). Never by file name alone: that flipped an unrelated open
        /// "bracket.sldprt" from another folder.</summary>
        private static List<OpenDoc> FindMatches(List<OpenDoc> open, string target)
        {
            string norm = Norm(target);
            var matches = open.FindAll(d => d.Norm == norm);
            if (matches.Count > 0) return matches;
            string id = FileIdentity(target);
            if (id == null) return matches;
            foreach (var d in open)
            {
                if (!d.IdResolved) { d.Id = FileIdentity(d.Path); d.IdResolved = true; }
                if (d.Id != null && d.Id == id) matches.Add(d);
            }
            return matches;
        }

        private static string FlipOne(ISldWorks sw, List<OpenDoc> open, string target, Mode mode)
        {
            var matches = FindMatches(open, target);
            if (matches.Count == 0) return "not-open";
            // The same file open twice under different paths: don't guess.
            if (matches.Count > 1) return "ambiguous";
            var match = matches[0];
            var doc = match.Doc;

            if (mode == Mode.Rwr)
            {
                // The bytes on disk are newer than what SOLIDWORKS loaded, so an
                // in-place flip would let the user save old-version work over the
                // new version. Reload instead, but never throw away unsaved edits.
                bool? staleDirty = SafeIsDirty(doc);
                if (staleDirty == true) return "stale-dirty";
                if (staleDirty == null) return "failed";
                return Reload(sw, doc, match.Path) ? "reloaded" : "failed";
            }

            bool readOnly = mode == Mode.Ro;
            // On check-in, unsaved edits in SOLIDWORKS were NOT part of what was
            // checked in. Read this before the flip so the user can be told.
            bool? dirtyBefore = readOnly ? SafeIsDirty(doc) : null;
            if (SafeIsReadOnly(doc, !readOnly) == readOnly) return "already";

            // SetReadOnlyState flips the session state in place (no reload, the
            // feature tree and any unsaved edits stay). It can refuse while
            // SOLIDWORKS is busy (rebuilding, a dialog open), so try a few times
            // and CHECK the outcome: the old helper ignored the result, so a
            // refused flip left a checked-out file read-only with no sign of it.
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try { doc.SetReadOnlyState(readOnly); } catch (Exception ex) { Diag("  SetReadOnlyState threw: " + ex.Message); }
                if (SafeIsReadOnly(doc, !readOnly) == readOnly)
                    return readOnly && dirtyBefore == true ? "flipped-dirty" : "flipped";
                System.Threading.Thread.Sleep(400);
            }

            if (readOnly) return "failed";

            // Still read-only. Reloading from the (now writable) file opens it
            // read-write, but throws away in-memory edits, so only when there
            // are none.
            bool? dirty = SafeIsDirty(doc);
            if (dirty == true) return "failed-dirty";
            if (dirty == null) return "failed";
            return Reload(sw, doc, match.Path) ? "reloaded" : "failed";
        }

        /// <summary>Reload <paramref name="doc"/> from disk as editable, discarding
        /// nothing (callers check it isn't dirty first), and verify through a
        /// FRESH document reference: the old IModelDoc2 may be stale after a
        /// reload.</summary>
        private static bool Reload(ISldWorks sw, IModelDoc2 doc, string fallbackPath)
        {
            string path;
            try { path = doc.GetPathName(); } catch { path = fallbackPath; }
            if (string.IsNullOrEmpty(path)) path = fallbackPath;
            int rc;
            try
            {
                // ReloadOrReplace(ReadOnly, ReplaceFileName, DontSave)
                rc = doc.ReloadOrReplace(false, path, true);
            }
            catch (Exception ex) { Diag("  ReloadOrReplace threw: " + ex.Message); return false; }
            Diag($"  ReloadOrReplace rc={rc}");
            // swReloadOkay = 0, swDocumentNotChanged = 14, swReadOnlyChanged = 16
            if (rc != 0 && rc != 14 && rc != 16) return false;

            IModelDoc2 fresh = null;
            try { fresh = sw.GetOpenDocumentByName(path) as IModelDoc2; }
            catch (Exception ex) { Diag("  GetOpenDocumentByName threw: " + ex.Message); }
            return !SafeIsReadOnly(fresh ?? doc, true);
        }

        private static bool SafeIsReadOnly(IModelDoc2 doc, bool fallback)
        {
            try { return doc.IsOpenedReadOnly(); } catch { return fallback; }
        }

        /// <summary>The doc's unsaved-changes flag, or null if SOLIDWORKS kept
        /// refusing to say (the message filter already retries busy rejections;
        /// this covers other transient failures).</summary>
        private static bool? SafeIsDirty(IModelDoc2 doc)
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try { return doc.GetSaveFlag(); }
                catch (Exception ex)
                {
                    Diag("  GetSaveFlag threw: " + ex.Message);
                    System.Threading.Thread.Sleep(300);
                }
            }
            return null;
        }

        /// <summary>Lexical normalization only: forward slashes, "." / "..",
        /// trailing separator, case. GetFullPath does NOT resolve mapped drives,
        /// UNC shares or 8.3 short names; <see cref="FileIdentity"/> covers those.</summary>
        private static string Norm(string p)
        {
            string s = (p ?? "").Replace('/', '\\');
            try { if (s.Length > 0) s = Path.GetFullPath(s); } catch { }
            return s.TrimEnd('\\').ToLowerInvariant();
        }

        /// <summary>"volume serial:file index" for an existing file, or null when
        /// it can't be opened or the filesystem reports no index (some network
        /// shares return 0). Two path strings with the same identity are the same
        /// file whatever path form reached it.</summary>
        private static string FileIdentity(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            string p = path.Replace('/', '\\');
            if (p.Length >= 260 && !p.StartsWith(@"\\?\"))
                p = p.StartsWith(@"\\") ? @"\\?\UNC\" + p.Substring(2) : @"\\?\" + p;
            try
            {
                using (var h = CreateFileW(p, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero,
                                           OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
                {
                    if (h.IsInvalid) return null;
                    if (!GetFileInformationByHandle(h, out var info)) return null;
                    if (info.nFileIndexHigh == 0 && info.nFileIndexLow == 0) return null;
                    return $"{info.dwVolumeSerialNumber:x8}:{info.nFileIndexHigh:x8}{info.nFileIndexLow:x8}";
                }
            }
            catch (Exception ex)
            {
                Diag("  FileIdentity failed: " + ex.Message);
                return null;
            }
        }

        /// <summary>Append a line to %TEMP%\helios_sw_helper.log when
        /// HELIOS_SW_HELPER_DEBUG is set — for diagnosing the COM connect/flip
        /// without a debugger. No-op otherwise.</summary>
        private static void Diag(string msg)
        {
            if (System.Environment.GetEnvironmentVariable("HELIOS_SW_HELPER_DEBUG") == null) return;
            try
            {
                var f = Path.Combine(Path.GetTempPath(), "helios_sw_helper.log");
                File.AppendAllText(f, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + System.Environment.NewLine);
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

        // ---- OLE message filter: retry calls a busy SOLIDWORKS rejects ----

        [DllImport("ole32.dll")]
        private static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);

        [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IOleMessageFilter
        {
            [PreserveSig] int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);
            [PreserveSig] int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);
            [PreserveSig] int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
        }

        private sealed class RetryMessageFilter : IOleMessageFilter
        {
            private const int SERVERCALL_ISHANDLED = 0;
            private const int SERVERCALL_RETRYLATER = 2;
            private const int PENDINGMSG_WAITDEFPROCESS = 2;
            private const int RetryDelayMs = 100;
            private const int GiveUpAfterMs = 10000;

            public int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo) =>
                SERVERCALL_ISHANDLED;

            // dwTickCount = ms since the call was first made. Return a delay to
            // retry after, or -1 to give up (the call then fails as before).
            public int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType) =>
                dwRejectType == SERVERCALL_RETRYLATER && dwTickCount < GiveUpAfterMs ? RetryDelayMs : -1;

            public int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType) =>
                PENDINGMSG_WAITDEFPROCESS;
        }

        // ---- File identity (volume serial + file index) ----

        private const uint FILE_READ_ATTRIBUTES = 0x80;
        private const uint FILE_SHARE_ALL = 0x7; // READ | WRITE | DELETE
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
            IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle hFile, out BY_HANDLE_FILE_INFORMATION lpFileInformation);
    }
}
