// Plugin version helpers. A plugin's version is its OWN semver, independent of
// the Helios app version. The SDK ships `isSdkCompatible` for matching an SDK
// *range*, but the marketplace needs a plain "is X strictly newer than Y" to
// decide when to surface an "update available" affordance — that lives here.

interface Parsed {
  core: [number, number, number];
  /** Pre-release tag (everything after the first `-`), or null for a release. */
  pre: string | null;
}

function parse(version: string): Parsed {
  const dash = version.indexOf("-");
  const coreStr = dash === -1 ? version : version.slice(0, dash);
  const pre = dash === -1 ? null : version.slice(dash + 1);
  const parts = coreStr.split(".");
  const num = (i: number): number => {
    const v = Number(parts[i]);
    return Number.isFinite(v) ? v : 0;
  };
  return { core: [num(0), num(1), num(2)], pre: pre || null };
}

/** True if `a` is a strictly newer semver than `b`. A pre-release sorts BELOW
 *  the release of the same core version (1.2.0-rc.1 < 1.2.0), matching semver. */
export function isNewer(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const ai = pa.core[i] ?? 0;
    const bi = pb.core[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  // Same core version — disambiguate on the pre-release tag.
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true; // a is a release, b is a pre-release
  if (pb.pre === null) return false; // a is a pre-release, b is a release
  return pa.pre > pb.pre; // both pre-releases — coarse lexical ordering
}

/** A plugin whose newest approved `version` is ahead of the `installedVersion`. */
export function hasUpdate(plugin: { version: string; installedVersion: string | null }): boolean {
  return plugin.installedVersion !== null && isNewer(plugin.version, plugin.installedVersion);
}
