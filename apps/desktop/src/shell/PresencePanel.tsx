import { useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import type { ModuleId } from "./ModulePicker";
import type { PresenceUser } from "./useHeliosPresence";

const MODULE_LABEL: Record<ModuleId, string> = {
  logs: "Logs",
  vault: "Vault",
  cfd: "CFD",
  pm: "PM",
  games: "Games",
  amethyst: "Amethyst",
  marketplace: "Marketplace",
  org: "Admin",
};

const PANEL_COLLAPSE_KEY = "helios:presenceCollapsed";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(PANEL_COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(PANEL_COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** First+last initial, e.g. "Nick Murray" → "NM". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Deterministic hue from a user id so each person keeps a stable avatar tint. */
function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function Avatar({ user }: { user: PresenceUser }) {
  const hue = hueFromId(user.userId);
  return (
    <span
      aria-hidden
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold tracking-wide font-mono-num"
      style={{
        backgroundColor: `hsl(${hue} 42% 20%)`,
        color: `hsl(${hue} 70% 76%)`,
        borderColor: `hsl(${hue} 38% 34%)`,
      }}
    >
      {initials(user.name)}
    </span>
  );
}

/** The live green status dot with an expanding "ping" ring. */
function LiveDot({ size = 7 }: { size?: number }) {
  return (
    <span aria-hidden className="relative inline-flex flex-shrink-0" style={{ width: size, height: size }}>
      <span
        className="helios-live-ring absolute inset-0 rounded-full"
        style={{ backgroundColor: "#3FB950" }}
      />
      <span
        className="relative inline-block rounded-full"
        style={{ width: size, height: size, backgroundColor: "#3FB950", boxShadow: "0 0 6px #3FB95088" }}
      />
    </span>
  );
}

interface Props {
  users: PresenceUser[];
  currentUserId: string | null;
  /** True when the whole module rail is collapsed to its icon strip. */
  railCollapsed: boolean;
}

/**
 * "Who's on Helios right now" — an app-wide presence roster in the sidebar,
 * fed by Supabase Realtime presence (see useHeliosPresence). Admin/owner-gated
 * by the caller. Independently collapsible, and degrades to a compact count
 * indicator when the rail itself is collapsed.
 */
export function PresencePanel({ users, currentUserId, railCollapsed }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const count = users.length;

  // Rail collapsed to icons → compact vertical indicator (live dot + count),
  // with the roster names in the tooltip.
  if (railCollapsed) {
    const names = users.map((u) => (u.userId === currentUserId ? `${u.name} (you)` : u.name)).join("\n");
    return (
      <div
        role="img"
        className="flex flex-col items-center gap-1 border-t border-helios-line py-2.5"
        title={count > 0 ? `On Helios:\n${names}` : "On Helios"}
        aria-label={`${count} on Helios${count > 0 ? `: ${names.replace(/\n/g, ", ")}` : ""}`}
      >
        <LiveDot size={7} />
        <span className="font-mono-num text-[11px] leading-none text-helios-text">{count}</span>
      </div>
    );
  }

  function toggle() {
    const next = !collapsed;
    writeCollapsed(next);
    setCollapsed(next);
  }

  const others = count - (users.some((u) => u.userId === currentUserId) ? 1 : 0);

  return (
    <div className="border-t border-helios-line">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-helios-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-asu-gold"
      >
        <LiveDot size={7} />
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-helios-dim">
          On Helios
        </span>
        <span className="font-mono-num text-[11px] tabular-nums text-helios-text">{count}</span>
        <IconChevronDown
          size={14}
          strokeWidth={1.5}
          className={"text-helios-dim transition-transform duration-200 " + (collapsed ? "-rotate-90" : "")}
        />
      </button>

      {/* Smooth height collapse via the 0fr→1fr grid-rows technique. */}
      <div
        className={
          "grid transition-[grid-template-rows] duration-200 ease-out " +
          (collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]")
        }
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="max-h-52 space-y-0.5 overflow-y-auto px-1.5 pb-2" aria-label="People on Helios">
            {users.map((u, i) => {
              const you = u.userId === currentUserId;
              return (
                <li
                  key={u.userId}
                  className="helios-presence-row flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-helios-panel"
                  style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
                  title={`${u.name}${you ? " (you)" : ""} — in ${MODULE_LABEL[u.module]}${u.subteam ? ` · ${u.subteam}` : ""}`}
                >
                  <Avatar user={u} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="flex items-center gap-1 truncate text-xs text-helios-text">
                      <span className="truncate">{u.name}</span>
                      {you && (
                        <span className="flex-shrink-0 rounded-sm bg-asu-gold/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-asu-gold">
                          you
                        </span>
                      )}
                    </span>
                    <span className="truncate text-[10px] text-helios-dim">
                      {MODULE_LABEL[u.module]}
                      {u.subteam ? <span className="text-[#5A5F66]"> · {u.subteam}</span> : null}
                    </span>
                  </span>
                  <LiveDot size={6} />
                </li>
              );
            })}
            {count === 0 && (
              <li className="px-1.5 py-2 text-[11px] italic text-helios-dim">Connecting…</li>
            )}
            {count > 0 && others === 0 && (
              <li className="px-1.5 pt-1 text-[10px] text-helios-dim">You&apos;re the only one online.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
