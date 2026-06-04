using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HeliosVault
{
    /// <summary>
    /// The contents of the "Helios Vault" Task Pane — a refined "ground station"
    /// instrument panel. Talks to the running Helios desktop app over its
    /// localhost bridge (see HeliosBridge): shows the active document's real
    /// vault status and drives check-out / check-in / cancel / get-latest /
    /// add-to-vault, plus an interactive vault + assembly tree (VaultTreePanel).
    ///
    /// Visuals live in HeliosTheme / HeliosWidgets / VaultTreePanel; this class
    /// owns the data flow (bridge calls + the SOLIDWORKS read-only sync).
    /// </summary>
    public class HeliosVaultControl : UserControl
    {
        private const int Pad = 14;

        private readonly Func<string> _getActivePath;
        private readonly Action _saveActiveDoc;
        private readonly Func<string[]> _getComponents;
        // Make the open active document read-write (SOLIDWORKS keeps it read-only
        // for its whole open session even after the on-disk bit clears).
        private readonly Action _makeActiveWritable;
        // Restore the open document to read-only after a check-in.
        private readonly Action _makeActiveReadonly;
        private readonly HeliosBridge _bridge = new HeliosBridge();

        private HeliosHeaderPanel _header;
        private FlowLayoutPanel _flow;
        private HeliosStatusCard _statusCard;
        private System.Windows.Forms.Timer _pollTimer;
        private HeliosButton _checkOut, _checkIn, _cancelCheckout, _getLatest, _addToVault, _refresh;
        private VaultTreePanel _treePanel;
        private readonly List<Control> _fullWidth = new List<Control>();

        private string _activePath;
        private bool _tracked, _checkedOut, _checkedOutByMe;
        // Baseline for detecting EXTERNAL lock changes so SOLIDWORKS's read-only
        // state can be synced. Reset when the active doc changes.
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

            // Live connection/identity indicator — polls the bridge /health. Also
            // a safety net for document changes if SW's doc-change events don't
            // reach the add-in, and how the pane picks up check-out/in done from
            // the Helios app (quiet poll → SyncReadOnlyToLock).
            _pollTimer = new System.Windows.Forms.Timer { Interval = 4000 };
            _pollTimer.Tick += async (s, e) =>
            {
                await RefreshConnection();
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
                _header.SetConnection(0, null);
                return;
            }
            var u = GetObj(res.Json, "user");
            var name = u != null ? (GetStr(u, "displayName") ?? GetStr(u, "email")) : null;
            if (GetBool(res.Json, "hasSession") && !string.IsNullOrEmpty(name))
                _header.SetConnection(2, name);
            else
                _header.SetConnection(1, null);
        }

        private void BuildUi()
        {
            BackColor = HeliosTheme.Base0;
            ForeColor = HeliosTheme.Text;
            Font = HeliosTheme.Body;

            // Scrolling content area (added first so the docked header reserves
            // the top and this fills the remainder).
            _flow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                Padding = new Padding(Pad, Pad, Pad, Pad),
                BackColor = HeliosTheme.Base0,
            };
            Controls.Add(_flow);

            // Fixed branded header, edge-to-edge.
            _header = new HeliosHeaderPanel { Dock = DockStyle.Top };
            Controls.Add(_header);

            _statusCard = new HeliosStatusCard { Margin = new Padding(0, 0, 0, 12) };
            _fullWidth.Add(_statusCard);
            _flow.Controls.Add(_statusCard);

            _checkOut = MakeButton("Check Out", HeliosButtonVariant.Primary, HeliosTheme.GlyphUnlock, 0);
            _checkIn = MakeButton("Check In", HeliosButtonVariant.Primary, HeliosTheme.GlyphSave);
            _cancelCheckout = MakeButton("Cancel Check-Out", HeliosButtonVariant.Danger, HeliosTheme.GlyphUndo);
            _getLatest = MakeButton("Get Latest", HeliosButtonVariant.Secondary, HeliosTheme.GlyphDownload);
            _addToVault = MakeButton("Add to Vault", HeliosButtonVariant.Primary, HeliosTheme.GlyphAdd, 0);
            _refresh = MakeButton("Refresh", HeliosButtonVariant.Ghost, HeliosTheme.GlyphRefresh);

            _checkOut.Click += async (s, e) => await DoCheckOut();
            _checkIn.Click += async (s, e) => await DoCheckIn();
            _cancelCheckout.Click += async (s, e) => await DoCancelCheckout();
            _getLatest.Click += async (s, e) => await DoGetLatest();
            _addToVault.Click += async (s, e) => await DoAddToVault();
            _refresh.Click += async (s, e) => await RefreshStatus();

            // Order: the contextual primary (CheckOut/CheckIn/AddToVault) sits at
            // the top; visibility is set per-state by ApplyActions.
            foreach (var b in new[] { _addToVault, _checkOut, _checkIn, _cancelCheckout, _getLatest, _refresh })
                _flow.Controls.Add(b);

            // Interactive vault + open-assembly tree.
            _treePanel = new VaultTreePanel(_bridge, _getComponents, SafeGetActivePath)
            {
                Height = 384,
                Margin = new Padding(0, 14, 0, 8),
            };
            _fullWidth.Add(_treePanel);
            _flow.Controls.Add(_treePanel);

            ApplyActions("nodoc");
            RelayoutWidths();
        }

        private HeliosButton MakeButton(string text, HeliosButtonVariant variant, string glyph, int topGap = 7)
        {
            var b = new HeliosButton
            {
                Text = text,
                Variant = variant,
                Glyph = glyph,
                Height = 34,
                Width = 200,
                Margin = new Padding(0, topGap, 0, 0),
            };
            _fullWidth.Add(b);
            return b;
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            RelayoutWidths();
        }

        private void RelayoutWidths()
        {
            if (_flow == null) return;
            // Reserve the scrollbar width unconditionally so toggling it can't set
            // up a layout feedback loop (the classic FlowLayoutPanel pitfall).
            int w = ClientSize.Width - (Pad * 2) - SystemInformation.VerticalScrollBarWidth;
            if (w < 80) return;
            foreach (var c in _fullWidth) c.Width = w;
        }

        /// <summary>Point the panel at a (possibly new) active document and refresh.</summary>
        public void SetActiveDocument(string path)
        {
            _activePath = path;
            _statusCard.SetDocument(string.IsNullOrEmpty(path) ? null : Path.GetFileName(path));
            _ = RefreshStatus();
        }

        private async Task RefreshStatus(bool quiet = false)
        {
            var latest = SafeGetActivePath();
            if (latest != null) _activePath = latest;

            if (string.IsNullOrEmpty(_activePath))
            {
                _statusCard.SetDocument(null);
                _statusCard.SetStatus("Open a part, assembly, or drawing.", HeliosTheme.TextDim);
                _tracked = _checkedOut = _checkedOutByMe = false;
                ApplyActions("nodoc");
                if (!quiet && _treePanel != null) await _treePanel.RefreshActiveAsync();
                return;
            }

            await RefreshDocStatus(quiet);
            if (!quiet && _treePanel != null) await _treePanel.RefreshActiveAsync();
        }

        private async Task RefreshDocStatus(bool quiet = false)
        {
            _statusCard.SetDocument(Path.GetFileName(_activePath));
            if (!quiet) _statusCard.SetStatus("Checking…", HeliosTheme.TextDim);

            var res = await _bridge.StatusAsync(_activePath);
            if (res.Unreachable)
            {
                _statusCard.SetStatus("Helios isn't running — open the Helios app.", HeliosTheme.Red);
                _tracked = _checkedOut = _checkedOutByMe = false;
                ApplyActions("offline");
                return;
            }
            if (!res.Ok || res.Json == null)
            {
                _statusCard.SetStatus(res.Error ?? "Couldn't read vault status.", HeliosTheme.Red);
                ApplyActions("offline");
                return;
            }

            _tracked = GetBool(res.Json, "tracked");
            if (!_tracked)
            {
                _statusCard.SetStatus("Not in the vault — add it to start tracking.", HeliosTheme.TextDim);
                ApplyActions("untracked");
                return;
            }

            _checkedOut = GetBool(res.Json, "checkedOut");
            _checkedOutByMe = GetBool(res.Json, "checkedOutByMe");
            SyncReadOnlyToLock();

            var latestObj = GetObj(res.Json, "latest");
            var verNum = latestObj != null ? GetLong(latestObj, "versionNum") : null;
            var rev = latestObj != null ? GetLong(latestObj, "revision") : null;
            var verText = verNum.HasValue ? $"v{verNum.Value}" : "—";
            if (rev.HasValue) verText += $" · rev {rev.Value}";

            if (!_checkedOut)
            {
                _statusCard.SetStatus("Available to check out", HeliosTheme.Green, verText);
                ApplyActions("available");
            }
            else if (_checkedOutByMe)
            {
                _statusCard.SetStatus("Checked out by you", HeliosTheme.Gold, verText);
                ApplyActions("out-me");
            }
            else
            {
                _statusCard.SetStatus("Checked out by another member", HeliosTheme.Red, verText);
                ApplyActions("out-other");
            }
        }

        private async Task DoCheckOut()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            SetBusy("Checking out…");

            var res = await _bridge.CheckoutAsync(_activePath);
            if (res.Unreachable) _statusCard.SetStatus("Helios isn't running — open the Helios app.", HeliosTheme.Red);
            else if (!res.Ok) _statusCard.SetStatus(res.Error ?? "Check out failed.", HeliosTheme.Red);
            else InvokeOnUi(_makeActiveWritable);

            await RefreshStatus();
        }

        private async Task DoCheckIn()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            _saveActiveDoc?.Invoke(); // check-in reads from disk — save current edits first
            SetBusy("Checking in…");

            var res = await _bridge.CheckInAsync(_activePath, null);
            if (res.Unreachable) _statusCard.SetStatus("Helios isn't running — open the Helios app.", HeliosTheme.Red);
            else if (!res.Ok) _statusCard.SetStatus(res.Error ?? "Check in failed.", HeliosTheme.Red);
            else InvokeOnUi(_makeActiveReadonly);

            await RefreshStatus();
        }

        private async Task DoCancelCheckout()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            var choice = MessageBox.Show(
                "Cancel your check-out of this file?\n\nThis releases your lock without saving a new "
                    + "version. Any edits you made won't be added to the vault.",
                "Cancel Check-Out", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (choice != DialogResult.Yes) return;

            SetBusy("Cancelling check-out…");
            var res = await _bridge.CancelCheckoutAsync(_activePath);
            if (res.Unreachable) _statusCard.SetStatus("Helios isn't running — open the Helios app.", HeliosTheme.Red);
            else if (!res.Ok) _statusCard.SetStatus(res.Error ?? "Cancel check-out failed.", HeliosTheme.Red);
            else InvokeOnUi(_makeActiveReadonly);

            await RefreshStatus();
        }

        private async Task DoGetLatest()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            SetBusy("Getting latest…");

            var res = await _bridge.GetLatestAsync(_activePath);
            if (res.Unreachable) _statusCard.SetStatus("Helios isn't running — open the Helios app.", HeliosTheme.Red);
            else if (!res.Ok) _statusCard.SetStatus(res.Error ?? "Get latest failed.", HeliosTheme.Red);
            else _statusCard.SetStatus("Got the latest version.", HeliosTheme.Green);

            await RefreshStatus();
        }

        private async Task DoAddToVault()
        {
            if (string.IsNullOrEmpty(_activePath)) return;
            _saveActiveDoc?.Invoke(); // upload current edits
            SetBusy("Adding to vault…");

            var res = await _bridge.AddToVaultAsync(_activePath);
            if (res.Unreachable) _statusCard.SetStatus("Helios isn't running — open the Helios app.", HeliosTheme.Red);
            else if (!res.Ok) _statusCard.SetStatus(res.Error ?? "Add to vault failed.", HeliosTheme.Red);

            await RefreshStatus();
        }

        /// <summary>Run a SOLIDWORKS COM callback on the UI (SW) thread.</summary>
        private void InvokeOnUi(Action action)
        {
            if (action == null) return;
            try
            {
                if (IsHandleCreated && InvokeRequired) BeginInvoke(action);
                else action();
            }
            catch { /* control tearing down */ }
        }

        private string SafeGetActivePath()
        {
            try { return _getActivePath?.Invoke(); }
            catch { return null; }
        }

        /// <summary>Sync SOLIDWORKS's session read-only state to the lock when it
        /// changes EXTERNALLY (Helios app / force-unlock) while a doc stays open.</summary>
        private void SyncReadOnlyToLock()
        {
            if (!string.Equals(_syncedPath ?? "", _activePath ?? "", StringComparison.OrdinalIgnoreCase))
            {
                _syncedPath = _activePath;
                _syncedCheckedOutByMe = _checkedOutByMe;
                return;
            }
            if (_checkedOutByMe == _syncedCheckedOutByMe) return;
            _syncedCheckedOutByMe = _checkedOutByMe;
            InvokeOnUi(_checkedOutByMe ? _makeActiveWritable : _makeActiveReadonly);
        }

        /// <summary>Show only the actions that apply to the current state.</summary>
        private void ApplyActions(string mode)
        {
            bool available = mode == "available";
            bool outMe = mode == "out-me";
            bool untracked = mode == "untracked";

            Set(_addToVault, untracked);
            Set(_checkOut, available);
            Set(_checkIn, outMe);
            Set(_cancelCheckout, outMe);
            Set(_getLatest, available || outMe || mode == "out-other");
            Set(_refresh, true);
            RelayoutWidths();
        }

        private static void Set(HeliosButton b, bool show)
        {
            if (b == null) return;
            b.Visible = show;
            b.Enabled = show;
        }

        /// <summary>Disable the action row during an in-flight bridge op + show a
        /// progress message; RefreshStatus re-applies the real state after.</summary>
        private void SetBusy(string message)
        {
            _statusCard.SetStatus(message, HeliosTheme.TextDim);
            foreach (var b in new[] { _checkOut, _checkIn, _cancelCheckout, _getLatest, _addToVault, _refresh })
                if (b != null) b.Enabled = false;
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
