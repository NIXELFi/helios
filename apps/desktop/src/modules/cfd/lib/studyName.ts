// Study display names. One source of truth: a study shows its user-given
// `name` when set, else the config-file basename — so every screen, dropdown,
// and export label agrees on what a study is called.

import { basename } from "./cfdPath";

/** What to call a study anywhere it's shown. */
export function studyName(study: { name?: string; configPath: string }): string {
  const n = study.name?.trim();
  return n && n.length > 0 ? n : basename(study.configPath);
}

/** Config basename without its extension — the stem used to build provenance
 *  auto-names ("sdm26 — opt #12 recipe"). */
export function configStem(configPath: string): string {
  return basename(configPath).replace(/\.[^.]+$/, "");
}

/** Default name for a sweep started from an optimization trial's recipe. */
export function sweepFromTrialName(configPath: string, trialIdx: number): string {
  return `${configStem(configPath)} — opt #${trialIdx} recipe`;
}

/** Default name for a refine-around-best optimization spawned from a study. */
export function refineName(configPath: string, trialIdx: number): string {
  return `${configStem(configPath)} — refine of #${trialIdx}`;
}
