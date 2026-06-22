using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
using SolidWorks.Interop.swpublished;

namespace HeliosVault
{
    /// <summary>
    /// Helios Vault SOLIDWORKS add-in (Phase 1 skeleton).
    ///
    /// Implements ISwAddin so SOLIDWORKS loads it in-process, and hosts a
    /// "Helios Vault" Task Pane. Phase 1 just proves the toolchain: it loads,
    /// shows the panel, and reflects the active document's name. Real
    /// check-in/out / get-latest gets wired to the Helios desktop app's local
    /// bridge in Phase 3.
    ///
    /// COM registration is self-contained via the [ComRegisterFunction] hooks
    /// below — run `regasm /codebase HeliosVault.dll` (elevated). See README.md.
    /// </summary>
    [Guid("B7A4E2C9-3F1D-4A8B-9C2E-5D6F7A8B9C0D")]
    [ComVisible(true)]
    [ProgId("HeliosVault.SwAddin")]
    public class SwAddin : ISwAddin
    {
        private ISldWorks _sw;
        // Same object as _sw, typed as the coclass so we can subscribe to its
        // document-change notifications (the event interface lives on SldWorks,
        // not ISldWorks).
        private SldWorks _swEvents;
        private int _cookie;
        private ITaskpaneView _taskpane;
        private HeliosVaultControl _control;

        // -------------------------------------------------------------------
        // COM (un)registration — writes the keys SOLIDWORKS scans on startup to
        // discover add-ins. HKLM advertises the add-in; HKCU enables it for the
        // current user. `regasm /codebase` invokes these.
        // -------------------------------------------------------------------
        private static string AddinHklm(Type t) => $@"SOFTWARE\SolidWorks\Addins\{{{t.GUID}}}";
        private static string AddinHkcu(Type t) => $@"Software\SolidWorks\AddInsStartup\{{{t.GUID}}}";

        [ComRegisterFunction]
        public static void RegisterFunction(Type t)
        {
            using (RegistryKey hklm = Registry.LocalMachine.CreateSubKey(AddinHklm(t)))
            {
                // 0 = present but not auto-loaded for all users; the per-user
                // HKCU key below turns it on. Title/Description show in
                // Tools > Add-Ins.
                hklm.SetValue(null, 0, RegistryValueKind.DWord);
                hklm.SetValue("Title", "Helios Vault");
                hklm.SetValue("Description", "Sun Devil Motorsports — Helios PDM (check-in/out, versions, get latest).");
            }
            using (RegistryKey hkcu = Registry.CurrentUser.CreateSubKey(AddinHkcu(t)))
            {
                hkcu.SetValue(null, 1, RegistryValueKind.DWord); // load for this user
            }
        }

        [ComUnregisterFunction]
        public static void UnregisterFunction(Type t)
        {
            Registry.LocalMachine.DeleteSubKey(AddinHklm(t), throwOnMissingSubKey: false);
            Registry.CurrentUser.DeleteSubKey(AddinHkcu(t), throwOnMissingSubKey: false);
        }

        // -------------------------------------------------------------------
        // ISwAddin
        // -------------------------------------------------------------------
        public bool ConnectToSW(object ThisSW, int Cookie)
        {
            _sw = (ISldWorks)ThisSW;
            _cookie = Cookie;
            // Lets SOLIDWORKS route callbacks (toolbar/menu) back to this instance.
            _sw.SetAddinCallbackInfo2(0, this, _cookie);

            // Create the docked Task Pane and host our WinForms control in it.
            // (no custom icon yet — "" uses the default.)
            _taskpane = _sw.CreateTaskpaneView2("", "Helios Vault");
            _control = new HeliosVaultControl(GetActivePath, SaveActiveDoc, GetActiveComponentPaths, MakeActiveDocWritable, MakeActiveDocReadOnly);
            _taskpane.DisplayWindowFromHandlex64(_control.Handle.ToInt64());

            // Show the active doc + its vault status now...
            _control.SetActiveDocument(GetActivePath());

            // ...and keep it live: re-read the active document whenever the user
            // opens or switches files. Without this the pane only ever reflects
            // whatever was active when the add-in loaded (usually nothing, at
            // SOLIDWORKS startup), so freshly-opened vault files wrongly show as
            // "not in the vault" until you hit Refresh. `as` (not a hard cast) so
            // a wrapper that doesn't expose the event interface just degrades to
            // the control's poll-based fallback instead of failing to load.
            _swEvents = ThisSW as SldWorks;
            if (_swEvents != null)
            {
                _swEvents.ActiveModelDocChangeNotify += OnActiveModelDocChange;
                _swEvents.FileOpenPostNotify += OnFileOpenPost;
            }
            return true;
        }

        // Active document changed (opened / switched / closed) → refresh the pane.
        private int OnActiveModelDocChange()
        {
            RefreshActiveDoc();
            return 0; // 0 = handled OK; never abort SOLIDWORKS's own handling
        }

        private int OnFileOpenPost(string fileName)
        {
            RefreshActiveDoc();
            return 0;
        }

        /// <summary>Re-point the Task Pane at the current active document, marshaled
        /// to the control's UI thread.</summary>
        private void RefreshActiveDoc()
        {
            var ctrl = _control;
            if (ctrl == null) return;
            try
            {
                if (ctrl.IsHandleCreated && ctrl.InvokeRequired)
                    ctrl.BeginInvoke((Action)(() => ctrl.SetActiveDocument(GetActivePath())));
                else
                    ctrl.SetActiveDocument(GetActivePath());
            }
            catch { /* control is tearing down */ }
        }

        public bool DisconnectFromSW()
        {
            if (_swEvents != null)
            {
                try
                {
                    _swEvents.ActiveModelDocChangeNotify -= OnActiveModelDocChange;
                    _swEvents.FileOpenPostNotify -= OnFileOpenPost;
                }
                catch { /* SW already torn down */ }
                _swEvents = null;
            }
            if (_taskpane != null)
            {
                _taskpane.DeleteView();
                Marshal.ReleaseComObject(_taskpane);
                _taskpane = null;
            }
            // Dispose before nulling: stops the 4-second poll timer and releases
            // the GDI handles owned by the control and its child VaultTreePanel
            // ImageList. Without this they leak for the entire SW process lifetime.
            _control?.Dispose();
            _control = null;
            if (_sw != null)
            {
                Marshal.ReleaseComObject(_sw);
                _sw = null;
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
            return true;
        }

        /// <summary>Full path of the SOLIDWORKS active document, or null.</summary>
        private string GetActivePath()
        {
            try { return _sw?.IActiveDoc2?.GetPathName(); }
            catch { return null; }
        }

        /// <summary>
        /// Top-level component file paths of the active assembly (empty for a
        /// part/drawing). Lets the Task Pane show each component's vault status.
        /// Top-level only — drilling into a sub-assembly is just opening it.
        /// </summary>
        private string[] GetActiveComponentPaths()
        {
            try
            {
                var doc = _sw?.IActiveDoc2;
                if (doc == null || doc.GetType() != (int)swDocumentTypes_e.swDocASSEMBLY)
                    return new string[0];
                if (!(doc is IAssemblyDoc asm)) return new string[0];
                if (!(asm.GetComponents(true) is object[] comps)) return new string[0];

                var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var o in comps)
                {
                    if (!(o is IComponent2 c)) continue;
                    try { if (c.IsSuppressed()) continue; } catch { /* keep it */ }
                    var p = c.GetPathName();
                    if (!string.IsNullOrEmpty(p)) set.Add(p);
                }
                var arr = new string[set.Count];
                set.CopyTo(arr);
                return arr;
            }
            catch { return new string[0]; }
        }

        /// <summary>
        /// Make the active document read-write after a check-out. SOLIDWORKS keeps
        /// a document read-only for its entire open session even once the file's
        /// on-disk read-only attribute is cleared (which the Helios bridge does on
        /// check-out), so the user would still be blocked from editing (the title
        /// bar keeps showing "[Read-Only]" and Save is disabled).
        ///
        /// `SetReadOnlyState(false)` flips that session state IN PLACE — no reload,
        /// no view/feature-tree disruption. (`ReloadOrReplace` did not reliably
        /// clear the read-only flag.) If for some reason it can't, fall back to
        /// reloading from the now-writable file on disk.
        /// Must be called on the SOLIDWORKS (main) thread.
        /// </summary>
        private void MakeActiveDocWritable()
        {
            try
            {
                var doc = _sw?.IActiveDoc2;
                if (doc == null) return;
                bool readOnly;
                try { readOnly = doc.IsOpenedReadOnly(); }
                catch { readOnly = true; }
                if (!readOnly) return; // already writable

                bool ok;
                try { ok = doc.SetReadOnlyState(false); }
                catch { ok = false; }

                if (!ok)
                {
                    // Fallback: reload from disk (now writable) so it reopens
                    // read-write. Override user settings so it doesn't silently
                    // reopen read-only again.
                    var path = doc.GetPathName();
                    if (!string.IsNullOrEmpty(path))
                    {
                        try { doc.ReloadOrReplace(true, path, true); } catch { /* best effort */ }
                    }
                }
            }
            catch { /* best effort — the file is writable on disk regardless */ }
        }

        /// <summary>
        /// Restore the active document to read-only after a check-in. Mirror of
        /// MakeActiveDocWritable: the bridge re-sets the file's on-disk read-only
        /// bit on check-in, and this flips SOLIDWORKS's session state to match so
        /// the user can't keep editing/saving a file that's no longer checked out.
        /// Must be called on the SOLIDWORKS (main) thread.
        /// </summary>
        private void MakeActiveDocReadOnly()
        {
            try
            {
                var doc = _sw?.IActiveDoc2;
                if (doc == null) return;
                bool readOnly;
                try { readOnly = doc.IsOpenedReadOnly(); }
                catch { readOnly = false; }
                if (readOnly) return; // already read-only
                try { doc.SetReadOnlyState(true); } catch { /* best effort */ }
            }
            catch { /* best effort */ }
        }

        /// <summary>Best-effort silent save of the active document, so a check-in
        /// uploads the user's current edits (check-in reads from disk).</summary>
        private void SaveActiveDoc()
        {
            try
            {
                var doc = _sw?.IActiveDoc2;
                if (doc == null) return;
                int err = 0, warn = 0;
                doc.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref err, ref warn);
            }
            catch { /* best effort — the user can save manually */ }
        }
    }
}
