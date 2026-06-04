using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace HeliosVault
{
    /// <summary>
    /// An interactive vault tree for the Helios pane: browse vault folders + the
    /// open assembly's components, and check files in/out/get-latest from any
    /// node via a right-click menu — all through the same bridge as the rest of
    /// the add-in, so it stays in lockstep with Explorer + the desktop app.
    ///
    /// The "Vault" branch lazy-loads the full folder hierarchy from GET /files
    /// (expand-on-demand, so a 13k-file vault stays responsive). The "Open
    /// Assembly" branch lists the active document + its top-level components.
    /// </summary>
    internal sealed class VaultTreePanel : Panel
    {
        private static readonly Color Bg = Color.FromArgb(14, 14, 16);
        private static readonly Color Card = Color.FromArgb(22, 23, 27);
        private static readonly Color Fg = Color.FromArgb(216, 220, 226);
        private static readonly Color Dim = Color.FromArgb(144, 151, 160);
        private static readonly Color Gold = Color.FromArgb(255, 198, 39);
        private static readonly Color Green = Color.FromArgb(122, 201, 130);
        private static readonly Color Red = Color.FromArgb(229, 115, 115);

        private readonly HeliosBridge _bridge;
        private readonly Func<string[]> _getComponents;
        private readonly Func<string> _getActivePath;

        private readonly TreeView _tree;
        private TreeNode _vaultRootNode;
        private TreeNode _asmRootNode;

        // In-memory folder model built once from /files; the TreeView is filled
        // lazily from it as the user expands folders.
        private sealed class Node
        {
            public string Name;
            public string Path;       // local path for file leaves; null for folders
            public bool IsFile;
            public bool CheckedOut;
            public bool CheckedOutByMe;
            public readonly SortedDictionary<string, Node> Children =
                new SortedDictionary<string, Node>(StringComparer.OrdinalIgnoreCase);
        }

        private Node _model;          // synthetic root over the vault tree
        private bool _vaultLoading;

        public VaultTreePanel(HeliosBridge bridge, Func<string[]> getComponents, Func<string> getActivePath)
        {
            _bridge = bridge;
            _getComponents = getComponents;
            _getActivePath = getActivePath;

            BackColor = Bg;
            Padding = new Padding(0);

            _tree = new TreeView
            {
                Dock = DockStyle.Fill,
                BackColor = Card,
                ForeColor = Fg,
                BorderStyle = BorderStyle.None,
                HideSelection = false,
                ShowLines = true,
                ShowPlusMinus = true,
                ShowRootLines = true,
                ItemHeight = 20,
                Font = new Font("Segoe UI", 8.75f),
            };
            _tree.BeforeExpand += OnBeforeExpand;
            _tree.NodeMouseClick += OnNodeMouseClick;
            Controls.Add(_tree);

            _vaultRootNode = new TreeNode("Vault") { ForeColor = Gold };
            _vaultRootNode.Nodes.Add(new TreeNode("Loading…") { ForeColor = Dim }); // lazy placeholder
            _asmRootNode = new TreeNode("Open in SOLIDWORKS") { ForeColor = Gold };
            _tree.Nodes.Add(_asmRootNode);
            _tree.Nodes.Add(_vaultRootNode);
        }

        // --- public API used by the pane --------------------------------------

        /// <summary>Refresh the "Open in SOLIDWORKS" branch from the active doc +
        /// its components. Cheap; called on doc change / manual refresh.</summary>
        public async Task RefreshActiveAsync()
        {
            try { await RefreshAsmBranch(); } catch { /* best-effort */ }
        }

        /// <summary>Force a reload of the lazy vault branch on next expand.</summary>
        public void InvalidateVault()
        {
            _model = null;
            _vaultRootNode.Nodes.Clear();
            _vaultRootNode.Nodes.Add(new TreeNode("Loading…") { ForeColor = Dim });
            if (_vaultRootNode.IsExpanded) { _vaultRootNode.Collapse(); }
        }

        // --- assembly branch ---------------------------------------------------

        private async Task RefreshAsmBranch()
        {
            string active = SafeActive();
            string[] comps;
            try { comps = _getComponents?.Invoke() ?? new string[0]; } catch { comps = new string[0]; }

            var paths = new List<string>();
            if (!string.IsNullOrEmpty(active)) paths.Add(active);
            foreach (var c in comps) if (!paths.Contains(c, StringComparer.OrdinalIgnoreCase)) paths.Add(c);

            _asmRootNode.Nodes.Clear();
            if (paths.Count == 0)
            {
                _asmRootNode.Text = "Open in SOLIDWORKS";
                _asmRootNode.Nodes.Add(new TreeNode("(no document open)") { ForeColor = Dim });
                return;
            }

            var res = await _bridge.StatusBatchAsync(paths);
            var byPath = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            if (res.Ok && res.Json != null && res.Json.TryGetValue("items", out var raw) && raw is object[] items)
                foreach (var it in items)
                    if (it is Dictionary<string, object> d && GetStr(d, "path") is string p)
                        byPath[p] = d;

            _asmRootNode.Text = $"Open in SOLIDWORKS ({paths.Count})";
            foreach (var p in paths)
            {
                byPath.TryGetValue(p, out var d);
                _asmRootNode.Nodes.Add(MakeFileNode(
                    Path.GetFileName(p), p,
                    tracked: d != null && GetBool(d, "tracked"),
                    outAny: d != null && GetBool(d, "checkedOut"),
                    outMe: d != null && GetBool(d, "checkedOutByMe")));
            }
            _asmRootNode.Expand();
        }

        // --- vault branch (lazy) ----------------------------------------------

        private async void OnBeforeExpand(object sender, TreeViewCancelEventArgs e)
        {
            // async void event handler → swallow everything so a bridge/parse
            // error can never crash SOLIDWORKS's UI thread.
            try
            {
                if (e.Node == _vaultRootNode && _model == null && !_vaultLoading)
                {
                    _vaultLoading = true; // set BEFORE the await, to bar a re-entrant double-load
                    await LoadVaultModel();
                    if (_model != null) PopulateChildren(_vaultRootNode, _model);
                }
                else if (e.Node.Tag is Node n && !n.IsFile && IsPlaceholder(e.Node))
                {
                    PopulateChildren(e.Node, n);
                }
            }
            catch { /* best-effort tree fill */ }
        }

        private async Task LoadVaultModel()
        {
            _vaultLoading = true;
            try
            {
                var res = await _bridge.FilesAsync();
                var root = new Node { Name = "Vault" };
                if (res.Ok && res.Json != null)
                {
                    var vaultRoot = NormSlashes(GetStr(res.Json, "vaultRoot") ?? "");
                    if (res.Json.TryGetValue("files", out var raw) && raw is object[] files)
                    {
                        foreach (var o in files)
                        {
                            if (!(o is Dictionary<string, object> d)) continue;
                            var path = GetStr(d, "path");
                            if (string.IsNullOrEmpty(path)) continue;
                            var rel = RelativeUnder(NormSlashes(path), vaultRoot);
                            Insert(root, rel.Split('/'), path, GetBool(d, "checkedOut"), GetBool(d, "checkedOutByMe"));
                        }
                    }
                }
                _model = root;
            }
            finally { _vaultLoading = false; }
        }

        private static void Insert(Node parent, string[] segs, string fullPath, bool outAny, bool outMe)
        {
            var cur = parent;
            for (int i = 0; i < segs.Length; i++)
            {
                var seg = segs[i];
                if (string.IsNullOrEmpty(seg)) continue;
                bool last = i == segs.Length - 1;
                if (!cur.Children.TryGetValue(seg, out var next))
                {
                    next = new Node { Name = seg };
                    cur.Children[seg] = next;
                }
                if (last)
                {
                    next.IsFile = true;
                    next.Path = fullPath;
                    next.CheckedOut = outAny;
                    next.CheckedOutByMe = outMe;
                }
                cur = next;
            }
        }

        private void PopulateChildren(TreeNode treeNode, Node model)
        {
            treeNode.Nodes.Clear();
            foreach (var kv in model.Children)
            {
                var child = kv.Value;
                TreeNode tn;
                if (child.IsFile)
                {
                    tn = MakeFileNode(child.Name, child.Path, tracked: true, outAny: child.CheckedOut, outMe: child.CheckedOutByMe);
                }
                else
                {
                    tn = new TreeNode("\U0001F4C1 " + child.Name) { ForeColor = Fg, Tag = child };
                    if (child.Children.Count > 0) tn.Nodes.Add(new TreeNode("…") { ForeColor = Dim }); // lazy
                }
                treeNode.Nodes.Add(tn);
            }
            if (model.Children.Count == 0)
                treeNode.Nodes.Add(new TreeNode("(empty)") { ForeColor = Dim });
        }

        private TreeNode MakeFileNode(string name, string path, bool tracked, bool outAny, bool outMe)
        {
            string mark; Color color;
            if (!tracked) { mark = "○"; color = Dim; }
            else if (!outAny) { mark = "●"; color = Green; }
            else if (outMe) { mark = "●"; color = Gold; }
            else { mark = "●"; color = Red; }
            return new TreeNode($"{mark} {name}")
            {
                ForeColor = color,
                Tag = new Node { Name = name, Path = path, IsFile = true, CheckedOut = outAny, CheckedOutByMe = outMe },
            };
        }

        private static bool IsPlaceholder(TreeNode n) =>
            n.Nodes.Count == 1 && (n.Nodes[0].Text == "…" || n.Nodes[0].Text == "Loading…");

        // --- right-click verbs -------------------------------------------------

        private void OnNodeMouseClick(object sender, TreeNodeMouseClickEventArgs e)
        {
            if (e.Button != MouseButtons.Right) return;
            if (!(e.Node.Tag is Node n) || !n.IsFile || string.IsNullOrEmpty(n.Path)) return;
            _tree.SelectedNode = e.Node;

            var menu = new ContextMenuStrip();
            menu.Items.Add(Verb("Check Out", !n.CheckedOut, () => Do("Check out", n, () => _bridge.CheckoutAsync(n.Path))));
            menu.Items.Add(Verb("Check In", n.CheckedOutByMe, () => Do("Check in", n, () => _bridge.CheckInAsync(n.Path, null))));
            menu.Items.Add(Verb("Cancel Check-Out", n.CheckedOutByMe, () => Do("Cancel check-out", n, () => _bridge.CancelCheckoutAsync(n.Path))));
            menu.Items.Add(Verb("Get Latest", true, () => Do("Get latest", n, () => _bridge.GetLatestAsync(n.Path))));
            menu.Show(_tree, e.Location);
        }

        private static ToolStripMenuItem Verb(string text, bool enabled, Action onClick)
        {
            var i = new ToolStripMenuItem(text) { Enabled = enabled };
            if (enabled) i.Click += (s, e) => onClick();
            return i;
        }

        private async void Do(string verb, Node n, Func<Task<HeliosBridge.BridgeResult>> action)
        {
            // async void → fully guarded; an unobserved throw here would tear
            // down SOLIDWORKS's UI thread.
            try
            {
                HeliosBridge.BridgeResult r;
                try { r = await action(); }
                catch (Exception ex) { r = new HeliosBridge.BridgeResult { Error = ex.Message }; }

                if (r.Unreachable)
                    MessageBox.Show("Helios isn't running — open the Helios app.", "Helios — " + verb, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                else if (!r.Ok)
                    MessageBox.Show(r.Error ?? (verb + " failed."), "Helios — " + verb, MessageBoxButtons.OK, MessageBoxIcon.Warning);

                // Refresh both branches so the node's status reflects the change.
                InvalidateVault();
                await RefreshActiveAsync();
            }
            catch { /* best-effort */ }
        }

        // --- helpers -----------------------------------------------------------

        private string SafeActive()
        {
            try { return _getActivePath?.Invoke(); } catch { return null; }
        }

        private static string NormSlashes(string p) => (p ?? "").Replace('\\', '/').TrimEnd('/');

        private static string RelativeUnder(string path, string root)
        {
            if (!string.IsNullOrEmpty(root) && path.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase))
                return path.Substring(root.Length + 1);
            return path; // not under root (shouldn't happen) — show full
        }

        private static bool GetBool(Dictionary<string, object> d, string k) =>
            d != null && d.TryGetValue(k, out var v) && v is bool b && b;

        private static string GetStr(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v) && v != null) ? Convert.ToString(v) : null;
    }
}
