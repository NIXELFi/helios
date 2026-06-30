import type { ReactNode } from "react";
import { hexToRgba } from "@helios/pm-ui";
import { AllTeamsIcon, SubteamIcon } from "@pm/components/SubteamIcon";
import { ASU_GOLD, ASU_MAROON, useSubteamTheme } from "@pm/lib/subteamTheme";

export function ViewHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  const { primary, secondary, isAllTeams, subteam } = useSubteamTheme();
  // Identity bar: a maroon→gold sweep for the whole team, the subteam color otherwise.
  const barBackground = isAllTeams
    ? `linear-gradient(180deg, ${ASU_MAROON} 0%, ${ASU_GOLD} 100%)`
    : primary;

  return (
    <header className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 overflow-hidden border-b border-helios-line bg-helios-panel/40 px-6 py-4">
      {/* high-tech color chrome */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1.5" style={{ background: barBackground }} aria-hidden />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{ background: `linear-gradient(90deg, ${hexToRgba(primary, 0.9)}, ${hexToRgba(secondary, 0.4)} 35%, transparent 75%)` }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-10 -top-16 h-40 w-56"
        style={{ background: `radial-gradient(circle, ${hexToRgba(primary, 0.22)} 0%, transparent 70%)` }}
        aria-hidden
      />
      {isAllTeams ? (
        <div
          className="pointer-events-none absolute -right-10 -top-16 h-40 w-56"
          style={{ background: `radial-gradient(circle, ${hexToRgba(ASU_GOLD, 0.14)} 0%, transparent 70%)` }}
          aria-hidden
        />
      ) : null}

      <div className="relative flex min-w-0 items-center gap-3">
        {/* logo badge with a clipped hi-tech corner + color glow */}
        <span
          className="relative grid size-11 shrink-0 place-items-center rounded-lg border [clip-path:polygon(0_0,100%_0,100%_72%,72%_100%,0_100%)]"
          style={{
            borderColor: hexToRgba(primary, 0.55),
            background: hexToRgba(primary, 0.12),
            color: primary,
            boxShadow: `0 0 18px -6px ${hexToRgba(primary, 0.8)}`,
          }}
          aria-hidden
        >
          {isAllTeams || !subteam ? (
            <AllTeamsIcon size={28} strokeWidth={1.4} />
          ) : (
            <SubteamIcon name={subteam.name} code={subteam.code} glyph={subteam.icon} size={24} />
          )}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-helios-text">{title}</h1>
          {description ? <p className="mt-0.5 text-xs text-helios-dim">{description}</p> : null}
        </div>
      </div>
      {actions ? (
        <div className="relative flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
