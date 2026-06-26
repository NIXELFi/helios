// Canonical plugin-bundle compliance rules — the SINGLE SOURCE shared by the
// author CLI (`cli/helios-plugin.mjs`) and the marketplace review pipeline
// (Sub-project D's runChecks). Plain ESM so the Node CLI can `import` it with no
// build step; typed for TS consumers by the sidecar `compliance.d.mts`.
//
// This scan is a heuristic AUTHOR AID, not the security control — the opaque-origin
// sandbox + strict CSP is. It can be defeated by aliasing, so the review pipeline
// treats a clean scan as necessary-not-sufficient. We flag APIs the bundled SDK
// never uses (network, alternate storage, cookies, dynamic eval), so their
// presence in a COMPILED bundle is a genuine red flag.

/** Permission keys a manifest may declare. Mirrors `ALL_PERMISSIONS` in
 *  capabilities.ts — kept here too so the plain-ESM CLI can import it without
 *  pulling in the TS catalog. */
export const ALLOWED_PERMISSIONS = ["file.read", "file.write", "storage", "engine:matlab"];

// The lookbehind `(?<![.\w])` excludes member-access forms (`store.fetch(`,
// `obj.eval(`) so only the GLOBAL builtins are flagged.
export const FORBIDDEN = [
  { re: /(?<![.\w])fetch\s*\(/, msg: "network call `fetch(` — blocked by CSP. Use a brokered capability instead." },
  { re: /\bXMLHttpRequest\b/, msg: "`XMLHttpRequest` — network is blocked by CSP." },
  { re: /\bWebSocket\b/, msg: "`WebSocket` — network is blocked by CSP." },
  { re: /\bnavigator\.sendBeacon\b/, msg: "`sendBeacon` — network is blocked by CSP." },
  { re: /\bdocument\.cookie\b/, msg: "`document.cookie` — unavailable in the sandbox." },
  { re: /\blocalStorage\b/, msg: "`localStorage` — unavailable in the sandbox. Use the SDK `storage` API." },
  { re: /\bsessionStorage\b/, msg: "`sessionStorage` — unavailable in the sandbox. Use the SDK `storage` API." },
  { re: /\bindexedDB\b/, msg: "`indexedDB` — unavailable in the sandbox. Use the SDK `storage` API." },
  { re: /(?<![.\w])eval\s*\(/, msg: "`eval(` — dynamic code execution is not allowed." },
];

// Map a used capability to the permission it requires. Matches BOTH the SDK
// helper names (save(), storage.set()) and the raw wire-method strings so the
// check works whether the plugin used the SDK helpers or spoke the protocol.
export const USAGE_TO_PERMISSION = [
  { re: /\bopenFile\s*\(|["']file\.read["']/, perm: "file.read" },
  { re: /\bsave\s*\(|["']file\.write["']/, perm: "file.write" },
  { re: /\bstorage\.(get|set|keys|delete)\s*\(|["']storage\.(get|set|keys|delete)["']/, perm: "storage" },
  { re: /\bengine\.matlab\.run\s*\(|["']engine\.matlab\.run["']/, perm: "engine:matlab" },
];

/** File extensions worth scanning for forbidden APIs / capability usage. */
export const SCANNABLE_EXTENSIONS = [".js", ".mjs", ".html", ".css"];

function isScannable(path) {
  const p = path.toLowerCase();
  return SCANNABLE_EXTENSIONS.some((e) => p.endsWith(e));
}

/**
 * Scan a built bundle for compliance findings.
 * @param {Record<string, string>} files  path -> file contents (only scannable
 *   extensions are inspected; the rest are ignored)
 * @param {{ permissions?: string[] }} manifest  the (already-parsed) manifest
 * @returns {Array<{level:"error"|"warn", kind:string, message:string, path?:string, permission?:string}>}
 */
export function scanBundle(files, manifest) {
  const findings = [];
  const declared = new Set(Array.isArray(manifest?.permissions) ? manifest.permissions : []);
  const used = new Set();

  for (const [path, content] of Object.entries(files)) {
    if (!isScannable(path) || typeof content !== "string") continue;
    for (const rule of FORBIDDEN) {
      if (rule.re.test(content)) {
        findings.push({ level: "error", kind: "forbidden-api", message: rule.msg, path });
      }
    }
    for (const u of USAGE_TO_PERMISSION) {
      if (u.re.test(content)) used.add(u.perm);
    }
  }

  // Declared-vs-used reconciliation.
  for (const perm of used) {
    if (!declared.has(perm)) {
      findings.push({
        level: "error",
        kind: "undeclared-permission",
        message: `code uses a '${perm}' capability but the manifest does not declare it`,
        permission: perm,
      });
    }
  }
  for (const perm of declared) {
    if (!used.has(perm)) {
      findings.push({
        level: "warn",
        kind: "unused-permission",
        message: `manifest declares '${perm}' but no code uses it — drop it to minimise the trust surface`,
        permission: perm,
      });
    }
  }
  return findings;
}
