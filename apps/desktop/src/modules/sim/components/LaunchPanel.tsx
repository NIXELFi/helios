import { useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconDeviceGamepad,
  IconDownload,
  IconFolderOpen,
  IconLock,
  IconPlayerPlayFilled,
  IconRefresh,
  IconUserCheck,
} from "@tabler/icons-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  PROFILES, TRACKS, fmtBytes, onSimInstallProgress, simAvailableBuild, simInstall, simLaunch,
  simSetExePath,
  simStatus,
  type LaunchRequest, type SimBuild, type SimStatus, type TrackId,
} from "../api";

const PREFS_KEY = "helios:sim:launch";

interface LaunchPrefs {
  track: TrackId;
  profile: string;
  session: string;
  traction: boolean;
  abs: boolean;
  autoShift: boolean;
  autostart: boolean;
  windowed: boolean;
  record: boolean;
}

const DEFAULTS: LaunchPrefs = {
  track: "autocross",
  profile: "wheel",
  session: "",
  // Off by default because the real car has none of them, and a time set with
  // any of them on does not go on the board.
  traction: false,
  abs: false,
  autoShift: false,
  autostart: true,
  windowed: false,
  record: true,
};

/**
 * The launch settings, as last left.
 *
 * Exported because `SimHome.chase` starts a drive too, and used to re-read
 * and re-default this same key by hand -- two descriptions of one thing that
 * agreed only by coincidence.
 */
export function readLaunchPrefs(): LaunchPrefs {
  return readPrefs();
}

function readPrefs(): LaunchPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LaunchPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function writePrefs(p: LaunchPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // ignore (private mode / quota)
  }
}

interface Props {
  status: SimStatus | null;
  /** The signed-in driver. Null when nobody is signed in, which is the one
   *  state in which a run cannot be started at all. */
  driver: { id: string; name: string } | null;
  onStatusChange: (s: SimStatus) => void;
  onLaunched: () => void;
}

export function LaunchPanel({ status, driver, onStatusChange, onLaunched }: Props) {
  const [prefs, setPrefs] = useState<LaunchPrefs>(readPrefs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  function set<K extends keyof LaunchPrefs>(key: K, value: LaunchPrefs[K]) {
    setPrefs((p) => {
      const next = { ...p, [key]: value };
      writePrefs(next);
      return next;
    });
  }

  async function launch() {
    if (!driver) return;
    setBusy(true);
    setError(null);
    setSent(null);
    const req: LaunchRequest = {
      track: prefs.track,
      profile: prefs.profile,
      driver: driver.name,
      driverId: driver.id,
      session: prefs.session.trim() || undefined,
      traction: prefs.traction,
      abs: prefs.abs,
      autoShift: prefs.autoShift,
      autostart: prefs.autostart,
      windowed: prefs.windowed,
      noRecord: !prefs.record,
    };
    try {
      const res = await simLaunch(req);
      setSent(`${TRACKS.find((t) => t.id === prefs.track)?.name ?? prefs.track} · pid ${res.pid}`);
      onLaunched();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickExe() {
    // Inside the try as well: the dialog itself can reject (no permission, no
    // window), and a rejection out here is an unhandled one that tells the
    // user nothing at all.
    let picked: unknown;
    try {
      picked = await openDialog({
        multiple: false,
        title: "Where is the simulator?",
        filters: [{ name: "Simulator", extensions: ["exe"] }],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (typeof picked !== "string") return;
    try {
      onStatusChange(await simSetExePath(picked));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const ready = !!status?.exePath;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
      {!ready && <NotFound status={status} onPick={pickExe} onStatusChange={onStatusChange} />}
      {ready && <UpdateBanner status={status} onStatusChange={onStatusChange} />}

      <section className="rounded-lg border border-helios-line bg-helios-panel p-5">
        <h3 className="mb-1 text-sm font-semibold">Start a run</h3>
        <p className="mb-4 text-xs text-helios-dim">
          The simulator records everything at 100&nbsp;Hz and files it here. Put a name on
          it and the time goes on the board.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Driver" hint="from your Helios account">
            <div
              className={
                "flex items-center gap-2 rounded border px-2.5 py-1.5 text-sm " +
                (driver
                  ? "border-helios-line bg-helios-deep"
                  : "border-helios-danger/40 bg-helios-danger/10 text-helios-danger")
              }
            >
              {driver ? (
                <>
                  <IconUserCheck size={15} className="shrink-0 text-helios-success" />
                  <span className="truncate">{driver.name}</span>
                </>
              ) : (
                <>
                  <IconLock size={15} className="shrink-0" />
                  <span>Not signed in</span>
                </>
              )}
            </div>
          </Field>
          <Field label="Session" hint="optional">
            <input
              className={inputCls}
              value={prefs.session}
              placeholder="e.g. Tuesday test, rear ARB stiff"
              maxLength={96}
              onChange={(e) => set("session", e.target.value)}
            />
          </Field>
          <Field label="Course">
            <select
              className={inputCls}
              value={prefs.track}
              onChange={(e) => set("track", e.target.value as TrackId)}
            >
              {TRACKS.map((t) => (
                <option key={t.id} value={t.id}>{t.name} — {t.detail}</option>
              ))}
            </select>
          </Field>
          <Field label="Controls">
            <select
              className={inputCls}
              value={prefs.profile}
              onChange={(e) => set("profile", e.target.value)}
            >
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Check
            label="Traction control"
            hint="The real car has none. A time set with it on is not ranked."
            checked={prefs.traction}
            onChange={(v) => set("traction", v)}
          />
          <Check
            label="ABS"
            hint="Same: not ranked."
            checked={prefs.abs}
            onChange={(v) => set("abs", v)}
          />
          <Check
            label="Automatic gearbox"
            hint="Shifts at the torque crossover. Not ranked."
            checked={prefs.autoShift}
            onChange={(v) => set("autoShift", v)}
          />
          <Check
            label="Record the run"
            hint="Off means this drive is not logged anywhere."
            checked={prefs.record}
            onChange={(v) => set("record", v)}
          />
          <Check
            label="Go straight to the grid"
            hint="Skip the simulator's own launch screen."
            checked={prefs.autostart}
            onChange={(v) => set("autostart", v)}
          />
          <Check
            label="Windowed"
            hint="A 1600×900 window instead of filling the screen."
            checked={prefs.windowed}
            onChange={(v) => set("windowed", v)}
          />
        </div>

        {/* Free roam has no finish line, so `Timing` never completes a lap and
            the recorder never files anything. Better said here than discovered
            twenty minutes later as "the simulator closed without filing a
            run". */}
        {prefs.track === "mis" && (
          <p className="mt-4 flex items-start gap-2 rounded border border-helios-warn/30 bg-helios-warn/10 px-3 py-2 text-xs text-helios-warn">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
            Free roam has no timed lap, so this run will not be filed and will not appear
            in the archive. Pick Autocross or Endurance for a time.
          </p>
        )}

        {!prefs.record && (
          <p className="mt-4 flex items-start gap-2 rounded border border-helios-warn/30 bg-helios-warn/10 px-3 py-2 text-xs text-helios-warn">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
            Recording is off — this run will leave no telemetry and no lap time.
          </p>
        )}

        {!driver && (
          <p className="mt-4 flex items-start gap-2 rounded border border-helios-danger/30 bg-helios-danger/10 px-3 py-2 text-xs text-helios-danger">
            <IconLock size={14} className="mt-0.5 shrink-0" />
            <span>
              Sign in to drive. A lap time is a claim about a person, so the driver is
              your Helios account rather than something typed into a box &mdash; which is
              what lets the leaderboard trust it.
            </span>
          </p>
        )}

        <div className="mt-5 flex items-center gap-3">
          <button
            className="inline-flex items-center gap-2 rounded bg-asu-gold px-4 py-2 text-sm font-semibold text-helios-on-gold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!ready || busy || !driver}
            title={driver ? undefined : "Sign in to Helios to start a run"}
            onClick={() => void launch()}
          >
            <IconPlayerPlayFilled size={15} />
            {busy ? "Starting…" : "Launch simulator"}
          </button>
          {sent && <span className="text-xs text-helios-success">Running — {sent}</span>}
          {error && <span className="text-xs text-helios-danger">{error}</span>}
        </div>
      </section>

      <section className="rounded-lg border border-helios-line bg-helios-panel p-5">
        <h3 className="mb-1 text-sm font-semibold">Set up in the simulator, not here</h3>
        <p className="text-xs leading-relaxed text-helios-dim">
          Helios decides what a run <em>is</em> — who, which course, which aids. How the
          rig <em>feels</em> belongs to the simulator, because those are numbers you can
          only get right with the wheel in your hands: the control mapping and rotation,
          force-feedback gain, pedal calibration, the throttle map, the camera. Set them
          on the simulator&rsquo;s own Controls and Car tabs and they stay with that rig.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-helios-muted">
          What you choose here applies to the run you launch and is not written over the
          rig&rsquo;s own settings — so launching as yourself doesn&rsquo;t leave the next
          person driving under your name.
        </p>
      </section>

      <SimLocation status={status} onPick={pickExe} onStatusChange={onStatusChange} />
    </div>
  );
}

/**
 * Ask the feed what it has, once.
 *
 * Shared by the not-installed panel and the update banner, because they used
 * NOT to be: the feed was only ever consulted when no simulator could be
 * found, so once you had one Helios never looked again and there was no way
 * to get a newer build except deleting the one you had. A fix published to
 * the feed could not reach anybody who had already installed.
 */
function useAvailableBuild(enabled: boolean) {
  const [build, setBuild] = useState<SimBuild | null>(null);
  const [checking, setChecking] = useState(enabled);
  const [feedError, setFeedError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setChecking(true);
    simAvailableBuild()
      .then((b) => { if (!cancelled) setBuild(b); })
      .catch((e) => { if (!cancelled) setFeedError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [enabled]);
  return { build, checking, feedError, setFeedError };
}

/**
 * Download and install one build, with progress.
 *
 * Returns the click handler and what to put on the button, so the first-run
 * panel and the update banner behave identically -- including the progress,
 * which is the whole reason a 7 MB download does not look like a hang.
 */
function useInstaller(onStatusChange: (s: SimStatus) => void, onError: (m: string | null) => void) {
  const [installing, setInstalling] = useState(false);
  const [got, setGot] = useState(0);

  async function install(build: SimBuild) {
    setInstalling(true);
    setGot(0);
    onError(null);
    const off = onSimInstallProgress((p) => setGot(p.bytes));
    try {
      await simInstall(build.version);
      onStatusChange(await simStatus());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      off();
      setInstalling(false);
    }
  }

  const label = (build: SimBuild | null, idle: string) => {
    if (!installing) return idle;
    const pct = build?.bytes ? Math.min(100, (got / build.bytes) * 100) : null;
    return pct != null ? `Downloading… ${pct.toFixed(0)}%` : `Downloading… ${fmtBytes(got)}`;
  };
  const pct = (build: SimBuild | null) =>
    installing && build?.bytes ? Math.min(100, (got / build.bytes) * 100) : null;

  return { install, installing, label, pct };
}

/** What `fsae-sim --version` prints, reduced to the version itself. */
export function installedVersion(status: SimStatus | null): string | null {
  const raw = status?.version?.trim();
  if (!raw) return null;
  return raw.split(/\s+/).pop() ?? null;
}

/**
 * The feed has something other than what is installed.
 *
 * Not "newer": this compares for DIFFERENCE, not order. Rolling back to a
 * build that is known to work at an event is a real thing to want, and a
 * version comparison that refused to offer it would be wrong in the moment it
 * mattered most. The banner says both versions and lets the driver decide.
 */
function UpdateBanner({
  status, onStatusChange,
}: { status: SimStatus | null; onStatusChange: (s: SimStatus) => void }) {
  const { build, feedError, setFeedError } = useAvailableBuild(true);
  const { install, installing, label, pct } = useInstaller(onStatusChange, setFeedError);
  const have = installedVersion(status);

  if (!build || !have || build.version === have) return null;
  const p = pct(build);
  return (
    <section className="rounded-lg border border-asu-gold/40 bg-asu-gold/10 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <IconDownload size={18} className="shrink-0 text-asu-gold" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            Simulator {build.version} is available
          </h3>
          <p className="mt-0.5 text-xs text-helios-dim">
            You have {have}
            {build.bytes ? ` · ${fmtBytes(build.bytes)} to download` : ""}
            {status?.exeConfigured ? "" : " · currently using a copy found on this machine"}
            {build.notes ? ` — ${build.notes}` : ""}
          </p>
          {feedError && <p className="mt-1 text-xs text-helios-danger">{feedError}</p>}
        </div>
        {p != null && (
          <span className="h-1 w-24 overflow-hidden rounded bg-helios-line" aria-hidden>
            <span className="block h-full bg-asu-gold transition-[width]" style={{ width: `${p}%` }} />
          </span>
        )}
        <button
          className="shrink-0 rounded bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-on-gold transition hover:brightness-110 disabled:opacity-50"
          disabled={installing}
          onClick={() => void install(build)}
        >
          {label(build, `Update to ${build.version}`)}
        </button>
      </div>
    </section>
  );
}

function NotFound({
  status, onPick, onStatusChange,
}: { status: SimStatus | null; onPick: () => void; onStatusChange: (s: SimStatus) => void }) {
  const [showPaths, setShowPaths] = useState(false);
  const { build, checking, feedError, setFeedError } = useAvailableBuild(true);
  const { install: doInstall, installing, label, pct } = useInstaller(onStatusChange, setFeedError);

  const shown = pct(build);

  return (
    <section className="rounded-lg border border-helios-warn/40 bg-helios-warn/10 p-5">
      <div className="flex items-start gap-3">
        <IconDeviceGamepad size={20} className="mt-0.5 shrink-0 text-helios-warn" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">The simulator is not installed here</h3>
          <p className="mt-1 text-xs text-helios-dim">
            Helios does not ship with it &mdash; a driving simulator is not something
            everyone wants inside their installer. You can still browse, analyse and
            compare runs that are already recorded; launching and replaying need the
            executable.
          </p>
          {build && (
            <p className="mt-2 text-xs text-helios-dim">
              Version <span className="font-mono">{build.version}</span> is available
              {build.bytes ? " (" + fmtBytes(build.bytes) + ")" : ""}. It downloads once and
              is checked against its SHA-256 before anything is installed.
              {build.notes ? " " + build.notes : ""}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {build && (
              <button
                className="inline-flex items-center gap-2 rounded bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-on-gold transition hover:brightness-110 disabled:opacity-50"
                disabled={installing}
                onClick={() => void doInstall(build)}
              >
                <IconDownload size={14} />
                {label(build, "Install the simulator")}
              </button>
            )}
            {shown != null && (
              <span className="h-1 w-32 overflow-hidden rounded bg-helios-line" aria-hidden>
                <span className="block h-full bg-asu-gold transition-[width]" style={{ width: `${shown}%` }} />
              </span>
            )}
            {checking && <span className="text-xs text-helios-muted">Checking for a build…</span>}
            <button
              className="inline-flex items-center gap-2 rounded border border-helios-line bg-helios-panel px-3 py-1.5 text-xs transition hover:border-asu-gold"
              onClick={onPick}
            >
              <IconFolderOpen size={14} /> Point Helios at it
            </button>
            {status && status.searched.length > 0 && (
              <button
                className="text-xs text-helios-dim underline decoration-dotted"
                onClick={() => setShowPaths((s) => !s)}
              >
                {showPaths ? "hide" : "show"} where it looked
              </button>
            )}
          </div>
          {feedError && (
            <p className="mt-2 text-xs text-helios-muted">
              No build feed reachable ({feedError}). Build it from the{" "}
              <span className="font-mono">fsae-sim</span> repo, or point Helios at a copy.
            </p>
          )}
          {showPaths && status && (
            <ul className="mt-3 max-h-40 overflow-y-auto font-mono text-[11px] leading-relaxed text-helios-muted">
              {status.searched.map((p) => <li key={p} className="truncate">{p}</li>)}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function SimLocation({
  status, onPick, onStatusChange,
}: { status: SimStatus | null; onPick: () => void; onStatusChange: (s: SimStatus) => void }) {
  // "Forget it and search again" writes to disk, so it can fail -- a read-only
  // config directory, a locked file. Discarding the rejection left the button
  // looking like it had worked while the path it was meant to clear was still
  // there, and the only trace was an unhandled rejection in a console nobody
  // has open.
  const [forgetError, setForgetError] = useState<string | null>(null);
  if (!status) return null;
  return (
    <section className="rounded-lg border border-helios-line bg-helios-panel p-5">
      <h3 className="mb-3 text-sm font-semibold">Where things are</h3>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[110px_1fr]">
        <dt className="text-helios-dim">Simulator</dt>
        <dd className="min-w-0 break-all font-mono text-[11px]">
          {status.exePath ?? <span className="font-sans text-helios-warn">not found</span>}
          {status.version && <span className="ml-2 font-sans text-helios-dim">{status.version}</span>}
          {status.exeConfigured && <span className="ml-2 font-sans text-helios-dim">(set by you)</span>}
        </dd>
        <dt className="text-helios-dim">Runs</dt>
        <dd className="min-w-0 break-all font-mono text-[11px]">
          {status.runsDir}
          <span className="ml-2 font-sans text-helios-dim">
            {status.runCount} run{status.runCount === 1 ? "" : "s"}
          </span>
        </dd>
      </dl>
      <div className="mt-4 flex gap-2">
        <button
          className="inline-flex items-center gap-2 rounded border border-helios-line px-3 py-1.5 text-xs transition hover:border-asu-gold"
          onClick={onPick}
        >
          <IconFolderOpen size={14} /> Choose the executable
        </button>
        {status.exeConfigured && (
          <button
            className="inline-flex items-center gap-2 rounded border border-helios-line px-3 py-1.5 text-xs transition hover:border-asu-gold"
            onClick={() => {
              simSetExePath(null)
                .then(onStatusChange)
                .catch((e) => setForgetError(e instanceof Error ? e.message : String(e)));
            }}
          >
            <IconRefresh size={14} /> Forget it and search again
          </button>
        )}
      </div>
      {forgetError && <p className="mt-2 text-xs text-helios-danger">{forgetError}</p>}
    </section>
  );
}

const inputCls =
  "w-full rounded border border-helios-line bg-helios-deep px-2.5 py-1.5 text-sm text-helios-text outline-none transition focus:border-asu-gold";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-helios-dim">
        {label}
        {hint && <span className="ml-1 text-helios-muted">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

function Check({
  label, hint, checked, onChange,
}: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded border border-helios-line px-3 py-2 transition hover:border-helios-dim">
      <input
        type="checkbox"
        className="mt-0.5 accent-asu-gold"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] leading-snug text-helios-muted">{hint}</span>
      </span>
    </label>
  );
}
