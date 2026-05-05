# 18 — Loading screen + Helios brand wordmark

## Symptom / motivation

The app's startup state was a single line of text — *"Loading sample session…"* — on a black background. The header logo was just `HELIOS` in default Inter. The team wanted a proper splash screen with branding, a real progress bar, and an animated feel during session load.

## What this commit ships

### Brand font — Orbitron

Imported `Orbitron` (weights 500/700/900) from Google Fonts via `<link>` in [apps/desktop/index.html](../apps/desktop/index.html). Orbitron's the iconic motorsport / sci-fi face — looks right for the Sun Devil Motorsports identity.

A new utility class `.font-helios` in [apps/desktop/src/styles.css](../apps/desktop/src/styles.css) applies Orbitron with `weight: 900` and `letter-spacing: 0.18em` so the wordmark always renders consistently. Used in both the splash screen and the dashboard header.

### Loading screen — [apps/desktop/src/components/LoadingScreen.tsx](../apps/desktop/src/components/LoadingScreen.tsx)

Deliberately simple — static wordmark, static subtitle, animated bar. An earlier draft had a pulsing radial glow + conic sun-ray fan + shimmering text gradient; user feedback was that the glow looked bad and the text animations were too much, so they were removed. The progress bar is the only animated element.

- **Wordmark + subtitle** — `HELIOS` in Orbitron 900 at 5–7 rem (responsive), brand yellow `#FFC627`, fixed letter-spacing `0.18em`. Subtitle in tracked-out uppercase: *"Sun Devil Motorsports · Telemetry"*.

Below the wordmark:

- **Real progress bar** — 520 px wide, height 1.5 px, on a `#16171B` track. Fill is solid `#FFC627`, width transitions over 300 ms (so jumps look smooth). On top of the fill, a sliding white-to-transparent gradient (`helios-bar-slide`, 1.4 s linear loop) keeps the bar feeling alive even between progress events.
- **Stage label + percentage** — current step on the left ("Loading SDM26 5/3 — Best Accel"), `XX%` on the right in `font-mono-num`.
- **Error state** — when a load actually fails, the bar is replaced with a red-bordered error banner.

Bottom of the splash: `v0.0.1 · ground-station` in dim text.

### Real progress threading — [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts)

`loadAllSessions` now takes an optional `onProgress` callback:

```ts
export async function loadAllSessions(
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadedSession[]>;

interface LoadProgress { label: string; loaded: number; total: number }
```

The function loops sessions sequentially (instead of `Promise.all`) so each step's progress is observable, fires `onProgress` before each session and once after the last one is done. App.tsx adds one extra "Computing math channels" beat before flipping to "Ready", giving the bar four discrete steps for the default 3-session load.

### Wiring — [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)

- `loadProgress` state replaces the bare "Loading sample session…" string.
- The early-return now mounts `<LoadingScreen progress={…} stage={…} error={error}/>` and runs in three cases: still loading, no primary id, or hard error.
- Header logo now uses `font-helios` so the brand looks consistent across the splash and the dashboard.

## Notes / future work

- **Orbitron is loaded from Google's CDN.** Works online (Tauri webview has internet by default). If we ever need offline-first, ship the woff2 files in the bundle and `@font-face` from `assets/`.
- **No Tauri-level splash window.** This loading screen covers the React-mount-to-ready window (~1–2 s for the bundled CSVs). The brief blank moment between the OS-level window appearing and React mounting is unaddressed; if it bothers anyone, Tauri 2 supports `visible: false` + a tiny splash window in `tauri.conf.json` and we can wire that later.

## Files changed

- [apps/desktop/index.html](../apps/desktop/index.html) — Google Fonts link
- [apps/desktop/src/styles.css](../apps/desktop/src/styles.css) — `.font-helios`, keyframes, shimmer/pulse classes
- [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts) — `LoadProgress` + `onProgress`
- [apps/desktop/src/components/LoadingScreen.tsx](../apps/desktop/src/components/LoadingScreen.tsx) — new
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — loading state + header wordmark
