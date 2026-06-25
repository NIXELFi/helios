# Pre-Submission Checklist

> **TOP RULE:** Do **NOT** declare the plugin "done" until
> `helios-plugin check <plugin-dir>` exits **0** and **every box below is checked.**
> The user cannot debug a broken plugin — that is your job, here, now.

Work top to bottom. Fix, re-run, repeat.

---

## 0. The validator (the gate)

- [ ] Ran `helios-plugin check ./<plugin-dir>`.
- [ ] It exited **0** (PASS). It validates the manifest, scans the bundle for
      forbidden APIs, and checks declared-vs-used permissions.
- [ ] **Zero errors.** (Errors include: malformed manifest, forbidden API found,
      a permission used but **not** declared.)
- [ ] Warnings reviewed and resolved. (A declared-but-**unused** permission is a
      warning — **remove it** unless you have a concrete reason.)

```
helios-plugin check ./my-plugin
# expect: exit 0, no errors
```

---

## 1. Manifest (`manifest.json`)

- [ ] `format` is `1`.
- [ ] `id` is lowercase dot/dash segments, unique, and **unchanged** from any prior
      version.
- [ ] `name` is set.
- [ ] `version` is valid semver and was **bumped** for this release.
- [ ] `entry` points to the self-contained `dist/index.html`.
- [ ] `sdk` is a valid range (`^1.0.0`) compatible with host contract `1.0.0`.
- [ ] `permissions` contains **only** values from `{file.read, file.write, storage,
      engine:matlab}` — no invented values.
- [ ] `permissions` is the **smallest** set that works (pure UI + compute → `[]`).
- [ ] `engine:matlab` is **not** declared (it is not implemented yet).
- [ ] Strict JSON — no comments, no trailing commas.

---

## 2. The wall (sandbox compliance)

- [ ] **No network:** no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`.
- [ ] **No browser storage:** no `localStorage`, `sessionStorage`, `indexedDB`,
      `document.cookie` — uses SDK `storage` instead.
- [ ] **No dynamic code:** no `eval`, no `new Function(...)`, no dynamic remote
      `import()`.
- [ ] **No host poking:** no `window.parent` / `window.top` access — SDK only.
- [ ] **No remote resources:** no remote `<script>`, `<link>`, web fonts, or
      `<img>`/CSS URLs. Everything inlined; images as `data:` URIs.
- [ ] Opened `dist/index.html` **fully offline** (network disabled) and it renders
      and works.

---

## 3. SDK usage

- [ ] `await ready()` is called **exactly once** before any host-dependent call.
- [ ] UI adapts to `getContext().theme` (light/dark) and `locale`.
- [ ] No attempt to read PII/tokens/session from context (it isn't there).
- [ ] Every host-crossing call (`openFile`, `save`, `storage.*`) is wrapped in
      `try/catch` and branches on the error `.code`.
- [ ] `openFile()` handles the `null` (cancel) case.
- [ ] `save()` handles the `false` (cancel) case.
- [ ] `storage` writes stay within the ~1MB quota.
- [ ] Every SDK capability used has a matching declared permission (else it rejects
      with `PermissionNotDeclared`).

---

## 4. Build & packaging

- [ ] `dist/index.html` is fully self-contained (JS + CSS inlined; assets relative
      or `data:`).
- [ ] The `.hplugin` zip contains **only** `manifest.json` + `dist/`.
- [ ] **No** `src/`, **no** `node_modules`, **no** `PLUGIN.md`, **no** build configs
      inside the zip.
- [ ] `icon` (if declared) is inside the zip and referenced by a relative path.

---

## 5. PLUGIN.md (project memory — not packaged)

- [ ] `PLUGIN.md` exists in the project and is **current**.
- [ ] Its permission table matches the manifest **exactly**, each with a written
      justification.
- [ ] "Files read" section is filled if `file.read` is declared.
- [ ] Compliance self-check boxes are all checked.
- [ ] Status log has a dated entry for this session.

---

## 6. Final sanity

- [ ] The plugin does what the user asked, with clear UI and sensible defaults.
- [ ] Error and empty/cancel states show a useful `notify(...)` message.
- [ ] Re-ran `helios-plugin check` one last time after all edits — still exit 0.

If all boxes are checked and the validator is green, the plugin is ready to submit.
