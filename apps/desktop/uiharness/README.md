# UI render harness

A tiny Vite app that renders the Marketplace author/reviewer surfaces against
stubbed IO, so they can be screenshotted and **looked at**. It is not part of any
shipped build: `apps/desktop/tsconfig.json` only includes `src`, and the app's own
`vite.config.ts` never references this directory.

It exists because unit tests assert the invariants you thought of. A screenshot
shows the ones you didn't — this is how the help panel's agent-instruction block
was caught clipping its own last words instead of wrapping.

## Run it

```bash
pnpm --filter @helios/desktop exec vite --config vite.harness.config.ts
# http://localhost:1421/?view=wizard
```

Views:

| URL | Shows |
|---|---|
| `?view=wizard` | Add to Marketplace, step 1 |
| `?view=wizard&dirty=1` | …with a fixture whose pre-flight fails |
| `?view=review` | The reviewer's queue |
| `?view=help` | The author help drawer |

The wizard's later steps are reached by **clicking**, not by a query flag — that
way the screenshots show states the real state machine produced. Drive it with a
CDP script (see the `verify-ui-by-screenshot` recipe): click `Choose folder…`,
then `Continue`.

## What is stubbed

`vite.harness.config.ts` aliases only the IO edges, so the components themselves
are the real ones:

- `@tauri-apps/api/core` → `stubs/tauri.ts` (fixture packed bundle + inspect)
- `@tauri-apps/plugin-dialog` / `-fs` → fixed folder path, fixed bytes
- `@helios/auth` → a fake Supabase client and user
- `../../org/data/useOrgData` → two subteams, all capabilities granted
- `../data/useReview` → a two-item review queue

`tailwind.config.ts` here re-exports the app's theme with **absolute** content
globs — with Vite's root set to this directory, the app config's relative globs
match nothing and every screenshot comes out as black text on a black page.
