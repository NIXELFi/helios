using System;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
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
            _control = new HeliosVaultControl(GetActivePath);
            _taskpane.DisplayWindowFromHandlex64(_control.Handle.ToInt64());

            // Show the active doc + its vault status now. (Live document-change
            // tracking — auto-refresh on open/switch — lands with Phase 4.)
            _control.SetActiveDocument(GetActivePath());
            return true;
        }

        public bool DisconnectFromSW()
        {
            if (_taskpane != null)
            {
                _taskpane.DeleteView();
                Marshal.ReleaseComObject(_taskpane);
                _taskpane = null;
            }
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
    }
}
