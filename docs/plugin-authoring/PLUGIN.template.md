<!--
  COPY THIS FILE to the plugin project root as PLUGIN.md.
  This is your LIVING MEMORY FILE. You (the AI agent) MUST create it at project
  start and KEEP IT UPDATED as you work — it keeps a long vibe-coding session
  consistent and in-compliance. Update the "Status log" every work session.
  Delete this comment after copying. Do NOT package PLUGIN.md inside the .hplugin.
-->

# PLUGIN.md — <PLUGIN NAME>

## Identity
- **id:** `<dot-dash id, lowercase, IMMUTABLE>`  <!-- e.g. aero.downforce-calculator -->
- **name:** `<display name>`
- **version:** `<semver, the plugin's OWN version>`  <!-- bump on every change -->
- **sdk range:** `^1.0.0`  <!-- host contract is 1.0.0 -->
- **subteam:** `<owning subteam, or n/a>`

## Purpose
<!-- 2-4 sentences. What problem does this plugin solve for the user? What does it
     take as input and what does it produce? Plain language. -->
<...>

## Permissions — declared and JUSTIFIED
<!-- DEFAULT-DENY. List ONLY permissions actually used. For each, state WHY.
     If the plugin is pure UI + compute, this table is EMPTY and permissions = []. -->

| Permission | Declared? | Why it's needed (specific) |
| --- | --- | --- |
| `file.read` | yes / no | <e.g. "user loads a lap-time CSV to summarize"> |
| `file.write` | yes / no | <e.g. "exports the computed summary as a .csv"> |
| `storage` | yes / no | <e.g. "remembers the user's last coefficient settings"> |
| `engine:matlab` | no | NOT available yet — do not declare or call. |

**Manifest `permissions` array (must match the table above exactly):**
```json
"permissions": []
```

## Files read (only if `file.read` is declared)
<!-- What file types/shapes the plugin expects, and what it does with them. -->
- Accepts: `<e.g. .csv with columns speed,downforce>`
- Behavior on bad/cancelled input: `<must handle null from openFile and bad parse>`

## Compliance self-check (the wall)
<!-- Confirm you respected the sandbox. Re-check each time you add code. -->
- [ ] No `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` (no network).
- [ ] No `localStorage` / `sessionStorage` / `indexedDB` / `document.cookie`
      (use SDK `storage`).
- [ ] No `eval` / dynamic `Function` / dynamic remote `import`.
- [ ] No `window.parent` / `window.top` access (use the SDK only).
- [ ] No remote scripts/styles/fonts/images — everything inlined in `dist/`;
      images as `data:` URIs.
- [ ] `await ready()` called once at startup.
- [ ] Every host call wrapped in try/catch handling error `.code`s.

## Key design decisions
<!-- Record non-obvious choices so a later session stays consistent.
     e.g. "Used canvas for the plot to avoid bundling a chart lib." -->
- <...>

## Build & package notes
- Bundler: `<vite / esbuild / …>` configured to inline JS+CSS into `dist/index.html`.
- Entry verified to run **offline** with no cross-origin loads: <yes/no>
- `.hplugin` contains ONLY `manifest.json` + `dist/` (no source, no node_modules).
- `helios-plugin check` last result: `<exit 0 / errors / warnings>` on `<date>`.

## Status log
<!-- Append a dated line every session. Newest at top. -->
- `<YYYY-MM-DD>` — <what changed / what's next> 
