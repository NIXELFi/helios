# Helios v5.0.0 — Plugin Runtime, Format & Host SDK (Sub-project A)

**Status:** Design approved (interactive, Sections 1–3); Sections 4–7 finalized by author under delegated autonomy.
**Date:** 2026-06-25
**Author:** Nick Murray (design dialogue) + Claude (drafting)
**Branch:** `feat/v5-plugin-runtime`

---

## 0. Context & vision

v5.0.0 turns Helios from a fixed five-module app into a **platform**: subteams build their own
tools ("add-ons"), version them independently of the main app, and only the members who need a
tool install it. The headline win is velocity — a subteam ships v1.4 → v1.5 of their downforce
calculator without anyone touching the main Helios release train.

The whole feature is too large for one spec, so it is decomposed into sequenced sub-projects, each
with its own spec → plan → build cycle:

- **Sub-project A — Plugin Runtime, Format & Host SDK** *(this spec)*. The foundation and the
  security model. Goal: a hand-loaded local plugin runs sandboxed in a Helios panel through a
  brokered API, provably unable to reach the DB or break the app. No marketplace yet.
- **Sub-project B — Marketplace Backend & Distribution.** Supabase storage for bundles, plugin/
  version/install tables, RLS scoping by subteam, publish/install.
- **Sub-project C — Marketplace UI.** Browse + per-member install/update/uninstall.
- **Sub-project D — Security Review & Vetting Pipeline.** submit → automated scan → human approve →
  publish. Reuses the same compliance validator authors run locally.
- **Sub-project E — MATLAB engine bridge** (and future engine bridges). The first Tier-2 curated
  host bridge, slotting into the capability framework defined here.

This spec is **Sub-project A only**.

### Guiding principle

> **The wall is absolute, but the doors are generous.**

Origin isolation + CSP make it *physically* impossible for a plugin to reach the host DOM, the
Supabase client, the login token, or the filesystem on its own, and they block ambient network
egress (`fetch`/XHR/WebSocket/remote resources). (One residual egress channel — the frame
navigating *itself* to an external URL — is not closable by CSP alone and is closed by the
production `plugin://` navigation handler; see §10.) Functionality does not come from weakening that
wall — it comes from a rich, well-designed **Host SDK** that brokers exactly what plugins
legitimately need. "More capable plugins" must always mean "a better SDK,"
never "a leakier sandbox."

### Requirements captured from the design dialogue

- Plugins are **standalone programs** (simulation tools, MATLAB-style features) that compute and
  render their own UI inside Helios.
- The permission surface is **small**. Default plugins are pure compute + UI. The main "data in"
  path is **user-mediated file open** (the user explicitly picks a file, e.g. from the vault); the
  plugin never gets raw DB access or a vault listing.
- Compute ceiling is "a mix" → **design the runtime airtight** (JS/TS + WASM/Workers) and provide a
  Tier-2, opt-in, reviewed **escape hatch** for external tools via *curated host bridges* (MATLAB
  first). Plugins may **never** spawn arbitrary processes.
- Authoring model: **prebuilt bundle + official SDK**. Authors build locally against a template and
  upload compiled output. Helios carries **no compiler** and never executes plugin source.
- UI surface: a single **Marketplace module** with its own launcher menu; clicking a working app
  opens it **fullscreen** in the Helios content area.
- **Agent Authoring Kit**: most authors will vibe-code with no coding experience, so the AI agent
  building a plugin is the real "developer." We ship an exhaustive, prescriptive doc set + a
  per-plugin memory file the agent maintains + a machine-checkable compliance validator.

---

## 1. Architecture overview

Three layers with a single, narrow communication channel:

```
HELIOS HOST (trusted) — React app · Supabase client · login JWT
  ├─ Marketplace module: launcher menu; click app → mounts plugin fullscreen
  ├─ Host Broker: postMessage RPC "server"; validates every call against the
  │   plugin's manifest-declared permissions; runs the real host capability impl
  └─ Plugin host frame (fills content area)
       <iframe sandbox="allow-scripts">  origin: plugin://<id>/  + strict CSP
         PLUGIN (untrusted): compiled bundle + its own UI + @helios/plugin-sdk
         ✗ no host DOM  ✗ no Supabase  ✗ no JWT  ✗ no network (CSP)  ✗ no FS
         ⇅ postMessage  ← the ONLY channel in or out
```

Key ideas:

1. **Different origin.** The plugin loads into a sandboxed iframe with **no `allow-same-origin`**,
   so the browser engine guarantees it holds no reference to the host's `window`, DOM,
   `localStorage`, or Supabase client.
2. **One channel only.** The plugin can do nothing but `postMessage` requests to the broker. CSP
   blocks `fetch`/XHR/WebSocket; there is no file or DB surface.
3. **The broker is the bouncer.** Every request is matched against the manifest's declared
   permissions before the host runs the real operation. Undeclared capability → hard reject.
4. **The SDK is the friendly face of that channel.** Authors `import { openFile, save, storage }
   from "@helios/plugin-sdk"` and write normal async code; under the hood it is typed wrappers over
   `postMessage`.

---

## 2. Package format & manifest

A plugin is a zip (extension `.hplugin`) of **compiled output only** — no source, no build step on
Helios's side:

```
my-plugin.hplugin (zip)
├── manifest.json        ← metadata + declared permissions (the contract)
├── dist/
│   ├── index.html       ← entry loaded into the sandbox frame (self-contained)
│   ├── assets/*.js,*.css ← bundled code + styles (inlined for the sandbox)
│   └── *.wasm, *.worker.js
├── icon.png             ← optional
└── README.md            ← optional
```

Manifest (`manifest.json`):

```jsonc
{
  "format": 1,                       // package format version
  "id": "aero.downforce-calculator", // stable, unique, immutable across versions
  "name": "Downforce Calculator",
  "version": "1.4.0",                // the PLUGIN's OWN semver — independent of Helios
  "description": "Quick aero-map downforce + balance sweeps.",
  "subteam": "aero-design",          // owning subteam (ties into existing org roles)
  "icon": "icon.png",
  "entry": "dist/index.html",
  "sdk": "^1.0.0",                   // which Host SDK contract it targets
  "permissions": []                  // DEFAULT-DENY: [] = pure sandbox, no doors
}
```

- **`permissions` is default-deny.** `[]` = a pure-sandbox plugin (UI + compute only). Every door
  must be explicitly listed; the broker rejects any brokered call whose permission isn't declared.
- **`version` is the plugin's own** — the "separate version control" win.
- **`sdk` is a compatibility range.** The host advertises an SDK contract version and refuses
  incompatible plugins with a clear message.
- **`id` is stable + immutable** — used for the `plugin://<id>/` origin, storage namespace, and
  (later) marketplace updates.

Publishing concerns (signatures, uploader, approval state) deliberately live in Sub-project B, layered
on top of this format without changing it.

---

## 3. Host SDK — the catalog of doors (tiered by trust)

The SDK (`@helios/plugin-sdk`) is a thin client; every function is a typed wrapper over one brokered
`postMessage` call.

| Permission key | SDK call | Tier | Notes |
|---|---|---|---|
| *(none)* | `host.log`, `host.notify`, `host.getContext()`, UI render | **0 — always on** | Nothing sensitive brokered. `getContext` returns only theme, locale, the plugin's own id/version. |
| `file.read` | `openFile()` (and later `openFromVault()`) | **1 — low-trust** | Opens a **host-rendered picker**; the *user* chooses; the plugin receives only that file's bytes + name. No directory listing, no FS. |
| `file.write` | `save(bytes, suggestedName)` | **1 — low-trust** | Host shows a save dialog; user confirms; host writes. No silent writes. |
| `storage` | `storage.get/set/keys/delete` | **1 — low-trust** | Private KV namespaced to the plugin id; isolated from other plugins and Helios data; quota-limited. |
| `engine:matlab` | `engine.matlab.run(script, inputs)` | **2 — high-trust** | Curated MATLAB bridge (Sub-project E). Runs native code w/ user privileges → install-time consent + human review required. |
| *(future)* `engine:python`, `net.fetch` | — | **2 — high-trust** | Designed-for, off by default, added on real need. |

Why the tiers carry the safety/functionality balance:

- **Tier 0 + 1 plugins are near-auto-approvable** — the worst case is a plugin reading a file the
  user handed it and scribbling in its own sandbox. This covers the vast majority of sim tools.
- **Only Tier 2 needs friction** (review + consent), paid exactly where the risk is.
- A plugin gets only what its manifest declares; the SDK throws `PermissionNotDeclared` if you call
  an undeclared capability, and the broker rejects it server-side regardless.

The catalog is intentionally small (YAGNI). New doors are added when real plugins need them.

---

## 4. Security model & threat mitigations

The runtime is the security boundary; the review pipeline (Sub-project D) is defense-in-depth on
top, not the primary control.

| Threat | Mitigation |
|---|---|
| Plugin reads/steals the Supabase client, JWT, or other auth state | Opaque-origin iframe (`sandbox="allow-scripts"`, **no** `allow-same-origin`). The plugin has no reference to the host realm — there is nothing to read. |
| Plugin reaches the host DOM / other modules | Same as above — cross-origin DOM access is blocked by the browser. The plugin only sees its own document. |
| Plugin exfiltrates data over the network | Strict CSP on the plugin document: `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; worker-src blob:`. No `fetch`/XHR/WebSocket/remote-resource load can leave. Outbound network is itself a future Tier-2 capability (`net.fetch` with a declared host allowlist), never ambient. **Residual gap:** CSP does not stop the frame navigating *itself* to an external URL (e.g. `location.assign`), so a plugin holding user-handed data could exfiltrate by self-navigation. Conspicuous (destroys its own UI) but real — closed by the `plugin://` navigation handler (§10), a Blocker before Sub-project B loads untrusted plugins. |
| Plugin reads/writes the filesystem | No FS API in the sandbox. File I/O is only via the user-mediated `file.read`/`file.write` brokered calls. |
| Plugin spawns processes / runs native code | Impossible from the sandbox. Native execution exists only through **curated** host bridges (e.g. `engine:matlab`), never a generic "run command." |
| Plugin forges messages / impersonates another plugin | The host validates `event.source === iframe.contentWindow` for every message and tags each frame with its own broker instance bound to that plugin's manifest. |
| Plugin escalates by calling an undeclared capability | Broker checks the method's required permission against `manifest.permissions` **before** dispatching. Undeclared → `PermissionNotDeclared`, no handler runs. |
| Plugin crashes / hangs / hard-loops | Each plugin frame is wrapped in a React `ErrorBoundary` (crash isolation, like every Helios module). Long-running work belongs in the plugin's own Web Worker; the host main thread is never blocked by plugin code (it runs in a separate frame). Resource caps (see §7). |
| Storage abuse (filling disk, snooping other plugins) | Storage is namespaced by plugin id and quota-limited; one plugin cannot read another's keys. |
| Manifest tampering / malformed package | `validateManifest()` runs at load; unknown permission keys, bad ids, missing entry, or incompatible `sdk` range are rejected before the frame is ever created. |

**Trust tiers drive scrutiny.** A Tier-0/1 plugin can be approved with minimal review because it is
provably harmless. A Tier-2 plugin (e.g. MATLAB) is shown to the user at install with an explicit
consent screen ("this plugin can run MATLAB programs on your computer") and requires human review.

**The "in-app sandbox test."** Because every effect a plugin can have flows through the broker, the
review pipeline (Sub-project D) can launch a candidate plugin in a *monitored* broker that records
every RPC call and CSP violation, and assert it never attempts anything its manifest didn't declare.
The runtime is built to make this observability free.

---

## 5. Loading & lifecycle

1. **Acquire** a `.hplugin` (Sub-project A: from local disk / a bundled example. Sub-project B: from
   the marketplace).
2. **Validate** — parse `manifest.json`, run `validateManifest()`, check `sdk` compatibility, verify
   `entry` exists. Reject with a clear error otherwise. Nothing is executed yet.
3. **Mount** — when the user launches the plugin, create the sandboxed iframe, inject the CSP, load
   the entry document (opaque origin), and attach a broker instance bound to this plugin's manifest.
4. **Handshake** — the SDK inside the frame posts `ready`; the host replies with an init payload
   (context: theme, locale, plugin id/version). RPC is open from here.
5. **Run** — the plugin renders its UI and makes brokered calls; the broker enforces permissions and
   dispatches to host capability implementations.
6. **Teardown** — on close/uninstall, the host removes the iframe (drops the realm entirely) and the
   broker stops listening. No plugin state survives except its namespaced `storage`.

Origins: production uses a custom Tauri `plugin://<id>/` asset protocol so each plugin gets a stable,
isolated origin. The Sub-project A MVP uses a dev-friendly opaque-origin srcdoc mount (same isolation
guarantee: no `allow-same-origin`); wiring the Rust `plugin://` protocol is a noted follow-up.

---

## 6. Agent Authoring Kit

The agent building a plugin is the real developer, so the kit's job is to make that agent impossible
to lead astray. Three pieces, shipped with the SDK:

1. **Agent-facing doc set** (`docs/plugin-authoring/`): exhaustive, *prescriptive* Markdown written
   for an AI agent — the manifest contract, full SDK API reference, and crucially a **"this will NOT
   work — use this instead"** constraints doc (no `fetch`, no `window.parent`, no DOM outside your
   root, no DB → here's the brokered call). Heavy on `MUST` / `MUST NOT`, with worked examples and a
   pre-submit checklist.
2. **Per-plugin memory file** (`PLUGIN.md`, created and maintained by the agent in the plugin
   project): captures *this tool's* identity, purpose, declared permissions **and why each is
   needed**, files it reads, and key decisions — so a long vibe-coding session stays consistent and
   in-compliance. Same spirit as a `CLAUDE.md`.
3. **Compliance validator** (`helios-plugin check`): validates the manifest, scans the built bundle
   for forbidden API usage, and checks declared-vs-actually-used permissions, emitting fixes. This
   makes compliance **machine-enforced, not just documented** — and it is the *same engine the
   review pipeline (Sub-project D) reuses*, so passing the author's check is most of the way through
   review.

Design consequence (accepted): the SDK contract and compliance rules must be **machine-checkable and
exhaustively specified.** Healthy discipline that de-risks the platform.

---

## 7. Error handling, resource limits & testing

**Error handling**
- Each plugin frame is wrapped in an `ErrorBoundary` (per-module convention) → a plugin crash shows a
  contained error, never takes down the shell.
- Broker RPC uses a typed result envelope: `{ ok: true, result }` or `{ ok: false, error: { code,
  message } }`. Error codes: `PermissionNotDeclared`, `UnknownMethod`, `BadParams`, `HandlerError`,
  `Timeout`.
- A malformed/oversized RPC message is dropped with a logged warning; it never throws into the host.

**Resource limits** (host-enforced, since plugin code can't be trusted to self-limit)
- Storage: per-plugin quota (MVP: a soft cap with a clear error on exceed).
- RPC: payload size cap; per-frame in-flight request cap to prevent flooding.
- Compute: heavy work belongs in the plugin's own Worker; a future host watchdog may surface
  "this plugin is unresponsive" and offer to terminate the frame.

**Testing strategy**
- **Unit (vitest), security-critical:** broker permission enforcement (declared vs undeclared
  capabilities), manifest validation (good/malformed/unknown-permission/incompatible-sdk), RPC
  envelope dispatch and error mapping. These encode the security guarantees as executable assertions.
- **Compliance validator tests:** forbidden-API detection, declared-vs-used permission diffing.
- **Integration (later):** a headless harness that mounts the example plugin and asserts a
  CSP-blocked `fetch` fails and an undeclared `engine.matlab` call is rejected.

---

## 8. Considered alternatives (for the record)

- **Web Worker + declarative UI bridge.** Strongest *logic* isolation but no real DOM — forcing every
  form/plot/table through a declarative bridge badly constrains "standalone programs." Rejected as the
  primary surface; Workers remain available *inside* a plugin for compute.
- **Separate Tauri webview/window per plugin.** Heavier, platform-specific, multi-webview management
  is fiddly, and seamless fullscreen-inside-Helios is harder than an iframe. The iframe's origin
  boundary already gives the isolation that matters. Rejected.

---

## 9. Sub-project A MVP scope (this build)

**In:** `@helios/plugin-sdk` (Tier 0 + Tier 1) · host broker + sandboxed-iframe host + manifest
validation/loader · Marketplace module with launcher + fullscreen mount, wired into the Shell · one
real example plugin built against the SDK · Agent Authoring Kit starter (docs + `PLUGIN.md` template
+ `helios-plugin check` validator) · unit tests for broker + manifest validation · this spec.

**Out (later sub-projects):** MATLAB bridge (E) · Supabase marketplace backend (B) · review pipeline
(D) · the production `plugin://` Tauri protocol · package signing · real `.hplugin` zip-from-disk
picker (the MVP exercises the identical validate→mount→broker path via a bundled example).

---

## 10. Known gaps / hardening backlog

Tracked from the post-MVP code review (2026-06-25). The MVP loads only trusted, bundled/local
plugins, so none of these block *this* checkpoint — but the items marked **[B-blocker]** MUST be
resolved before Sub-project B loads untrusted, third-party plugins.

- **[B-blocker] Self-navigation egress (H1).** A sandboxed frame can navigate *itself* to an
  external URL (`location.assign`), which CSP cannot prevent. A plugin holding user-handed data
  could exfiltrate this way. Fix: the production `plugin://` Tauri asset protocol + a webview
  navigation handler that denies any navigation to a non-`plugin://` URL. Until then the network
  claim is "no `fetch`/XHR/WebSocket/remote-resource egress," not "no network whatsoever."
- **RPC resource limits (partial).** Implemented: malformed-message drop with a logged warning;
  client re-posts `ready` until handshake (no deadlock); cumulative per-plugin storage quota.
  Deferred: a per-call `Timeout` (the code is reserved but not emitted — a blanket timeout would
  break legitimately-long interactive calls like the file picker, so this needs per-method tuning),
  an in-flight request cap, and an RPC payload-size cap.
- **Plugin teardown on module switch (L4).** Like every Helios module, the Marketplace stays mounted
  when you switch tabs, so a launched plugin keeps running (hidden) rather than being torn down on
  navigate-away. Consistent with the app's keep-state convention; the spec's "drops the realm" wording
  applies to the in-module back/close action. Revisit if background plugins prove costly.
- **Live theme (N1).** `PluginHost` passes `theme: "dark"` (Helios's only theme today) rather than a
  reactive theme value. Wire through if/when a light theme ships.
- **Validator is a heuristic, not a control.** `helios-plugin check` scans for obvious mistakes and
  can be defeated by aliasing; the sandbox/CSP is the real control. The review pipeline (D) should
  treat a clean check as necessary-not-sufficient and add the monitored-sandbox dynamic pass.
