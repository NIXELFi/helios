using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace HeliosVault
{
    internal enum HeliosButtonVariant { Primary, Secondary, Ghost, Danger }

    /// <summary>Custom-painted button: rounded, anti-aliased, with hover/press
    /// states, an optional Segoe MDL2 glyph, and per-variant colors.</summary>
    internal sealed class HeliosButton : Control
    {
        public HeliosButtonVariant Variant { get; set; } = HeliosButtonVariant.Secondary;
        public string Glyph { get; set; }

        private bool _hover, _down;

        public HeliosButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            DoubleBuffered = true;
            Height = 34;
            Cursor = Cursors.Hand;
            Font = HeliosTheme.BodyStrong;
            BackColor = HeliosTheme.Base0;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { _down = true; Invalidate(); } base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { _hover = _down = false; Invalidate(); base.OnEnabledChanged(e); }

        private void Colors(out Color fill, out Color border, out Color fg)
        {
            if (!Enabled)
            {
                fill = Variant == HeliosButtonVariant.Ghost ? Color.Transparent : Color.FromArgb(0x1A, 0x1B, 0x20);
                border = Color.FromArgb(0x24, 0x26, 0x2C);
                fg = Color.FromArgb(0x56, 0x5B, 0x66);
                return;
            }
            switch (Variant)
            {
                case HeliosButtonVariant.Primary:
                    fill = _down ? HeliosTheme.GoldLo : _hover ? HeliosTheme.GoldHi : HeliosTheme.Gold;
                    border = Color.Transparent;
                    fg = HeliosTheme.GoldInk;
                    break;
                case HeliosButtonVariant.Ghost:
                    fill = _down ? HeliosTheme.Surface : _hover ? Color.FromArgb(0x18, 0x1A, 0x20) : Color.Transparent;
                    border = _hover ? HeliosTheme.Line : Color.FromArgb(0x22, 0x24, 0x2B);
                    fg = _hover ? HeliosTheme.Text : HeliosTheme.TextDim;
                    break;
                case HeliosButtonVariant.Danger:
                    fill = _down ? Color.FromArgb(0x2A, 0x16, 0x16) : _hover ? Color.FromArgb(0x23, 0x16, 0x18) : HeliosTheme.Surface;
                    border = _hover ? Color.FromArgb(0x7A, 0x32, 0x30) : HeliosTheme.Line;
                    fg = _hover ? Color.FromArgb(0xF0, 0x8A, 0x84) : HeliosTheme.Text;
                    break;
                default: // Secondary
                    fill = _down ? Color.FromArgb(0x14, 0x16, 0x1B) : _hover ? HeliosTheme.SurfaceHi : HeliosTheme.Surface;
                    border = _hover ? HeliosTheme.LineHi : HeliosTheme.Line;
                    fg = HeliosTheme.Text;
                    break;
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            try
            {
                using (var bg = new SolidBrush(BackColor)) g.FillRectangle(bg, ClientRectangle);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Colors(out var fill, out var border, out var fg);
                var r = new Rectangle(0, 0, Width - 1, Height - 1);
                using (var path = HeliosTheme.RoundRect(r, 7))
                {
                    if (fill.A > 0) { using (var b = new SolidBrush(fill)) g.FillPath(b, path); }
                    if (border.A > 0) { using (var p = new Pen(border, 1f)) g.DrawPath(p, path); }
                }

                bool hasGlyph = !string.IsNullOrEmpty(Glyph);
                var textSz = TextRenderer.MeasureText(g, Text ?? "", Font, Size,
                    TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
                float glyphW = hasGlyph ? 18f : 0f;
                float gap = hasGlyph ? 7f : 0f;
                float total = glyphW + gap + textSz.Width;
                float x = (Width - total) / 2f;
                int cy = Height / 2;

                if (hasGlyph)
                {
                    HeliosTheme.DrawGlyph(g, Glyph, HeliosTheme.Glyph, fg,
                        new Rectangle((int)x, cy - 9, 18, 18));
                    x += glyphW + gap;
                }
                TextRenderer.DrawText(g, Text ?? "", Font,
                    new Rectangle((int)x, 0, textSz.Width + 2, Height), fg,
                    TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            }
            catch
            {
                using (var b = new SolidBrush(HeliosTheme.Surface)) g.FillRectangle(b, ClientRectangle);
            }
        }
    }

    /// <summary>Branded header: graphite gradient, the HELIOS VAULT wordmark with
    /// a gold diamond mark, a tracked subtitle, a live connection LED + identity,
    /// and a gold hairline rule with a maroon accent tick.</summary>
    internal sealed class HeliosHeaderPanel : Control
    {
        private int _connState; // 0 offline, 1 connected-no-session, 2 connected
        private string _connName = "Connecting…";

        public HeliosHeaderPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            DoubleBuffered = true;
            Height = 96;
        }

        public void SetConnection(int state, string name)
        {
            _connState = state;
            _connName = name ?? "";
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            try
            {
                var rect = ClientRectangle;
                HeliosTheme.VGradient(g, rect, HeliosTheme.Base1, HeliosTheme.Base0);
                g.SmoothingMode = SmoothingMode.AntiAlias;

                // Gold diamond mark.
                int top = 18, mx = 18, ms = 16;
                using (var b = new SolidBrush(HeliosTheme.Gold))
                {
                    var diamond = new[]
                    {
                        new PointF(mx + ms / 2f, top),
                        new PointF(mx + ms, top + ms / 2f),
                        new PointF(mx + ms / 2f, top + ms),
                        new PointF(mx, top + ms / 2f),
                    };
                    g.FillPolygon(b, diamond);
                }
                using (var ib = new SolidBrush(HeliosTheme.Base0))
                    g.FillEllipse(ib, mx + ms / 2f - 2.4f, top + ms / 2f - 2.4f, 4.8f, 4.8f);

                // Wordmark: "HELIOS" gold + " VAULT" light, letter-tracked.
                float wx = mx + ms + 11;
                float wy = top - 3;
                HeliosTheme.TrackedText(g, "HELIOS", HeliosTheme.Wordmark, HeliosTheme.Gold, wx, wy, 1.2f);
                float helW = HeliosTheme.TrackedWidth(g, "HELIOS", HeliosTheme.Wordmark, 1.2f);
                HeliosTheme.TrackedText(g, " VAULT", HeliosTheme.WordmarkLight, HeliosTheme.Text, wx + helW, wy, 1.2f);

                // Subtitle.
                HeliosTheme.TrackedText(g, "SUN DEVIL MOTORSPORTS  ·  GROUND STATION",
                    HeliosTheme.Caption, HeliosTheme.TextFaint, wx + 1, wy + 26, 0.6f);

                // Connection LED + identity line.
                Color led = _connState == 2 ? HeliosTheme.Green : _connState == 1 ? HeliosTheme.Gold : HeliosTheme.Red;
                int ly = 70;
                HeliosTheme.Led(g, mx + 4, ly + 2, led, 4f);
                string label = _connState == 0 ? "Helios offline — open Helios"
                    : _connState == 1 ? "Connected · sign in to Helios"
                    : "Connected · " + _connName;
                HeliosTheme.Text1(g, label, HeliosTheme.Body, _connState == 0 ? HeliosTheme.Red : HeliosTheme.TextDim,
                    new Rectangle(mx + 14, ly - 8, Width - mx - 22, 20));

                // Bottom hairline: gold rule + a maroon accent tick at the left.
                using (var p = new Pen(Color.FromArgb(70, HeliosTheme.Gold), 1f))
                    g.DrawLine(p, 0, Height - 1, Width, Height - 1);
                using (var p = new Pen(HeliosTheme.Gold, 2f))
                    g.DrawLine(p, 0, Height - 1, 46, Height - 1);
                using (var p = new Pen(HeliosTheme.Maroon, 2f))
                    g.DrawLine(p, 46, Height - 1, 66, Height - 1);
            }
            catch
            {
                using (var b = new SolidBrush(HeliosTheme.Base0)) g.FillRectangle(b, ClientRectangle);
            }
        }
    }

    /// <summary>The "active document" card: caption, document glyph + name, a
    /// hairline, then a status LED + status text with a monospace version chip.</summary>
    internal sealed class HeliosStatusCard : Control
    {
        private string _doc = "No document open";
        private string _status = "Open a part, assembly, or drawing.";
        private Color _statusColor = HeliosTheme.TextDim;
        private string _version = "";

        public HeliosStatusCard()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            DoubleBuffered = true;
            Height = 96;
            BackColor = HeliosTheme.Base0;
        }

        public void SetDocument(string name)
        {
            _doc = string.IsNullOrEmpty(name) ? "No document open" : name;
            Invalidate();
        }

        public void SetStatus(string text, Color color, string version = null)
        {
            _status = text ?? "";
            _statusColor = color;
            _version = version ?? "";
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            try
            {
                using (var bg = new SolidBrush(BackColor)) g.FillRectangle(bg, ClientRectangle);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                var card = new Rectangle(0, 0, Width - 1, Height - 1);
                HeliosTheme.Card(g, card, 9, HeliosTheme.Surface, HeliosTheme.Line);

                int pad = 13;
                HeliosTheme.TrackedText(g, "ACTIVE DOCUMENT", HeliosTheme.Caption, HeliosTheme.TextFaint, pad, 11, 0.9f);

                // Document glyph + name.
                HeliosTheme.DrawGlyph(g, HeliosTheme.GlyphPart, HeliosTheme.GlyphSmall, HeliosTheme.Gold,
                    new Rectangle(pad, 28, 16, 18));
                HeliosTheme.Text1(g, _doc, HeliosTheme.DocName, HeliosTheme.Text,
                    new Rectangle(pad + 21, 27, Width - pad * 2 - 21, 20));

                // Hairline.
                using (var p = new Pen(HeliosTheme.Line, 1f))
                    g.DrawLine(p, pad, 56, Width - pad, 56);

                // Status LED + text, version chip on the right.
                HeliosTheme.Led(g, pad + 4, 73, _statusColor, 4f);
                int verW = 0;
                if (!string.IsNullOrEmpty(_version))
                {
                    var sz = TextRenderer.MeasureText(g, _version, HeliosTheme.DataMono);
                    verW = sz.Width + 14;
                    var chip = new Rectangle(Width - pad - verW, 64, verW, 18);
                    HeliosTheme.Card(g, chip, 5, HeliosTheme.SurfaceHi, HeliosTheme.Line);
                    HeliosTheme.Text1(g, _version, HeliosTheme.DataMono, HeliosTheme.TextDim, chip, ContentAlignment.MiddleCenter);
                }
                HeliosTheme.Text1(g, _status, HeliosTheme.BodyStrong, _statusColor,
                    new Rectangle(pad + 14, 64, Width - pad * 2 - 14 - (verW > 0 ? verW + 8 : 0), 18));
            }
            catch
            {
                using (var b = new SolidBrush(HeliosTheme.Surface)) g.FillRectangle(b, ClientRectangle);
            }
        }
    }
}
