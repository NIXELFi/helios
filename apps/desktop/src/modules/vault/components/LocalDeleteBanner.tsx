import { useEffect, useRef, useState } from "react";
import {
  onLocalDeleteBlocked,
  onLocalDeletesPropagated,
  onReaperHeldBack,
} from "../data/local-delete-events";
import { osNotify } from "../data/notify";

/**
 * Subscribes to local-deletion outcome events fired by useAutoSync (spec 2c):
 *
 * - "blocked": the user deleted a file locally that wasn't checked out. The
 *   sync pass restored it; this shows a persistent amber banner (styled like
 *   UnmatchedFilesBanner) prompting them to check it out first.
 *
 * - "propagated": the user deleted a locally-checked-out file; the sync pass
 *   soft-deleted it in the vault. This shows a transient green/gold success
 *   line that auto-dismisses after ~6 s.
 *
 * Both events also fire an OS desktop notification (best-effort — silent on
 * permission denial; the in-app banner is the guaranteed surface).
 *
 * Returns null when both lists are empty.
 */
/** How many names a banner shows before collapsing to "and N more". */
const NAMES_SHOWN = 5;

/**
 * A long file list without the wall of text: the first few names inline, the
 * rest behind "and N more", which expands into a capped, scrollable box. A
 * whole-folder restore (hundreds of files) used to dump every name into the
 * banner and push the vault off the screen.
 */
function NameList({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false);
  const rest = names.length - NAMES_SHOWN;
  if (rest <= 0) return <span className="font-mono-num">{names.join(", ")}</span>;
  return (
    <>
      <span className="font-mono-num">{names.slice(0, NAMES_SHOWN).join(", ")}</span>
      {" "}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="underline decoration-dotted underline-offset-2 hover:text-asu-gold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
      >
        {open ? "show less" : `and ${rest} more`}
      </button>
      {open && (
        <ul className="mt-1.5 max-h-40 overflow-auto rounded border border-[#FFB800]/30 bg-black/20 px-2 py-1 font-mono-num text-xs">
          {names.map((n) => (
            <li key={n} className="truncate" title={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function LocalDeleteBanner() {
  const [blockedNames, setBlockedNames] = useState<string[]>([]);
  const [propagatedNames, setPropagatedNames] = useState<string[]>([]);
  const [heldBackNames, setHeldBackNames] = useState<string[]>([]);

  // Auto-dismiss timer for the propagated (success) line.
  const propagatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubBlocked = onLocalDeleteBlocked((names) => {
      setBlockedNames((prev) => {
        const dedupe = new Set([...prev, ...names]);
        return Array.from(dedupe);
      });
      // OS toast — one per event batch; N=1 uses the singular form.
      const n = names.length;
      const body =
        n === 1
          ? `"${names[0]!}" was deleted locally but isn't checked out — restored from vault. Check out first to delete.`
          : `${n} files were missing locally and have been restored from the vault.`;
      void osNotify("Helios Vault", body);
    });

    const unsubPropagated = onLocalDeletesPropagated((names) => {
      setPropagatedNames((prev) => {
        const dedupe = new Set([...prev, ...names]);
        return Array.from(dedupe);
      });
      // Clear any existing auto-dismiss and start fresh.
      if (propagatedTimerRef.current !== null) {
        clearTimeout(propagatedTimerRef.current);
      }
      propagatedTimerRef.current = setTimeout(() => {
        setPropagatedNames([]);
        propagatedTimerRef.current = null;
      }, 6000);

      // OS toast.
      const n = names.length;
      const body =
        n === 1
          ? `"${names[0]!}" moved to Deleted.`
          : `${n} file(s) moved to Deleted.`;
      void osNotify("Helios Vault", body);
    });

    const unsubHeldBack = onReaperHeldBack((names) => {
      setHeldBackNames((prev) => {
        const dedupe = new Set([...prev, ...names]);
        return Array.from(dedupe);
      });
      const n = names.length;
      const body =
        n === 1
          ? `"${names[0]!}" was deleted in the vault but your local copy has unsaved changes — kept on disk.`
          : `${n} file(s) deleted in the vault had local changes — kept on disk.`;
      void osNotify("Helios Vault", body);
    });

    return () => {
      unsubBlocked();
      unsubPropagated();
      unsubHeldBack();
      if (propagatedTimerRef.current !== null) {
        clearTimeout(propagatedTimerRef.current);
      }
    };
  }, []);

  if (blockedNames.length === 0 && propagatedNames.length === 0 && heldBackNames.length === 0) return null;

  return (
    <>
      {blockedNames.length > 0 && (
        <div className="border-b border-[#FFB800]/50 bg-[#FFB800]/10 px-4 py-2 text-sm">
          <div className="flex items-start gap-3">
            <span className="flex-1 text-asu-gold/90">
              {blockedNames.length === 1 ? (
                <>
                  <span className="font-mono-num">{blockedNames[0]!}</span>
                  {" "}was deleted locally but isn&apos;t checked out — restored from vault. Check out first to delete.
                </>
              ) : (
                <>
                  {blockedNames.length} files were missing from your local folder and have been
                  restored from the vault. To delete a file from the vault, check it out first.{" "}
                  <NameList names={blockedNames} />
                </>
              )}
            </span>
            <button
              onClick={() => setBlockedNames([])}
              className="shrink-0 rounded border border-[#FFB800]/40 px-3 py-1 text-xs text-asu-gold/90 hover:bg-[#FFB800]/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {heldBackNames.length > 0 && (
        <div className="border-b border-[#FFB800]/50 bg-[#FFB800]/10 px-4 py-2 text-sm">
          <div className="flex items-start gap-3">
            <span className="flex-1 text-asu-gold/90">
              {heldBackNames.length === 1 ? (
                <>
                  <span className="font-mono-num">{heldBackNames[0]!}</span>
                  {" "}was deleted in the vault, but your local copy has unsaved changes — kept on disk. Restore the file from Deleted to keep working on it, or delete the local copy manually.
                </>
              ) : (
                <>
                  {heldBackNames.length} vault-deleted files had unsaved local changes — kept on disk. Restore them from Deleted or delete the local copies manually.{" "}
                  <NameList names={heldBackNames} />
                </>
              )}
            </span>
            <button
              onClick={() => setHeldBackNames([])}
              className="shrink-0 rounded border border-[#FFB800]/40 px-3 py-1 text-xs text-asu-gold/90 hover:bg-[#FFB800]/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {propagatedNames.length > 0 && (
        <div className="border-b border-asu-gold/30 bg-asu-gold/10 px-4 py-2 text-sm">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-asu-gold">
              Moved to Deleted:{" "}
              <span className="font-mono-num">{propagatedNames.join(", ")}</span>
            </span>
            <button
              onClick={() => {
                setPropagatedNames([]);
                if (propagatedTimerRef.current !== null) {
                  clearTimeout(propagatedTimerRef.current);
                  propagatedTimerRef.current = null;
                }
              }}
              className="shrink-0 rounded border border-asu-gold/40 px-3 py-1 text-xs text-asu-gold hover:bg-asu-gold/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
