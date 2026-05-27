import { useEffect, useRef, useState } from "react";
import { UpdatesPill } from "../components/UpdatesPill";
import type { UpdaterState } from "../lib/use-updater";

export type ModuleId = "logs" | "vault" | "cfd";

// macOS uses `titleBarStyle: "Overlay"` + inset traffic-lights at (14, 14),
// so the brand header needs ~48 px of top padding to clear them. Windows
// and Linux draw native window decorations ABOVE the webview, so the same
// padding shows up as dead space. Detect the platform once at module load
// and pick the right top padding. Tauri's webview sets a normal userAgent
// per OS — no extra plugin needed.
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
const BRAND_HEADER_TOP_PADDING = IS_MAC ? "pt-12" : "pt-3";

interface Props {
  active: ModuleId;
  onSelect: (id: ModuleId) => void;
  /** Current app version — surfaced under the HELIOS wordmark so the user
   *  can see what build they're on from any module. */
  appVersion: string;
  /** Updater lifecycle — drives the UpdatesPill rendered at the bottom of
   *  the rail so update affordance persists across Log / Vault / CFD. */
  updaterState: UpdaterState;
  onUpdaterClick: () => void;
  /** Auth chrome props. `userLabel` is what to show in the sidebar pill
   *  (display name preferred over email). When `userLabel === null` the
   *  pill renders a "Sign in" affordance instead. */
  userLabel: string | null;
  /** Click the user pill / sign-in pill. Opens the AuthModal. */
  onOpenAuth: () => void;
  /** Sign the user out of the current Supabase session. Wired into the
   *  account dropdown. */
  onSignOut: () => void;
  /** Wipe the saved Supabase connection. Surfaced under the account
   *  dropdown so a user on a shared machine can hand off to someone with
   *  a different Supabase backend. */
  onDisconnect: () => void;
  /** True when the user is allowed to enter the Vault module. Pulled up
   *  to a prop so the same gate is shared with click-routing in the
   *  parent Shell. */
  vaultEnabled: boolean;
}

export function ModulePicker(props: Props) {
  const {
    active,
    onSelect,
    appVersion,
    updaterState,
    onUpdaterClick,
    userLabel,
    onOpenAuth,
    onSignOut,
    onDisconnect,
    vaultEnabled,
  } = props;
  return (
    // Sidebar layout: brand header → nav buttons → spacer → user pill →
    // updater footer. Brand + user + updater live here (not inside any
    // module) so they persist across Log / Vault / CFD.
    <nav className="flex w-44 flex-col border-r border-helios-line bg-helios-base">
      <div className={"border-b border-helios-line px-3 pb-3 " + BRAND_HEADER_TOP_PADDING}>
        <div className="font-helios text-xl leading-none text-asu-gold">HELIOS</div>
        <div className="mt-1 text-[10px] uppercase tracking-wider text-helios-dim">
          v{appVersion} · ground-station
        </div>
      </div>

      <div className="flex flex-col gap-1 p-2">
        <NavButton
          label="Logs"
          active={active === "logs"}
          onClick={() => onSelect("logs")}
        />
        <NavButton
          label="Vault"
          badge="NEW"
          active={active === "vault"}
          onClick={() => onSelect("vault")}
          disabled={!vaultEnabled}
          disabledTitle="Sign in to use Vault"
        />
        <NavButton
          label="CFD"
          badge="NEW"
          active={active === "cfd"}
          onClick={() => onSelect("cfd")}
        />
      </div>

      <div className="flex-1" />

      <div className="border-t border-helios-line p-2">
        <UserPill
          label={userLabel}
          onOpenAuth={onOpenAuth}
          onSignOut={onSignOut}
          onDisconnect={onDisconnect}
        />
      </div>

      <div className="border-t border-helios-line p-2">
        <UpdatesPill state={updaterState} onClick={onUpdaterClick} />
      </div>
    </nav>
  );
}

function NavButton(props: {
  label: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const { label, badge, active, onClick, disabled, disabledTitle } = props;
  // We render disabled nav entries as a button with aria-disabled (not the
  // `disabled` attribute), so clicking still fires onClick. The parent
  // Shell uses that click to surface the auth modal — see the Vault wiring
  // in Shell.tsx. The pointer stays the default cursor as a soft hint
  // that the entry is not currently active.
  return (
    <button
      type="button"
      aria-current={!disabled && active ? "page" : undefined}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      title={disabled ? disabledTitle : undefined}
      className={
        "flex items-center justify-between rounded-sm border px-3 py-1.5 text-left text-sm transition-colors " +
        (disabled
          ? "cursor-default border-helios-line bg-helios-panel/40 text-helios-dim opacity-60 hover:border-helios-line"
          : active
            ? "border-asu-gold bg-asu-gold font-semibold text-helios-base"
            : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold")
      }
    >
      <span>{label}</span>
      {badge && (
        <span
          className={
            "ml-2 rounded-sm px-1.5 py-0.5 text-[10px] font-bold " +
            (disabled
              ? "bg-helios-line text-helios-dim"
              : active
                ? "bg-helios-base text-asu-gold"
                : "bg-asu-gold text-helios-base")
          }
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function UserPill(props: {
  label: string | null;
  onOpenAuth: () => void;
  onSignOut: () => void;
  onDisconnect: () => void;
}) {
  const { label, onOpenAuth, onSignOut, onDisconnect } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside / Escape closes the dropdown. Same pattern as the Log
  // workspace overflow menu so the chrome feels consistent.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (label === null) {
    // Logged out (or no connection configured). Single pill that opens the
    // auth modal; the modal itself decides whether to start on the Connect
    // step or the Sign-in step based on connection state.
    return (
      <button
        type="button"
        onClick={onOpenAuth}
        className="flex w-full items-center justify-between rounded-sm border border-helios-line bg-helios-panel px-3 py-1.5 text-left text-xs text-helios-text hover:border-asu-gold"
      >
        <span>Sign in</span>
        <span aria-hidden className="text-[10px] text-helios-dim">→</span>
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center justify-between rounded-sm border border-helios-line bg-helios-panel px-3 py-1.5 text-left text-xs text-helios-text hover:border-asu-gold"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-asu-gold"
          />
          <span className="truncate" title={label}>{label}</span>
        </span>
        <span aria-hidden className="ml-1 text-[10px] text-helios-dim">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-1 w-full rounded-sm border border-helios-line bg-helios-base text-xs text-helios-text shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onSignOut(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-helios-panel"
          >
            Sign out
          </button>
          <div className="border-t border-helios-line" aria-hidden />
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onDisconnect(); }}
            className="block w-full px-3 py-1.5 text-left text-helios-dim hover:bg-helios-panel hover:text-red-200"
            title="Forget the saved Supabase URL and anon key on this machine"
          >
            Disconnect Supabase
          </button>
        </div>
      )}
    </div>
  );
}
