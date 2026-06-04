using System.Runtime.InteropServices;
using SharpShell.Attributes;
using SharpShell.SharpInfoTipHandler;

namespace HeliosShell
{
    /// <summary>
    /// Explorer hover tooltip ("info tip") for vault files: shows the Helios
    /// status (checked out by you / by another / available) on top of the normal
    /// file tooltip, read from the cached shell-state — so the vault state is
    /// visible without opening anything. Returns null for non-vault files so
    /// Explorer keeps its default tooltip.
    /// </summary>
    [ComVisible(true)]
    [Guid("8F2A6C14-9B3D-4E57-A1C2-D4E5F6070805")]
    [COMServerAssociation(AssociationType.AllFiles)]
    public class HeliosInfoTip : SharpInfoTipHandler
    {
        protected override string GetInfo(RequestedInfoType infoType, bool singleLine)
        {
            if (infoType != RequestedInfoType.InfoTip) return null;

            var entry = ShellState.EntryFor(SelectedItemPath);
            if (entry == null) return null; // not a tracked vault file

            string state = Bridge.GetStr(entry, "state");
            string line;
            switch (state)
            {
                case "out-me": line = "Checked out by you"; break;
                case "out-other": line = "Checked out by another member"; break;
                case "available": line = "Available — in the Helios vault"; break;
                default: return null;
            }
            return singleLine ? "Helios Vault — " + line : "Helios Vault\n" + line;
        }
    }
}
