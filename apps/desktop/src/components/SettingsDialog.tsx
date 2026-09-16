import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import {
  IconAdjustments,
  IconBell,
  IconDatabase,
  IconInfoCircle,
  IconKeyboard,
  type TablerIcon,
} from "@tabler/icons-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { usePrefs, type LandingPref, type ThemePref } from "../lib/prefs";
import { osNotify } from "../lib/os-notify";
import { IS_MAC, IS_WINDOWS, MOD_KEY } from "../lib/platform";
import { getBreadcrumbs, getLastError } from "../lib/breadcrumbs";
import type { UpdaterApi } from "../lib/use-updater";
import type { ReportKind } from "../shell/report/types";
import { KeyChip, SHORTCUT_GROUPS } from "./ShortcutsOverlay";

export type SettingsTab = "general" | "notifications" | "data" | "shortcuts" | "about";

const TABS: { id: SettingsTab; label: string; Icon: TablerIcon }[] = [
  { id: "general", label: "General", Icon: IconAdjustments },
  { id: "notifications", label: "Notifications", Icon: IconBell },
  { id: "data", label: "Data", Icon: IconDatabase },
  { id: "shortcuts", label: "Shortcuts", Icon: IconKeyboard },
  { id: "about", label: "About", Icon: IconInfoCircle },
];

const CFD_DIR_KEY = "helios.cfd.teamDataDir";
const PM_SNAPSHOT_PREFIX = "helios:pm:workspaceSnapshot:";
const RELEASES_URL = "https://github.com/NIXELFi/helios/releases";

interface Props {
  open: boolean;
  /** Tab to show when opened; the dialog remembers the last one otherwise. */
  initialTab?: SettingsTab;
  onClose: () => void;
  appVersion: string;
  updater: UpdaterApi;
  /** Opens the UpdateModal (install flow) — lives in the Shell. */
  onOpenUpdate: () => void;
  onOpenReport: (kind: ReportKind) => void;
  /** Switch to the Vault module and land on its Settings screen. */
  onGoToVaultSettings: () => void;
  account: { email: string | null; id: string | null; role: string | null } | null;
}

/**
 * App-wide Settings (⌘/Ctrl+,). Machine-level preferences only — see
 * lib/prefs.ts. Vault-specific setup (sync folder, SOLIDWORKS add-in) stays
 * in Vault → Settings; the Data tab links across.
 */
export function SettingsDialog(props: Props) {
  const { open, initialTab, onClose } = props;
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "general");
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  const dialogRef = useModalA11y(open, onClose);
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 helios-overlay-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="flex h-[min(88vh,620px)] w-[min(94vw,820px)] overflow-hidden rounded-md border border-helios-line bg-helios-panel text-helios-text helios-elevate helios-modal-in"
      >
        <nav aria-label="Settings sections" className="flex w-44 shrink-0 flex-col border-r border-helios-line bg-helios-base">
          <div id="settings-title" className="px-4 pb-2 pt-4 text-[11px] uppercase tracking-wider text-asu-gold">
            Settings
          </div>
          <div className="flex flex-col gap-0.5 p-2">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
                className={
                  "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                  (tab === id ? "bg-asu-gold/15 text-asu-gold" : "text-helios-dim hover:bg-helios-panel hover:text-asu-gold")
                }
              >
                <Icon size={16} strokeWidth={1.5} className="shrink-0" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <div className="px-4 pb-3 text-[10px] text-helios-dim/70">
            <KeyChip>{MOD_KEY}</KeyChip> <KeyChip>,</KeyChip> opens this anywhere
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-helios-line px-5 py-2.5">
            <h2 className="text-sm font-semibold">{TABS.find((t) => t.id === tab)?.label}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="rounded-sm border border-helios-line bg-helios-base px-2 py-0.5 text-[11px] text-helios-text hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              Close ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === "general" && <GeneralTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "data" && <DataTab onGoToVaultSettings={props.onGoToVaultSettings} onClose={onClose} />}
            {tab === "shortcuts" && <ShortcutsTab />}
            {tab === "about" && <AboutTab {...props} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── primitives ───────────────────────── */

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-helios-dim">{title}</h3>
      {hint && <p className="mb-2 max-w-prose text-xs text-helios-dim/80">{hint}</p>}
      <div className="divide-y divide-helios-line rounded border border-helios-line bg-helios-base">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-helios-text">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-helios-dim">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-not-allowed disabled:opacity-40 " +
        (checked ? "border-asu-gold bg-asu-gold" : "border-helios-line bg-helios-panel")
      }
    >
      <span
        aria-hidden
        className={
          "inline-block h-3.5 w-3.5 rounded-full transition-transform " +
          (checked ? "translate-x-[18px] bg-helios-base" : "translate-x-[3px] bg-helios-dim")
        }
      />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded border border-helios-line bg-helios-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={
            "rounded-sm px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
            (value === o.value ? "bg-asu-gold text-helios-on-gold" : "text-helios-dim hover:text-helios-text")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SmallButton({ onClick, children, disabled, tone = "default" }: { onClick: () => void; children: ReactNode; disabled?: boolean; tone?: "default" | "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-sm border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50 " +
        (tone === "danger"
          ? "border-helios-danger/50 text-helios-danger hover:bg-helios-danger/10"
          : "border-helios-line text-helios-text hover:border-asu-gold hover:bg-helios-line")
      }
    >
      {children}
    </button>
  );
}

/* ───────────────────────── General ───────────────────────── */

function GeneralTab() {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);

  // Launch-at-login lives in the OS (autostart plugin) — read on open.
  // null = unknown / not in a Tauri context (control is disabled).
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    void invoke<boolean>("get_autostart").then(setAutostart).catch(() => setAutostart(null));
  }, []);
  async function setAutostartEnabled(enabled: boolean) {
    try {
      await invoke("set_autostart", { enabled });
      setAutostart(enabled);
    } catch {
      /* non-Tauri context / denied — leave as-is */
    }
  }
  function setCloseToTray(v: boolean) {
    update({ closeToTray: v });
    void invoke("set_close_to_tray", { enabled: v }).catch(() => {});
  }

  return (
    <>
      <Section title="Appearance">
        <Row label="Theme" hint={prefs.theme === "system" ? "Follows your OS setting." : prefs.theme === "light" ? "Light. Telemetry and charts were designed on dark; if something looks off in light, report it." : "Dark, the Helios default."}>
          <Segmented<ThemePref>
            label="Theme"
            value={prefs.theme}
            onChange={(v) => update({ theme: v })}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
          />
        </Row>
      </Section>
      <Section title="Startup">
        <Row label="Open Helios on" hint="Which module a signed-in launch shows first. Signed out, Helios always opens on Logs.">
          <Segmented<LandingPref>
            label="Landing module"
            value={prefs.landing}
            onChange={(v) => update({ landing: v })}
            options={[
              { value: "pm", label: "PM" },
              { value: "logs", label: "Logs" },
              { value: "last", label: "Last used" },
            ]}
          />
        </Row>
        <Row label="Launch at login" hint={autostart === null ? "Not available in this build." : "Starts hidden in the tray so the SOLIDWORKS add-in and vault sync are ready."}>
          <Switch label="Launch at login" checked={autostart === true} disabled={autostart === null} onChange={(v) => void setAutostartEnabled(v)} />
        </Row>
      </Section>
      <Section title="Updates">
        <Row
          label="Install updates automatically"
          hint={prefs.autoUpdate
            ? "When a new version is found, Helios downloads it and restarts after a 20-second countdown. You can postpone once for 30 minutes."
            : "Helios only tells you an update exists; you choose when to install it."}
        >
          <Switch label="Install updates automatically" checked={prefs.autoUpdate} onChange={(v) => update({ autoUpdate: v })} />
        </Row>
      </Section>
      <Section title="Window">
        <Row label="When I close the window" hint={prefs.closeToTray ? "Helios keeps running in the tray. Quit from the tray icon." : "Helios quits. The SOLIDWORKS add-in loses its connection until the next launch."}>
          <Segmented<"tray" | "quit">
            label="Close behaviour"
            value={prefs.closeToTray ? "tray" : "quit"}
            onChange={(v) => setCloseToTray(v === "tray")}
            options={[
              { value: "tray", label: "Keep in tray" },
              { value: "quit", label: "Quit" },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

/* ───────────────────────── Notifications ───────────────────────── */

function NotificationsTab() {
  const n = usePrefs((s) => s.prefs.notifications);
  const update = usePrefs((s) => s.update);
  const [testResult, setTestResult] = useState<string | null>(null);
  const off = !n.enabled;

  async function sendTest() {
    setTestResult(null);
    const ok = await osNotify("updates", "Helios", "Desktop notifications are working.", { force: true });
    setTestResult(ok ? "Sent." : "Couldn't send — check the OS notification permission for Helios.");
  }

  return (
    <>
      <Section title="Desktop notifications">
        <Row label="Show desktop notifications" hint="Master switch. In-app banners are never affected.">
          <Switch label="Show desktop notifications" checked={n.enabled} onChange={(v) => update({ notifications: { enabled: v } })} />
        </Row>
        <Row label="Vault sync warnings" hint="A synced file was deleted or changed locally in a way Helios can't reconcile.">
          <Switch label="Vault sync warnings" checked={n.vault} disabled={off} onChange={(v) => update({ notifications: { vault: v } })} />
        </Row>
        <Row label="App updates" hint="When a new Helios version has downloaded and is ready to install.">
          <Switch label="App updates" checked={n.updates} disabled={off} onChange={(v) => update({ notifications: { updates: v } })} />
        </Row>
      </Section>
      <Section title="Quiet hours" hint="Desktop notifications are held during this window (local time). Wraps midnight when the end is earlier than the start.">
        <Row label="Enable quiet hours">
          <Switch label="Enable quiet hours" checked={n.quiet.enabled} disabled={off} onChange={(v) => update({ notifications: { quiet: { enabled: v } } })} />
        </Row>
        <Row label="From / until">
          <div className="flex items-center gap-2 text-xs">
            <input
              type="time"
              aria-label="Quiet hours start"
              value={n.quiet.start}
              disabled={off || !n.quiet.enabled}
              onChange={(e) => e.target.value && update({ notifications: { quiet: { start: e.target.value } } })}
              className="rounded-sm border border-helios-line bg-helios-panel px-1.5 py-0.5 font-mono-num text-xs text-helios-text focus:border-asu-gold focus:outline-none disabled:opacity-40"
            />
            <span className="text-helios-dim">to</span>
            <input
              type="time"
              aria-label="Quiet hours end"
              value={n.quiet.end}
              disabled={off || !n.quiet.enabled}
              onChange={(e) => e.target.value && update({ notifications: { quiet: { end: e.target.value } } })}
              className="rounded-sm border border-helios-line bg-helios-panel px-1.5 py-0.5 font-mono-num text-xs text-helios-text focus:border-asu-gold focus:outline-none disabled:opacity-40"
            />
          </div>
        </Row>
      </Section>
      <div className="flex items-center gap-3">
        <SmallButton onClick={() => void sendTest()}>Send a test notification</SmallButton>
        {testResult && <span className="text-xs text-helios-dim" role="status">{testResult}</span>}
      </div>
    </>
  );
}

/* ───────────────────────── Data ───────────────────────── */

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function countPmSnapshots(): number {
  try {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(PM_SNAPSHOT_PREFIX)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

function DataTab({ onGoToVaultSettings, onClose }: { onGoToVaultSettings: () => void; onClose: () => void }) {
  const [cfdDir, setCfdDir] = useState<string | null>(() => readLocal(CFD_DIR_KEY));
  const [snapshots, setSnapshots] = useState(countPmSnapshots);
  const [msg, setMsg] = useState<string | null>(null);

  async function pickCfdDir() {
    try {
      const r = await openDirDialog({ directory: true, multiple: false });
      if (typeof r === "string") {
        localStorage.setItem(CFD_DIR_KEY, r);
        setCfdDir(r);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }
  function clearCfdDir() {
    try { localStorage.removeItem(CFD_DIR_KEY); } catch { /* ignore */ }
    setCfdDir(null);
  }
  function clearPmSnapshots() {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(PM_SNAPSHOT_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
      setSnapshots(0);
      setMsg(`Cleared ${keys.length} cached workspace${keys.length === 1 ? "" : "s"}. PM re-pulls from the server on its next open.`);
    } catch {
      setMsg("Couldn't clear the cache.");
    }
  }
  async function revealAppData() {
    try {
      const dir = await appLocalDataDir();
      await invoke("reveal_in_explorer", { path: dir });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <Section title="Folders">
        <Row label="Vault sync folder & SOLIDWORKS add-in" hint="Managed in Vault → Settings.">
          <SmallButton onClick={() => { onClose(); onGoToVaultSettings(); }}>Open Vault settings →</SmallButton>
        </Row>
        <Row label="CFD team data folder" hint={cfdDir ? <span className="break-all font-mono-num">{cfdDir}</span> : "Not set — the CFD Performance tab asks on first use."}>
          <div className="flex gap-2">
            <SmallButton onClick={() => void pickCfdDir()}>Change…</SmallButton>
            {cfdDir && <SmallButton onClick={clearCfdDir}>Clear</SmallButton>}
          </div>
        </Row>
      </Section>
      <Section title="Local cache" hint="Safe to clear; nothing here is the only copy of anything.">
        <Row label="PM workspace cache" hint={snapshots > 0 ? `${snapshots} cached workspace${snapshots === 1 ? "" : "s"} for instant open.` : "Empty."}>
          <SmallButton onClick={clearPmSnapshots} disabled={snapshots === 0} tone="danger">Clear</SmallButton>
        </Row>
        <Row label="App data folder" hint="Scan cache, plugin bundles, logs.">
          <SmallButton onClick={() => void revealAppData()}>Show in {IS_MAC ? "Finder" : "Explorer"}</SmallButton>
        </Row>
      </Section>
      {msg && <p className="text-xs text-helios-dim" role="status">{msg}</p>}
    </>
  );
}

/* ───────────────────────── Shortcuts ───────────────────────── */

function ShortcutsTab() {
  return (
    <>
      {SHORTCUT_GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.items.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-2">
              <span className="min-w-0 truncate text-sm text-helios-text">{s.label}</span>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((k, j) => <KeyChip key={j}>{k}</KeyChip>)}
              </span>
            </div>
          ))}
        </Section>
      ))}
      <p className="text-xs text-helios-dim">Press <KeyChip>?</KeyChip> in Logs for the overlay version.</p>
    </>
  );
}

/* ───────────────────────── About ───────────────────────── */

function updaterLine(u: UpdaterApi["state"]): string {
  switch (u.kind) {
    case "checking": return "Checking for updates…";
    case "up_to_date": return "You're on the latest version.";
    case "available": return `v${u.update.version} is available.`;
    case "downloading": return `Downloading v${u.update.version}…`;
    case "installing": return `Installing v${u.update.version}…`;
    case "installed": return `v${u.version} installed — restart to finish.`;
    case "offline": return "Couldn't reach the update server.";
    default: return "";
  }
}

function AboutTab({ appVersion, updater, onOpenUpdate, onOpenReport, account, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const platform = IS_WINDOWS ? "Windows" : IS_MAC ? "macOS" : "Linux";
  const u = updater.state;
  const actionable = u.kind === "available" || u.kind === "downloading" || u.kind === "installing" || u.kind === "installed";

  async function copyDiagnostics() {
    const lines = [
      `Helios v${appVersion} · ${platform}`,
      `UA: ${navigator.userAgent}`,
      `User: ${account?.email ?? "(signed out)"} ${account?.id ?? ""} ${account?.role ? `· ${account.role}` : ""}`,
      `Updater: ${updaterLine(u)}`,
      `Time: ${new Date().toISOString()}`,
      "",
      "Last error:",
      JSON.stringify(getLastError(), null, 1),
      "",
      "Recent breadcrumbs:",
      ...getBreadcrumbs().slice(-20).map((b) => `  ${b.category}: ${b.message}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <div className="font-helios text-3xl leading-none text-asu-gold">HELIOS</div>
        <div className="text-xs text-helios-dim">
          <div className="text-sm text-helios-text">Version {appVersion} · {platform}</div>
          <div>Sun Devil Motorsports · Ground Station</div>
        </div>
      </div>
      <Section title="Updates">
        <Row label={updaterLine(u)} hint={u.kind === "offline" ? u.error : undefined}>
          {actionable ? (
            <SmallButton onClick={() => { onClose(); onOpenUpdate(); }}>{u.kind === "installed" ? "Restart" : "Install…"}</SmallButton>
          ) : (
            <SmallButton onClick={updater.recheck} disabled={u.kind === "checking"}>Check for updates</SmallButton>
          )}
        </Row>
      </Section>
      <Section title="Account">
        <Row label={account?.email ?? "Signed out"} hint={account?.role ?? undefined}>
          <span className="font-mono-num text-[10px] text-helios-dim/70">{account?.id ? account.id.slice(0, 8) : ""}</span>
        </Row>
      </Section>
      <Section title="Support">
        <Row label="Report a bug or request a feature" hint="Goes straight to the Helios maintainers with your recent activity attached.">
          <SmallButton onClick={() => { onClose(); onOpenReport("bug"); }}>Report…</SmallButton>
        </Row>
        <Row label="Copy diagnostics" hint="Version, platform, account, last error and recent activity — paste into a message.">
          <SmallButton onClick={() => void copyDiagnostics()}>{copied ? "Copied ✓" : "Copy"}</SmallButton>
        </Row>
        <Row label="Release notes" hint="What changed in each version.">
          <SmallButton onClick={() => void invoke("open_external_url", { url: RELEASES_URL }).catch(() => {})}>Open on GitHub ↗</SmallButton>
        </Row>
      </Section>
    </>
  );
}
