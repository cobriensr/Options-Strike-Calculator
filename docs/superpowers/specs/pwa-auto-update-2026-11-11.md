# PWA auto-update

**Date:** 2026-11-11 · **Status:** approved by the owner (options 1 and 2), queued after
`live-snapshot-alert-2026-11-11.md`

## Goal

The trading browser picks up a new deploy by itself during the session: the
app checks for a new version every 15 minutes and installs it at a moment that
can't interrupt a trade.

## Why

On 2026-11-11 every live snapshot from 2:40 PM CT saved the same SPX and VIX
while the server's quotes moved. The leading explanation (unconfirmed) is a
browser still running a bundle from before the 11-07 frozen-inputs fix. Two
gaps make that easy:

1. **The open app never checks for a new version.** Browsers look for a new
   service worker only on a page load (or, rarely, on a push event when the
   last check is over 24 h old). The app is a single page with no router, so a
   window left open for days never loads again, and `onNeedRefresh` never fires.
   `src/main.tsx` registers the SW once and never calls `registration.update()`.
2. **A plain refresh doesn't install it.** In prompt mode
   (`registerType: 'prompt'`, `vite.config.ts`) the new SW waits until the
   banner's Reload posts `SKIP_WAITING` (`src/lib/sw-update.ts` `applyUpdate`)
   or every window of the app is closed. A refresh is served by the old
   precache; it only makes the banner appear.

## Decisions (owner, 2026-11-11)

- **Option 1:** check for a new version every 15 min and when the tab becomes
  visible.
- **Option 2:** when a new version is waiting, apply it automatically at a safe
  moment (rule below). The banner stays, so a manual Reload still works.
- Not chosen now: stamping the build SHA on each snapshot save / rejecting
  stale builds (option 3).

## Thresholds / constants

| Name | Value | Why |
| --- | --- | --- |
| `UPDATE_CHECK_INTERVAL_MS` | 15 min | A deploy reaches an open window within 15 min; the check is one small `sw.js` request. |
| Visible-check throttle | 1 min | Tab switching must not fire a request each time. |
| `FETCH_TIMEOUT_MS` | 30 s | The `sw.js` pre-fetch gives up before the 1-min focus throttle, so a stalled check can't hold the in-flight guard. |
| Safe-moment re-check | every 60 s while an update waits, plus on `visibilitychange` | So a waiting update applies within a minute of a safe moment. |

## Safe-moment rule

A pure function `isSafeToApplyUpdate(ctx)` in `src/lib/sw-update-policy.ts`.

Inputs: `hidden` (`document.visibilityState === 'hidden'`), `now` (Date), and
`busy` (true while something holds the update, e.g. a chart analysis in
flight).

**Rule (owner chose this default, 2026-11-11):**

- `busy` → never.
- `hidden` → yes.
- Outside the cash session (before 08:30 CT or after the day's close, weekends,
  holidays) → yes.
- Otherwise (visible, market open) → no; the banner shows and the next safe
  moment applies it.

Costs of a reload: typed inputs are lost (none of `useSpotInputs`,
`useTimeInputs`, `useIvInputs`, `useStrategyInputs` persist), and an
in-flight `/api/analyze` request (up to 780 s, `src/hooks/useChartAnalysis.ts`)
is dropped. Hence `busy`.

## Open questions (defaults picked)

1. **Who writes `isSafeToApplyUpdate`.** Settled 2026-11-11: the owner chose
   the default rule above; the implementer writes it.
2. **Idle rule** ("visible but untouched for N min during the session").
   Default: not included; needs input-event tracking.
3. **Half-days.** `currentSessionStage` returns `'half-day'` for the whole day,
   so the policy must use the close time (`getMarketCloseHourET`) rather than
   the stage to know the market has closed.

## Data dependencies

None: no API, table, env var or migration. Frontend only (Vercel deploy).

## Files

- Task 1: `src/lib/sw-update.ts`, `src/main.tsx`, a new test for the check
  scheduler (`src/__tests__/sw-update.test.ts`).
- Task 2: `src/lib/sw-update-policy.ts` (new) + test, `src/lib/sw-update.ts`,
  `src/hooks/useChartAnalysis.ts` (hold while an analysis runs), their tests.

## Global Constraints

- Skills to load: `progressive-web-app`, `react-expert`, `test-master`.
- Every interval and listener has a cleanup (R1). Module-level state stays
  bounded (one timer, one listener set).
- Routine failures of an update check are not reported to Sentry: anything
  while offline, and a TypeError or `TimeoutError` from the `sw.js` fetch
  (laptop waking, flaky Wi-Fi). Anything else is a `captureUnlessAuth`
  warning, as `applyUpdate` does. That includes a rejected `update()` after the
  fetch returned 200, which is how a new `sw.js` that fails to evaluate shows
  up. It is reported once per error name until a check succeeds (ruling,
  2026-11-11, Task 1 review).
- No change to `src/sw.ts` or `vite.config.ts` unless the vite-plugin-pwa docs
  require it. Check the installed plugin's docs for the periodic-update pattern
  (Context7 or `node_modules/vite-plugin-pwa`) rather than assuming it.
- The existing banner and its test keep working; manual Reload still applies
  the update.

## Task 1: Check for a new version every 15 minutes and on tab focus

- `registerSW({ onNeedRefresh, onRegisteredSW(swUrl, registration) })` in
  `src/main.tsx`; `onRegisteredSW` hands the registration to a new
  `startUpdateChecks(registration, swUrl)` in `src/lib/sw-update.ts`.
- `startUpdateChecks` runs `registration.update()` every
  `UPDATE_CHECK_INTERVAL_MS`, and on `visibilitychange` to visible no more
  than once per minute. Skip when `navigator.onLine === false` or a check is
  already in flight. Follow the plugin's documented pattern (it fetches
  `swUrl` with `cache: 'no-store'` first so an offline server doesn't throw).
- Returns a stop function that clears the interval and removes the listener;
  `resetUpdateState()` also stops it for tests.
- Tests (fake timers): checks at 15 and 30 min; a visible event checks once
  and a second within a minute doesn't; hidden events don't check; offline
  skips; a fetch-stage network failure or timeout doesn't throw and isn't
  captured; a rejected `update()` after a 200 is captured once; stop clears
  everything; no check before
  `onRegisteredSW`.

**Acceptance:** `npm run review` green.

## Task 2: Apply a waiting update at a safe moment

- `src/lib/sw-update-policy.ts`: `isSafeToApplyUpdate({ hidden, now, busy })`
  per the Safe-moment rule. Pure, table-tested in
  both DST regimes, on a half-day before and after the noon CT close, a
  weekend and a holiday.
- `src/lib/sw-update.ts`: when `needsRefresh` becomes true, evaluate the
  policy now, on every `visibilitychange`, and every 60 s; on the first true,
  call `applyUpdate()` once and stop evaluating. Export
  `holdAutoUpdate(): () => void` (a counted hold; the returned release is
  idempotent) that makes `busy` true while any hold is open.
- `src/hooks/useChartAnalysis.ts`: take a hold for the life of the analyze
  request and release it in `finally`.
- Tests: waiting update + hidden → applies; visible during the session → does
  not, then hidden → applies; hold open → never applies, release then applies
  on the next evaluation; applies at most once; timers and listeners cleaned
  up.

**Acceptance:** `npm run review` green; banner test unchanged and passing.
