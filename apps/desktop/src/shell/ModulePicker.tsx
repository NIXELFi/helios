import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
  /** Subteam + role shown as a secondary line under the name so it's obvious
   *  who you're signed in as and what access you have. Either may be null. */
  userSubteam: string | null;
  userRole: string | null;
  /** Click the user pill / sign-in pill. Opens the AuthModal. */
  onOpenAuth: () => void;
  /** Sign the user out of the current Supabase session. Wired into the
   *  account dropdown. */
  onSignOut: () => void;
  /** Wipe the saved Supabase connection. Surfaced under the account
   *  dropdown so a user on a shared machine can hand off to someone with
   *  a different Supabase backend. */
  onDisconnect: () => void;
  /** Open the self-service change-password modal. */
  onChangePassword: () => void;
  /** True when the user is allowed to enter the Vault module. Pulled up
   *  to a prop so the same gate is shared with click-routing in the
   *  parent Shell. */
  vaultEnabled: boolean;
  /** True during boot getSession(), before we know whether a returning user
   *  is signed in. While loading we suppress the disabled "Sign in to use
   *  Vault" presentation so a signed-in user doesn't see it flash. */
  authLoading?: boolean;
}

export function ModulePicker(props: Props) {
  const {
    active,
    onSelect,
    appVersion,
    updaterState,
    onUpdaterClick,
    userLabel,
    userSubteam,
    userRole,
    onOpenAuth,
    onSignOut,
    onDisconnect,
    onChangePassword,
    vaultEnabled,
    authLoading = false,
  } = props;
  // While auth is still resolving, don't render Vault as disabled — a returning
  // signed-in user would otherwise see "Sign in to use Vault" flash before
  // their session lands. Treat it as a normal (pending) entry until we know.
  const vaultDisabled = !vaultEnabled && !authLoading;
  return (
    // Sidebar layout: brand header → nav buttons → spacer → user pill →
    // updater footer. Brand + user + updater live here (not inside any
    // module) so they persist across Log / Vault / CFD.
    <nav className="flex w-44 flex-col border-r border-helios-line bg-helios-base">
      <div className={"border-b border-helios-line px-3 pb-3 " + BRAND_HEADER_TOP_PADDING}>
        <div className="font-helios text-xl leading-none text-asu-gold">HELIOS</div>
        <div className="mt-1 truncate text-[10px] uppercase tracking-wider text-helios-dim">
          {/* `appVersion` starts as "dev" until getVersion() resolves; show a
              neutral placeholder instead of flashing "vdev" on every boot. */}
          {appVersion && appVersion !== "dev"
            ? `v${appVersion} · ground-station`
            : "ground-station"}
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
          disabled={vaultDisabled}
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
          subteam={userSubteam}
          role={userRole}
          onOpenAuth={onOpenAuth}
          onSignOut={onSignOut}
          onDisconnect={onDisconnect}
          onChangePassword={onChangePassword}
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
  // in Shell.tsx. Because the entry IS actionable (it opens sign-in), it
  // keeps a pointer cursor and a real hover cue rather than reading as a
  // dead control; we just dim it relative to the live modules so it's clear
  // it isn't currently accessible.
  return (
    <button
      type="button"
      aria-current={!disabled && active ? "page" : undefined}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      title={disabled ? disabledTitle : undefined}
      className={
        "flex items-center justify-between rounded-sm border px-3 py-1.5 text-left text-sm transition-colors " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
        (disabled
          ? "cursor-pointer border-helios-line bg-helios-panel/60 text-helios-text/70 hover:border-asu-gold hover:text-helios-text"
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
              ? "bg-helios-line text-helios-text/80"
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
  subteam: string | null;
  role: string | null;
  onOpenAuth: () => void;
  onSignOut: () => void;
  onDisconnect: () => void;
  onChangePassword: () => void;
}) {
  const { label, subteam, role, onOpenAuth, onSignOut, onDisconnect, onChangePassword } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the menu and return focus to the trigger so keyboard users aren't
  // dumped at the top of the document (focus-restore, per the modal/menu a11y
  // recipe). Callers that act on a menu item also call this.
  function closeAndRestore() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  // Click-outside closes the dropdown (no focus restore — the user is mousing
  // elsewhere). Same pattern as the Log workspace overflow menu.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Roving focus: when the menu opens, move focus to the first item so arrow
  // keys work immediately and the menu is operable without a mouse.
  useEffect(() => {
    if (!open) return;
    const items = menuItems();
    items[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function menuItems(): HTMLElement[] {
    if (!menuRef.current) return [];
    return Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }

  // Arrow-key navigation + Escape + Tab, scoped to the open menu. ArrowUp/Down
  // wrap; Home/End jump to the ends; Escape closes and restores focus to the
  // trigger.
  function onMenuKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAndRestore();
      return;
    }
    if (e.key === "Tab") {
      // Tab should exit the menu, not stay trapped inside it. Close it (so it
      // isn't left orphaned/open behind the newly-focused control) but DON'T
      // preventDefault — let the browser move focus naturally. No focus-restore
      // here either: the user is intentionally tabbing onward.
      setOpen(false);
      return;
    }
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  }

  if (label === null) {
    // Logged out (or no connection configured). Single pill that opens the
    // auth modal; the modal itself decides whether to start on the Connect
    // step or the Sign-in step based on connection state.
    return (
      <button
        type="button"
        onClick={onOpenAuth}
        className="flex w-full items-center justify-between rounded-sm border border-helios-line bg-helios-panel px-3 py-1.5 text-left text-xs text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        <span>Sign in</span>
        <span aria-hidden className="text-[10px] text-helios-dim">→</span>
      </button>
    );
  }

  return (
    <div
      ref={ref}
      className="relative"
      onBlur={(e) => {
        // Close when focus leaves the whole pill+menu (e.g. the user tabbed
        // out, or focus moved elsewhere). relatedTarget null = focus left the
        // document; otherwise close only if it landed outside this component.
        const next = e.relatedTarget as Node | null;
        if (!next || !ref.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full flex-col gap-0.5 rounded-sm border border-helios-line bg-helios-panel px-3 py-1.5 text-left text-xs text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        <span className="flex w-full items-center justify-between gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-asu-gold"
            />
            <span className="truncate" title={label}>{label}</span>
          </span>
          <span aria-hidden className="ml-1 text-[10px] text-helios-dim">▾</span>
        </span>
        {(subteam || role) && (
          <span className="truncate pl-3 text-[10px] text-helios-dim">
            {subteam && <span>{subteam}</span>}
            {subteam && role && <span className="text-[#5A5F66]"> · </span>}
            {role && <span className="uppercase tracking-wider text-asu-gold/80">{role}</span>}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="absolute bottom-full left-0 mb-1 w-full rounded-sm border border-helios-line bg-helios-base text-xs text-helios-text shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { closeAndRestore(); onChangePassword(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-helios-panel focus-visible:outline-none focus-visible:bg-helios-panel focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold"
          >
            Change password…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { closeAndRestore(); onSignOut(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-helios-panel focus-visible:outline-none focus-visible:bg-helios-panel focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold"
          >
            Sign out
          </button>
          <div className="border-t border-helios-line" aria-hidden />
          <button
            type="button"
            role="menuitem"
            onClick={() => { closeAndRestore(); onDisconnect(); }}
            className="block w-full px-3 py-1.5 text-left text-helios-dim hover:bg-helios-panel hover:text-red-200 focus-visible:outline-none focus-visible:bg-helios-panel focus-visible:text-red-200 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-asu-gold"
            title="Forget the saved Supabase URL and anon key on this machine"
          >
            Disconnect Supabase
          </button>
        </div>
      )}
    </div>
  );
}
