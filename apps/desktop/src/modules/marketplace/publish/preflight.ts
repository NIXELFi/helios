// Pre-flight: turn the raw compliance scan into something a non-coder can act on.
//
// The scan itself is NOT reimplemented here. It is `scanBundle` from
// @helios/plugin-sdk — the exact module the author CLI runs and the reviewer's
// re-scan runs. That shared origin is what lets the wizard tell someone "a green
// check here means a green check in review" without lying. If this file ever
// grows its own rules, that promise breaks; add rules to compliance.mjs instead.
//
// What this file DOES own: grouping findings by severity, explaining each one in
// plain English, and pointing every one of them at a help topic. A finding that
// says only "forbidden-api" is useless to the person who has to fix it.

import { scanBundle, validateManifest, type ComplianceFinding } from "@helios/plugin-sdk";
import type { HelpTopic } from "../authoring/helpContent";

export type FindingLevel = "error" | "warning" | "ok";

export interface PreflightFinding {
  level: FindingLevel;
  /** Stable machine code, for tests and telemetry. */
  code: string;
  /** Short label — what is wrong. */
  title: string;
  /** Plain English — what it means and what to do about it. */
  detail: string;
  /** Bundle-relative path, when the finding belongs to one file. */
  path?: string;
  /** Where the Help drawer should open when this finding is clicked. */
  helpTopic: HelpTopic;
}

export interface PreflightReport {
  /** True when nothing blocks publishing. Warnings do not block. */
  ok: boolean;
  errors: PreflightFinding[];
  warnings: PreflightFinding[];
  /** Checks that passed — shown so the author sees what is right, not only what is wrong. */
  passed: PreflightFinding[];
  /** Serializable snapshot, submitted as the version's review_report. */
  raw: {
    scan: ComplianceFinding[];
    manifestErrors: string[];
    manifestWarnings: string[];
    at: string;
  };
}

/** Which help topic a forbidden-API message belongs to. Keyed off the API named
 *  in the rule's own message, so adding a rule to compliance.mjs at worst lands
 *  in the general sandbox topic rather than breaking the mapping. */
function topicForForbidden(message: string): { topic: HelpTopic; title: string; detail: string } {
  const m = message.toLowerCase();
  if (m.includes("fetch") || m.includes("xmlhttprequest") || m.includes("websocket") || m.includes("sendbeacon")) {
    return {
      topic: "network",
      title: "Tries to use the network",
      detail:
        "A plugin has no network access — this call is blocked by the sandbox and will fail for every user. " +
        "Ask your agent to remove it and use the SDK file or storage APIs, or to bundle the data into dist/ instead.",
    };
  }
  if (m.includes("localstorage") || m.includes("sessionstorage") || m.includes("indexeddb") || m.includes("cookie")) {
    return {
      topic: "storage",
      title: "Uses browser storage",
      detail:
        "localStorage, sessionStorage, indexedDB and cookies do not exist in the plugin sandbox. " +
        "Ask your agent to switch to the SDK storage API and add \"storage\" to the manifest's permissions.",
    };
  }
  if (m.includes("eval")) {
    return {
      topic: "eval",
      title: "Runs code dynamically",
      detail:
        "eval() and dynamic code execution are blocked by the sandbox policy. This usually comes from a bundler " +
        "setting or an older library rather than from code anyone wrote on purpose.",
    };
  }
  return {
    topic: "host-access",
    title: "Uses something the sandbox blocks",
    detail:
      "This call is not available inside the plugin sandbox and will fail at runtime. " +
      "See the help topic for what the sandbox allows and what to use instead.",
  };
}

function explain(f: ComplianceFinding): PreflightFinding {
  switch (f.kind) {
    case "forbidden-api": {
      const { topic, title, detail } = topicForForbidden(f.message);
      return {
        level: "error",
        code: "forbidden-api",
        title,
        detail: `${detail}\n\nThe scanner reported: ${f.message}`,
        path: f.path,
        helpTopic: topic,
      };
    }
    case "undeclared-permission":
      return {
        level: "error",
        code: "undeclared-permission",
        title: `Uses "${f.permission}" without declaring it`,
        detail:
          `Your code calls the "${f.permission}" capability, but manifest.json does not list it. ` +
          "Permissions are default-deny, so this call would fail for every user. Add it to the " +
          "permissions array — or, if the capability is not actually needed, remove the code that calls it.",
        helpTopic: "permissions",
      };
    case "unused-permission":
      return {
        level: "warning",
        code: "unused-permission",
        title: `Asks for "${f.permission}" but never uses it`,
        detail:
          `manifest.json declares "${f.permission}", but nothing in the bundle uses it. Everyone installing ` +
          "your plugin is shown this permission, so dropping it makes the plugin easier to say yes to. " +
          "You can publish either way.",
        helpTopic: "permissions",
      };
    default:
      return {
        level: f.level === "error" ? "error" : "warning",
        code: f.kind,
        title: "Compliance finding",
        detail: f.message,
        path: f.path,
        helpTopic: "getting-started",
      };
  }
}

/** The checks whose silence is worth reporting positively. */
const PASSING_CHECKS: Array<{ code: string; title: string; when: (codes: Set<string>) => boolean }> = [
  {
    code: "no-network",
    title: "Makes no network calls",
    when: (codes) => !codes.has("network"),
  },
  {
    code: "no-browser-storage",
    title: "Does not use browser storage",
    when: (codes) => !codes.has("storage"),
  },
  {
    code: "no-dynamic-code",
    title: "Runs no dynamic code",
    when: (codes) => !codes.has("eval"),
  },
  {
    code: "permissions-match",
    title: "Permissions match what the code uses",
    when: (codes) => !codes.has("undeclared-permission"),
  },
];

/**
 * Run the pre-flight over a packed bundle.
 *
 * @param texts  bundle-relative path -> file contents, from `pack_plugin_bundle`
 * @param manifest  the parsed manifest.json
 */
export function preflight(texts: Record<string, string>, manifest: unknown): PreflightReport {
  const manifestResult = validateManifest(manifest);
  const scan = scanBundle(texts, (manifest ?? {}) as { permissions?: string[] });

  const errors: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];

  // Manifest problems come first: they are the most likely to be a one-line fix,
  // and several of them make the rest of the scan meaningless anyway.
  for (const message of manifestResult.errors) {
    errors.push({
      level: "error",
      code: "manifest",
      title: "manifest.json needs a fix",
      detail: message,
      path: "manifest.json",
      helpTopic: "manifest",
    });
  }
  for (const message of manifestResult.warnings) {
    warnings.push({
      level: "warning",
      code: "manifest",
      title: "manifest.json could be tidier",
      detail: message,
      path: "manifest.json",
      helpTopic: "manifest",
    });
  }

  // Track which sandbox areas produced a finding, so `passed` can report the rest.
  const flagged = new Set<string>();
  for (const f of scan) {
    const explained = explain(f);
    if (f.kind === "forbidden-api") flagged.add(explained.helpTopic);
    else flagged.add(f.kind);
    (explained.level === "error" ? errors : warnings).push(explained);
  }

  const passed: PreflightFinding[] = PASSING_CHECKS.filter((c) => c.when(flagged)).map((c) => ({
    level: "ok" as const,
    code: c.code,
    title: c.title,
    detail: "",
    helpTopic: "getting-started" as const,
  }));
  if (manifestResult.ok) {
    passed.unshift({
      level: "ok",
      code: "manifest-valid",
      title: "manifest.json is valid",
      detail: "",
      helpTopic: "manifest",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    passed,
    raw: {
      scan,
      manifestErrors: manifestResult.errors,
      manifestWarnings: manifestResult.warnings,
      at: new Date().toISOString(),
    },
  };
}

/** Does a reviewer's independent re-scan disagree with what the author submitted?
 *  A mismatch is not proof of anything bad — an older client could have produced
 *  the stored report — but it is exactly what a reviewer should look at first. */
export function reportsDisagree(stored: unknown, fresh: PreflightReport): boolean {
  const storedScan = (stored as PreflightReport["raw"] | null)?.scan;
  if (!Array.isArray(storedScan)) return false;
  const key = (f: ComplianceFinding) => `${f.kind}:${f.permission ?? ""}:${f.path ?? ""}:${f.message}`;
  const a = new Set(storedScan.map(key));
  const b = new Set(fresh.raw.scan.map(key));
  if (a.size !== b.size) return true;
  for (const k of b) if (!a.has(k)) return true;
  return false;
}
