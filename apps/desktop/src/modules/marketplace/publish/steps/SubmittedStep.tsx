import { IconCircleCheck } from "@tabler/icons-react";
import type { SubmittedVersion } from "../usePublish";
import type { HelpTopic } from "../../authoring/helpContent";

/** Step 4 — what actually happens next. Deliberately concrete: "pending" on its
 *  own tells an author nothing about whether they are waiting on a person or on
 *  a machine. */
export function SubmittedStep({
  submitted,
  subteamName,
  onDone,
  onHelp,
}: {
  submitted: SubmittedVersion;
  subteamName: string;
  onDone: () => void;
  onHelp: (t: HelpTopic) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <IconCircleCheck size={22} className="mt-0.5 shrink-0 text-helios-success" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-helios-text">Submitted for review</h3>
          <p className="mt-1 text-xs leading-relaxed text-helios-dim">
            <span className="font-mono text-helios-text">
              {submitted.pluginId} {submitted.version}
            </span>{" "}
            is now waiting on a lead or VP of {subteamName}. They will see your manifest, exactly which
            permissions it asks for, and a fresh compliance check run against the bundle you just
            uploaded — and they can install and run it before deciding.
          </p>
        </div>
      </div>

      <div className="rounded-sm border border-helios-line bg-helios-base p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
          What happens next
        </div>
        <ul className="space-y-1.5 text-[11px] leading-relaxed text-helios-text/90">
          <li className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-asu-gold" />
            <span>
              <span className="font-semibold">Approved</span> — it appears in Browse and anyone on the
              team can install it.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-asu-gold" />
            <span>
              <span className="font-semibold">Rejected</span> — the reviewer's note shows up under My
              Plugins. Fix it, bump the version, and submit again.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-asu-gold" />
            <span>
              Changed your mind? Withdraw it from <span className="font-semibold">My Plugins</span> while
              it is still pending.
            </span>
          </li>
        </ul>
        <button
          type="button"
          onClick={() => onHelp("review")}
          className="mt-2 text-[11px] font-medium text-asu-gold underline-offset-2 hover:underline"
        >
          How review works
        </button>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="rounded-sm bg-asu-gold px-4 py-2 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        Done
      </button>
    </div>
  );
}
