// The Add to Marketplace wizard. Step chrome and navigation only — every decision
// it displays comes from usePublish, and every rule it enforces is enforced again
// server-side. Four steps, because the author is answering four questions: which
// folder, does it pass, who owns it, and what happens now.

import { useMemo, useState } from "react";
import { IconX, IconHelpCircle, IconArrowLeft, IconUpload } from "@tabler/icons-react";
import { useMyCapabilities, useSubteams } from "../../org/data/useOrgData";
import { HelpDrawer, useHelpDrawer } from "../authoring/HelpDrawer";
import { usePublish } from "./usePublish";
import { ChooseFolderStep } from "./steps/ChooseFolderStep";
import { PreflightStep } from "./steps/PreflightStep";
import { ConfirmStep } from "./steps/ConfirmStep";
import { SubmittedStep } from "./steps/SubmittedStep";

const STEP_LABELS = ["Choose", "Check", "Confirm"] as const;

export function SubmitWizard({ onClose, onPublished }: { onClose: () => void; onPublished?: () => void }) {
  const publish = usePublish();
  const help = useHelpDrawer();
  const { can } = useMyCapabilities();
  const { data: subteams } = useSubteams();
  const [selectedSubteam, setSelectedSubteam] = useState<string | null>(null);

  // Only subteams the caller can actually publish to. The RPC re-checks this, so
  // filtering here is about not offering a choice that would be rejected.
  const publishable = useMemo(
    () => subteams.filter((s) => can("marketplace.publish", s.id)),
    [subteams, can],
  );

  const stepIndex =
    publish.phase === "idle" || publish.phase === "packing"
      ? 0
      : publish.phase === "preflight"
        ? 1
        : 2;

  const subteamName =
    publishable.find((s) => s.id === (publish.lockedSubteam ?? selectedSubteam))?.name ??
    "your subteam";

  const needsSubteam = publish.isNewPlugin && !selectedSubteam;

  function finish() {
    onPublished?.();
    publish.reset();
    onClose();
  }

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add to Marketplace"
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16"
        onClick={onClose}
      >
        <div
          className="w-full max-w-2xl overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-helios-line px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-asu-gold">
                <IconUpload size={16} strokeWidth={1.75} />
                <h2 className="font-display text-sm tracking-wide">ADD TO MARKETPLACE</h2>
              </div>
              {publish.phase !== "done" && (
                <ol className="mt-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
                  {STEP_LABELS.map((label, i) => (
                    <li key={label} className="flex items-center gap-1.5">
                      <span
                        className={
                          i === stepIndex
                            ? "font-semibold text-asu-gold"
                            : i < stepIndex
                              ? "text-helios-success"
                              : "text-helios-dim"
                        }
                      >
                        {i + 1}. {label}
                      </span>
                      {i < STEP_LABELS.length - 1 && <span className="text-helios-line">/</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => help.openHelp()}
                aria-label="Open plugin author help"
                title="Help"
                className="rounded-sm p-1 text-helios-dim transition-colors hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                <IconHelpCircle size={17} />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-sm p-1 text-helios-dim transition-colors hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                <IconX size={16} />
              </button>
            </div>
          </div>

          <div className="max-h-[65vh] overflow-y-auto px-4 py-4">
            {publishable.length === 0 ? (
              <NoCapability onHelp={help.openHelp} />
            ) : publish.phase === "done" && publish.submitted ? (
              <SubmittedStep
                submitted={publish.submitted}
                subteamName={subteamName}
                onDone={finish}
                onHelp={help.openHelp}
              />
            ) : publish.packed && publish.report && publish.phase !== "idle" && publish.phase !== "packing" ? (
              stepIndex === 1 ? (
                <PreflightStep
                  packed={publish.packed}
                  report={publish.report}
                  busy={publish.busy}
                  onRecheck={publish.recheck}
                  onHelp={help.openHelp}
                />
              ) : (
                <ConfirmStep
                  packed={publish.packed}
                  diff={publish.diff}
                  isNewPlugin={publish.isNewPlugin}
                  lockedSubteam={publish.lockedSubteam}
                  publishableSubteams={publishable}
                  selectedSubteam={selectedSubteam}
                  onSelectSubteam={setSelectedSubteam}
                  busy={publish.busy}
                  error={publish.error}
                  onHelp={help.openHelp}
                />
              )
            ) : (
              <ChooseFolderStep
                busy={publish.busy}
                error={publish.error}
                onChoose={publish.chooseFolder}
                onHelp={help.openHelp}
              />
            )}
          </div>

          {publishable.length > 0 && publish.phase !== "done" && publish.packed && (
            <div className="flex items-center justify-between gap-3 border-t border-helios-line px-4 py-3">
              <button
                type="button"
                onClick={stepIndex === 2 ? publish.back : publish.reset}
                disabled={publish.busy}
                className="inline-flex items-center gap-1.5 rounded-sm border border-helios-line px-3 py-1.5 text-xs font-medium text-helios-dim transition-colors hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
              >
                <IconArrowLeft size={14} />
                {stepIndex === 2 ? "Back" : "Choose a different folder"}
              </button>

              {stepIndex === 1 ? (
                <button
                  type="button"
                  onClick={publish.toConfirm}
                  disabled={!publish.canSubmit}
                  title={publish.report?.ok ? undefined : "Fix the blocking problems first"}
                  className="rounded-sm bg-asu-gold px-4 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => publish.submit(selectedSubteam)}
                  disabled={!publish.canSubmit || needsSubteam}
                  title={needsSubteam ? "Choose an owning subteam first" : undefined}
                  className="rounded-sm bg-asu-gold px-4 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Submit for review
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <HelpDrawer
        open={help.open}
        topic={help.topic}
        onClose={help.closeHelp}
        onTopicChange={help.setTopic}
      />
    </>
  );
}

/** Shown instead of hiding the button: someone who cannot publish still deserves
 *  to know what the feature is and who to ask. */
function NoCapability({ onHelp }: { onHelp: (t?: undefined) => void }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-helios-text">You cannot publish yet</h3>
      <p className="text-xs leading-relaxed text-helios-dim">
        Publishing a plugin needs the <span className="font-mono text-helios-text">marketplace.publish</span>{" "}
        capability for a subteam. Engineers, leads and VPs normally have it for their own subteam — if you
        do not, ask your lead or VP to add you in the Org tool.
      </p>
      <p className="text-xs leading-relaxed text-helios-dim">
        Nothing stops you building one in the meantime: the authoring kit and the starter project do not
        need the capability, only the final submit does.
      </p>
      <button
        type="button"
        onClick={() => onHelp()}
        className="rounded-sm border border-helios-line px-3 py-1.5 text-xs font-medium text-asu-gold transition-colors hover:border-asu-gold/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        Read the author guide
      </button>
    </div>
  );
}
