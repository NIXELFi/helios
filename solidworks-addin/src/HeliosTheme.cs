using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace HeliosVault
{
    /// <summary>
    /// Shared visual language for the Helios pane — a refined dark "ground
    /// station / instrument panel" look: graphite gradients, ASU gold as the one
    /// sharp accent, status LEDs, hairline rules, and crisp Segoe MDL2 glyphs.
    /// Centralizes the palette, a cached font ladder (never allocate fonts in a
    /// paint loop), and GDI helpers so every widget renders consistently.
    /// </summary>
    internal static class HeliosTheme
    {
        // --- palette ----------------------------------------------------------
        public static readonly Color Base0 = Color.FromArgb(0x0B, 0x0C, 0x0F);   // deepest bg
        public static readonly Color Base1 = Color.FromArgb(0x12, 0x14, 0x19);   // bg gradient top
        public static readonly Color Surface = Color.FromArgb(0x16, 0x18, 0x1E); // cards
        public static readonly Color SurfaceHi = Color.FromArgb(0x1D, 0x20, 0x27);
        public static readonly Color Line = Color.FromArgb(0x2A, 0x2D, 0x36);    // hairline borders
        public static readonly Color LineHi = Color.FromArgb(0x3A, 0x3E, 0x49);
        public static readonly Color Text = Color.FromArgb(0xE7, 0xEA, 0xF0);
        public static readonly Color TextDim = Color.FromArgb(0x97, 0x9E, 0xAB);
        public static readonly Color TextFaint = Color.FromArgb(0x5C, 0x62, 0x6E);
        public static readonly Color Gold = Color.FromArgb(0xFF, 0xC6, 0x27);    // ASU gold — THE accent
        public static readonly Color GoldHi = Color.FromArgb(0xFF, 0xD7, 0x5E);
        public static readonly Color GoldLo = Color.FromArgb(0xD9, 0xA4, 0x1C);
        public static readonly Color GoldInk = Color.FromArgb(0x1A, 0x14, 0x06); // text on gold
        public static readonly Color Maroon = Color.FromArgb(0x8C, 0x1D, 0x40);  // ASU maroon — rare 2nd accent
        public static readonly Color Green = Color.FromArgb(0x5B, 0xC9, 0x7E);   // available / synced
        public static readonly Color Red = Color.FromArgb(0xE6, 0x58, 0x4F);     // locked by other / error

        // --- fonts (created once, live for the process) -----------------------
        private const string UI = "Segoe UI";
        private const string Semi = "Segoe UI Semibold";
        private const string Mono = "Consolas";
        private const string Mdl2 = "Segoe MDL2 Assets";

        public static readonly Font Wordmark = Safe(Semi, 15.5f, FontStyle.Regular, UI, FontStyle.Bold);
        public static readonly Font WordmarkLight = new Font(UI, 15.5f, FontStyle.Regular);
        public static readonly Font Heading = Safe(Semi, 10.5f, FontStyle.Regular, UI, FontStyle.Bold);
        public static readonly Font Body = new Font(UI, 9f, FontStyle.Regular);
        public static readonly Font BodyStrong = Safe(Semi, 9.25f, FontStyle.Regular, UI, FontStyle.Bold);
        public static readonly Font DocName = Safe(Semi, 10.5f, FontStyle.Regular, UI, FontStyle.Bold);
        public static readonly Font Caption = new Font(UI, 7.25f, FontStyle.Bold);
        public static readonly Font DataMono = new Font(Mono, 8.5f, FontStyle.Regular);
        public static readonly Font Glyph = new Font(Mdl2, 11f, FontStyle.Regular);
        public static readonly Font GlyphSmall = new Font(Mdl2, 9f, FontStyle.Regular);
        public static readonly Font TreeFont = new Font(UI, 8.75f, FontStyle.Regular);

        /// <summary>Use `family` if installed (its style differs from the fallback),
        /// else the fallback — so a missing Segoe UI Semibold degrades to bold.</summary>
        private static Font Safe(string family, float size, FontStyle style, string fallback, FontStyle fbStyle)
        {
            try
            {
                var f = new Font(family, size, style);
                if (string.Equals(f.Name, family, StringComparison.OrdinalIgnoreCase)) return f;
                f.Dispose();
            }
            catch { }
            return new Font(fallback, size, fbStyle);
        }

        // --- Segoe MDL2 Assets glyphs (crisp vector icons on Win10/11) --------
        // Defined from codepoints (ASCII source) so the icon font's private-use
        // characters are unambiguous.
        private static string G(int cp) => char.ConvertFromUtf32(cp);
        public static readonly string GlyphUnlock = G(0xE785);    // check out (lock — you hold control)
        public static readonly string GlyphSave = G(0xE74E);      // check in (save to vault)
        public static readonly string GlyphUndo = G(0xE7A7);      // cancel check-out
        public static readonly string GlyphDownload = G(0xE896);  // get latest
        public static readonly string GlyphAdd = G(0xE710);       // add to vault
        public static readonly string GlyphRefresh = G(0xE72C);   // refresh
        public static readonly string GlyphFolder = G(0xE8B7);    // folder
        public static readonly string GlyphFolderOpen = G(0xE838);
        public static readonly string GlyphPart = G(0xE8A5);      // document
        public static readonly string GlyphHistory = G(0xE81C);   // history
        public static readonly string GlyphConnected = G(0xE703); // network/connected

        // --- drawing helpers --------------------------------------------------
        public static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            int d = radius * 2;
            var p = new GraphicsPath();
            if (radius <= 0 || d > r.Width || d > r.Height) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRound(Graphics g, Rectangle r, int radius, Color fill)
        {
            using (var path = RoundRect(r, radius))
            using (var b = new SolidBrush(fill))
                g.FillPath(b, path);
        }

        public static void Card(Graphics g, Rectangle r, int radius, Color fill, Color border)
        {
            using (var path = RoundRect(r, radius))
            using (var b = new SolidBrush(fill))
            using (var p = new Pen(border, 1f))
            {
                g.FillPath(b, path);
                g.DrawPath(p, path);
            }
        }

        public static void VGradient(Graphics g, Rectangle r, Color top, Color bottom)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            using (var br = new LinearGradientBrush(r, top, bottom, LinearGradientMode.Vertical))
                g.FillRectangle(br, r);
        }

        /// <summary>A status "LED": a filled dot with a soft surrounding glow.</summary>
        public static void Led(Graphics g, float cx, float cy, Color color, float r = 4.5f)
        {
            var prev = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var glow = new SolidBrush(Color.FromArgb(55, color)))
                g.FillEllipse(glow, cx - r * 2, cy - r * 2, r * 4, r * 4);
            using (var b = new SolidBrush(color))
                g.FillEllipse(b, cx - r, cy - r, r * 2, r * 2);
            using (var hi = new SolidBrush(Color.FromArgb(140, 255, 255, 255)))
                g.FillEllipse(hi, cx - r * 0.5f, cy - r * 0.65f, r * 0.66f, r * 0.66f);
            g.SmoothingMode = prev;
        }

        /// <summary>Draw letter-tracked text (extra spacing between glyphs) for the
        /// wordmark + captions — that precise, technical feel TextRenderer can't do.</summary>
        public static void TrackedText(Graphics g, string text, Font font, Color color, float x, float y, float tracking)
        {
            if (string.IsNullOrEmpty(text)) return;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            using (var b = new SolidBrush(color))
            using (var sf = new StringFormat(StringFormat.GenericTypographic))
            {
                foreach (var ch in text)
                {
                    var s = ch.ToString();
                    g.DrawString(s, font, b, x, y, sf);
                    x += g.MeasureString(s, font, PointF.Empty, sf).Width + tracking;
                }
            }
        }

        public static float TrackedWidth(Graphics g, string text, Font font, float tracking)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            float w = 0;
            using (var sf = new StringFormat(StringFormat.GenericTypographic))
                foreach (var ch in text)
                    w += g.MeasureString(ch.ToString(), font, PointF.Empty, sf).Width + tracking;
            return w;
        }

        /// <summary>Single-line text, vertically centered in `r`, ellipsized.</summary>
        public static void Text1(Graphics g, string text, Font font, Color color, Rectangle r,
            ContentAlignment align = ContentAlignment.MiddleLeft)
        {
            var flags = TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine;
            switch (align)
            {
                case ContentAlignment.MiddleCenter: flags |= TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter; break;
                case ContentAlignment.MiddleRight: flags |= TextFormatFlags.Right | TextFormatFlags.VerticalCenter; break;
                default: flags |= TextFormatFlags.Left | TextFormatFlags.VerticalCenter; break;
            }
            TextRenderer.DrawText(g, text ?? "", font, r, color, flags);
        }

        /// <summary>Draw a Segoe MDL2 glyph centered in a square at (x,y,size).</summary>
        public static void DrawGlyph(Graphics g, string glyph, Font font, Color color, Rectangle box)
        {
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (var b = new SolidBrush(color))
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                g.DrawString(glyph, font, b, box, sf);
        }

        public static Color StatusColor(string state)
        {
            switch (state)
            {
                case "out-me": return Gold;
                case "out-other": return Red;
                case "available": return Green;
                default: return TextFaint;
            }
        }
    }
}
