# `@helios/plugin-sdk` — API Reference

> **TOP RULE:** Talk to the host **only** through this SDK. **NEVER** reach for
> `window.parent`, `window.top`, `postMessage`, `fetch`, or any browser storage —
> the SDK is the *only* sanctioned bridge to Helios, and everything else is blocked
> by the sandbox/CSP. Always `await ready()` once before calling host-dependent
> methods.

The SDK is imported from the package `@helios/plugin-sdk` and bundled into your
`dist/`. The current host SDK contract version is **1.0.0**; declare `"sdk":
"^1.0.0"` in your manifest.

```ts
import {
  ready, getContext, log, notify,
  openFile, save, storage, engine
} from "@helios/plugin-sdk";
```

---

## Lifecycle

### `ready(): Promise<PluginContext>`
- **MUST** be awaited **exactly once** at startup. Resolves when the host handshake
  completes. Until it resolves, host-dependent calls are not guaranteed to work.
- Returns the `PluginContext` (see `getContext`).

```ts
const ctx = await ready();
```

### `getContext(): PluginContext | null`
- Returns the current context, or `null` if called before `ready()` has resolved.
- `PluginContext` shape:

```ts
interface PluginContext {
  pluginId: string;       // your manifest id
  pluginVersion: string;  // your manifest version
  theme: "light" | "dark";
  locale: string;         // e.g. "en-US"
}
```

- **Non-sensitive only.** There is **NO user PII, NO email, NO tokens, NO session
  data** here, and there never will be. Do not attempt to derive identity from it.
- **MUST** adapt your UI to `theme` and `locale`.

---

## Tier 0 — always available (no permission required)

### `log(...args): void`
- Writes to the plugin's **host-side console** (for developer debugging). It is not
  shown to the end user.
- Use freely for diagnostics. It is the only "console" that reliably surfaces.

```ts
log("parsed rows:", rows.length);
```

### `notify(message: string, level?: "info" | "warn" | "error"): void`
- Shows a **transient toast** to the user. Default level is `"info"`.
- Use for short, user-facing status ("Exported report", "Invalid CSV").

```ts
notify("Export complete", "info");
notify("Could not parse file", "error");
```

---

## Tier 1 — files (`file.read`, `file.write`)

### `openFile(opts?: { accept?: string }): Promise<{ name: string; bytes: Uint8Array } | null>`
- **Requires `"file.read"`.**
- Opens a **host-rendered file picker**. The user explicitly chooses one file.
- `accept` is an optional hint (e.g. `".csv"`, `"image/*"`) for the picker filter.
- Resolves to `{ name, bytes }`, or **`null` if the user cancels** — you **MUST**
  handle `null`.
- There is **no directory listing and no filesystem access** — only the one file the
  user picks.

```ts
const file = await openFile({ accept: ".csv" });
if (!file) return; // user cancelled
const text = new TextDecoder().decode(file.bytes);
log("loaded", file.name, file.bytes.length, "bytes");
```

### `save(bytes: Uint8Array | string, suggestedName: string): Promise<boolean>`
- **Requires `"file.write"`.**
- Opens a **user-confirmed save dialog**. Pass the content (bytes or string) and a
  suggested filename.
- Resolves `true` once the save is initiated. **Code defensively for `false`**: the
  current build's browser-download path can't detect a user cancel (so it always
  resolves `true`), but a future native save dialog will resolve `false` on cancel.

```ts
const csv = "speed,downforce\n30,1940\n";
const ok = await save(csv, "downforce.csv");
notify(ok ? "Saved" : "Save cancelled", ok ? "info" : "warn");
```

---

## Tier 1 — storage (`storage`)

Private, **plugin-scoped** key-value store. Namespaced by your `id`, isolated from
other plugins and from Helios data. **~1MB quota.** This is the **only** persistence
available — `localStorage`/`sessionStorage`/`indexedDB` do not exist in the sandbox.

```ts
storage.get<T>(key: string): Promise<T | null>;
storage.set(key: string, value: T): Promise<void>;
storage.keys(): Promise<string[]>;
storage.delete(key: string): Promise<void>;
```

- All methods **require `"storage"`** and are **async** — always `await`.
- Values are serialized; store JSON-serializable data. `get` returns `null` for a
  missing key.
- **MUST** stay within ~1MB total. Do not dump large blobs here.

```ts
// Persist user settings between sessions.
await storage.set("settings", { cl: 3.2, area: 1.1 });
const settings = await storage.get<{ cl: number; area: number }>("settings");
const allKeys = await storage.keys();
await storage.delete("settings");
```

---

## Tier 2 — engine (`engine:matlab`) — NOT AVAILABLE YET

### `engine.matlab.run(script: string, inputs?: unknown): Promise<unknown>`
- **Requires `"engine:matlab"`** (HIGH trust: runs native MATLAB at the user's
  privileges, install-time consent + human review).
- **NOT IMPLEMENTED YET.** The MATLAB bridge arrives in a later sub-project.
  **Do not build a plugin that depends on it today** — calling it will not work.
- Documented here only so you know it exists and what its shape will be.

---

## Error handling — error codes

Any SDK call that crosses to the host can **reject** with an `Error` carrying a
`.code` property. **MUST** wrap host-dependent calls in `try/catch` and branch on
`.code`.

| `.code` | Meaning | What you did wrong / how to fix |
| --- | --- | --- |
| `"PermissionNotDeclared"` | You called a capability whose permission is **not** in the manifest. | Add the permission to `manifest.json` `permissions` (and justify it in `PLUGIN.md`). |
| `"UnknownMethod"` | You called a method the host does not recognize. | You invented an API or mistyped. Use only the methods in this doc. |
| `"BadParams"` | Arguments were the wrong shape/type. | Check the signature above. |
| `"HandlerError"` | The host-side handler threw while processing. | Inspect the message; the inputs may be invalid (e.g. unreadable file). |
| `"Timeout"` | The host did not respond in time. *(Reserved — not emitted by the current build; per-call timeouts arrive with the marketplace.)* | Retry once; surface a `notify(..., "error")` if it persists. |

```ts
try {
  const file = await openFile({ accept: ".csv" });
  // ...
} catch (e: any) {
  if (e?.code === "PermissionNotDeclared") {
    notify("This plugin is missing the file.read permission", "error");
    log("PermissionNotDeclared: add file.read to manifest");
  } else {
    notify("Something went wrong", "error");
    log("SDK error", e?.code, e?.message);
  }
}
```

---

## Full minimal program

```ts
import { ready, getContext, log, notify, openFile, save, storage } from "@helios/plugin-sdk";

async function main() {
  const ctx = await ready();
  document.documentElement.dataset.theme = ctx.theme;
  log("booted", ctx.pluginId, ctx.pluginVersion, ctx.locale);

  // restore last settings (needs "storage")
  const last = await storage.get<{ cl: number }>("settings");
  const cl = last?.cl ?? 3.2;

  document.getElementById("load")!.addEventListener("click", async () => {
    const file = await openFile({ accept: ".csv" }); // needs "file.read"
    if (!file) return;
    const text = new TextDecoder().decode(file.bytes);
    const out = process(text, cl);
    const ok = await save(out, "result.csv"); // needs "file.write"
    await storage.set("settings", { cl });     // needs "storage"
    notify(ok ? "Done" : "Save cancelled", ok ? "info" : "warn");
  });
}

function process(_csv: string, _cl: number): string { return "ok\n"; }

main();
```

This program **MUST** declare `["file.read", "file.write", "storage"]` in its
manifest. `log` and `notify` need nothing.
