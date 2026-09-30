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
    case "external-asset":
      return {
        level: f.level === "error" ? "error" : "warning",
        code: "external-asset",
        title:
          f.level === "error"
            ? "Your entry page loads code from a separate file"
            : "Your entry page points at an image or font file",
        detail:
          "Helios runs your plugin from the entry HTML file alone, inside a sandbox that only allows " +
          "inline code and data: images. Anything the page loads by URL, even a file sitting next to it " +
          "in dist/, is never fetched. " +
          (f.level === "error"
            ? "With a script or stylesheet that means a blank page. Ask your agent to switch the build " +
              "to a single-file output (for Vite: vite-plugin-singlefile) so everything is inlined."
            : "The plugin still runs, but the image or font will be missing. Embed it as a data: URI.") +
          `\n\nThe scanner reported: ${f.message}`,
        path: f.path,
        helpTopic: "bundle",
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
 * @param unscanned  scannable files too large to read (from the packer). The scan
 *   cannot vouch for them, so the report says so instead of showing green.
 */
export function preflight(
  texts: Record<string, string>,
  manifest: unknown,
  unscanned: string[] = [],
): PreflightReport {
  const manifestResult = validateManifest(manifest);
  const scan = scanBundle(texts, (manifest ?? {}) as { permissions?: string[]; entry?: string });

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

  const entry =
    typeof (manifest as { entry?: unknown } | null)?.entry === "string"
      ? ((manifest as { entry: string }).entry).replace(/^\.?\//, "")
      : null;
  for (const path of unscanned) {
    const isEntry = path === entry;
    (isEntry ? errors : warnings).push({
      level: isEntry ? "error" : "warning",
      code: "unscanned",
      title: isEntry ? "Your entry page is too large to check" : "A file is too large to check",
      detail:
        "The check reads every script and page in the bundle, but this file is over 16 MB, so it was " +
        "not read and nothing here can vouch for it. " +
        (isEntry
          ? "Since the entry page is what runs, it has to be checked: trim what the build inlines " +
            "(unused libraries, embedded data) until it is under 16 MB."
          : "You can still submit; your reviewer will see this warning too."),
      path,
      helpTopic: "bundle",
    });
  }

  // Nothing is reported as passing while part of the bundle went unread.
  const checks = unscanned.length > 0 ? [] : PASSING_CHECKS;
  const passed: PreflightFinding[] = checks.filter((c) => c.when(flagged)).map((c) => ({
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

/**
 * Differences between the manifest recorded with a version (what the review
 * card, the permission diff and install consent are all based on) and the
 * manifest.json actually inside the uploaded bundle. The submit wizard always
 * sends the bundle's own manifest, so any drift means the version was published
 * some other way, and approving it would ship something nobody reviewed: installs
 * refuse a bundle that grants itself more than was approved, and the launcher
 * refuses one whose version is not the recorded one. Each difference is blocking.
 */
export function manifestDrift(recorded: unknown, bundle: unknown): PreflightFinding[] {
  const r = (recorded ?? {}) as Record<string, unknown>;
  const b = (bundle ?? {}) as Record<string, unknown>;
  const perms = (m: Record<string, unknown>) =>
    (Array.isArray(m.permissions) ? (m.permissions as unknown[]).map(String) : []).sort().join(", ") || "none";
  const out: PreflightFinding[] = [];
  for (const [field, a, c] of [
    ["id", String(r.id ?? ""), String(b.id ?? "")],
    ["version", String(r.version ?? ""), String(b.version ?? "")],
    ["entry", String(r.entry ?? ""), String(b.entry ?? "")],
    ["permissions", perms(r), perms(b)],
  ] as const) {
    if (a !== c) {
      out.push({
        level: "error",
        code: "manifest-drift",
        title: `The bundle's ${field} does not match what was submitted`,
        detail:
          `The version was submitted with ${field} "${a}", but manifest.json inside the uploaded bundle says ` +
          `"${c}". Everything on this card describes the submitted value, so approving would ship something ` +
          "that was not reviewed. Reject it and ask the author to resubmit from Add to Marketplace.",
        path: "manifest.json",
        helpTopic: "review",
      });
    }
  }
  return out;
}
