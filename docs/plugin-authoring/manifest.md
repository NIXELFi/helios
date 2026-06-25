# `manifest.json` — The Contract Reference

> **TOP RULE:** `permissions` is **DEFAULT-DENY**. Start with `"permissions": []`
> and add a capability **only** when the plugin genuinely needs it. If the plugin
> just renders UI and computes, it **MUST** stay `[]`.

Every `.hplugin` **MUST** contain a `manifest.json` at the zip root. It is JSON
(no comments, no trailing commas). The host parses it before loading the entry. A
malformed manifest means the plugin will not load.

---

## Complete example (all fields)

```json
{
  "format": 1,
  "id": "aero.downforce-calculator",
  "name": "Downforce Calculator",
  "version": "1.4.0",
  "description": "Computes downforce from speed and aero coefficients.",
  "subteam": "aero",
  "icon": "dist/icon.png",
  "entry": "dist/index.html",
  "sdk": "^1.0.0",
  "permissions": ["file.read", "storage"]
}
```

## Minimal example (pure sandbox)

```json
{
  "format": 1,
  "id": "aero.downforce-calculator",
  "name": "Downforce Calculator",
  "version": "1.0.0",
  "entry": "dist/index.html",
  "sdk": "^1.0.0",
  "permissions": []
}
```

---

## Field reference

### `format` — number — REQUIRED
- **MUST** be `1`. This is the manifest schema version. There is no other valid
  value today.

### `id` — string — REQUIRED
- Stable, unique, and **IMMUTABLE across versions**. It is the plugin's identity.
- Used to derive the **plugin origin** and the **storage namespace**. Changing it
  orphans the plugin's stored data and is treated as a different plugin.
- **MUST** be lowercase letters/digits arranged in dot/dash segments.
  - Examples: `aero.downforce-calculator`, `suspension.spring-rate-tool`,
    `data.csv-summarizer`.
- **MUST NOT** contain uppercase, spaces, underscores, or path characters.
- **NEVER** change `id` to "rename" a plugin — change `name` instead.

### `name` — string — REQUIRED
- Human-readable display name shown in the Helios plugin list.
- Free text. Change this freely between versions; it does not affect identity.

### `version` — string — REQUIRED
- The **plugin's OWN semver**, fully independent of the Helios application version.
  e.g. `"1.4.0"`.
- **MUST** be valid semver (`MAJOR.MINOR.PATCH`).
- **MUST** be bumped on every change you ship.
- This is **not** the SDK version and **not** the Helios version — do not confuse
  them.

### `description` — string — OPTIONAL
- One-line summary of what the plugin does. Shown in the plugin list.

### `subteam` — string — OPTIONAL
- The owning subteam (e.g. `"aero"`, `"suspension"`). Organizational metadata only.

### `icon` — string — OPTIONAL
- Relative path to an icon asset, e.g. `"dist/icon.png"`.
- **MUST** be inside the packaged zip (typically under `dist/`). It is loaded from
  the plugin's own origin, so a relative path is required — **NEVER** a remote URL.

### `entry` — string — REQUIRED
- Relative path to the HTML entry point, e.g. `"dist/index.html"`.
- **MUST** point to a **self-contained** HTML file: all JS/CSS/assets inlined or
  referenced by relative paths within `dist/`.
- The entry runs at an **opaque origin** — it cannot load cross-origin resources.
  See [constraints.md](./constraints.md).

### `sdk` — string — REQUIRED
- The compatible **SDK contract range** as a semver range, e.g. `"^1.0.0"`.
- The **current host SDK contract version is `1.0.0`**.
- Use `"^1.0.0"` unless you have a specific reason. If the host's contract version
  falls outside this range, the host may refuse to load the plugin.

### `permissions` — array of strings — REQUIRED
- **DEFAULT-DENY.** `[]` means a pure-sandbox plugin (UI + compute only).
- Every capability the plugin uses **MUST** be listed explicitly.
- **Allowed values — ONLY these four. No others exist:**

| Value | Grants | Trust tier |
| --- | --- | --- |
| `"file.read"` | Read a file the user explicitly picks via a host-rendered picker. No directory listing, no filesystem access. | Tier 1 (low) |
| `"file.write"` | Save a result file via a user-confirmed save dialog. | Tier 1 (low) |
| `"storage"` | Private, plugin-scoped key-value storage (namespaced by `id`, isolated, ~1MB quota). | Tier 1 (low) |
| `"engine:matlab"` | Run MATLAB programs on the user's machine via their local MATLAB license. Native code at user privileges. Install-time consent + human review. | Tier 2 (HIGH) |

- **MUST NOT** invent permission strings. Anything not in this table is invalid.
- **MUST** map each declared permission to a real SDK call you make. The validator
  **errors** on undeclared-but-used and **warns** on declared-but-unused.
- `"engine:matlab"` is **NOT implemented yet** (arrives in a later sub-project). Do
  not declare it unless the user explicitly accepts a non-functional placeholder;
  calling `engine.matlab.run` will not work today.

---

## Permission decision guide

Ask, in order:

1. Does the plugin only take inputs from its own UI and compute/render results?
   → `permissions: []`. Stop. You are done.
2. Does it need the user to load a file (CSV, log, etc.) from their machine?
   → add `"file.read"`.
3. Does it produce a file the user should save (export, report)?
   → add `"file.write"`.
4. Does it need to remember settings/results between sessions?
   → add `"storage"`.
5. Does it need to run MATLAB on the user's machine? → it is not available yet.
   Do not rely on `"engine:matlab"`.

**ALWAYS choose the smallest set.** Each extra permission raises the trust tier and
review burden. Record the justification for each one in `PLUGIN.md`.

---

## Common manifest mistakes (MUST NOT)

- **MUST NOT** point `entry` at a file that loads external scripts/styles/fonts.
- **MUST NOT** set `permissions` to a string — it is an array.
- **MUST NOT** include `"network"`, `"http"`, `"fetch"`, `"clipboard"`, or any other
  value: only the four listed exist.
- **MUST NOT** change `id` between versions.
- **MUST NOT** forget to bump `version`.
- **MUST NOT** add comments or trailing commas — it is strict JSON.
