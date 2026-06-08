"use client";

// Identity theme for the active scope. A subteam-specific view themes itself in
// that subteam's color (accent bar, logo, aura); the all-subteams scope uses the
// ASU maroon + gold combo. Consumed by ViewHeader (header chrome) and the Aura
// backdrop so it's instantly obvious which subteam you're looking at.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Subteam } from "@helios/pm-ui";
import { usePathname } from "@pm/lib/router";
import { activeTeamSlug } from "@pm/lib/nav";
import { usePmStore } from "@pm/lib/pmStore";

export const ASU_MAROON = "#8C1D40";
export const ASU_GOLD = "#FFC627";

export interface SubteamTheme {
  subteam: Subteam | null;
  isAllTeams: boolean;
  primary: string; // main accent (subteam color, or maroon for all-teams)
  secondary: string; // secondary accent (gold)
  name: string; // display name of the scope
}

const ALL_TEAMS_THEME: SubteamTheme = {
  subteam: null,
  isAllTeams: true,
  primary: ASU_MAROON,
  secondary: ASU_GOLD,
  name: "All Subteams",
};

const Ctx = createContext<SubteamTheme>(ALL_TEAMS_THEME);

export function SubteamThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const subteams = usePmStore((s) => s.subteams);
  const slug = activeTeamSlug(pathname);
  const subteam = slug ? subteams.find((s) => s.slug === slug) ?? null : null;

  const value = useMemo<SubteamTheme>(() => {
    if (!subteam) return ALL_TEAMS_THEME;
    return {
      subteam,
      isAllTeams: false,
      primary: subteam.color ?? ASU_GOLD,
      secondary: ASU_GOLD,
      name: subteam.name,
    };
  }, [subteam]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSubteamTheme(): SubteamTheme {
  return useContext(Ctx);
}
