// The reviewer's queue. What a reviewer needs, in the order they need it: what
// changed about the permissions, what an independent scan of the uploaded bytes
// says, the chance to actually run the thing, and only then a decision.
//
// The one rule the UI must never soften: a publisher cannot approve their own
// submission. The database enforces it; this surface explains it rather than
// offering a button that would fail.

import { useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconLoader2,
  IconPlayerPlay,
  IconScan,
  IconShieldCheck,
  IconThumbDown,
  IconThumbUp,
} from "@tabler/icons-react";
import { useUser } from "@helios/auth";
import { PermissionList } from "../components/PermissionList";
import { permissionDiff, describeDiff } from "../publish/permissionDiff";
import type { HelpTopic } from "../authoring/helpContent";
import {
  useReviewInspect,
  useReviewPreview,
  useReviewQueue,
  useReviewVersion,
  type ReviewItem,
} from "../data/useReview";
import type { AvailablePlugin } from "../data/useMarketplace";

export function ReviewView({
  available,
  onHelp,
  onPreviewInstalled,
}: {
  /** Approved plugins, used to diff a submission against its last release. */
  available: AvailablePlugin[];
  onHelp: (t: HelpTopic) => void;
  onPreviewInstalled?: () => void;
}) {
  const { loading, error, queue, refetch } = useReviewQueue();
  const user = useUser();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-helios-dim">
        <IconLoader2 size={14} className="animate-spin" /> Loading the review queue…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-danger">
        Couldn’t load the review queue: {error}
      </div>
    );
  }
  if (queue.length === 0) {
    return (
      <div className="rounded-sm border border-helios-line bg-helios-base p-6 text-center">
        <IconShieldCheck size={22} className="mx-auto text-helios-dim" />
        <p className="mt-2 text-xs font-medium text-helios-text">Nothing waiting on you</p>
        <p className="mt-1 text-[11px] text-helios-dim">
          Submissions from your subteam land here for approval before anyone can install them.
        </p>
        <button
          type="button"
          onClick={() => onHelp("review")}
          className="mt-3 text-[11px] font-medium text-asu-gold underline-offset-2 hover:underline"
        >
          What am I looking for?
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {queue.map((item) => (
        <ReviewCard
          key={`${item.pluginId}@${item.version}`}
          item={item}
          available={available}
          isOwnSubmission={item.publishedBy === user?.id}
          onDone={refetch}
          onHelp={onHelp}
          onPreviewInstalled={onPreviewInstalled}
        />
      ))}
    </div>
  );
}

function ReviewCard({
  item,
  available,
  isOwnSubmission,
  onDone,
  onHelp,
  onPreviewInstalled,
}: {
  item: ReviewItem;
  available: AvailablePlugin[];
  isOwnSubmission: boolean;
  onDone: () => void;
  onHelp: (t: HelpTopic) => void;
  onPreviewInstalled?: () => void;
}) {
  const key = `${item.pluginId}@${item.version}`;
  const { inspect, reports, inspecting, error: inspectError } = useReviewInspect();
  const { preview, previewing, error: previewError } = useReviewPreview();
  const { review, reviewing, error: reviewError } = useReviewVersion();
  const [notes, setNotes] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const previousApproved = useMemo(
    () => available.find((p) => p.id === item.pluginId)?.permissions ?? null,
    [available, item.pluginId],
  );
  const diff = useMemo(
    () => permissionDiff(previousApproved, item.permissions),
    [previousApproved, item.permissions],
  );

  const scan = reports[key];
  const busy = inspecting === key || previewing === key || reviewing;

  async function decide(decision: "approved" | "rejected") {
    await review({
      pluginId: item.pluginId,
      version: item.version,
      decision,
      notes: notes.trim() || undefined,
      // Attach the reviewer's own scan, not the author's.
      report: scan?.report.raw ?? undefined,
    });
    onDone();
  }

  return (
    <article className="rounded-sm border border-helios-line bg-helios-panel p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-helios-text">
            {item.name}{" "}
            <span className="font-mono text-xs font-normal text-helios-dim">{item.version}</span>
          </h3>
          <p className="mt-0.5 truncate font-mono text-[10px] text-helios-dim">{item.pluginId}</p>
        </div>
        <span className="shrink-0 rounded-sm bg-asu-gold/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-asu-gold">
          Pending
        </span>
      </header>

      {item.manifest.description && (
        <p className="mt-2 text-xs leading-relaxed text-helios-text/85">
          {item.manifest.description}
        </p>
      )}

      {/* Permissions — the reason most reviews take a second look. */}
      <div className="mt-3 rounded-sm border border-helios-line bg-helios-base p-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
          Permissions
        </div>
        <p className="text-[11px] text-helios-text/90">{describeDiff(diff)}</p>
        {diff.addsHighTrust && (
          <div className="mt-2 flex items-start gap-2 rounded-sm border border-helios-danger/50 bg-helios-danger/15 p-2.5">
            <IconAlertTriangle size={15} className="mt-0.5 shrink-0 text-helios-danger" />
            <div className="text-[11px] leading-relaxed text-helios-text/90">
              Adds a high-trust permission that reaches outside the sandbox. Approving this lets it run
              on every machine that installs the plugin.
            </div>
          </div>
        )}
        {diff.added.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-asu-gold">
              New in this version
            </div>
            <PermissionList permissions={diff.added} mode="detail" />
          </div>
        )}
      </div>

      {/* Independent re-scan of the uploaded bytes. */}
      <div className="mt-3 rounded-sm border border-helios-line bg-helios-base p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
            Compliance check
          </div>
          <button
            type="button"
            onClick={() => void inspect(item)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-sm border border-helios-line px-2.5 py-1 text-[11px] font-medium text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            {inspecting === key ? (
              <IconLoader2 size={12} className="animate-spin" />
            ) : (
              <IconScan size={12} />
            )}
            {scan ? "Re-scan" : "Scan the uploaded bundle"}
          </button>
        </div>

        {!scan && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-helios-dim">
            Runs the compliance scan against the bytes actually in storage. The report submitted with a
            version comes from the author's machine — this one does not.
          </p>
        )}

        {scan && (
          <div className="mt-2 space-y-2">
            {scan.disagrees && (
              <div className="flex items-start gap-2 rounded-sm border border-helios-warn/50 bg-helios-warn/10 p-2.5">
                <IconAlertTriangle size={15} className="mt-0.5 shrink-0 text-helios-warn" />
                <div className="text-[11px] leading-relaxed text-helios-text/90">
                  This scan does not match the report submitted with the version. That can simply mean the
                  author used an older client — but it is worth understanding before you approve.
                </div>
              </div>
            )}
            {scan.report.ok ? (
              <div className="flex items-center gap-2 text-[11px] text-helios-success">
                <IconCircleCheck size={14} /> No blocking findings in the uploaded bundle.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {scan.report.errors.map((f, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-helios-danger">
                    <span className="font-semibold">{f.title}</span>
                    {f.path && <span className="ml-1.5 font-mono text-[10px]">{f.path}</span>}
                  </li>
                ))}
              </ul>
            )}
            {scan.report.warnings.length > 0 && (
              <ul className="space-y-1">
                {scan.report.warnings.map((f, i) => (
                  <li key={i} className="text-[11px] text-helios-dim">
                    {f.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {inspectError && (
          <p className="mt-1.5 text-[11px] text-helios-danger">Scan failed: {inspectError}</p>
        )}
      </div>

      {/* Test-drive. Approving something nobody ran is most of the way to not reviewing it. */}
      <div className="mt-3 flex items-center justify-between gap-2 rounded-sm border border-helios-line bg-helios-base p-3">
        <div className="min-w-0 text-[11px] leading-relaxed text-helios-text/90">
          Install this pending build locally and run it. It is marked as an unapproved preview and does
          not affect what Browse says you have installed.
        </div>
        <button
          type="button"
          onClick={() => {
            void preview(item)
              .then(() => onPreviewInstalled?.())
              .catch(() => {
                /* surfaced below */
              });
          }}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-helios-line px-2.5 py-1 text-[11px] font-medium text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
        >
          {previewing === key ? (
            <IconLoader2 size={12} className="animate-spin" />
          ) : (
            <IconPlayerPlay size={12} />
          )}
          Test-drive
        </button>
      </div>
      {previewError && (
        <p className="mt-1.5 text-[11px] text-helios-danger">Test-drive failed: {previewError}</p>
      )}

      {/* Decision. */}
      <div className="mt-3 border-t border-helios-line pt-3">
        {isOwnSubmission ? (
          <div className="flex items-start gap-2 rounded-sm border border-helios-line bg-helios-base p-3">
            <IconShieldCheck size={15} className="mt-0.5 shrink-0 text-helios-dim" />
            <div className="text-[11px] leading-relaxed text-helios-text/90">
              You published this version, so you cannot approve it — approval is what lets code run on
              everyone else's machine, and it takes a second person. Another lead or VP of this subteam
              can review it.{" "}
              <button
                type="button"
                onClick={() => onHelp("review")}
                className="font-medium text-asu-gold underline-offset-2 hover:underline"
              >
                Why?
              </button>
            </div>
          </div>
        ) : (
          <>
            <label htmlFor={`notes-${key}`} className="sr-only">
              Review notes
            </label>
            <textarea
              id={`notes-${key}`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={rejecting ? 3 : 2}
              placeholder={
                rejecting
                  ? "What needs to change? This is what the author will read."
                  : "Notes (optional)"
              }
              className="w-full rounded-sm border border-helios-line bg-helios-base px-2.5 py-2 text-[11px] text-helios-text placeholder:text-helios-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!rejecting) {
                    setRejecting(true);
                    return;
                  }
                  void decide("rejected");
                }}
                disabled={busy || (rejecting && notes.trim().length === 0)}
                title={
                  rejecting && notes.trim().length === 0
                    ? "Say what needs to change — a rejection with no note just repeats"
                    : undefined
                }
                className="inline-flex items-center gap-1.5 rounded-sm border border-helios-danger/50 px-3 py-1.5 text-[11px] font-semibold text-helios-danger transition-colors hover:bg-helios-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-helios-danger disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconThumbDown size={13} />
                {rejecting ? "Confirm rejection" : "Reject"}
              </button>
              <button
                type="button"
                onClick={() => void decide("approved")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-sm bg-asu-gold px-3 py-1.5 text-[11px] font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-40"
              >
                {reviewing ? (
                  <IconLoader2 size={13} className="animate-spin" />
                ) : (
                  <IconThumbUp size={13} />
                )}
                Approve
              </button>
            </div>
          </>
        )}
        {reviewError && <p className="mt-1.5 text-[11px] text-helios-danger">{reviewError}</p>}
      </div>
    </article>
  );
}
