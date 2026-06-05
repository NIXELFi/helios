# Games Tab — Design Spec

**Date:** 2026-06-05
**Status:** Approved by Nick (MVP scope; iterate after)

## Summary

Add a fifth module to Helios: **Games** — four small arcade games (Snake,
Breakout, Flappy, 2048) with Supabase-backed leaderboards. Three ranking
views: per-game all-time, per-game weekly, and a subteam ranking summing
members' personal bests across all games. The tab is fully auth-gated,
like Vault and PM.

## Goals

- A `games` module following the existing module conventions exactly
  (mount-once shell section, ErrorBoundary, auth gating, Tailwind +
  Helios palette).
- Four keyboard-driven games with a shared, minimal game contract so
  future games are one folder + one registry entry.
- Leaderboards that piggyback on existing Supabase auth and the
  subteam-at-signup convention (`auth.users.raw_user_meta_data->>'subteam'`).

## Non-goals (v1)

- Anti-cheat / server-side score validation (scores are client-trusted).
- Realtime leaderboard subscriptions (fetch on open + after submit).
- Offline score queueing (failed submit offers retry only).
- Normalized cross-game scoring (raw sum; see Open questions).
- Mobile/touch controls.

## Module & UI

### Shell integration

- `apps/desktop/src/shell/ModulePicker.tsx`
  - `ModuleId` union gains `"games"`.
  - `MODULE_ICON` gains `IconDeviceGamepad2` (Tabler).
  - New NavButton, auth-gated like Vault/PM.
- `apps/desktop/src/Shell.tsx`
  - Import `GamesModule` from `./modules/games`.
  - Add a mount-once / toggle-visibility section copying the Vault/PM
    pattern, wrapped in ErrorBoundary, rendered only when logged in.
  - Auth-gate `activate()` logic mirrors Vault/PM (`gamesEnabled`).

### Module layout

```
apps/desktop/src/modules/games/
  index.tsx            — GamesModule: picker grid ⇄ active game + leaderboard panel
  registry.ts          — GameDef[]: { id, title, icon, blurb, component }
  api.ts               — submitScore(), fetchAllTime(), fetchWeekly(), fetchSubteams()
  components/
    GameCard.tsx       — picker tile
    LeaderboardPanel.tsx — tabs: All-time | Weekly | Subteams
    GameOverOverlay.tsx  — score, submit status, restart
  games/
    snake/    breakout/    flappy/    twenty48/
      index.tsx          — canvas/DOM component (the GameDef component)
      logic.ts           — pure game core (testable, no rendering)
```

### Game contract

Each game exports a React component with props:

```ts
interface GameProps {
  onGameOver(score: number): void;
  paused: boolean; // true when tab hidden — game must halt its loop
}
```

Games own their input handling, loop, and rendering (canvas for snake /
breakout / flappy; DOM+Tailwind allowed for 2048). The module owns all
chrome: start/restart, score submission, leaderboards. Game state resets
on restart by remounting the component (`key` bump) — games need no
external reset API.

Notes:

- No existing module receives a visibility signal (the shell hides
  modules with CSS, keeping them mounted). `paused` must be derived in
  `Shell.tsx` from `active !== "games"` and threaded down
  `GamesModule → active game`.
- The 2048 folder is `twenty48` (JS identifiers can't start with a
  digit) but the registry `id` — and everything that touches the DB —
  uses the string `'2048'` to match the `game_id` check constraint.

### UX flow

1. Tab opens on the picker grid (4 GameCards) with the leaderboard panel
   alongside (defaults to All-time, game filter = last played or first).
2. Selecting a game swaps the grid for the game surface; leaderboard
   panel stays, filtered to that game.
3. Game over → GameOverOverlay shows score, auto-submits, shows
   "submitted ✓" (or error + Retry button), offers Restart / Back.
4. Leaderboard panel refetches after a successful submit.

## Data model

New `games` schema, one timestamped migration in
`infra/pdm-supabase/supabase/migrations/`.

```sql
create table games.scores (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  game_id      text not null check (game_id in ('snake','breakout','flappy','2048')),
  score        integer not null check (score >= 0),
  subteam      text,        -- stamped by trigger from auth metadata
  display_name text,        -- stamped by trigger from auth metadata
  created_at   timestamptz not null default now()
);
create index on games.scores (game_id, score desc);
create index on games.scores (game_id, created_at);
```

- One row per finished run.
- **Trigger** (`before insert`, `security definer`): fills `subteam` and
  `display_name` from `auth.users.raw_user_meta_data` for
  `auth.uid()`. Clients cannot read other users' metadata, so
  denormalizing at write time is what makes leaderboards queryable.
  Trigger also overwrites any client-supplied values for these columns
  and forces `user_id = auth.uid()`.
- **RLS:** insert allowed for `authenticated` with
  `user_id = auth.uid()`; select allowed for all `authenticated`;
  no update/delete.
- Missing subteam in metadata → stored as null, surfaced in UI as
  "Unassigned".

## Leaderboards (SQL views in `games` schema)

1. **`games.leaderboard_alltime`** — per `game_id`, each player's max
   score with display_name/subteam, ranked.
2. **`games.leaderboard_weekly`** — same, filtered
   `created_at >= date_trunc('week', now())`.
3. **`games.leaderboard_subteams`** — per game, each member's personal
   best; sum bests within a subteam per game; subteam total = sum across
   the four games. View returns per-game subtotals + grand total so the
   UI can show a breakdown. Members with no scores contribute nothing
   (they are simply absent from the aggregation).

Views are `security_invoker`; RLS on the base table gates access.
Grants: `select` to `authenticated` only.

## Error handling

- Submit failure: overlay shows error + Retry; score is held in
  component state only (lost on navigation — acceptable for v1).
- Leaderboard fetch failure: panel shows inline error + Retry.
- Each game wrapped by the module-level ErrorBoundary; a crashing game
  cannot take down the shell.
- `paused` prop wired to module visibility so hidden games don't burn
  CPU or rack up time-based scores while invisible.

## Testing

- **Vitest** unit tests on each `logic.ts` core:
  - snake: movement, growth, self/wall collision
  - breakout: ball-brick/paddle collision, level clear
  - flappy: gravity step, gap collision, scoring
  - 2048: merge rules, move legality, game-over detection
- Registry contract test (every GameDef has unique id, component, icon).
- `api.ts` tests with a mocked Supabase client (correct table/columns,
  payload shapes).
- Migration includes commented fixture queries used to spot-check the
  three views against seeded data.

## Open questions / future iterations

- **Score normalization:** raw subteam sums let 2048 (scores in the
  thousands) dwarf Flappy (tens). If this proves unfun, swap the
  subteam view to normalize per game (e.g., score / game's top score).
  View-only change; no schema impact.
- Weekly reset prizes, personal-best history charts, more games,
  realtime updates — all deferred.
