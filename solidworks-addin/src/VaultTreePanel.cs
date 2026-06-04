using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
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
    /// node via a right-click menu — all through the bridge, so it stays in
    /// lockstep with Explorer + the desktop app.
    ///
    /// Visuals: a styled header strip + a TreeView with crisp status-icon glyphs
    /// (folder / document with a green/gold/red status dot). The "Vault" branch
    /// lazy-loads the full hierarchy from GET /files (expand-on-demand, so a 13k
    /// file vault stays responsive); the "Open in SOLIDWORKS" branch lists the
    /// active document + its top-level components.
    /// </summary>
    internal sealed class VaultTreePanel : Panel
    {
        private readonly HeliosBridge _bridge;
        private readonly Func<string[]> _getComponents;
        private readonly Func<string> _getActivePath;

        private readonly TreeView _tree;
        private readonly ImageList _icons;
        private TreeNode _vaultRootNode;
        private TreeNode _asmRootNode;

        private sealed class Node
        {
            public string Name;
            public string Path;       // local path for file leaves; null for folders
            public bool IsFile;
            public bool Tracked = true;
            public bool CheckedOut;
            public bool CheckedOutByMe;
            public readonly SortedDictionary<string, Node> Children =
                new SortedDictionary<string, Node>(StringComparer.OrdinalIgnoreCase);
        }

        private Node _model;
        private bool _vaultLoading;

        public VaultTreePanel(HeliosBridge bridge, Func<string[]> getComponents, Func<string> getActivePath)
        {
            _bridge = bridge;
            _getComponents = getComponents;
            _getActivePath = getActivePath;

            BackColor = HeliosTheme.Surface;

            _icons = BuildIcons();

            _tree = new TreeView
            {
                Dock = DockStyle.Fill,
                BackColor = HeliosTheme.Surface,
                ForeColor = HeliosTheme.Text,
                BorderStyle = BorderStyle.None,
                Font = HeliosTheme.TreeFont,
                ItemHeight = 23,
                Indent = 17,
                ShowLines = false,
                ShowRootLines = true,
                ShowPlusMinus = true,
                FullRowSelect = true,
                HideSelection = false,
                ImageList = _icons,
            };
            _tree.BeforeExpand += OnBeforeExpand;
            _tree.AfterExpand += (s, e) => UpdateFolderIcon(e.Node, true);
            _tree.AfterCollapse += (s, e) => UpdateFolderIcon(e.Node, false);
            _tree.NodeMouseClick += OnNodeMouseClick;

            var header = new TreeHeader();
            header.RefreshClicked += async (s, e) => { InvalidateVault(); await RefreshActiveAsync(); };

            Controls.Add(_tree);     // fill
            Controls.Add(header);    // docks top over the fill

            _vaultRootNode = new TreeNode("Vault") { ImageKey = "vault", SelectedImageKey = "vault", ForeColor = HeliosTheme.Gold };
            _vaultRootNode.Nodes.Add(new TreeNode("Loading…") { ImageKey = "blank", ForeColor = HeliosTheme.TextFaint });
            _asmRootNode = new TreeNode("Open in SOLIDWORKS") { ImageKey = "asm", SelectedImageKey = "asm", ForeColor = HeliosTheme.Gold };
            _tree.Nodes.Add(_asmRootNode);
            _tree.Nodes.Add(_vaultRootNode);
        }

        protected override void Dispose(bool disposing)
        {
            // The ImageList owns its 9 status bitmaps; release their GDI handles
            // when the pane tears down (it isn't auto-disposed with the control).
            if (disposing) _icons?.Dispose();
            base.Dispose(disposing);
        }

        // --- status icon set (folder / document + green/gold/red dot) ----------
        private static ImageList BuildIcons()
        {
            var list = new ImageList { ImageSize = new Size(16, 16), ColorDepth = ColorDepth.Depth32Bit };
            list.Images.Add("vault", Icon(HeliosTheme.GlyphFolder, HeliosTheme.Gold, null));
            list.Images.Add("asm", Icon(HeliosTheme.GlyphPart, HeliosTheme.Gold, null));
            list.Images.Add("folder", Icon(HeliosTheme.GlyphFolder, HeliosTheme.GoldLo, null));
            list.Images.Add("folder-open", Icon(HeliosTheme.GlyphFolderOpen, HeliosTheme.Gold, null));
            list.Images.Add("available", Icon(HeliosTheme.GlyphPart, HeliosTheme.TextDim, HeliosTheme.Green));
            list.Images.Add("out-me", Icon(HeliosTheme.GlyphPart, HeliosTheme.Text, HeliosTheme.Gold));
            list.Images.Add("out-other", Icon(HeliosTheme.GlyphPart, HeliosTheme.TextDim, HeliosTheme.Red));
            list.Images.Add("untracked", Icon(HeliosTheme.GlyphPart, HeliosTheme.TextFaint, null));
            list.Images.Add("blank", new Bitmap(16, 16, PixelFormat.Format32bppArgb));
            return list;
        }

        private static Bitmap Icon(string glyph, Color glyphColor, Color? dot)
        {
            var bmp = new Bitmap(16, 16, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(glyphColor))
                using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    g.DrawString(glyph, HeliosTheme.Glyph, b, new RectangleF(-1, 0, 17, 16), sf);
                if (dot.HasValue)
                {
                    using (var ring = new SolidBrush(HeliosTheme.Surface))
                        g.FillEllipse(ring, 8.2f, 8.2f, 7.6f, 7.6f);
                    using (var db = new SolidBrush(dot.Value))
                        g.FillEllipse(db, 9.3f, 9.3f, 5.4f, 5.4f);
                }
            }
            return bmp;
        }

        private void UpdateFolderIcon(TreeNode node, bool open)
        {
            if (node.Tag is Node n && !n.IsFile)
            {
                node.ImageKey = open ? "folder-open" : "folder";
                node.SelectedImageKey = node.ImageKey;
            }
        }

        // --- public API used by the pane --------------------------------------
        public async Task RefreshActiveAsync()
        {
            try { await RefreshAsmBranch(); } catch { }
        }

        public void InvalidateVault()
        {
            _model = null;
            _vaultLoading = false;
            _vaultRootNode.Nodes.Clear();
            _vaultRootNode.Nodes.Add(new TreeNode("Loading…") { ImageKey = "blank", ForeColor = HeliosTheme.TextFaint });
            if (_vaultRootNode.IsExpanded) _vaultRootNode.Collapse();
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

            _tree.BeginUpdate();
            try
            {
                _asmRootNode.Nodes.Clear();
                if (paths.Count == 0)
                {
                    _asmRootNode.Text = "Open in SOLIDWORKS";
                    _asmRootNode.Nodes.Add(new TreeNode("No document open") { ImageKey = "blank", ForeColor = HeliosTheme.TextFaint });
                    return;
                }

                var res = await _bridge.StatusBatchAsync(paths);
                var byPath = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
                if (res.Ok && res.Json != null && res.Json.TryGetValue("items", out var raw) && raw is object[] items)
                    foreach (var it in items)
                        if (it is Dictionary<string, object> d && GetStr(d, "path") is string p)
                            byPath[p] = d;

                _asmRootNode.Text = $"Open in SOLIDWORKS  ({paths.Count})";
                foreach (var p in paths)
                {
                    byPath.TryGetValue(p, out var d);
                    _asmRootNode.Nodes.Add(MakeFileNode(
                        System.IO.Path.GetFileName(p), p,
                        tracked: d != null && GetBool(d, "tracked"),
                        outAny: d != null && GetBool(d, "checkedOut"),
                        outMe: d != null && GetBool(d, "checkedOutByMe")));
                }
                _asmRootNode.Expand();
            }
            finally { _tree.EndUpdate(); }
        }

        // --- vault branch (lazy) ----------------------------------------------
        private async void OnBeforeExpand(object sender, TreeViewCancelEventArgs e)
        {
            try
            {
                if (e.Node == _vaultRootNode && _model == null && !_vaultLoading)
                {
                    _vaultLoading = true;
                    await LoadVaultModel();
                    if (_model != null) PopulateChildren(_vaultRootNode, _model);
                }
                else if (e.Node.Tag is Node n && !n.IsFile && IsPlaceholder(e.Node))
                {
                    PopulateChildren(e.Node, n);
                }
            }
            catch { }
        }

        private async Task LoadVaultModel()
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
                    next.Tracked = true;
                    next.CheckedOut = outAny;
                    next.CheckedOutByMe = outMe;
                }
                cur = next;
            }
        }

        private void PopulateChildren(TreeNode treeNode, Node model)
        {
            _tree.BeginUpdate();
            try
            {
                treeNode.Nodes.Clear();
                foreach (var kv in model.Children)
                {
                    var child = kv.Value;
                    TreeNode tn;
                    if (child.IsFile)
                    {
                        tn = MakeFileNode(child.Name, child.Path, child.Tracked, child.CheckedOut, child.CheckedOutByMe);
                    }
                    else
                    {
                        tn = new TreeNode(child.Name) { Tag = child, ImageKey = "folder", SelectedImageKey = "folder", ForeColor = HeliosTheme.Text };
                        if (child.Children.Count > 0) tn.Nodes.Add(new TreeNode("…") { ImageKey = "blank", ForeColor = HeliosTheme.TextFaint });
                    }
                    treeNode.Nodes.Add(tn);
                }
                if (model.Children.Count == 0)
                    treeNode.Nodes.Add(new TreeNode("(empty)") { ImageKey = "blank", ForeColor = HeliosTheme.TextFaint });
            }
            finally { _tree.EndUpdate(); }
        }

        private TreeNode MakeFileNode(string name, string path, bool tracked, bool outAny, bool outMe)
        {
            string key; Color color;
            if (!tracked) { key = "untracked"; color = HeliosTheme.TextFaint; }
            else if (!outAny) { key = "available"; color = HeliosTheme.Text; }
            else if (outMe) { key = "out-me"; color = HeliosTheme.Gold; }
            else { key = "out-other"; color = HeliosTheme.Red; }
            return new TreeNode(name)
            {
                ImageKey = key,
                SelectedImageKey = key,
                ForeColor = color,
                Tag = new Node { Name = name, Path = path, IsFile = true, Tracked = tracked, CheckedOut = outAny, CheckedOutByMe = outMe },
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

            var menu = new ContextMenuStrip { Renderer = new DarkMenuRenderer() };
            menu.Items.Add(Verb("Check Out", !n.CheckedOut, () => Do("Check out", n, () => _bridge.CheckoutAsync(n.Path))));
            menu.Items.Add(Verb("Check In", n.CheckedOutByMe, () => Do("Check in", n, () => _bridge.CheckInAsync(n.Path, null))));
            menu.Items.Add(Verb("Cancel Check-Out", n.CheckedOutByMe, () => Do("Cancel check-out", n, () => _bridge.CancelCheckoutAsync(n.Path))));
            menu.Items.Add(new ToolStripSeparator());
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
            try
            {
                HeliosBridge.BridgeResult r;
                try { r = await action(); }
                catch (Exception ex) { r = new HeliosBridge.BridgeResult { Error = ex.Message }; }

                if (r.Unreachable)
                    MessageBox.Show("Helios isn't running — open the Helios app.", "Helios — " + verb, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                else if (!r.Ok)
                    MessageBox.Show(r.Error ?? (verb + " failed."), "Helios — " + verb, MessageBoxButtons.OK, MessageBoxIcon.Warning);

                InvalidateVault();
                await RefreshActiveAsync();
            }
            catch { }
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
            return path;
        }

        private static bool GetBool(Dictionary<string, object> d, string k) =>
            d != null && d.TryGetValue(k, out var v) && v is bool b && b;

        private static string GetStr(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v) && v != null) ? Convert.ToString(v) : null;

        /// <summary>The styled strip above the tree: a tracked caption + a refresh
        /// glyph button.</summary>
        private sealed class TreeHeader : Control
        {
            public event EventHandler RefreshClicked;
            private bool _hover;
            private Rectangle _btn;

            public TreeHeader()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                         | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
                DoubleBuffered = true;
                Dock = DockStyle.Top;
                Height = 30;
                Cursor = Cursors.Default;
            }

            protected override void OnMouseMove(MouseEventArgs e)
            {
                bool h = _btn.Contains(e.Location);
                if (h != _hover) { _hover = h; Cursor = h ? Cursors.Hand : Cursors.Default; Invalidate(); }
                base.OnMouseMove(e);
            }
            protected override void OnMouseLeave(EventArgs e) { if (_hover) { _hover = false; Invalidate(); } base.OnMouseLeave(e); }
            protected override void OnMouseClick(MouseEventArgs e)
            {
                if (_btn.Contains(e.Location)) RefreshClicked?.Invoke(this, EventArgs.Empty);
                base.OnMouseClick(e);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                var g = e.Graphics;
                try
                {
                    using (var b = new SolidBrush(HeliosTheme.SurfaceHi)) g.FillRectangle(b, ClientRectangle);
                    using (var p = new Pen(HeliosTheme.Line, 1f)) g.DrawLine(p, 0, Height - 1, Width, Height - 1);
                    HeliosTheme.TrackedText(g, "VAULT & ASSEMBLY", HeliosTheme.Caption, HeliosTheme.TextDim, 12, 9, 0.9f);

                    _btn = new Rectangle(Width - 28, 4, 22, 22);
                    if (_hover) HeliosTheme.FillRound(g, _btn, 5, HeliosTheme.Surface);
                    HeliosTheme.DrawGlyph(g, HeliosTheme.GlyphRefresh, HeliosTheme.GlyphSmall,
                        _hover ? HeliosTheme.Gold : HeliosTheme.TextDim, _btn);
                }
                catch
                {
                    using (var b = new SolidBrush(HeliosTheme.SurfaceHi)) g.FillRectangle(b, ClientRectangle);
                }
            }
        }

        /// <summary>Dark renderer so the right-click menu matches the pane.</summary>
        private sealed class DarkMenuRenderer : ToolStripProfessionalRenderer
        {
            public DarkMenuRenderer() : base(new DarkColors()) { RoundedEdges = false; }
            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
            {
                e.TextColor = e.Item.Enabled ? HeliosTheme.Text : HeliosTheme.TextFaint;
                base.OnRenderItemText(e);
            }
            private sealed class DarkColors : ProfessionalColorTable
            {
                public override Color ToolStripDropDownBackground => HeliosTheme.Surface;
                public override Color MenuBorder => HeliosTheme.Line;
                public override Color MenuItemBorder => HeliosTheme.Gold;
                public override Color MenuItemSelected => Color.FromArgb(40, HeliosTheme.Gold);
                public override Color MenuItemSelectedGradientBegin => Color.FromArgb(40, HeliosTheme.Gold);
                public override Color MenuItemSelectedGradientEnd => Color.FromArgb(40, HeliosTheme.Gold);
                public override Color ImageMarginGradientBegin => HeliosTheme.Surface;
                public override Color ImageMarginGradientMiddle => HeliosTheme.Surface;
                public override Color ImageMarginGradientEnd => HeliosTheme.Surface;
                public override Color SeparatorDark => HeliosTheme.Line;
            }
        }
    }
}
