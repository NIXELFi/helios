using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace HeliosShell
{
    /// <summary>Small WinForms dialogs for the Explorer shell extension: a
    /// check-in comment prompt, an error box, and a revision-history window.
    /// Kept dependency-free so the shell DLL stays self-contained.</summary>
    internal static class HeliosUi
    {
        private static readonly Color Bg = Color.FromArgb(20, 20, 22);
        private static readonly Color Panel = Color.FromArgb(28, 29, 33);
        private static readonly Color Fg = Color.FromArgb(220, 224, 230);
        private static readonly Color Dim = Color.FromArgb(150, 156, 165);
        private static readonly Color Gold = Color.FromArgb(255, 198, 39);

        /// <summary>Sentinel returned by PromptComment when the user cancels (vs
        /// "" which means "check in with no comment").</summary>
        internal static readonly string Cancelled = "\0__helios_cancelled__";

        internal static void Error(string verb, string message) =>
            MessageBox.Show(message, "Helios — " + verb, MessageBoxButtons.OK, MessageBoxIcon.Warning);

        /// <summary>Prompt for a check-in comment. Returns the comment, "" to
        /// check in without one (Skip), or <see cref="Cancelled"/> on cancel.</summary>
        internal static string PromptComment(string fileName)
        {
            using (var form = new Form())
            {
                form.Text = "Check in " + fileName;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MinimizeBox = false;
                form.MaximizeBox = false;
                form.ClientSize = new Size(420, 180);
                form.BackColor = Bg;
                form.ForeColor = Fg;
                form.Font = new Font("Segoe UI", 9f);

                var label = new Label { Text = "Describe what changed (optional):", AutoSize = true, Left = 14, Top = 12, ForeColor = Dim };
                var box = new TextBox { Left = 14, Top = 36, Width = 392, Height = 80, Multiline = true, BackColor = Panel, ForeColor = Fg, BorderStyle = BorderStyle.FixedSingle };
                var submit = new Button { Text = "Check In", Left = 246, Top = 132, Width = 76, DialogResult = DialogResult.OK, BackColor = Color.FromArgb(34, 110, 52), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
                var skip = new Button { Text = "Skip", Left = 166, Top = 132, Width = 72, BackColor = Panel, ForeColor = Fg, FlatStyle = FlatStyle.Flat };
                var cancel = new Button { Text = "Cancel", Left = 330, Top = 132, Width = 76, DialogResult = DialogResult.Cancel, BackColor = Panel, ForeColor = Fg, FlatStyle = FlatStyle.Flat };

                string skipResult = null;
                skip.Click += (s, e) => { skipResult = ""; form.DialogResult = DialogResult.OK; };

                form.Controls.AddRange(new Control[] { label, box, submit, skip, cancel });
                form.AcceptButton = submit;
                form.CancelButton = cancel;

                var dr = form.ShowDialog();
                if (dr != DialogResult.OK) return Cancelled;
                return skipResult ?? box.Text;
            }
        }

        /// <summary>Fetch + show the file's version history from the bridge.</summary>
        internal static void ShowHistory(string path)
        {
            var res = Bridge.Versions(path);
            if (res.Unreachable) { Error("Revision History", "Helios isn't running."); return; }
            if (!res.Ok) { Error("Revision History", res.Error ?? "Couldn't load history."); return; }

            var rows = new List<Dictionary<string, object>>();
            if (res.Json != null && res.Json.TryGetValue("versions", out var raw) && raw is object[] arr)
                foreach (var o in arr) if (o is Dictionary<string, object> d) rows.Add(d);

            using (var form = new Form())
            {
                form.Text = "Revision History — " + System.IO.Path.GetFileName(path);
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ClientSize = new Size(660, 380);
                form.BackColor = Bg;
                form.ForeColor = Fg;
                form.Font = new Font("Segoe UI", 9f);

                var list = new ListView
                {
                    Dock = DockStyle.Fill,
                    View = View.Details,
                    FullRowSelect = true,
                    GridLines = false,
                    BackColor = Panel,
                    ForeColor = Fg,
                    BorderStyle = BorderStyle.None,
                };
                list.Columns.Add("Version", 70);
                list.Columns.Add("Rev", 55);
                list.Columns.Add("Date", 150);
                list.Columns.Add("Size", 90);
                list.Columns.Add("Comment", 280);

                foreach (var d in rows)
                {
                    var item = new ListViewItem("v" + GetStr(d, "version_num"));
                    item.SubItems.Add(GetStr(d, "revision") ?? "—");
                    item.SubItems.Add(FormatDate(GetStr(d, "created_at")));
                    item.SubItems.Add(FormatSize(GetStr(d, "size_bytes")));
                    item.SubItems.Add(GetStr(d, "comment") ?? "");
                    list.Items.Add(item);
                }
                if (rows.Count == 0)
                    list.Items.Add(new ListViewItem("No versions yet"));

                var header = new Label
                {
                    Dock = DockStyle.Top,
                    Height = 30,
                    Text = "  " + System.IO.Path.GetFileName(path) + "  ·  " + rows.Count + " version(s)",
                    TextAlign = ContentAlignment.MiddleLeft,
                    ForeColor = Gold,
                    BackColor = Bg,
                    Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                };
                form.Controls.Add(list);
                form.Controls.Add(header);
                form.ShowDialog();
            }
        }

        private static string GetStr(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v) && v != null) ? Convert.ToString(v) : null;

        private static string FormatDate(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return "";
            return DateTime.TryParse(iso, out var dt) ? dt.ToLocalTime().ToString("yyyy-MM-dd HH:mm") : iso;
        }

        private static string FormatSize(string bytes)
        {
            if (!long.TryParse(bytes, out var b)) return "";
            string[] units = { "B", "KB", "MB", "GB" };
            double n = b; int u = 0;
            while (n >= 1024 && u < units.Length - 1) { n /= 1024; u++; }
            return $"{n:0.#} {units[u]}";
        }
    }
}
