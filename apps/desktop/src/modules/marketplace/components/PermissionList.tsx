// The permissions an add-on requests, rendered from the SDK CAPABILITIES catalog
// (the single source of truth for tier + human description). Two modes:
//   • "badge"  — compact colored chips for cards / list rows.
//   • "detail" — full rows (tier label + description) for the detail page and the
//                install-consent modal, where the user is making a trust decision.
// Default-deny: a permission the manifest didn't list simply isn't shown. An
// empty permission set renders an explicit "Sandboxed" affordance so a pure
// plugin reads as safe rather than as missing information.

import { IconLock, IconShieldCheck, IconAlertTriangle } from "@tabler/icons-react";
import { CAPABILITIES, type PermissionKey } from "@helios/plugin-sdk";

const TIER_LABEL: Record<number, string> = {
  0: "Always allowed",
  1: "Low trust",
  2: "High trust",
};

/** Known capability keys, in catalog order, filtered to those requested. */
function knownPermissions(permissions: string[]): PermissionKey[] {
  return permissions.filter((p): p is PermissionKey => p in CAPABILITIES);
}

export function PermissionList({
  permissions,
  mode = "badge",
}: {
  permissions: string[];
  mode?: "badge" | "detail";
}) {
  const keys = knownPermissions(permissions);

  if (keys.length === 0) {
    if (mode === "detail") {
      return (
        <div className="flex items-start gap-2 rounded-sm border border-helios-line bg-helios-panel/60 p-3">
          <IconShieldCheck size={16} className="mt-0.5 shrink-0 text-helios-success" />
          <div>
            <div className="text-xs font-medium text-helios-text">Sandboxed</div>
            <p className="mt-0.5 text-[11px] text-helios-dim">
              UI and computation only — no access to your files, the database, the network, or
              anything else outside its box.
            </p>
          </div>
        </div>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sm bg-helios-line px-1.5 py-0.5 text-[10px] text-helios-dim"
        title="Pure sandbox — UI + compute only, no access to anything outside the box."
      >
        <IconLock size={10} /> Sandboxed
      </span>
    );
  }

  if (mode === "detail") {
    return (
      <ul className="space-y-2">
        {keys.map((p) => {
          const info = CAPABILITIES[p];
          const danger = info.tier === 2;
          return (
            <li
              key={p}
              className={
                "flex items-start gap-2 rounded-sm border p-3 " +
                (danger
                  ? "border-helios-danger/40 bg-helios-danger/10"
                  : "border-helios-line bg-helios-panel/60")
              }
            >
              <IconAlertTriangle
                size={16}
                className={"mt-0.5 shrink-0 " + (danger ? "text-helios-danger" : "text-asu-gold")}
              />
              <div>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-medium text-helios-text">{p}</code>
                  <span
                    className={
                      "rounded-sm px-1 py-0.5 text-[9px] uppercase tracking-wider " +
                      (danger ? "bg-helios-danger/20 text-helios-danger" : "bg-asu-gold/15 text-asu-gold")
                    }
                  >
                    {TIER_LABEL[info.tier]}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-helios-dim">{info.description}</p>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      {keys.map((p) => {
        const info = CAPABILITIES[p];
        const tone =
          info.tier === 2 ? "bg-helios-danger/15 text-helios-danger" : "bg-asu-gold/15 text-asu-gold";
        return (
          <span
            key={p}
            className={`rounded-sm px-1.5 py-0.5 text-[10px] ${tone}`}
            title={info.description}
          >
            {p}
          </span>
        );
      })}
    </>
  );
}

/** Does this permission set include any high-trust (Tier-2) capability? Drives
 *  the extra consent warning at install time. */
export function hasHighTrust(permissions: string[]): boolean {
  return knownPermissions(permissions).some((p) => CAPABILITIES[p].tier === 2);
}
