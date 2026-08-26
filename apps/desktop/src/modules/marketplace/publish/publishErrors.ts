// Turning a Postgres raise into a sentence someone can act on.
//
// The publish RPC raises precise, correct, and completely unhelpful messages:
// "version 1.2.0 of aero.x already exists (versions are immutable)" is accurate
// and tells a non-coder nothing about what to do next. Each mapping below pairs
// the failure with the fix.
//
// The fallback deliberately keeps the raw message rather than replacing it with
// something reassuring — an error nobody can diagnose is worse than an ugly one.

import type { HelpTopic } from "../authoring/helpContent";

export interface ExplainedError {
  title: string;
  detail: string;
  helpTopic?: HelpTopic;
  /** True when retrying the same bytes could plausibly succeed (network, not logic). */
  retryable: boolean;
}

function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

/** Suggest the next patch version, so the fix can be stated concretely. */
function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return "the next version";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function explainPublishError(e: unknown, context?: { version?: string }): ExplainedError {
  const raw = messageOf(e);
  const msg = raw.toLowerCase();

  if (msg.includes("versions are immutable") || msg.includes("already exists")) {
    const version = context?.version;
    const next = version ? bumpPatch(version) : "the next version";
    return {
      title: version ? `Version ${version} has already been published` : "That version already exists",
      detail:
        "Published versions can never be changed — people install specific versions, and results have to stay " +
        `reproducible. Bump "version" in manifest.json to ${next}, rebuild, and submit again.`,
      helpTopic: "versions",
      retryable: false,
    };
  }

  if (msg.includes("insufficient privilege")) {
    return {
      title: "You cannot publish to this subteam",
      detail:
        "Publishing needs the marketplace.publish capability for the subteam that owns this plugin. Engineers, " +
        "leads and VPs have it for their own subteam. Ask your lead or VP to add you, or pick a subteam you " +
        "already belong to.",
      helpTopic: "review",
      retryable: false,
    };
  }

  if (msg.includes("bundle_bytes out of range")) {
    return {
      title: "The bundle is too large",
      detail:
        "A plugin bundle is capped at 25 MB. It is almost always one large asset — check for uncompressed " +
        "images or data files that could be trimmed or left out of dist/.",
      helpTopic: "bundle",
      retryable: false,
    };
  }

  if (msg.includes("manifest.") || msg.includes("manifest must be")) {
    return {
      title: "The server rejected manifest.json",
      detail: `${raw}\n\nThe manifest is validated again on the server, so this is a real problem with the file rather than a UI glitch.`,
      helpTopic: "manifest",
      retryable: false,
    };
  }

  if (msg.includes("authentication required") || msg.includes("jwt")) {
    return {
      title: "Your session expired",
      detail: "Sign in again and resubmit. Nothing was published.",
      retryable: true,
    };
  }

  if (
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econn")
  ) {
    return {
      title: "Could not reach the marketplace",
      detail:
        "The upload did not complete. Your packed bundle is still here, so Retry will not have to rebuild it. " +
        "If this keeps happening, check whether you are on the work network's restricted VLAN.",
      retryable: true,
    };
  }

  return {
    title: "Publishing failed",
    detail: raw,
    retryable: true,
  };
}

/** Storage rejects a second upload of an existing object. Because the key IS the
 *  content hash, that means the identical bytes are already stored — which is
 *  success, not failure. Anything else is a real upload error. */
export function isDuplicateObjectError(e: unknown): boolean {
  const msg = messageOf(e).toLowerCase();
  const status = (e as { statusCode?: unknown } | null)?.statusCode;
  return (
    msg.includes("already exists") ||
    msg.includes("duplicate") ||
    msg.includes("resource already exists") ||
    status === "409" ||
    status === 409
  );
}
