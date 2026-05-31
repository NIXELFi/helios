import { useEffect, useState } from "react";
import { useActiveVault } from "../data/useActiveVault";
import { broadcastDownloadMode, type DownloadMode } from "../data/useDownloadMode";
import type { Vault } from "../data/types";
import { DEVICE_NOUN } from "../../../lib/platform";

const STORAGE_KEY = "helios.vault.downloadMode";
const WELCOMED_KEY = "helios.vault.downloadMode.welcomed";

type Map = Record<string, DownloadMode>;

function readMap(): Map {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj as Map : {};
  } catch { return {}; }
}

/**
 * First-run modal that asks "auto-sync vs manual-download" per vault.
 *
 * Shows once per device, the first time the user opens Helios with at least
 * one accessible vault that doesn't yet have a download-mode entry. After the
 * user clicks Save, we set `helios.vault.downloadMode.welcomed = true` so
 * future new vaults silently default to 'auto' without prompting again.
 */
export function DownloadModeWelcome() {
  const { vaults, loading } = useActiveVault();
  const welcomed = (() => {
    try { return localStorage.getItem(WELCOMED_KEY) === "true"; } catch { return false; }
  })();

  // Local pending choices keyed by vault id. Initialized once from stored map
  // + 'manual' default for vaults present on first mount. We must NOT clobber
  // user picks on every `vaults` identity change (refetch / realtime tick
  // produces a new array reference but the same vault ids). Default is
  // manual to match useDownloadMode — on a Mac with SolidWorks-heavy vaults
  // pulling everything is rarely what the user wants.
  const [choices, setChoices] = useState<Map>(() => {
    const stored = readMap();
    const next: Map = { ...stored };
    for (const v of vaults) {
      if (!(v.id in next)) next[v.id] = "manual";
    }
    return next;
  });

  // When the vault list grows (new vault becomes accessible mid-session),
  // add a 'manual' default for each new id but leave existing picks alone.
  useEffect(() => {
    setChoices((prev) => {
      let changed = false;
      const next: Map = { ...prev };
      for (const v of vaults) {
        if (!(v.id in next)) {
          next[v.id] = "manual";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [vaults]);
  // We can't read welcomed reactively (it's just a string in localStorage),
  // so after Save we toggle local state to unmount the modal until next reload.
  // This hook MUST come before any conditional returns to satisfy the
  // Rules of Hooks — putting it after the early returns crashed the whole
  // Vault screen to a black render on first mount.
  const [forceHide, setForceHide] = useState(false);

  if (loading || welcomed) return null;
  if (vaults.length === 0) return null;
  if (forceHide) return null;

  function save() {
    try {
      const merged: Map = { ...readMap(), ...choices };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      localStorage.setItem(WELCOMED_KEY, "true");
      // Notify same-window useDownloadMode instances with the merged map.
      // We previously dispatched a synthetic StorageEvent without `newValue`,
      // which the listener read as "key cleared" and wiped every vault's mode
      // to {} (audit H16). The broadcast carries the actual map; cross-window
      // siblings still get the native storage event from the writes above.
      broadcastDownloadMode(merged);
    } catch { /* private mode */ }
    setForceHide(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-[36rem] max-w-[90vw] rounded-lg border border-helios-line bg-helios-panel p-6 shadow-2xl">
        <h2 className="mb-2 text-lg font-semibold text-helios-text">
          Choose how each vault syncs to this {DEVICE_NOUN}
        </h2>
        <p className="mb-5 text-sm text-helios-dim">
          <span className="text-helios-text">Auto</span> downloads every file in the vault to your
          local folder in the background — best when you regularly open the file types in that
          vault. <span className="text-helios-text">Manual</span> shows the file list but only
          downloads bytes when you click — best when you can't open the file types on this machine
          (e.g. SolidWorks parts on a {DEVICE_NOUN}). You can change this any time in Settings.
        </p>
        <div className="mb-5 space-y-2">
          {vaults.map((v: Vault) => (
            <div key={v.id} className="flex items-center justify-between rounded border border-helios-line bg-helios-base px-3 py-2">
              <span className="truncate text-sm text-helios-text">{v.name}</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setChoices((c) => ({ ...c, [v.id]: "auto" }))}
                  className={
                    "rounded px-3 py-1 text-xs " +
                    (choices[v.id] === "auto"
                      ? "bg-asu-gold text-white"
                      : "border border-helios-line text-helios-dim hover:bg-helios-line hover:text-helios-text")
                  }
                >
                  Auto
                </button>
                <button
                  type="button"
                  onClick={() => setChoices((c) => ({ ...c, [v.id]: "manual" }))}
                  className={
                    "rounded px-3 py-1 text-xs " +
                    (choices[v.id] === "manual"
                      ? "bg-asu-gold text-white"
                      : "border border-helios-line text-helios-dim hover:bg-helios-line hover:text-helios-text")
                  }
                >
                  Manual
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            className="rounded bg-asu-gold px-4 py-1.5 text-sm text-white hover:bg-asu-gold"
          >
            Save and continue
          </button>
        </div>
      </div>
    </div>
  );
}
