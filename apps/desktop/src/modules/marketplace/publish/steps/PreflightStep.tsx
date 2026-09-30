import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconRefresh,
  IconLoader2,
} from "@tabler/icons-react";
import type { PreflightFinding, PreflightReport } from "../preflight";
import type { PackedBundle } from "../usePublish";
import type { HelpTopic } from "../../authoring/helpContent";

/** Step 2 — the checks. Errors block; warnings do not; passes are shown on
 *  purpose, because someone who cannot read the code needs to see what is right
 *  and not only what is wrong. */
export function PreflightStep({
  packed,
  report,
  busy,
  onRecheck,
  onHelp,
}: {
  packed: PackedBundle;
  report: PreflightReport;
  busy: boolean;
  onRecheck: () => void;
  onHelp: (t: HelpTopic) => void;
}) {
  const { errors, warnings, passed, ok } = report;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-helios-text">
            {ok ? "Everything checks out" : "A few things need fixing first"}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-helios-dim">
            {ok
              ? "These are the same checks your reviewer runs, so this will pass review too."
              : "These are the same checks your reviewer runs. Fix them here and review becomes a question of whether the plugin is a good idea, not whether it works."}
          </p>
        </div>
        <button
          type="button"
          onClick={onRecheck}
          disabled={busy}
          title="Re-pack the same folder and check again"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-helios-line px-3 py-1.5 text-xs font-medium text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? (
            <IconLoader2 size={14} className="animate-spin" />
          ) : (
            <IconRefresh size={14} />
          )}
          Re-check
        </button>
      </div>

      <BundleSummary packed={packed} />

      {errors.length > 0 && (
        <FindingGroup
          title={`Must fix (${errors.length})`}
          tone="error"
          findings={errors}
          onHelp={onHelp}
        />
      )}
      {warnings.length > 0 && (
        <FindingGroup
          title={`Worth a look (${warnings.length})`}
          tone="warning"
          findings={warnings}
          onHelp={onHelp}
        />
      )}
      {packed.warnings.length > 0 && (
        <div className="rounded-sm border border-helios-line bg-helios-base p-3">
          {packed.warnings.map((w, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-helios-dim">
              {w}
            </p>
          ))}
        </div>
      )}
      {passed.length > 0 && (
        <div className="rounded-sm border border-helios-line bg-helios-base p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
            Passed
          </div>
          <ul className="space-y-1">
            {passed.map((p) => (
              <li key={p.code} className="flex items-center gap-2 text-[11px] text-helios-text/80">
                <IconCircleCheck size={13} className="shrink-0 text-helios-success" />
                {p.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BundleSummary({ packed }: { packed: PackedBundle }) {
  const m = packed.manifest;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-sm border border-helios-line bg-helios-base p-3 text-[11px]">
      <Row label="Plugin" value={`${m.name} (${m.id})`} />
      <Row label="Version" value={m.version} mono />
      <Row label="Files" value={`${packed.entries.length}`} />
      <Row label="Size" value={humanBytes(packed.bytes)} />
    </dl>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-helios-dim">{label}</dt>
      <dd className={"min-w-0 truncate text-helios-text" + (mono ? " font-mono" : "")}>{value}</dd>
    </div>
  );
}

function FindingGroup({
  title,
  tone,
  findings,
  onHelp,
}: {
  title: string;
  tone: "error" | "warning";
  findings: PreflightFinding[];
  onHelp: (t: HelpTopic) => void;
}) {
  const isError = tone === "error";
  return (
    <div
      className={
        "rounded-sm border p-3 " +
        (isError
          ? "border-helios-danger/40 bg-helios-danger/10"
          : "border-asu-gold/40 bg-asu-gold/5")
      }
    >
      <div
        className={
          "mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider " +
          (isError ? "text-helios-danger" : "text-asu-gold")
        }
      >
        {isError ? <IconAlertTriangle size={13} /> : <IconInfoCircle size={13} />}
        {title}
      </div>
      <ul className="space-y-3">
        {findings.map((f, i) => (
          <li key={`${f.code}-${f.path ?? ""}-${i}`}>
            <div className="text-xs font-semibold text-helios-text">
              {f.title}
              {f.path && (
                <span className="ml-2 font-mono text-[10px] font-normal text-helios-dim">
                  {f.path}
                </span>
              )}
            </div>
            <p className="mt-0.5 whitespace-pre-line text-[11px] leading-relaxed text-helios-text/85">
              {f.detail}
            </p>
            <button
              type="button"
              onClick={() => onHelp(f.helpTopic)}
              className="mt-1 text-[11px] font-medium text-asu-gold underline-offset-2 hover:underline"
            >
              How do I fix this?
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
