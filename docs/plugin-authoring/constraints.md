# Constraints — "THIS WILL NOT WORK — use this instead"

> **READ THIS BEFORE USING ANY BROWSER API.** This is the most important document in
> the kit. Most plugin failures come from an agent assuming it has a normal browser
> environment. **It does not.** The plugin runs behind a wall. Below is the wall, and
> for every blocked thing, the sanctioned alternative.

---

## The Wall (why these constraints exist)

The plugin loads in:

```html
<iframe sandbox="allow-scripts"></iframe>
```

- **`allow-scripts` only** — there is deliberately **NO `allow-same-origin`**. The
  iframe runs at an **opaque origin**. It cannot share an origin with anything, so
  cross-origin loads and same-origin tricks all fail.

…with this strict Content-Security-Policy:

```
default-src 'none';
connect-src 'none';
script-src 'unsafe-inline';
style-src  'unsafe-inline';
img-src    data: blob:;
font-src   data:;
```

Consequences you **MUST** internalize:

- **No network at all.** `connect-src 'none'` kills `fetch`, XHR, WebSocket, beacons.
- **No host visibility.** You cannot see the Helios page, the Supabase client, the
  login token, cookies, or any user session. Opaque origin + no `allow-same-origin`.
- **No remote resources.** `default-src 'none'` + opaque origin block remote scripts,
  images, fonts, and stylesheets. Only inline scripts/styles, `data:`/`blob:` images,
  and `data:` fonts are allowed.
- **The SDK is the only door.** All communication with Helios goes through
  `@helios/plugin-sdk`, which handles the host channel internally.

If you write code that assumes a network, a host, or browser storage, it will fail
**silently** inside the sandbox, and the non-coder user cannot fix it. So don't.

---

## ❌ Don't / ✅ Do — every forbidden API

### Network

| ❌ Don't | ✅ Do instead |
| --- | --- |
| `fetch(url)` | There is **no network**. Bundle the data into `dist/` at build time, or take it as user input, or read it via `openFile()` (needs `file.read`). |
| `new XMLHttpRequest()` | Same as above. No HTTP of any kind. |
| `new WebSocket(url)` | No live connections. Compute locally; persist via SDK `storage`. |
| `navigator.sendBeacon(url, data)` | No analytics/telemetry egress. Use `log()` for host-side diagnostics. |
| Call a REST/GraphQL API, hit Supabase directly | Impossible from the sandbox. If the plugin needs server data, it must come in as a user-picked file or be bundled. |

### Storage

| ❌ Don't | ✅ Do instead |
| --- | --- |
| `localStorage.setItem(k, v)` / `getItem` | `await storage.set(k, v)` / `await storage.get(k)` (needs `storage`). |
| `sessionStorage....` | Use SDK `storage` (it persists across sessions, plugin-scoped). |
| `indexedDB.open(...)` | Use SDK `storage` for KV needs (~1MB). For large transient data, keep it in memory. |
| `document.cookie` | Unavailable. No cookies exist. Use SDK `storage` for persistence. |

### Code execution

| ❌ Don't | ✅ Do instead |
| --- | --- |
| `eval("…")` | Write the logic directly. No dynamic code. |
| `new Function("…")()` | Same — disallowed dynamic execution. Use real functions. |
| `import(remoteUrl)` (dynamic remote import) | Bundle all code into `dist/` at build time. No runtime remote loading. |
| `setTimeout("code string", t)` | Pass a real function: `setTimeout(() => {...}, t)`. |

### Reaching the host

| ❌ Don't | ✅ Do instead |
| --- | --- |
| `window.parent.postMessage(...)` | **NEVER.** Use the SDK — it manages the host channel for you. |
| `window.top.location` / reading parent DOM | Blocked by opaque origin. Use `getContext()` for the (non-sensitive) info you're allowed. |
| Try to read the login token / Supabase session | It is not reachable, by design. Plugins never see auth. |
| Assume you can navigate Helios or open host routes | You cannot. The plugin only controls its own iframe document. |

### External resources

| ❌ Don't | ✅ Do instead |
| --- | --- |
| `<script src="https://cdn…/lib.js">` | Bundle the library into your inlined JS. No remote scripts load. |
| `<link rel="stylesheet" href="https://…">` | Inline your CSS (`<style>` or bundled). |
| `@import url("https://fonts…")` / CDN web fonts | Use system fonts, or embed the font as a `data:` URI (`font-src data:`). |
| `<img src="https://…/logo.png">` | Embed as a `data:` URI: `<img src="data:image/png;base64,…">` (`img-src data: blob:`). |
| `background-image: url("https://…")` | Use a `data:` URI or `blob:` URL instead. |
| Load an icon/asset from a remote URL | Package it inside `dist/` and reference it by relative path, or inline as `data:`. |

---

## What you CAN do freely (no permission, no wall)

- Render any HTML/CSS/JS UI. Use any framework, bundled into `dist/`.
- Run arbitrary client-side computation (math, parsing, simulation, charts drawn on
  `<canvas>`/SVG).
- Use `data:` and `blob:` URLs for images you generate at runtime.
- Use inline styles and inline scripts (CSP allows `'unsafe-inline'` for script/style).
- `log()` and `notify()` — Tier 0, always available.

---

## How the validator enforces this

`helios-plugin check` scans your bundle and **flags forbidden APIs**: `fetch`,
`XMLHttpRequest`, `WebSocket`, `sendBeacon`, `localStorage`, `sessionStorage`,
`indexedDB`, `document.cookie`, `eval`, dynamic `Function`, direct
`window.parent`/`window.top` access, and remote resource references. It also checks
declared-vs-used permissions. **It MUST pass (exit 0)** before you submit. See
[checklist.md](./checklist.md).

> If you ever feel the need to make a network call, fetch a font, or reach the parent
> window — **STOP.** Re-read this doc. The answer is always: bundle it, take it as
> input, or use the SDK.
