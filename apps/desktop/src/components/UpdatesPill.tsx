import type { UpdaterState } from "../lib/use-updater";

interface Props {
  state: UpdaterState;
  onClick: () => void;
}

/** Header pill that surfaces the updater lifecycle. Always visible — even
 *  the up-to-date state shows a dim "✓" pill, both as a manual-recheck
 *  affordance and to make it visible to the user that the app is checking
 *  for updates at all. */
export function UpdatesPill({ state, onClick }: Props) {
  const view = pillFor(state);
  return (
    <button
      type="button"
      onClick={onClick}
      // The visible label is a terse glyph ("✓ v3.7.0", "↑ v3.8.0 ready");
      // mirror the descriptive title into an aria-label so screen readers get
      // the full state, not just the symbol.
      aria-label={view.title}
      className={
        "px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors flex items-center gap-1 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
        view.className
      }
      title={view.title}
    >
      {view.label}
    </button>
  );
}

function pillFor(state: UpdaterState): { label: string; title: string; className: string } {
  switch (state.kind) {
    case "checking":
      return {
        label: "checking…",
        title: "Checking for updates",
        className: "bg-[#16171B] text-[#9097A0] border-[#2A2C32]",
      };
    case "up_to_date":
      return {
        label: `✓ v${state.current || "—"}`,
        title: "You're on the latest version. Click to recheck.",
        className: "bg-[#16171B] text-[#9097A0] border-[#2A2C32] hover:border-[#FFC627]",
      };
    case "available":
      return {
        label: `↑ v${state.update.version} ready`,
        title: `Update available (you're on v${state.update.currentVersion})`,
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold animate-pulse",
      };
    case "downloading": {
      const pct = state.total ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;
      return {
        label: pct === null ? "downloading…" : `downloading ${pct}%`,
        title: "Downloading update",
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627]",
      };
    }
    case "installing":
      return {
        label: "installing…",
        title: "Installing update; the app will relaunch",
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627]",
      };
    case "installed":
      return {
        label: `↻ restart for v${state.version}`,
        title: `Helios v${state.version} is installed — quit and reopen Helios to finish updating.`,
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold",
      };
    case "offline":
      return {
        label: "– offline",
        title: `Update check failed: ${state.error}. Click to retry.`,
        className: "bg-[#16171B] text-[#9097A0] border-[#2A2C32] hover:border-[#FFC627]",
      };
  }
}
