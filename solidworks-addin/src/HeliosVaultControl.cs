using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace HeliosVault
{
    /// <summary>
    /// The contents of the "Helios Vault" Task Pane. Phase 1: shows the active
    /// document + placeholder Check Out / Check In / Get Latest buttons. The
    /// buttons get wired to the Helios desktop app's localhost bridge in
    /// Phase 3; for now they explain what's coming so the panel is testable.
    ///
    /// Built in code (no .Designer.cs) to keep the skeleton self-contained.
    /// </summary>
    public class HeliosVaultControl : UserControl
    {
        private static readonly Color Bg = Color.FromArgb(14, 14, 16);
        private static readonly Color Fg = Color.FromArgb(216, 220, 226);
        private static readonly Color Dim = Color.FromArgb(144, 151, 160);
        private static readonly Color Gold = Color.FromArgb(255, 198, 39);

        private Label _docLabel;

        public HeliosVaultControl()
        {
            BuildUi();
        }

        private void BuildUi()
        {
            BackColor = Bg;
            ForeColor = Fg;
            Font = new Font("Segoe UI", 9f);
            Padding = new Padding(12);

            var title = new Label
            {
                Text = "HELIOS VAULT",
                ForeColor = Gold,
                Font = new Font("Segoe UI", 14f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(12, 12),
            };

            var subtitle = new Label
            {
                Text = "Sun Devil Motorsports · Ground Station",
                ForeColor = Dim,
                AutoSize = true,
                Location = new Point(12, 40),
            };

            var docCaption = new Label
            {
                Text = "ACTIVE DOCUMENT",
                ForeColor = Dim,
                Font = new Font("Segoe UI", 7.5f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(12, 74),
            };

            _docLabel = new Label
            {
                Text = "No document open",
                AutoSize = true,
                MaximumSize = new Size(260, 0),
                Location = new Point(12, 92),
            };

            var checkOut = MakeButton("Check Out", 128);
            var checkIn = MakeButton("Check In", 162);
            var getLatest = MakeButton("Get Latest", 196);

            // Phase 1 placeholders — Phase 3 wires these to the Helios bridge.
            checkOut.Click += (s, e) => Soon("Check Out");
            checkIn.Click += (s, e) => Soon("Check In");
            getLatest.Click += (s, e) => Soon("Get Latest");

            Controls.AddRange(new Control[] { title, subtitle, docCaption, _docLabel, checkOut, checkIn, getLatest });
        }

        private Button MakeButton(string text, int top)
        {
            return new Button
            {
                Text = text,
                Location = new Point(12, top),
                Width = 150,
                Height = 28,
                FlatStyle = FlatStyle.Flat,
                ForeColor = Fg,
                BackColor = Color.FromArgb(22, 23, 27),
            };
        }

        private static void Soon(string action)
        {
            MessageBox.Show(
                action + " will talk to the running Helios app (bridge) — coming in Phase 3.",
                "Helios Vault",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        /// <summary>Reflect the SOLIDWORKS active document (called by the add-in).</summary>
        public void SetActiveDocument(string path)
        {
            if (_docLabel == null) return;
            _docLabel.Text = string.IsNullOrEmpty(path)
                ? "No document open"
                : Path.GetFileName(path);
        }
    }
}
