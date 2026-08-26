import { useMemo } from "react";
import { IconAlertTriangle, IconLock, IconLoader2, IconShieldCheck } from "@tabler/icons-react";
import { PermissionList } from "../../components/PermissionList";
import { describeDiff, type PermissionDiff } from "../permissionDiff";
import type { PackedBundle } from "../usePublish";
import type { ExplainedError } from "../publishErrors";
import type { Subteam } from "../../../org/data/useOrgData";
import type { HelpTopic } from "../../authoring/helpContent";

/** Step 3 — the last look before submitting. Two things earn the space here: who
 *  will own the plugin, and what changed about the permissions. */
export function ConfirmStep({
  packed,
  diff,
  isNewPlugin,
  lockedSubteam,
  publishableSubteams,
  selectedSubteam,
  onSelectSubteam,
  busy,
  error,
  onHelp,
}: {
  packed: PackedBundle;
  diff: PermissionDiff | null;
  isNewPlugin: boolean;
  lockedSubteam: string | null;
  publishableSubteams: Subteam[];
  selectedSubteam: string | null;
  onSelectSubteam: (id: string | null) => void;
  busy: boolean;
  error: ExplainedError | null;
  onHelp: (t: HelpTopic) => void;
}) {
  const owner = useMemo(
    () => publishableSubteams.find((s) => s.id === lockedSubteam) ?? null,
    [publishableSubteams, lockedSubteam],
  );
  const reviewerSubteam =
    (isNewPlugin
      ? publishableSubteams.find((s) => s.id === selectedSubteam)?.name
      : owner?.name) ?? "your subteam";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-helios-text">Ready to submit</h3>
        <p className="mt-1 text-xs leading-relaxed text-helios-dim">
          Submitting sends{" "}
          <span className="font-mono text-helios-text">
            {packed.manifest.name} {packed.manifest.version}
          </span>{" "}
          for review. It is not released until someone approves it.
        </p>
      </div>

      {isNewPlugin ? (
        <div>
          <label
            htmlFor="publish-subteam"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-helios-dim"
          >
            Owning subteam
          </label>
          <select
            id="publish-subteam"
            value={selectedSubteam ?? ""}
            onChange={(e) => onSelectSubteam(e.target.value || null)}
            className="w-full rounded-sm border border-helios-line bg-helios-base px-3 py-2 text-xs text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            <option value="">Select a subteam…</option>
            {publishableSubteams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-helios-dim">
            This is permanent — a plugin cannot be moved between subteams later. Only subteams you can
            publish to are listed.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-sm border border-helios-line bg-helios-base p-3">
          <IconLock size={14} className="mt-0.5 shrink-0 text-helios-dim" />
          <div className="text-[11px] leading-relaxed text-helios-text/90">
            Owned by <span className="font-semibold">{owner?.name ?? "its original subteam"}</span>. An
            existing plugin keeps its owner — this is a new version of something already published.
          </div>
        </div>
      )}

      {diff && (
        <div className="rounded-sm border border-helios-line bg-helios-base p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
            Permissions
          </div>
          <p className="mb-2 text-[11px] text-helios-text/90">{describeDiff(diff)}</p>

          {diff.addsHighTrust && (
            <div className="mb-2 flex items-start gap-2 rounded-sm border border-helios-danger/50 bg-helios-danger/15 p-2.5">
              <IconAlertTriangle size={15} className="mt-0.5 shrink-0 text-helios-danger" />
              <div className="text-[11px] leading-relaxed text-helios-text/90">
                This version asks for a <span className="font-semibold">high-trust</span> permission that
                reaches outside the sandbox. Expect your reviewer to ask what it is for.
              </div>
            </div>
          )}

          {diff.added.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-asu-gold">
                New in this version
              </div>
              <PermissionList permissions={diff.added} />
            </div>
          )}
          {diff.unchanged.length > 0 && (
            <div className="mb-2 text-[11px] text-helios-dim">
              Already approved: {diff.unchanged.join(", ")}
            </div>
          )}
          {diff.removed.length > 0 && (
            <div className="text-[11px] text-helios-dim">
              No longer requested: {diff.removed.join(", ")}
            </div>
          )}
          {diff.identical && diff.added.length === 0 && diff.unchanged.length === 0 && (
            <div className="text-[11px] text-helios-dim">
              This plugin runs in a pure sandbox — it renders and computes, and that is all.
            </div>
          )}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-sm border border-helios-line bg-helios-base p-3">
        <IconShieldCheck size={14} className="mt-0.5 shrink-0 text-helios-dim" />
        <div className="text-[11px] leading-relaxed text-helios-text/90">
          A lead or VP of {reviewerSubteam} — someone other than you — reviews it before anyone can
          install it. You cannot approve your own submission, even if you have review rights.{" "}
          <button
            type="button"
            onClick={() => onHelp("review")}
            className="font-medium text-asu-gold underline-offset-2 hover:underline"
          >
            How review works
          </button>
        </div>
      </div>

      <details className="rounded-sm border border-helios-line bg-helios-base p-3">
        <summary className="cursor-pointer text-[11px] font-medium text-helios-dim">
          What exactly gets uploaded ({packed.entries.length} files)
        </summary>
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto font-mono text-[10px] text-helios-text/70">
          {packed.entries.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <div className="mt-2 break-all font-mono text-[10px] text-helios-dim">
          sha256 {packed.sha256}
        </div>
      </details>

      {error && (
        <div className="flex items-start gap-2 rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3">
          <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-helios-danger" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-helios-danger">{error.title}</div>
            <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-helios-text/90">
              {error.detail}
            </p>
            {error.helpTopic && (
              <button
                type="button"
                onClick={() => onHelp(error.helpTopic as HelpTopic)}
                className="mt-2 text-[11px] font-medium text-asu-gold underline-offset-2 hover:underline"
              >
                Read more
              </button>
            )}
          </div>
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 text-[11px] text-helios-dim">
          <IconLoader2 size={14} className="animate-spin" />
          Uploading and submitting…
        </div>
      )}
    </div>
  );
}
