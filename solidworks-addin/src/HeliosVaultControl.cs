using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HeliosVault
{
    /// <summary>
    /// The contents of the "Helios Vault" Task Pane. Talks to the running Helios
    /// desktop app over its localhost bridge (see HeliosBridge): shows the active
    /// document's real vault status and drives check-out / check-in / get-latest /
    /// add-to-vault. For an assembly, it also lists each top-level component's
    /// vault status.
    ///
    /// Layout: a single top-down FlowLayoutPanel so sections stack and never
    /// overlap. Child widths track the (stable) control size — NOT the scroll
    /// panel's client size — so the appearing scrollbar can't trigger a layout
    /// loop. Built in code (no .Designer.cs) to keep the add-in self-contained.
    /// </summary>
    public class HeliosVaultControl : UserControl
    {
        private static readonly Color Bg = Color.FromArgb(14, 14, 16);
        private static readonly Color Card = Color.FromArgb(22, 23, 27);
        private static readonly Color Border = Color.FromArgb(42, 44, 51);
        private static readonly Color Fg = Color.FromArgb(216, 220, 226);
        private static readonly Color Dim = Color.FromArgb(144, 151, 160);
        private static readonly Color Gold = Color.FromArgb(255, 198, 39);
        private static readonly Color Green = Color.FromArgb(122, 201, 130);
        private static readonly Color Red = Color.FromArgb(229, 115, 115);
        private static readonly Color Ink = Color.FromArgb(20, 20, 22);

        private const int Pad = 16;

        private readonly Func<string> _getActivePath;
        private readonly Action _saveActiveDoc;
        private readonly Func<string[]> _getComponents;
        // Make the open active document read-write (SOLIDWORKS keeps it read-only
        // for its whole open session even after the on-disk bit clears).
        private readonly Action _makeActiveWritable;
        // Restore the open document to read-only after a check-in — it's no longer
        // checked out, and the bridge has re-set the on-disk read-only bit.
        private readonly Action _makeActiveReadonly;
        private readonly HeliosBridge _bridge = new HeliosBridge();

        private FlowLayoutPanel _flow;
        private Panel _divider;
        private Label _docLabel, _statusLabel, _compsCaption, _connLabel;
        private System.Windows.Forms.Timer _pollTimer;
        private Button _checkOut, _checkIn, _cancelCheckout, _getLatest, _addToVault, _refresh;
        private VaultTreePanel _treePanel;
        private readonly List<Control> _fullWidth = new List<Control>();
        private readonly List<Label> _wrapLabels = new List<Label>();
        private readonly List<Label> _componentRows = new List<Label>();

        private string _activePath;
        private bool _tracked, _checkedOut, _checkedOutByMe;
        // Baseline for detecting EXTERNAL lock changes (check-out/in from the
        // Helios app, or a force-unlock) so SOLIDWORKS's read-only state can be
        // synced. Reset when the active doc changes; we react only to changes
        // while a given doc stays open, never to its initial open state.
        private string _syncedPath;
        private bool _syncedCheckedOutByMe;

        public HeliosVaultControl(Func<string> getActivePath, Action saveActiveDoc, Func<string[]> getComponents, Action makeActiveWritable = null, Action makeActiveReadonly = null)
        {
            _getActivePath = getActivePath;
            _saveActiveDoc = saveActiveDoc;
            _getComponents = getComponents;
            _makeActiveWritable = makeActiveWritable;
            _makeActiveReadonly = makeActiveReadonly;
            BuildUi();

            // Live connection/identity indicator — polls the bridge /health.
            // Also a safety net for document changes: if SOLIDWORKS's doc-change
            // events don't reach the add-in (varies by edition), noticing the
            // active path changed here still refreshes the pane within a tick.
            _pollTimer = new System.Windows.Forms.Timer { Interval = 4000 };
            _pollTimer.Tick += async (s, e) =>
            {
                await RefreshConnection();
                // Quietly re-read the active doc's status every tick. This is how the
                // pane — and SOLIDWORKS's read-only state — pick up a check-out or
                // check-in performed from the HELIOS APP (or a force-unlock), not just
                // from this add-in; it also covers a missed SW doc-change event.
                await RefreshStatus(quiet: true);
            };
            _pollTimer.Start();
            _ = RefreshConnection();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _pollTimer?.Stop();
                _pollTimer?.Dispose();
            }
            base.Dispose(disposing);
        }

        private async Task RefreshConnection()
        {
            var res = await _bridge.HealthAsync();
            if (res.Unreachable || !res.Ok || res.Json == null)
            {
                _connLabel.ForeColor = Red;
                _connLabel.Text = "○ Helios offline — open Helios";
                return;
            }
            var name = GetObj(res.Json, "user") is var u && u != null
                ? (GetStr(u, "displayName") ?? GetStr(u, "email"))
                : null;
            if (GetBool(res.Json, "hasSession") && !string.IsNullOrEmpty(name))
            {
                _connLabel.ForeColor = Green;
                _connLabel.Text = $"● Connected · {name}";
            }
            else
            {
                _connLabel.ForeColor = Dim;
                _connLabel.Text = "● Connected · sign in to Helios";
            }
        }

        private void BuildUi()
        {
            BackColor = Bg;
            ForeColor = Fg;
            Font = new Font("Segoe UI", 9f);

            _flow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                Padding = new Padding(Pad),
                BackColor = Bg,
            };
            Controls.Add(_flow);

            _flow.Controls.Add(MakeLabel("HELIOS VAULT", Gold, 15f, FontStyle.Bold, new Padding(0)));
            _flow.Controls.Add(MakeLabel("Sun Devil Motorsports · Ground Station", Dim, 8.5f, FontStyle.Regular, new Padding(0, 2, 0, 0)));

            _connLabel = MakeLabel("○ Connecting…", Dim, 8.5f, FontStyle.Bold, new Padding(0, 6, 0, 0));
            _wrapLabels.Add(_connLabel);
            _flow.Controls.Add(_connLabel);

            _divider = new Panel { Height = 2, BackColor = Gold, Margin = new Padding(0, 12, 0, 14) };
            _fullWidth.Add(_divider);
            _flow.Controls.Add(_divider);

            _flow.Controls.Add(MakeCaption("ACTIVE DOCUMENT", new Padding(0)));
            _docLabel = MakeLabel("No document open", Fg, 9.5f, FontStyle.Regular, new Padding(0, 3, 0, 0));
            _wrapLabels.Add(_docLabel);
            _flow.Controls.Add(_docLabel);

            _flow.Controls.Add(MakeCaption("VAULT STATUS", new Padding(0, 14, 0, 0)));
            _statusLabel = MakeLabel("—", Dim, 9.5f, FontStyle.Bold, new Padding(0, 3, 0, 0));
            _wrapLabels.Add(_statusLabel);
            _flow.Controls.Add(_statusLabel);

            _checkOut = MakeButton("Check Out", primary: true, topGap: 18);
            _checkIn = MakeButton("Check In");
            _cancelCheckout = MakeButton("Cancel Check-Out");
            _getLatest = MakeButton("Get Latest");
            _addToVault = MakeButton("Add to Vault", primary: true);
            _refresh = MakeButton("Refresh", topGap: 12);

            _checkOut.Click += async (s, e) => await DoCheckOut();
            _checkIn.Click += async (s, e) => await DoCheckIn();
            _cancelCheckout.Click += async (s, e) => await DoCancelCheckout();
            _getLatest.Click += async (s, e) => await DoGetLatest();
            _addToVault.Click += async (s, e) => await DoAddToVault();
            _refresh.Click += async (s, e) => await RefreshStatus();

            _flow.Controls.Add(_checkOut);
            _flow.Controls.Add(_checkIn);
            _flow.Controls.Add(_cancelCheckout);
            _flow.Controls.Add(_getLatest);
            _flow.Controls.Add(_addToVault);
            _flow.Controls.Add(_refresh);

            _compsCaption = MakeCaption("COMPONENTS", new Padding(0, 18, 0, 0));
            _compsCaption.Visible = false;
            _flow.Controls.Add(_compsCaption);

            // Interactive vault + open-assembly tree: browse folders / components
            // and check files in/out from any node (supersedes the flat list).
            _flow.Controls.Add(MakeCaption("VAULT & ASSEMBLY", new Padding(0, 18, 0, 6)));
            _treePanel = new VaultTreePanel(_bridge, _getComponents, SafeGetActivePath)
            {
                Height = 380,
                Margin = new Padding(0, 0, 0, 8),
            };
            _fullWidth.Add(_treePanel);
            _flow.Controls.Add(_treePanel);

            _addToVault.Visible = false;
            SetButtonsEnabled(false, false, false);
            RelayoutWidths();
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            RelayoutWidths();
        }

        private void RelayoutWidths()
        {
            if (_flow == null) return;
            int w = ClientSize.Width - (Pad * 2) - SystemInformation.VerticalScrollBarWidth;
            if (w < 60) return;
            foreach (var c in _fullWidth) c.Width = w;
            foreach (var l in _wrapLabels) l.MaximumSize = new Size(w, 0);
        }

        private static Label MakeLabel(string text, Color color, float size, FontStyle style, Padding margin)
        {
            return new Label
            {
                Text = text,
                ForeColor = color,
                Font = new Font("Segoe UI", size, style),
                AutoSize = true,
                Margin = margin,
            };
        }

        private static Label MakeCaption(string text, Padding margin) =>
            MakeLabel(text, Dim, 7.5f, FontStyle.Bold, margin);

        private Button MakeButton(string text, bool primary = false, int topGap = 4)
        {
            var b = new Button
            {
                Text = text,
                Height = 36,
                Width = 200,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, primary ? FontStyle.Bold : FontStyle.Regular),
                Margin = new Padding(0, topGap, 0, 0),
                TextAlign = ContentAlignment.MiddleCenter,
                Cursor = Cursors.Hand,
                Tag = primary,
            };
            b.FlatAppearance.BorderSize = 1;
            _fullWidth.Add(b);
            StyleButton(b);
            b.EnabledChanged += (s, e) => StyleButton(b);
            return b;
        }

        private static void StyleButton(Button b)
        {
            bool primary = b.Tag is bool p && p;
            if (!b.Enabled)
            {
                b.BackColor = Color.FromArgb(26, 27, 31);
                b.ForeColor = Color.FromArgb(96, 101, 109);
                b.FlatAppearance.BorderColor = Color.FromArgb(38, 40, 46);
                return;
            }
            if (primary)
            {
                b.BackColor = Gold;
                b.ForeColor = Ink;
                b.FlatAppearance.BorderColor = Gold;
                b.FlatAppearance.MouseOverBackColor = Color.FromArgb(255, 212, 84);
                b.FlatAppearance.MouseDownBackColor = Color.FromArgb(230, 176, 30);
            }
            else
            {
                b.BackColor = Card;
                b.ForeColor = Fg;
                b.FlatAppearance.BorderColor = Border;
                b.FlatAppearance.MouseOverBackColor = Color.FromArgb(34, 36, 42);
                b.FlatAppearance.MouseDownBackColor = Color.FromArgb(28, 30, 35);
            }
        }

        /// <summary>
        /// Point the panel at a (possibly new) active document and refresh its
        /// vault status. Called by the add-in on connect / document change.
        /// </summary>
        public void SetActiveDocument(string path)
        {
            _activePath = path;
            _docLabel.Text = string.IsNullOrEmpty(path) ? "No document open" : Path.GetFileName(path);
            _ = RefreshStatus();
        }

        private async Task RefreshStatus(bool quiet = false)
        {
            var latest = SafeGetActivePath();
            if (latest != null) _activePath = latest;

            if (string.IsNullOrEmpty(_activePath))
            {
                _docLabel.Text = "No document open";
                ShowStatus("Open a part, assembly, or drawing.", Dim);
                _tracked = _checkedOut = _checkedOutByMe = false;
                SetButtonsEnabled(false, false, false);
                _addToVault.Visible = false;
                if (!quiet && _treePanel != null) await _treePanel.RefreshActiveAsync();
                return;
            }

            await RefreshDocStatus(quiet);
            // The tree's "Open in SOLIDWORKS" branch tracks the active doc +
            // components; refresh it on a doc change / manual refresh, not the
            // quiet status poll (which would flicker the tree).
            if (!quiet && _treePanel != null) await _treePanel.RefreshActiveAsync();
        }

        private async Task RefreshDocStatus(bool quiet = false)
        {
            _docLabel.Text = Path.GetFileName(_activePath);
            if (!quiet) ShowStatus("Checking…", Dim);

            var res = await _bridge.StatusAsync(_activePath);
            if (res.Unreachable)
            {
                ShowStatus("● Helios isn't running — open the Helios app.", Red);
                _tracked = _checkedOut = _checkedOutByMe = false;
                SetButtonsEnabled(false, false, false);
                _addToVault.Visible = false;
                return;
            }
            if (!res.Ok || res.Json == null)
            {
                ShowStatus("● " + (res.Error ?? "Couldn't read vault status."), Red);
                SetButtonsEnabled(false, false, false);
                _addToVault.Visible = false;
                return;
            }

            _tracked = GetBool(res.Json, "tracked");
            if (!_tracked)
            {
                ShowStatus("Not in the Helios vault — add it to start tracking.", Dim);
                SetButtonsEnabled(false, false, false);
                _addToVault.Visible = true; // offer to add it
                return;
            }
            _addToVault.Visible = false;

            _checkedOut = GetBool(res.Json, "checkedOut");
            _checkedOutByMe = GetBool(res.Json, "checkedOutByMe");
            // Keep SOLIDWORKS's read-only state in sync if the lock changed
            // externally (Helios app / force-unlock) while this doc stayed open.
            SyncReadOnlyToLock();
            var latestObj = GetObj(res.Json, "latest");
            var verNum = latestObj != null ? GetLong(latestObj, "versionNum") : null;
            var rev = latestObj != null ? GetLong(latestObj, "revision") : null;
            var vault = GetStr(res.Json, "vault");
            var verText = verNum.HasValue ? $"v{verNum.Value}" : "no version yet";
            if (rev.HasValue) verText += $" · rev {rev.Value}";
            if (!string.IsNullOrEmpty(vault)) verText += $" · {vault}";

            if (!_checkedOut)
                ShowStatus($"● Available · {verText}", Green);
            else if (_checkedOutByMe)
                ShowStatus($"● Checked out by you · {verText}", Gold);
            else
                ShowStatus($"● Checked out by another member · {verText}", Red);

            SetButtonsEnabled(
                checkOut: _tracked && !_checkedOut,
                checkIn: _tracked && _checkedOutByMe,
                getLatest: _tracked);
        }

        /// <summary>For an assembly, list each top-level component's vault status.</summary>
        private async Task RefreshComponents()
        {
            ClearComponents();

            string[] paths;
            try { paths = _getComponents?.Invoke() ?? new string[0]; }
            catch { paths = new string[0]; }

            if (paths.Length == 0)
            {
                _compsCaption.Visible = false;
                return;
            }

            _compsCaption.Visible = true;
            _compsCaption.Text = $"COMPONENTS ({paths.Length})";

            var res = await _bridge.StatusBatchAsync(paths);
            if (!res.Ok || res.Json == null || !(res.Json.TryGetValue("items", out var raw) && raw is object[] items))
            {
                AddComponentRow("(couldn't load component status)", Dim);
                RelayoutWidths();
                return;
            }

            foreach (var it in items)
            {
                if (!(it is Dictionary<string, object> d)) continue;
                var name = GetStr(d, "name") ?? Path.GetFileName(GetStr(d, "path") ?? "?");
                Color color;
                string mark;
                if (!GetBool(d, "tracked")) { color = Dim; mark = "○"; }
                else if (!GetBool(d, "checkedOut")) { color = Green; mark = "●"; }
                else if (GetBool(d, "checkedOutByMe")) { color = Gold; mark = "●"; }
                else { color = Red; mark = "●"; }
                AddComponentRow($"{mark} {name}", color);
            }
            RelayoutWidths();
        }

        private void AddComponentRow(string text, Color color)
        {
            var l = MakeLabel(text, color, 8.5f, FontStyle.Regular, new Padding(0, 2, 0, 0));
            _componentRows.Add(l);
            _wrapLabels.Add(l);
            _flow.Controls.Add(l);
        }

        private void ClearComponents()
        {
            foreach (var row in _componentRows)
            {
                _flow.Controls.Remove(row);
                _wrapLabels.Remove(row);
                row.Dispose();
            }
            _componentRows.Clear();
        }

        private async Task DoCheckOut()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            SetButtonsEnabled(false, false, false);
            ShowStatus("Checking out…", Dim);

            var res = await _bridge.CheckoutAsync(_activePath);
            if (res.Unreachable)
                ShowStatus("● Helios isn't running — open the Helios app.", Red);
            else if (!res.Ok)
                ShowStatus("● " + (res.Error ?? "Check out failed."), Red);
            else if (_makeActiveWritable != null)
            {
                // The bridge cleared the on-disk read-only bit; now drop SOLIDWORKS's
                // session read-only state so the open doc is editable. COM calls
                // must run on SOLIDWORKS's (this control's) UI thread, but this
                // continuation may be on a thread-pool thread — marshal back.
                try
                {
                    if (IsHandleCreated && InvokeRequired)
                        BeginInvoke(_makeActiveWritable);
                    else
                        _makeActiveWritable();
                }
                catch { /* control tearing down */ }
            }

            await RefreshStatus();
        }

        private async Task DoCheckIn()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            _saveActiveDoc?.Invoke(); // check-in reads from disk — save current edits first
            SetButtonsEnabled(false, false, false);
            ShowStatus("Checking in…", Dim);

            var res = await _bridge.CheckInAsync(_activePath, null);
            if (res.Unreachable)
                ShowStatus("● Helios isn't running — open the Helios app.", Red);
            else if (!res.Ok)
                ShowStatus("● " + (res.Error ?? "Check in failed."), Red);
            else if (_makeActiveReadonly != null)
            {
                // Checked in → no longer checked out. The bridge re-set the on-disk
                // read-only bit; mirror that in SOLIDWORKS so the doc goes back to
                // read-only. Marshal to the SW/UI thread (continuation may be off it).
                try
                {
                    if (IsHandleCreated && InvokeRequired)
                        BeginInvoke(_makeActiveReadonly);
                    else
                        _makeActiveReadonly();
                }
                catch { /* control tearing down */ }
            }

            await RefreshStatus();
        }

        private async Task DoCancelCheckout()
        {
            if (string.IsNullOrEmpty(_activePath)) return;

            // Releasing the lock is the undo of a check-out — for when you checked
            // a file out but made no edits. If you DID save changes, the local
            // bytes stay on disk but can't be checked in again without checking
            // out, so confirm first (default = No).
            var choice = MessageBox.Show(
                "Cancel your check-out of this file?\n\nThis releases your lock without saving a new "
                    + "version. Any edits you made won't be added to the vault.",
                "Cancel Check-Out",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (choice != DialogResult.Yes) return;

            SetButtonsEnabled(false, false, false);
            ShowStatus("Cancelling check-out…", Dim);

            var res = await _bridge.CancelCheckoutAsync(_activePath);
            if (res.Unreachable)
                ShowStatus("● Helios isn't running — open the Helios app.", Red);
            else if (!res.Ok)
                ShowStatus("● " + (res.Error ?? "Cancel check-out failed."), Red);
            else if (_makeActiveReadonly != null)
            {
                // Lock released → no longer checked out. The bridge re-set the
                // on-disk read-only bit; mirror that in SOLIDWORKS so the open doc
                // goes back to read-only. Marshal to the SW/UI thread.
                try
                {
                    if (IsHandleCreated && InvokeRequired)
                        BeginInvoke(_makeActiveReadonly);
                    else
                        _makeActiveReadonly();
                }
                catch { /* control tearing down */ }
            }

            await RefreshStatus();
        }

        private async Task DoGetLatest()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            SetButtonsEnabled(false, false, false);
            ShowStatus("Getting latest…", Dim);

            var res = await _bridge.GetLatestAsync(_activePath);
            if (res.Unreachable)
                ShowStatus("● Helios isn't running — open the Helios app.", Red);
            else if (!res.Ok)
                // Common cause: the file is open in SOLIDWORKS so it can't be
                // overwritten — the message from the bridge explains.
                ShowStatus("● " + (res.Error ?? "Get latest failed."), Red);
            else
                ShowStatus("● Got the latest version.", Green);

            await RefreshStatus();
        }

        private async Task DoAddToVault()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            _saveActiveDoc?.Invoke(); // upload current edits
            _addToVault.Enabled = false;
            ShowStatus("Adding to vault…", Dim);

            var res = await _bridge.AddToVaultAsync(_activePath);
            if (res.Unreachable)
                ShowStatus("● Helios isn't running — open the Helios app.", Red);
            else if (!res.Ok)
                ShowStatus("● " + (res.Error ?? "Add to vault failed."), Red);

            _addToVault.Enabled = true;
            await RefreshStatus();
        }

        private string SafeGetActivePath()
        {
            try { return _getActivePath?.Invoke(); }
            catch { return null; }
        }

        /// <summary>
        /// Sync SOLIDWORKS's session read-only state to the lock when it changes
        /// EXTERNALLY (check-out/in from the Helios app, or a force-unlock):
        /// writable iff checked out by me. Only acts on a transition for the SAME
        /// open doc — its initial open state is authoritative, so we never flip on
        /// first sight. The make-writable / make-read-only actions are idempotent
        /// and marshal themselves to the SOLIDWORKS (UI) thread.
        /// </summary>
        private void SyncReadOnlyToLock()
        {
            // New active doc → adopt its current state as the baseline; don't flip.
            if (!string.Equals(_syncedPath ?? "", _activePath ?? "", StringComparison.OrdinalIgnoreCase))
            {
                _syncedPath = _activePath;
                _syncedCheckedOutByMe = _checkedOutByMe;
                return;
            }
            if (_checkedOutByMe == _syncedCheckedOutByMe) return; // no change
            _syncedCheckedOutByMe = _checkedOutByMe;
            var action = _checkedOutByMe ? _makeActiveWritable : _makeActiveReadonly;
            if (action == null) return;
            try
            {
                if (IsHandleCreated && InvokeRequired) BeginInvoke(action);
                else action();
            }
            catch { /* control tearing down */ }
        }

        private void ShowStatus(string text, Color color)
        {
            _statusLabel.ForeColor = color;
            _statusLabel.Text = text;
        }

        private void SetButtonsEnabled(bool checkOut, bool checkIn, bool getLatest)
        {
            _checkOut.Enabled = checkOut;
            _checkIn.Enabled = checkIn;
            // Cancel Check-Out applies in exactly the same state as Check In — you
            // can only release a check-out you currently hold.
            _cancelCheckout.Enabled = checkIn;
            _getLatest.Enabled = getLatest;
        }

        // --- tiny JSON-dictionary helpers (JavaScriptSerializer shapes) --------

        private static bool GetBool(Dictionary<string, object> d, string k) =>
            d != null && d.TryGetValue(k, out var v) && v is bool b && b;

        private static string GetStr(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v) && v != null) ? Convert.ToString(v) : null;

        private static Dictionary<string, object> GetObj(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v)) ? v as Dictionary<string, object> : null;

        private static long? GetLong(Dictionary<string, object> d, string k)
        {
            if (d == null || !d.TryGetValue(k, out var v) || v == null) return null;
            try { return Convert.ToInt64(v); } catch { return null; }
        }
    }
}
