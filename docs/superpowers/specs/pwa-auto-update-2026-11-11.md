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
- **Amendment (owner, 2026-11-12): tabs agree first (Task 3).** The owner
  sometimes has two or more tabs of the app open in one browser.
  SKIP_WAITING is per origin, and vite-plugin-pwa's prompt mode reloads
  every controlled tab on `controllerchange`, so a hidden tab's automatic
  apply would reload a visible tab mid-session. No tab applies while any other
  tab of the app is unsafe: visible during the cash session, or holding the
  update (a chart analysis in flight). Tasks 2 and 3 ship together.
- **Owner, 2026-11-12, after the final review: keep `hidden → yes` during the
  session.** That includes a window Chrome reports as hidden because another
  application fully covers it. The owner accepted that such a window may
  reload mid-session.

## Thresholds / constants

| Name | Value | Why |
| --- | --- | --- |
| `UPDATE_CHECK_INTERVAL_MS` | 15 min | A deploy reaches an open window within 15 min; the check is one small `sw.js` request. |
| Visible-check throttle | 1 min | Tab switching must not fire a request each time. |
| `FETCH_TIMEOUT_MS` | 30 s | The `sw.js` pre-fetch gives up before the 1-min focus throttle, so a stalled check can't hold the in-flight guard. |
| Safe-moment re-check | every 60 s: from startup where Web Locks exist (the tab agreement), otherwise only while an update waits. Plus `visibilitychange` where there are no locks | So a waiting update applies within a minute of a safe moment, and the session's edges are noticed under a visible tab. With the agreement a visibility change only updates the lock and never starts an apply attempt (Task 3). |
| Policy look-ahead | 1 tick (60 s) | A visible tab counts as unsafe from a tick before the open, so it already holds its lock when the session starts. |
| `APPLY_STALL_MS` | 30 s | An automatic apply with no `controllerchange` after this long reports one warning per page and goes back to waiting (Task 2). |
| `RETRY_PROMPT_TIMEOUT` | 30 min | A retry prompt nobody answers cancels itself, so the run's hold on a waiting update ends (Task 2). |

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
- Task 3: `src/lib/sw-update-tabs.ts` (new, the Web Locks calls) +
  `src/__tests__/sw-update-tabs.test.ts` (new), `src/lib/sw-update.ts`,
  `src/main.tsx`.

## Global Constraints

- Skills to load: `progressive-web-app`, `react-expert`, `test-master`.
- Every interval and listener has a cleanup (R1). Module-level state stays
  bounded. Ruling (2026-11-12, final review): the steady state is two timers
  and two `visibilitychange` listeners per tab, the 15-minute check
  (`startUpdateChecks`) and the 60 s watch (`startWatch`, shared by the tab
  agreement and a waiting update); each has its own cleanup. Plus, while they
  last, one stall timeout after an automatic apply and one timer per parked
  retry prompt.
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
- Each check first looks at `registration.waiting` and marks an update if one
  waits (ruling, 2026-11-12, final review): workbox-window stops listening for
  `updatefound` after the first external update, so a later deploy can leave a
  worker waiting with no `onNeedRefresh`, and the tab on the old bundle for
  good. It does so before any gate (in flight, installing, offline) and before
  the fetch.
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
  policy on every `visibilitychange` and every 60 s; on the first true,
  call `applyUpdate()` once and stop evaluating. Export
  `holdAutoUpdate(): () => void` (stacking holds; the returned release is
  idempotent) that makes `busy` true while any hold is open.
  - Accepted rulings (2026-11-12, Task 2 review):
    - The first evaluation runs on the first 60 s tick or `visibilitychange`, not
      inside `markNeedsRefresh`. This keeps the banner test independent of the
      clock: it marks an update with the real clock and clicks Reload, and an
      apply inside `markNeedsRefresh` would make that two calls whenever the
      clock is outside the session.
    - Releasing the last hold doesn't evaluate at once; the next tick or
      `visibilitychange` does (within 60 s), so someone who hid the tab during a
      long analysis and returns inside that minute still sees the result.
    - Holds are `Set<symbol>` tokens, so a release is idempotent and a release
      from before `resetUpdateState()` can't release a newer hold.
    - `applyUpdate` ends the wait for a safe moment, so a Reload click stops the
      automatic apply. A click after an automatic apply repeats the idempotent
      `updateSW(true)`; there is no "applied" flag, so a manual retry after a
      failed `updateSW` keeps working.
  - Ruling (2026-11-12, final review): a failed or stalled automatic apply is
    not silent or final. In the installed plugin `updateSW(true)` never
    rejects (`messageSkipWaiting` is fire-and-forget, and does nothing when no
    worker waits), so the signal is a `controllerchange` that never comes.
    After an automatic apply the module starts one 30 s timeout, cleared by the
    same `controllerchange` listener that reloads the page. On expiry it
    reports one warning, tagged `sw_update_apply_stalled`, at most once per
    page, and goes back to waiting for a safe moment, so the next one retries.
    The banner's Reload arms no timeout and takes over from one that runs.
    `resetUpdateState()` clears it.
- `src/hooks/useChartAnalysis.ts`: take a hold for the life of the analyze
  request and release it in `finally`. If the host panel unmounts mid-run, the
  request is not aborted and keeps its hold until it ends, but a retry prompt
  parked at unmount is cancelled and a run that fails after unmount ends
  instead of prompting, so the hold can't outlive the run. A retry prompt left
  parked on a mounted host cancels itself after 30 minutes (ruling, 2026-11-12,
  final review), through the same resolver as the Cancel button, so the
  existing "Retry cancelled." path runs and `finally` releases the hold. One
  timer per parked prompt, cleared when it is answered, cancelled or the host
  unmounts. Otherwise a prompt nobody answers would block every tab's updates
  until the page reloads.
- Tests: waiting update + hidden → applies; visible during the session → does
  not, then hidden → applies; hold open → never applies, release then applies
  on the next evaluation; applies at most once; timers and listeners cleaned
  up.

**Acceptance:** `npm run review` green; banner test unchanged and passing.

## Task 3: Tabs agree before any tab applies

**Goal:** the 2026-11-12 amendment. A waiting update is applied only when
every open tab of the app is safe, not just the tab doing the applying.

- **Mechanism: the Web Locks API** (`navigator.locks`; Chrome 69+, Firefox
  96+, Safari 15.4+), lock name `sw-update-unsafe`.
  - **Every tab, from startup, whether or not an update waits:** while the tab
    is unsafe, it holds a shared lock. Unsafe is `busy || (!hidden && in the
    cash session)`, the same inputs and helpers as `isSafeToApplyUpdate`, so
    reuse the policy instead of restating it. The tab takes the lock when it
    becomes unsafe and releases it when it becomes safe. Re-check on
    `visibilitychange`, on hold and release, and on a 60 s tick so the session
    edges (09:30 ET, the day's close) are noticed while the tab stays visible.
    Holding the lock means keeping the `request` callback's promise pending
    and resolving it to release.
  - **The applying tab:** when its own policy is true, it asks for the lock in
    exclusive mode with `ifAvailable: true`. If it gets the lock, no other tab
    is unsafe, so it calls `applyUpdate()` inside the callback. If it gets
    `null`, it keeps waiting, and the next tick or `visibilitychange` tries
    again. A tab never blocks on its own shared lock, because it releases the
    lock whenever its own policy turns safe.
- **No `navigator.locks`:** fall back to Task 2's per-tab behavior and say so
  in a comment. Every browser the owner uses has it.
- **Module state stays bounded (R1):** one tracker, with one listener, one
  timer and one pending lock at a time. `resetUpdateState()` stops the
  tracker, releases a held lock, and clears everything. Starting the tracker
  twice doesn't stack.
- **Where it starts:** from `main.tsx` alongside `startUpdateChecks`, or
  lazily from the module. Pick one and say why. Settled: `main.tsx`
  (`startTabAgreement()`). Every tab has to announce itself from startup,
  update or not, which a lazy start can't do, and an import-time start would
  put a timer and a listener into every test that imports the module.
- **Tests:** stub `navigator.locks` with a small in-memory fake at the global
  boundary (`vi.stubGlobal`). Its exclusive `ifAvailable` returns `null` while
  any shared holder exists, which is how "another tab" is simulated: the test
  holds a shared lock itself.
  - Another tab unsafe (it holds the shared lock) → this hidden tab doesn't
    apply. When that lock is released, it applies on the next tick.
  - This tab becomes visible during the session → it takes the shared lock.
    Becoming hidden, or the session ending → it releases it.
  - A hold → the shared lock is taken. The last release → it is released.
  - No `navigator.locks` → Task 2 behavior unchanged.
  - Apply still happens at most once, and reset releases everything.
  - Mutation-check: dropping the exclusive check, and never releasing the
    shared lock.
- **Rulings (2026-11-12, Task 3 review and final review):**
  - **A tab switch must not race an apply.** While the tracker runs, a
    `visibilitychange` only brings this tab's shared lock in step with its
    policy; it never starts an apply attempt. Only the 60 s tick asks, and the
    tick isn't correlated with another tab's transition. Otherwise tab A,
    hidden by a switch, could ask a few milliseconds before tab B, now
    visible, had its shared lock granted, and reload B. Without Web Locks the
    tab keeps Task 2's behavior and evaluates on `visibilitychange`.
  - **One tick of look-ahead.** The policy is read now and again one tick
    (60 s) later, and the tab is safe only if both are. A visible tab then
    holds its shared lock from a tick before the open, so another tab's
    attempt in the open's first minute can't reload it.
  - **The applying tab waits for its own release.** It awaits the shared
    request's promise (the release is processed after the request is queued)
    before it asks for the exclusive lock; a test with a stalled release pins
    this, and the test fake takes ten microtask turns to release.
  - **Reset hygiene.** `resetUpdateState()` clears the in-flight flag and
    bumps an epoch; an apply attempt that began before a reset ends without
    touching what began after it.

**Acceptance:** `npm run review` green; the banner test is unchanged and
passing.
