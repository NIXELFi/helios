// "My plugins": every plugin the caller can publish to, each version with its
// review status, the reviewer's note inline, and the actions an author needs
// without asking anyone: withdraw a pending submission, yank a bad release, and
// (for a lead) the "recommended for my subteam" flag.
//
// Who may act mirrors the server rules exactly, so nobody is offered a button
// that would only fail: withdraw and yank belong to the version's author or a
// reviewer for the subteam; recommending belongs to a reviewer.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBan,
  IconLoader2,
  IconPackage,
  IconStar,
  IconStarFilled,
  IconUpload,
} from "@tabler/icons-react";
import { useUser } from "@helios/auth";
import { useMyCapabilities, useSubteams } from "../../org/data/useOrgData";
import type { HelpTopic } from "../authoring/helpContent";
import { useMyPlugins, type MyPlugin, type MyVersion, type ReviewStatus } from "./useMyPlugins";

export const YANK_EXPLAINER =
  "Anyone who already installed it keeps a working copy. It just stops being offered, and nobody can install it again.";

const STATUS: Record<ReviewStatus, { label: string; className: string }> = {
  pending: { label: "In review", className: "bg-asu-gold/15 text-asu-gold" },
  approved: { label: "Live", className: "bg-helios-success/15 text-helios-success" },
  rejected: { label: "Changes requested", className: "bg-helios-danger/15 text-helios-danger" },
  withdrawn: { label: "Withdrawn", className: "bg-helios-line text-helios-dim" },
  yanked: { label: "Yanked", className: "bg-helios-warn/15 text-helios-warn" },
};

export function MyPluginsView({
  reloadToken = 0,
  onHelp,
  onAdd,
  onChanged,
}: {
  /** Changes whenever the module refetches (Refresh, a publish): reload too. */
  reloadToken?: number;
  onHelp: (t: HelpTopic) => void;
  onAdd: () => void;
  /** Something changed that Browse / Installed also show (a yank, a recommend). */
  onChanged?: () => void;
}) {
  const my = useMyPlugins();
  const { refetch: refetchMine } = my;
  const firstToken = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken !== firstToken.current) refetchMine();
  }, [reloadToken, refetchMine]);
  const user = useUser();
  const { can } = useMyCapabilities();
  const { data: subteams } = useSubteams();
  const subteamName = useMemo(() => {
    const m = new Map(subteams.map((s) => [s.id, s.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "Subteam") : "Whole org");
  }, [subteams]);

  if (my.loading && my.plugins.length === 0) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-helios-dim">
        <IconLoader2 size={14} className="animate-spin" /> Loading your plugins…
      </div>
    );
  }
  if (my.error) {
    return (
      <div className="rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-danger">
        Couldn’t load your plugins: {my.error}
      </div>
    );
  }
  if (my.plugins.length === 0) {
    return (
      <div className="rounded-sm border border-helios-line bg-helios-base p-6 text-center">
        <IconPackage size={22} className="mx-auto text-helios-dim" />
        <p className="mt-2 text-xs font-medium text-helios-text">You haven’t published anything yet</p>
        <p className="mt-1 text-[11px] text-helios-dim">
          Plugins you and your subteam submit show up here with their review status.
        </p>
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1.5 rounded-sm bg-asu-gold px-3 py-1.5 text-[11px] font-semibold text-helios-base hover:opacity-90"
          >
            <IconUpload size={13} /> Add to Marketplace
          </button>
          <button
            type="button"
            onClick={() => onHelp("getting-started")}
            className="text-[11px] font-medium text-asu-gold underline-offset-2 hover:underline"
          >
            How do I build one?
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {my.actionError && (
        <div role="alert" className="rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-danger">
          {my.actionError}
        </div>
      )}
      {my.plugins.map((p) => (
        <PluginCard
          key={p.id}
          plugin={p}
          subteamName={subteamName(p.subteam)}
          myId={user?.id ?? null}
          isReviewer={can("marketplace.review", p.subteam)}
          pending={my.pending}
          onWithdraw={(v) => my.withdraw(p.id, v).then(() => onChanged?.())}
          onYank={(v, reason) => my.yank(p.id, v, reason).then(() => onChanged?.())}
          onRecommend={(value) => my.setRecommended(p.id, value).then(() => onChanged?.())}
          onHelp={onHelp}
        />
      ))}
    </div>
  );
}

function PluginCard({
  plugin,
  subteamName,
  myId,
  isReviewer,
  pending,
  onWithdraw,
  onYank,
  onRecommend,
  onHelp,
}: {
  plugin: MyPlugin;
  subteamName: string;
  myId: string | null;
  isReviewer: boolean;
  pending: string | null;
  onWithdraw: (version: string) => Promise<void>;
  onYank: (version: string, reason: string) => Promise<void>;
  onRecommend: (value: boolean) => Promise<void>;
  onHelp: (t: HelpTopic) => void;
}) {
  const hasLive = plugin.versions.some((v) => v.status === "approved");
  return (
    <article className="rounded-sm border border-helios-line bg-helios-panel p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-helios-text">{plugin.name}</h3>
          <p className="mt-0.5 truncate text-[10px] text-helios-dim">
            <span className="font-mono">{plugin.id}</span> · {subteamName}
            {plugin.latestVersion ? (
              <>
                {" "}
                · live <span className="font-mono">v{plugin.latestVersion}</span>
              </>
            ) : (
              " · not live yet"
            )}
          </p>
        </div>
        {isReviewer ? (
          <button
            type="button"
            onClick={() => void onRecommend(!plugin.isRecommended).catch(() => {})}
            disabled={pending === plugin.id || !hasLive}
            aria-pressed={plugin.isRecommended}
            title={
              hasLive
                ? "Recommended plugins are highlighted for everyone on this subteam"
                : "Only a plugin with a live version can be recommended"
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-helios-line px-2 py-1 text-[11px] text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold disabled:opacity-50"
          >
            {plugin.isRecommended ? (
              <IconStarFilled size={12} className="text-asu-gold" />
            ) : (
              <IconStar size={12} />
            )}
            {plugin.isRecommended ? "Recommended" : "Recommend"}
          </button>
        ) : (
          plugin.isRecommended && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-asu-gold">
              <IconStarFilled size={12} /> Recommended
            </span>
          )
        )}
      </header>

      <ul className="mt-3 divide-y divide-helios-line/60 rounded-sm border border-helios-line bg-helios-base">
        {plugin.versions.map((v) => (
          <VersionRow
            key={v.version}
            v={v}
            canManage={isReviewer || v.publishedBy === myId}
            mine={v.publishedBy === myId}
            busy={pending === `${plugin.id}@${v.version}`}
            onWithdraw={() => onWithdraw(v.version)}
            onYank={(reason) => onYank(v.version, reason)}
            onHelp={onHelp}
          />
        ))}
      </ul>
    </article>
  );
}

function VersionRow({
  v,
  canManage,
  mine,
  busy,
  onWithdraw,
  onYank,
  onHelp,
}: {
  v: MyVersion;
  canManage: boolean;
  mine: boolean;
  busy: boolean;
  onWithdraw: () => Promise<void>;
  onYank: (reason: string) => Promise<void>;
  onHelp: (t: HelpTopic) => void;
}) {
  const [yanking, setYanking] = useState(false);
  const [reason, setReason] = useState("");
  const chip = STATUS[v.status] ?? { label: v.status, className: "bg-helios-line text-helios-dim" };

  return (
    <li className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-helios-text">v{v.version}</span>
        <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${chip.className}`}>
          {chip.label}
        </span>
        <span className="text-[10px] text-helios-dim">
          {mine ? "you" : "a teammate"} · {new Date(v.publishedAt).toLocaleDateString()}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {canManage && v.status === "pending" && (
            <button
              type="button"
              onClick={() => void onWithdraw().catch(() => {})}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-sm border border-helios-line px-2 py-1 text-[11px] text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold disabled:opacity-50"
            >
              {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconArrowBackUp size={12} />}
              Withdraw
            </button>
          )}
          {canManage && v.status === "approved" && !yanking && (
            <button
              type="button"
              onClick={() => setYanking(true)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-sm border border-helios-danger/40 px-2 py-1 text-[11px] text-helios-danger transition-colors hover:bg-helios-danger/10 disabled:opacity-50"
            >
              <IconBan size={12} /> Yank
            </button>
          )}
        </div>
      </div>

      {v.status === "rejected" && v.reviewNotes && (
        <div className="mt-2 rounded-sm border border-helios-danger/30 bg-helios-danger/5 p-2 text-[11px] leading-relaxed text-helios-text/90">
          <span className="font-semibold text-helios-danger">Reviewer: </span>
          <span className="whitespace-pre-wrap">{v.reviewNotes}</span>{" "}
          <button
            type="button"
            onClick={() => onHelp("rejected")}
            className="font-medium text-asu-gold underline-offset-2 hover:underline"
          >
            What now?
          </button>
        </div>
      )}
      {v.status !== "rejected" && v.reviewNotes && (
        <p className="mt-1.5 whitespace-pre-wrap text-[11px] text-helios-dim">{v.reviewNotes}</p>
      )}

      {yanking && (
        <div className="mt-2 rounded-sm border border-helios-warn/50 bg-helios-warn/10 p-2.5">
          <div className="flex items-start gap-2 text-[11px] leading-relaxed text-helios-text/90">
            <IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-helios-warn" />
            <div>
              <div className="font-semibold">Yank v{v.version}?</div>
              {YANK_EXPLAINER}{" "}
              <button
                type="button"
                onClick={() => onHelp("yank")}
                className="font-medium text-asu-gold underline-offset-2 hover:underline"
              >
                More
              </button>
            </div>
          </div>
          <label htmlFor={`yank-${v.version}`} className="sr-only">
            Reason for yanking
          </label>
          <textarea
            id={`yank-${v.version}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why? (optional, shown to reviewers)"
            className="mt-2 w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1.5 text-[11px] text-helios-text placeholder:text-helios-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setYanking(false)}
              className="rounded-sm border border-helios-line px-2.5 py-1 text-[11px] text-helios-dim hover:text-helios-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                void onYank(reason)
                  .then(() => setYanking(false))
                  .catch(() => {})
              }
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-sm bg-helios-danger px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy && <IconLoader2 size={12} className="animate-spin" />}
              Yank v{v.version}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
