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

// External references in the ENTRY document. The host reads the entry HTML and
// runs it as an iframe `srcdoc` under a CSP that only allows inline script/style
// and data:/blob: images, so nothing the entry points at by URL is ever loaded,
// relative path or not. A default multi-file build (Vite's `assets/index-abc.js`)
// therefore packs fine and opens as a blank page. Scripts and stylesheets are
// errors (the plugin cannot work); images and CSS url()s are warnings (it works,
// minus the picture).
const EXTERNAL_REF_RULES = [
  {
    re: /<script\b[^>]*\bsrc\s*=\s*["']?(?!data:|blob:)[^"'\s>]+/i,
    level: "error",
    msg: "the entry HTML loads a script by URL (`<script src=...>`). Plugins run from the entry HTML alone, so it will never load and the page stays blank. Inline the script: build with a single-file setup (e.g. vite-plugin-singlefile).",
  },
  {
    re: /<link\b(?=[^>]*\brel\s*=\s*["']?[^"'>]*\b(?:stylesheet|modulepreload)\b)[^>]*\bhref\s*=\s*["']?(?!data:|blob:)[^"'\s>]+/i,
    level: "error",
    msg: "the entry HTML links a stylesheet or module by URL (`<link href=...>`). It will never load. Inline your CSS/JS into the entry HTML with a single-file build.",
  },
  {
    re: /<(?:img|source|image)\b[^>]*\b(?:src|href)\s*=\s*["']?(?!data:|blob:|#)[^"'\s>]+/i,
    level: "warn",
    msg: "the entry HTML references an image by URL. Only data: and blob: images load in the sandbox, so it will show as broken. Embed it as a data: URI.",
  },
  {
    // Lower-case and not part of an identifier, so JS like `URL.createObjectURL(`
    // or `canvas.toDataURL(` in an inlined bundle does not trip it.
    re: /(?<![\w.$])url\(\s*["']?(?!data:|blob:|#)[^)"'\s]+/,
    level: "warn",
    msg: "the entry HTML uses a CSS url(...) that is not a data: URI (a font, background image or @import). It will not load in the sandbox. Embed it as a data: URI.",
  },
];

function normalizeEntry(entry) {
  return typeof entry === "string" ? entry.replace(/^\.?\//, "") : null;
}

/**
 * Scan a built bundle for compliance findings.
 * @param {Record<string, string>} files  path -> file contents (only scannable
 *   extensions are inspected; the rest are ignored)
 * @param {{ permissions?: string[], entry?: string }} manifest  the (already-parsed) manifest
 * @returns {Array<{level:"error"|"warn", kind:string, message:string, path?:string, permission?:string}>}
 */
export function scanBundle(files, manifest) {
  const findings = [];
  const declared = new Set(Array.isArray(manifest?.permissions) ? manifest.permissions : []);
  const used = new Set();
  const entry = normalizeEntry(manifest?.entry);

  for (const [path, content] of Object.entries(files)) {
    if (!isScannable(path) || typeof content !== "string") continue;
    if (entry && path.replace(/^\.?\//, "") === entry) {
      for (const rule of EXTERNAL_REF_RULES) {
        if (rule.re.test(content)) {
          findings.push({ level: rule.level, kind: "external-asset", message: rule.msg, path });
        }
      }
    }
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
