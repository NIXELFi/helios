using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using SharpShell.Attributes;
using SharpShell.Interop;
using SharpShell.SharpIconOverlayHandler;

namespace HeliosShell
{
    /// <summary>
    /// Icon-overlay badges in Explorer reflecting vault state, read from the
    /// bridge-written shell-state cache (fast, no HTTP per icon). One handler
    /// per state because Windows allows a single overlay per file. Handler names
    /// are registered with a leading space so they sort to the top of the
    /// ~15-slot ShellIconOverlayIdentifiers list (other apps grab slots the same
    /// way). Icons are generated once + cached.
    /// </summary>
    internal static class OverlayIcons
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr handle);

        private static readonly object Gate = new object();
        private static Icon _outMe, _outOther, _available;

        internal static Icon OutMe => Get(ref _outMe, Color.FromArgb(255, 198, 39), Glyph.Lock);     // gold
        internal static Icon OutOther => Get(ref _outOther, Color.FromArgb(229, 83, 80), Glyph.Lock); // red
        internal static Icon Available => Get(ref _available, Color.FromArgb(102, 187, 106), Glyph.Check); // green

        private enum Glyph { Check, Lock }

        private static Icon Get(ref Icon slot, Color fill, Glyph glyph)
        {
            lock (Gate)
            {
                if (slot == null) slot = MakeBadge(fill, glyph);
                return slot;
            }
        }

        /// <summary>A 16×16 transparent image with a colored badge in the
        /// bottom-left corner (where Explorer overlays sit) + a white glyph.</summary>
        private static Icon MakeBadge(Color fill, Glyph glyph)
        {
            using (var bmp = new Bitmap(16, 16, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    var badge = new Rectangle(0, 6, 10, 10);
                    using (var b = new SolidBrush(fill)) g.FillEllipse(b, badge);
                    using (var p = new Pen(Color.FromArgb(230, 24, 24, 26), 1.4f)) g.DrawEllipse(p, badge);
                    using (var wp = new Pen(Color.White, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                    {
                        if (glyph == Glyph.Check)
                        {
                            g.DrawLines(wp, new[] { new Point(2, 11), new Point(4, 13), new Point(8, 8) });
                        }
                        else // a tiny padlock: shackle arc + body
                        {
                            g.DrawArc(wp, new Rectangle(3, 8, 4, 4), 180, 180);
                            using (var wb = new SolidBrush(Color.White))
                                g.FillRectangle(wb, new Rectangle(2, 10, 6, 4));
                        }
                    }
                }
                var h = bmp.GetHicon();
                try { return (Icon)Icon.FromHandle(h).Clone(); }
                finally { DestroyIcon(h); }
            }
        }
    }

    /// <summary>Overlay: this file is checked out BY YOU (writable, editing).</summary>
    [ComVisible(true)]
    [Guid("8F2A6C14-9B3D-4E57-A1C2-D4E5F6070802")]
    [COMServerAssociation(AssociationType.AllFiles)]
    public class HeliosOverlayOutMe : SharpIconOverlayHandler
    {
        protected override bool CanShowOverlay(string path, FILE_ATTRIBUTE attributes) =>
            ShellState.StateFor(path) == "out-me";
        protected override int GetPriority() => 0;
        protected override Icon GetOverlayIcon() => OverlayIcons.OutMe;
    }

    /// <summary>Overlay: checked out by ANOTHER member (locked to you).</summary>
    [ComVisible(true)]
    [Guid("8F2A6C14-9B3D-4E57-A1C2-D4E5F6070803")]
    [COMServerAssociation(AssociationType.AllFiles)]
    public class HeliosOverlayOutOther : SharpIconOverlayHandler
    {
        protected override bool CanShowOverlay(string path, FILE_ATTRIBUTE attributes) =>
            ShellState.StateFor(path) == "out-other";
        protected override int GetPriority() => 0;
        protected override Icon GetOverlayIcon() => OverlayIcons.OutOther;
    }

    /// <summary>Overlay: in the vault, available to check out.</summary>
    [ComVisible(true)]
    [Guid("8F2A6C14-9B3D-4E57-A1C2-D4E5F6070804")]
    [COMServerAssociation(AssociationType.AllFiles)]
    public class HeliosOverlayAvailable : SharpIconOverlayHandler
    {
        protected override bool CanShowOverlay(string path, FILE_ATTRIBUTE attributes) =>
            ShellState.StateFor(path) == "available";
        protected override int GetPriority() => 0;
        protected override Icon GetOverlayIcon() => OverlayIcons.Available;
    }
}
