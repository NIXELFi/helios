using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using SharpShell.Attributes;
using SharpShell.SharpContextMenu;

namespace HeliosShell
{
    /// <summary>
    /// Right-click "Helios Vault ▸" menu in Explorer for vault files: Check Out,
    /// Check In, Get Latest, Cancel Check-Out, Add to Vault, and Revision
    /// History — all driven through the same localhost bridge the SOLIDWORKS
    /// add-in uses, so the three surfaces stay in lockstep. Enable/disable
    /// reflects the file's live lock state.
    /// </summary>
    [ComVisible(true)]
    [Guid("8F2A6C14-9B3D-4E57-A1C2-D4E5F6070801")]
    [COMServerAssociation(AssociationType.AllFiles)]
    public class HeliosContextMenu : SharpContextMenu
    {
        // --- SHChangeNotify: nudge Explorer to repaint a file's overlay/icon
        //     after an action changes its vault state. -------------------------
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern void SHChangeNotify(int eventId, int flags, string item1, string item2);
        private const int SHCNE_UPDATEITEM = 0x00002000;
        private const int SHCNF_PATHW = 0x0005;

        private static void RefreshIcon(string path)
        {
            try { SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, path, null); } catch { }
        }

        protected override bool CanShowMenu()
        {
            try
            {
                foreach (var p in SelectedItemPaths)
                    if (ShellState.StateFor(p) != null || ShellState.IsUnderVault(p)) return true;
            }
            catch { }
            return false;
        }

        protected override ContextMenuStrip CreateMenu()
        {
            var menu = new ContextMenuStrip();
            var root = new ToolStripMenuItem("Helios Vault");
            var paths = SelectedItemPaths.ToList();

            if (!Bridge.IsHeliosRunning())
            {
                root.DropDownItems.Add(Disabled("Helios isn't running — open the Helios app"));
            }
            else if (paths.Count == 1)
            {
                BuildSingle(root, paths[0]);
            }
            else
            {
                BuildMulti(root, paths);
            }

            menu.Items.Add(root);
            return menu;
        }

        // ---- single-file menu (full verb set, state-aware) --------------------
        private void BuildSingle(ToolStripMenuItem root, string path)
        {
            // Build from the cached shell-state — NEVER a blocking HTTP call on
            // Explorer's UI thread (that would freeze Explorer if the bridge is
            // slow). The cache is refreshed by the bridge on every lock change.
            var state = ShellState.StateFor(path);
            if (state == null)
            {
                if (ShellState.IsUnderVault(path))
                    root.DropDownItems.Add(Item("Add to Vault", () => Run("Add to Vault", path, () => Bridge.Add(path))));
                else
                    root.DropDownItems.Add(Disabled("Not in the Helios vault"));
                return;
            }

            bool outMe = state == "out-me";
            bool outAny = outMe || state == "out-other";
            string statusText = outMe ? "● Checked out by you"
                : outAny ? "● Checked out by another member"
                : "● Available";
            root.DropDownItems.Add(Disabled(statusText));
            root.DropDownItems.Add(new ToolStripSeparator());

            root.DropDownItems.Add(Item("Check Out", () => Run("Check out", path, () => Bridge.Checkout(path)), enabled: !outAny));
            root.DropDownItems.Add(Item("Check In…", () => CheckInFlow(path), enabled: outMe));
            root.DropDownItems.Add(Item("Cancel Check-Out", () => Run("Cancel check-out", path, () => Bridge.CancelCheckout(path)), enabled: outMe));
            root.DropDownItems.Add(Item("Get Latest", () => Run("Get latest", path, () => Bridge.GetLatest(path))));
            root.DropDownItems.Add(new ToolStripSeparator());
            root.DropDownItems.Add(Item("Revision History…", () => HeliosUi.ShowHistory(path)));
        }

        // ---- multi-select menu (bulk verbs over the tracked files) ------------
        private void BuildMulti(ToolStripMenuItem root, List<string> paths)
        {
            var tracked = paths.Where(p => ShellState.StateFor(p) != null).ToList();
            root.DropDownItems.Add(Disabled($"{tracked.Count} of {paths.Count} in the vault"));
            root.DropDownItems.Add(new ToolStripSeparator());
            root.DropDownItems.Add(Item("Check Out", () => RunMany("Check out", tracked, Bridge.Checkout)));
            root.DropDownItems.Add(Item("Check In", () => RunMany("Check in", tracked, p => Bridge.CheckIn(p, null))));
            root.DropDownItems.Add(Item("Get Latest", () => RunMany("Get latest", tracked, Bridge.GetLatest)));
            root.DropDownItems.Add(Item("Cancel Check-Out", () => RunMany("Cancel check-out", tracked, Bridge.CancelCheckout)));
        }

        // ---- actions ----------------------------------------------------------
        private void CheckInFlow(string path)
        {
            var comment = HeliosUi.PromptComment(System.IO.Path.GetFileName(path));
            if (comment == HeliosUi.Cancelled) return; // user cancelled the prompt
            Run("Check in", path, () => Bridge.CheckIn(path, string.IsNullOrEmpty(comment) ? null : comment));
        }

        private void Run(string verb, string path, Func<Bridge.Result> action)
        {
            // Off the UI thread: a slow/forwarded bridge op (e.g. a large
            // check-in) must never freeze Explorer. The menu closes immediately;
            // a failure surfaces when the op finishes.
            System.Threading.Tasks.Task.Run(() =>
            {
                Bridge.Result r;
                try { r = action(); }
                catch (Exception ex) { r = new Bridge.Result { Error = ex.Message }; }
                RefreshIcon(path);
                if (r.Unreachable)
                    HeliosUi.Error(verb, "Helios isn't running — open the Helios app.");
                else if (!r.Ok)
                    HeliosUi.Error(verb, r.Error ?? (verb + " failed."));
            });
        }

        private void RunMany(string verb, List<string> paths, Func<string, Bridge.Result> action)
        {
            if (paths.Count == 0) return;
            System.Threading.Tasks.Task.Run(() =>
            {
                int ok = 0;
                var errors = new List<string>();
                foreach (var p in paths)
                {
                    Bridge.Result r;
                    try { r = action(p); }
                    catch (Exception ex) { r = new Bridge.Result { Error = ex.Message }; }
                    RefreshIcon(p);
                    if (r.Ok) ok++;
                    else errors.Add($"{System.IO.Path.GetFileName(p)}: {r.Error ?? "failed"}");
                }
                if (errors.Count > 0)
                    HeliosUi.Error(verb, $"{ok}/{paths.Count} succeeded.\n\n" + string.Join("\n", errors.Take(10)));
            });
        }

        // ---- menu-item helpers ------------------------------------------------
        private static ToolStripMenuItem Item(string text, Action onClick, bool enabled = true)
        {
            var i = new ToolStripMenuItem(text) { Enabled = enabled };
            if (enabled) i.Click += (s, e) => onClick();
            return i;
        }

        private static ToolStripMenuItem Disabled(string text) =>
            new ToolStripMenuItem(text) { Enabled = false };
    }
}
