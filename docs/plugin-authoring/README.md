# Helios v5 — Agent Authoring Kit

You are an AI coding agent building a **Helios plugin** for a non-coder. Read this
entire kit before writing a single line. These docs are the contract. If you follow
them exactly, the plugin loads, passes validation, and ships. If you deviate, it
will silently fail inside the sandbox and the user — who cannot debug it — will be
stuck.

> **THE ONE RULE THAT MATTERS MOST**
>
> **A Helios plugin runs in a locked-down, network-isolated, cross-origin-blocked
> sandboxed iframe.** It has **NO network**, **NO access to the host page**, **NO
> Supabase**, **NO login token**, and **NO browser storage** (`localStorage`,
> `cookies`, `indexedDB` are all gone). It may only render UI, compute, and talk to
> the host through the `@helios/plugin-sdk`. **Everything you build MUST be
> self-contained.** If you assume otherwise, you will ship something broken.

---

## What a plugin is

A plugin is a **self-contained web app** (HTML/CSS/JS — any framework, compiled and
bundled) that:

- Runs inside a **locked-down sandboxed iframe** in Helios.
- Renders its own UI and computes freely (this is where it has full freedom).
- Is delivered as a `.hplugin` zip containing `manifest.json` + a `dist/` folder.
- Has a **self-contained `dist/index.html`** entry: all JS, CSS, and assets are
  inlined or referenced by **relative** paths inside `dist/`.
- Runs at an **opaque origin** — it cannot load anything cross-origin (no CDNs, no
  remote fonts, no remote images, no remote scripts).
- Talks to Helios **only** through `@helios/plugin-sdk`.

You build against the `@helios/plugin-sdk` package and bundle to `dist/`.

---

## Golden rules (memorize these)

1. **MUST** treat the plugin as offline and origin-isolated. **NEVER** use
   `fetch`, `XMLHttpRequest`, `WebSocket`, or `navigator.sendBeacon`. There is no
   network. (See [constraints.md](./constraints.md).)
2. **MUST** inline/bundle everything into `dist/`. **NEVER** reference a remote
   `<script>`, `<img>` URL, web font, or stylesheet. Images go in as `data:` URIs.
3. **MUST NOT** use `localStorage`, `sessionStorage`, `indexedDB`, or
   `document.cookie`. Use the SDK `storage` API (requires the `storage` permission).
4. **MUST NOT** touch `window.parent`, `window.top`, or try to reach the host page
   directly. Use the SDK — it handles all host communication internally.
5. **MUST NOT** use `eval()` or any dynamic code execution.
6. **MUST** `await ready()` exactly once at startup before using any other SDK
   method that depends on the host.
7. **MUST** declare every capability you use in `manifest.json` `permissions`.
   It is **default-deny**: an empty array means pure sandbox (UI + compute only).
   Calling an undeclared capability rejects with `code === "PermissionNotDeclared"`.
8. **MUST** request the **fewest** permissions possible. If the plugin only computes
   and renders, `permissions` **MUST** be `[]`.
9. **MUST** keep `id` stable and immutable across versions. Bump `version` (the
   plugin's own semver) on every change.
10. **MUST** create and maintain `PLUGIN.md` in the project (copy it from
    [PLUGIN.template.md](./PLUGIN.template.md)) and keep it updated as you work.
11. **MUST** run `helios-plugin check <plugin-dir>` and get a clean exit before
    declaring the plugin done. (See [checklist.md](./checklist.md).)

---

## Quickstart

### 1. Project layout

```
my-plugin/
  manifest.json          # the contract (see manifest.md)
  PLUGIN.md              # your living memory file (see PLUGIN.template.md)
  src/
    index.ts             # your entry; imports @helios/plugin-sdk
    styles.css
  package.json
  dist/                  # BUILD OUTPUT — self-contained
    index.html           # everything inlined; no network, no cross-origin
```

### 2. Minimal `manifest.json`

```json
{
  "format": 1,
  "id": "aero.downforce-calculator",
  "name": "Downforce Calculator",
  "version": "1.0.0",
  "description": "Computes downforce from speed and aero coefficients.",
  "entry": "dist/index.html",
  "sdk": "^1.0.0",
  "permissions": []
}
```

### 3. Minimal `src/index.ts` using the SDK

```ts
import { ready, getContext, log, notify } from "@helios/plugin-sdk";

async function main() {
  // MUST await ready() once before using host-dependent APIs.
  const ctx = await ready();
  log("plugin booted", ctx.pluginId, ctx.pluginVersion);

  // ctx.theme is "light" | "dark" — adapt your UI to it.
  document.documentElement.dataset.theme = ctx.theme;

  const root = document.getElementById("app")!;
  root.innerHTML = `
    <label>Speed (m/s) <input id="v" type="number" value="30"></label>
    <button id="go">Compute</button>
    <output id="out"></output>
  `;

  document.getElementById("go")!.addEventListener("click", () => {
    const v = Number((document.getElementById("v") as HTMLInputElement).value);
    const cl = 3.2, rho = 1.225, area = 1.1;
    const downforceN = 0.5 * rho * v * v * cl * area;
    (document.getElementById("out") as HTMLOutputElement).value =
      `${downforceN.toFixed(1)} N`;
    notify("Computed downforce", "info");
  });
}

main();
```

### 4. Build to a self-contained `dist/index.html`

Use a bundler (Vite, esbuild, etc.) configured to **inline** JS and CSS into a
single HTML file with no external references. The output **MUST** run with no
network and no cross-origin loads. Verify by opening it offline.

### 5. Validate

```
helios-plugin check ./my-plugin
```

It **MUST** pass (exit 0). It validates the manifest, scans the bundle for forbidden
APIs, and checks declared-vs-used permissions.

### 6. Package

Zip `manifest.json` + `dist/` into `my-plugin.hplugin`. **NO source, NO
node_modules.**

```
my-plugin.hplugin
  manifest.json
  dist/
    index.html
```

---

## Index — read these in order

| Doc | What it covers | When you need it |
| --- | --- | --- |
| [README.md](./README.md) | This overview, quickstart, golden rules | First. Always. |
| [manifest.md](./manifest.md) | The `manifest.json` field-by-field contract | Before you write the manifest |
| [sdk-api.md](./sdk-api.md) | Every SDK function, signatures, errors | Whenever you call the SDK |
| [constraints.md](./constraints.md) | **"This will not work — use this instead."** The most important doc. | Before using ANY browser API |
| [PLUGIN.template.md](./PLUGIN.template.md) | Copy to `PLUGIN.md`; your living memory | At project start; keep updated |
| [checklist.md](./checklist.md) | Pre-submission checklist | Before you say "done" |

---

## The trust model in one table

| Capability | Permission | Trust tier | Notes |
| --- | --- | --- | --- |
| Render UI, compute | _(none)_ | Tier 0 | Always available. No permission needed. |
| `log`, `notify` | _(none)_ | Tier 0 | Always available. |
| Read a user-picked file | `file.read` | Tier 1 (low) | Host-rendered picker. No directory/filesystem access. |
| Save a result file | `file.write` | Tier 1 (low) | User-confirmed save dialog. |
| Private key-value storage | `storage` | Tier 1 (low) | Plugin-scoped, ~1MB, isolated. |
| Run MATLAB locally | `engine:matlab` | Tier 2 (HIGH) | Native code w/ user privileges. Install-time consent + human review. **NOT implemented yet — do not call.** |

Default-deny: if it's not in `permissions`, you cannot use it.
