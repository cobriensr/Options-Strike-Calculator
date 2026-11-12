# Live snapshot alert

**Date:** 2026-11-11 · **Status:** Tasks 1-2 shipped 2026-11-12; Task 3 (owner
amendment, 2026-11-12) in progress

## Goal

Push a phone alert during the session when no live `market_snapshots` row has
saved in the last 30 minutes, so the owner learns the same morning (not days
later) that the trading browser is closed, asleep, signed out or stuck.

Why: live rows only save from the owner's own browser
(`useSnapshotSave`, owner-gated). On 2026-11-09, 11-10 and 11-11 no live rows
saved until 2:40 PM CT on 11-11, and nothing noticed. The repair is a replay
after the fact; this alert makes the gap visible while it can still be fixed.

## Decisions (owner, 2026-11-11)

- **Option B:** check every 15 minutes from 9:00 AM CT to 15 minutes before
  the day's close; push when no live row has saved in the last 30 minutes;
  **at most one push per trading day**.
- Sent with `sendPushToOwner` (`api/_lib/push.ts`), the channel the Schwab
  re-auth reminder already uses.
- Not included: a "rows save but repeat the same SPX/VIX" rule. Offered, not
  chosen (see Open questions).

**Amendment (owner, 2026-11-12), replaces "at most one push per trading
day":** alert only after saves have started that day, and send one push per
stall.

- A day with no live row sends no push: the owner doesn't want to have to open
  the app by 9:00 CT. Under the original rule, a day where the app opened late
  spent the day's only push at 9:00, and a real stall later went unnoticed.
- Each stall gets its own push. If saves resume and stop again, a second push
  goes out.
- Trade-off the owner accepted: a whole day with no saves (browser open but
  signed out) sends nothing. `owner-session-long-lived-2026-11-11.md` removes
  the usual cause.

**Second amendment (owner, 2026-11-12): a deliberate close is not a stall.**
When the owner's page is closed (tab or browser closed, or navigated away), it
tells the server, and the next checks send no push until the app saves again.
A signed-out page, failing saves, a tab Chrome froze or discarded, and a crash
still push, because none of them sends the close signal. Trade-off the owner
accepted: shutting the laptop lid with the app open sends no close signal, so
it pushes like a stall. A close signal that doesn't arrive (it is
best-effort) also pushes.

**Third amendment (owner, 2026-11-12): phones don't save.** Without this,
tapping the alert on the phone opens the app, the phone saves one live row
(the stall looks over), and closing the phone sends the close signal, so the
trading computer could stay broken with no further push. Touch-first devices
(phones, tablets) don't save live snapshots or send the close signal;
computers do. A per-browser switch in the app overrides the default either
way. Past-date and backtest saves are not affected. Trade-off the owner
accepted: a second computer left open also counts.

## Thresholds / constants

| Name | Value | Why |
| --- | --- | --- |
| `STALE_AFTER_MIN` | 30 | Live rows save every 5 min while the page is open; 30 min is six missed slots. |
| Window start | 09:00 CT (10:00 ET) | 30 min after the 08:30 CT open, so the first check can already be stale. |
| Window end | the day's close − 15 min (14:45 CT; 11:45 CT on a half-day) | The last check that can still help this session. |
| Cadence | every 15 min | Worst-case detection is 30 + 15 = 45 min. |
| `CLAIM_TTL_SEC` | 24 h | The claim only has to outlive one day's window (under 6 h). |
| `PUSH_TTL_SEC` | 1 h | A late delivery is still useful within the session; the claim blocks a retry once the push service accepted it. |
| Sentry monitor `failureIssueThreshold` | 2 | One lost completion check-in should not page; two in a row page within 30 min, and a run that reaches no device errors on consecutive ticks. |

Example: saves stop at 11:10 AM CT. The 11:30 check sees a 20-minute gap (no
push). The 11:45 check sees 35 minutes and pushes "Last live snapshot 11:10 AM
CT". The later checks find that stall's claim and skip. If saves resume at
12:00 and stop again at 13:05, the 13:45 check pushes again for the new stall.

Since the Task 3 amendment, a day with no live row yet sends nothing: the
check reports `success` with "no live snapshot yet today".

## What counts as a live row

`market_snapshots` rows with `date` = today (ET date), `is_backtest = false`
and `entry_time <> 'pre-market'`. The latest `created_at` among them is the
last live save. (`api/pre-market.ts` writes a `pre-market` row with
`is_backtest = false` and null SPX; it is not a calculator snapshot.)
Since 2026-10-28 `is_backtest = false` means a live save on its own date
(see the note on `getVixOhlcFromSnapshots` in `api/_lib/db-snapshots.ts`), so
only today's rows are read and the old inverted flag does not matter.

## Data dependencies

- No migration, no new table, no new env var.
- Reads `market_snapshots` (Neon). Writes one Upstash Redis claim key per
  alerted stall: `snapshot-stale-alert:{date}:{last save epoch ms}` (Task 3;
  Tasks 1-2 keyed per day).
- New Vercel cron: `/api/cron/check-live-snapshots`.
- Task 3: a new owner-only endpoint, `POST /api/snapshot-close`, and one Redis
  key per day, `snapshot-app-closed:{date}` (24 h expiry).

## Open questions (defaults picked)

1. **Frozen-values rule** ("the last 3 live rows have identical SPX"). Default:
   not built. The owner can ask for it later; it would be a second check in the
   same job.
2. **No-trade days** (owner away on a trading day). Settled by the 2026-11-12
   amendment: a day with no live row sends no push.

## Phases

1. **Extract the claim-then-push protocol** (Task 1, ~4 files). The
   re-auth reminder's SET NX claim, send, fenced release on no delivery is
   about 60 lines. The new cron needs exactly the same protocol, so it moves
   to a shared module first and the reminder uses it. Behavior unchanged.
2. **The new cron** (Task 2, 4 files + this doc). Shippable on its own after
   Task 1.
3. **Server: alert only after saves start, once per stall, never after a
   deliberate close** (Task 3, owner amendments 2026-11-12; 4 files + this
   doc). Shippable alone: with no close signal yet, it behaves like the first
   amendment.
4. **Client: which browser saves live snapshots** (Task 4; 4 files). The
   device default and the per-browser switch, not yet wired into saving.
5. **Client: gate live saves on the device, send the close signal** (Task 5;
   3 files). Needs Task 3's endpoint and Task 4's helper.

## Files

- Task 1: `api/_lib/push-once.ts` (new), `api/__tests__/push-once.test.ts`
  (new), `api/cron/schwab-reauth-reminder.ts`, and
  `api/__tests__/cron-schwab-reauth-reminder.test.ts` only if it needs a
  change.
- Task 2: `api/cron/check-live-snapshots.ts` (new),
  `api/__tests__/cron-check-live-snapshots.test.ts` (new), `vercel.json`,
  `api/_lib/cron-schedules.ts`.
- Task 3: `api/cron/check-live-snapshots.ts`,
  `api/__tests__/cron-check-live-snapshots.test.ts`, `api/snapshot-close.ts`
  (new), `api/__tests__/snapshot-close.test.ts` (new), this doc.
- Task 4: `src/lib/live-save-device.ts` (new),
  `src/__tests__/live-save-device.test.ts` (new), the settings surface that
  hosts the switch (likely `src/components/PanelPrefsModal/PanelPrefsModal.tsx`)
  and its test.
- Task 5: `src/hooks/useSnapshotSave.ts`,
  `src/__tests__/hooks/useSnapshotSave.test.ts`, `src/main.tsx`.

## Global Constraints

- Skills to load: `backend-development`, `test-master`, `monitoring-expert`.
- Vercel-only change: no `uw-stream/` or `sidecar/` files, so no Railway hold.
- R6 for the claim, R4 for the tests (Redis throw, push throw, no device
  reached, DB reject), R7 (constants live in the file that uses them; no env
  vars).
- A run that pushed nothing because no device received it must not report
  `success`.
- Time logic is ET-anchored and DST-safe, like `isGexbotLiveCt` in
  `api/_lib/cron-helpers.ts`: CT is always ET − 1 h, so 09:00 CT = 10:00 ET.

## Task 1: Extract the claim-then-push protocol into `api/_lib/push-once.ts`

**Goal:** one shared function owns "claim a Redis key with SET NX, send the
owner push, release the claim when nothing was delivered", so the re-auth
reminder and the new snapshot alert use the same tested code. No behavior
change to the reminder.

**Move from `api/cron/schwab-reauth-reminder.ts`:** `RELEASE_CLAIM_LUA`, the
`releaseClaim` function, the `randomUUID()` claim token, the
`redis.set(key, token, { nx: true, ex })` claim, the `sendPushToOwner` call
with release-and-rethrow on a throw, and release when `result.sent === 0`.

**Shape (adjust names if the code reads better, keep the semantics):**

```ts
export type PushOnceOutcome =
  | { claimed: false }
  | { claimed: true; result: FanOutResult };

export async function sendOwnerPushOnce(opts: {
  key: string;
  claimTtlSec: number;
  payload: PushPayload;
  pushTtlSec: number;
  /** Prefix for the release-failure log line. */
  job: string;
}): Promise<PushOnceOutcome>;
```

- Claim fails closed: a throw from SET NX propagates (nothing sent).
- Claim not taken (`!== 'OK'`) → `{ claimed: false }`, no send.
- `sendPushToOwner` throws → release the claim (fenced), rethrow.
- `result.sent === 0` → release the claim (fenced), return the result. The
  caller decides the status and the Sentry message.
- A failed release logs and captures, as today, and does not throw.
- Also move the undelivered-reason ternary (`every send failed` /
  `every subscription expired` / `no push subscriptions`) into an exported
  `undeliveredReason(result: FanOutResult): string`, since both crons report
  it.
- The release-and-TTL commentary in the reminder's header moves with the
  code (the module header documents the protocol; the reminder header keeps
  its own key list and TTL arithmetic and points to the module).

**Reminder after the change:** same keys, same TTLs, same statuses, same
Sentry messages and fingerprints, same metadata. The existing
`api/__tests__/cron-schwab-reauth-reminder.test.ts` must pass unchanged; if a
test has to change, say exactly why in the report.

**Tests (`api/__tests__/push-once.test.ts`, written first):** claimed and
delivered; claim taken by an earlier run (no send); SET NX throws (no send,
rethrows); send throws (release with this run's token, rethrows); sent 0
(release, result returned); release throws (logged + captured, outcome still
returned); `undeliveredReason` for each of the three cases. Mock
`@upstash/redis` (as the reminder's test does) or `../_lib/redis.js`, plus
`../_lib/push.js`, `../_lib/logger.js`, `../_lib/sentry.js`.

**Acceptance:** `npm run review` green; reminder test unchanged and passing;
the reminder file no longer contains its own Lua script or release function.

## Task 2: The `check-live-snapshots` cron

**Goal:** the alert described at the top of this doc.

**`api/cron/check-live-snapshots.ts`:**

- `withCronInstrumentation('check-live-snapshots', handler, { timeCheck: isLiveSnapshotWatchWindow, requireApiKey: false })`
  (confirm the option names against `cron-instrumentation.ts`).
- `isLiveSnapshotWatchWindow()` lives in this file (single call site, R7):
  weekday, not a holiday (`getMarketCloseHourET(date) != null`), ET time
  ≥ 10:00 and ≤ `closeHourET * 60 − 15` minutes. Export it for the tests.
- Read the last live save:
  ```sql
  SELECT MAX(created_at) AS last_live_at
  FROM market_snapshots
  WHERE date = ${today}
    AND is_backtest = false
    AND entry_time <> 'pre-market'
  ```
  in `withDbRetry(..., 2, 10_000)`. `today` is the ET date (the guard's
  `today`, or `getETDateStr`). Coerce the timestamp with `neonIso` /
  `api/_lib/db-date.ts`.
- Reference time = the last live save, or today's 09:30 ET open
  (`getETMarketOpenUtcIso(today)`) when there is none. Stale when
  `now − reference ≥ STALE_AFTER_MIN`.
- Not stale → `{ status: 'success', message: 'live snapshots current', metadata: { lastLiveAt, minutesSince } }`.
- Stale → `sendOwnerPushOnce` (Task 1) with key `snapshot-stale-alert:{today}`,
  `CLAIM_TTL_SEC` 24 h, `PUSH_TTL_SEC` 1 h, payload:
  - title: `Live snapshots stopped saving`
  - body with a last save: `Last live snapshot {h:mm AM/PM} CT. Open the app signed in as owner.`
  - body with none today: `No live snapshot since the open. Open the app signed in as owner.`
  - `tag: snapshot-stale-{today}`, `requireInteraction: true`, `url: '/'`
- Not claimed → `skipped`, message `alert already sent today`.
- `sent === 0` → `error`, message `alert not delivered: {undeliveredReason}`,
  plus `Sentry.captureMessage('snapshot.stale_alert.undelivered', { level: 'error', fingerprint: [...] })`
  (`error`, not `warning`: the only Issue Stream rule mails high priority, and a
  lost phone alert must reach the owner).
- Sent with failures → `partial`; otherwise `success`, message `stale alert sent`.
- Format the CT time with an existing helper if one fits (search
  `src/utils/timezone.ts` and `formatSchwabExpiryCt` in
  `src/utils/schwab-expiry.ts` for the pattern); `.js` extensions on any
  `src/` import.
- Header comment: what it checks, the window and the 45-min worst case, the
  claim key / TTL arithmetic (R6), and `Spec: docs/superpowers/specs/live-snapshot-alert-2026-11-11.md`.

**`vercel.json`:** `{ "path": "/api/cron/check-live-snapshots", "schedule": "*/15 14-20 * * 1-5" }`.
14:00–20:45 UTC covers 10:00–15:45 ET in both EST and EDT; the handler's
window skips the rest.

**`api/_lib/cron-schedules.ts`:** an ET-local entry like the
`detect-periscope-*-lottery` ones:
`schedule: '*/15 10-15 * * 1-5'`, `timezone: MARKET_HOURS_TZ`,
`checkinMargin: DEFAULT_MARGIN`, `maxRuntime: DEFAULT_MAX_RUNTIME`, with a
comment on the UTC union and the half-day skips. `cron-schedules.test.ts`
must pass.

**Tests (`api/__tests__/cron-check-live-snapshots.test.ts`, written first,
cron pattern from CLAUDE.md, fake timers for the clock):**

- auth guard: no or wrong `CRON_SECRET` → 401, no DB read.
- window: 08:55 CT skips; 09:00 CT (10:00 ET) runs; 14:45 CT runs; 14:50 CT skips; a half-day (pick a date in `EARLY_CLOSE_DATES`) at
  11:45 CT runs and 12:00 CT skips; a holiday and a Saturday skip. One case
  in EDT and one in EST.
- last save 20 min ago → success, no push.
- last save 35 min ago → push with the "Last live snapshot … CT" body and the
  dated key.
- no live row at 09:00 CT → push with the "since the open" body.
- claim already taken → skipped, no push.
- push reaches no device → status `error`, Sentry message by name, and
  (via Task 1) the claim released.
- DB read rejects → status `error` (500), no push.
- push throws → status `error`.

**Acceptance:** `npm run review` green; `cron-schedules.test.ts` passes with
the new entry.

## Task 3: Server — alert only after saves start, once per stall, never after a deliberate close

**Goal:** both 2026-11-12 amendments in Decisions, server side. Files:
`api/cron/check-live-snapshots.ts`, `api/__tests__/cron-check-live-snapshots.test.ts`,
`api/snapshot-close.ts` (new), `api/__tests__/snapshot-close.test.ts` (new),
and this doc. Commit the doc's uncommitted amendment edits as-is, in their own
`docs(spec): …` commit.

**`api/snapshot-close.ts` (new): `POST /api/snapshot-close`.**

- Owner only, with `guardOwnerEndpoint`. POST only (405 otherwise).
  `rejectIfRateLimited(req, res, 'snapshot-close', 30)`, following
  `api/snapshot.ts`.
- No body. It writes the Redis key `snapshot-app-closed:{ET date}`, with the
  server's current time (ISO) as the value and `CLAIM_TTL`-style expiry of 24 h
  (`SET key value EX 86400`, overwriting). The key is date-derived (R6); the
  value is a marker time, and the last write wins, which is the intent.
- Answers 204. A Redis failure is a 500 with Sentry via the usual error path.
  The client never reads the answer.
- A guest or public caller gets the guard's 401, with no write.

**Cron additions (`api/cron/check-live-snapshots.ts`), on top of the bullets
below:**

- When the last save is stale, read `snapshot-app-closed:{today}` before
  claiming. If it holds a time at or after the last save, the owner closed the
  app after it last saved: return `{ status: 'success', message: 'app closed
  at {h:mm AM/PM} CT', metadata: { lastLiveAt, closedAt } }`, with no claim and
  no push.
- A close marker older than the last save (the app was reopened and saved
  since) is ignored, and the stall pushes as usual.
- A Redis read failure propagates: a 500 and an `error` check-in, the same as
  a claim failure. It must not read as "closed".
- An unparseable marker value reads as no marker (stall pushes), with a
  `logger.warn`. A bad marker must not silence a real stall.

**Per-stall and no-row changes:**

- **No live row today → no push.** Return `{ status: 'success', message:
  'no live snapshot yet today', metadata: { lastLiveAt: null } }`. Drop the
  09:30 ET open fallback and the "No live snapshot since the open." body.
  Remove `getETMarketOpenUtcIso` from the imports if nothing else uses it
  (orphan cleanup). Keep the throw on an unparseable stored timestamp: NaN
  must not read as "current".
- **Per-stall claim key:** `snapshot-stale-alert:{today}:{lastSaveMs}`, where
  `lastSaveMs` is the parsed `MAX(created_at)` in epoch ms. It comes from the
  event (R6). During one stall the last save doesn't change, so every later
  check finds the same key and skips. A save that resumes and stops again has
  a new `MAX(created_at)`, hence a new key and a new push. `CLAIM_TTL_SEC`
  stays 24 h: it outlives any stall in the window, and the next day's date
  changes the key.
- **Per-stall notification tag:** `snapshot-stale-{today}-{lastSaveMs}`.
  `src/sw.ts` shows the notification with the payload's `tag` and no
  `renotify`, so a second stall that reused the day's tag would silently
  replace the first notification without alerting.
- **Not claimed:** the message becomes `alert already sent for this stall`.
- **Header comment:** rewrite the key and TTL lines and the "one push per
  day" wording to describe per stall and no push before the first save. Keep
  the window, the 45-min worst case and the `Spec:` line.
- **Window unchanged:** 10:00 ET to the close − 15 min. The schedule,
  `vercel.json` and `SCHEDULE_MAP` don't change.
- **Tests:**
  - Replace "no live row at 09:00 CT → push with the 'since the open' body"
    with: no live row today → `success`, message `no live snapshot yet today`,
    no claim and no push. Cover it at 09:00 CT and at 14:45 CT.
  - Last save 35 min ago → the key and tag carry that save's epoch ms.
  - Two stalls in one day: the first pushes; a later check in the same stall
    is `skipped` with the new message; after a newer last save goes stale,
    a second push goes out with a different key and tag.
  - The existing undelivered, claim-throw, push-throw, DB-reject and
    malformed-timestamp cases still pass, adjusted for the key.
  - Mutation-check: a per-day key fails the two-stall test; the open fallback
    put back fails the no-row test.
  - Close marker: a stale last save with a marker at or after it → `success`
    "app closed", no claim, no push; a marker older than the last save → push;
    a Redis read that throws → 500, no push; an unparseable marker → push plus
    a warn. Mutation-check the `>=` comparison.
  - `snapshot-close.test.ts`: owner POST → 204 and the key written with a
    24 h expiry under the ET date; GET → 405; guest and public → 401 with no
    write; rate-limited → 429; Redis throws → 500.

**Acceptance:** `npm run review` green.

## Task 4: Client — which browser saves live snapshots

**Goal:** the third amendment's device rule and its per-browser switch. It is
not wired into saving yet; Task 5 does that. Files:
`src/lib/live-save-device.ts` (new), `src/__tests__/live-save-device.test.ts`
(new), and the settings surface that hosts the switch and its test.

- `src/lib/live-save-device.ts`:
  - `isTouchFirstDevice(): boolean` is
    `matchMedia('(hover: none) and (pointer: coarse)').matches`. Phones and
    tablets match. A touchscreen laptop doesn't, because its primary pointer
    is fine and can hover.
  - `getLiveSaveOverride(): 'on' | 'off' | null` and
    `setLiveSaveOverride(value: 'on' | 'off' | null)` use the `localStorage`
    key `sc-live-save-device`. `null` clears it. Every access is wrapped in
    try/catch: a storage that throws reads as no override.
  - `isLiveSaveDevice(): boolean` returns the override if set, else
    `!isTouchFirstDevice()`. Any unknown stored value reads as no override.
  - Subscribers: `subscribeLiveSaveDevice(cb): () => void`, notified on set,
    following the small subscriber-set pattern in `src/lib/sw-update.ts`, so
    the hook in Task 5 re-renders when the switch flips in this tab.
    Cross-tab sync isn't needed.
- The switch: an owner-only control labelled "Save live snapshots from this
  browser". It shows the effective value, with a note when it's the device
  default ("Default for this device: on" or "off"), and offers "Use device
  default". Put it in the existing settings surface that fits best. Check
  `src/components/PanelPrefsModal/PanelPrefsModal.tsx` and
  `src/components/AppHeader/` first, and say in the report where it went and
  why. It must meet the `fixing-accessibility` rules: a labelled control,
  keyboard reachable, with its state announced.
- Tests:
  - the helper truth table: touch-first with no override → off; desktop with
    no override → on; override on or off beats the device; a garbage stored
    value → device default; `localStorage` throwing → device default;
    subscribers fire on set and unsubscribe cleanly;
  - the switch: it renders the effective state, toggling writes the override,
    "Use device default" clears it, and it doesn't render for a guest.

**Acceptance:** `npm run review` green.

## Task 5: Client — gate live saves on the device, send the close signal

**Goal:** only a live-save device saves live rows and sends the close signal.
Files: `src/hooks/useSnapshotSave.ts`,
`src/__tests__/hooks/useSnapshotSave.test.ts`, `src/main.tsx`.

- **Gate live saves.** In `useSnapshotSave`, a live save (today, with live
  quotes) posts only when `isLiveSaveDevice()` (Task 4) is true. Past-date and
  backtest saves are unchanged. Subscribe to the switch so flipping it takes
  effect without a reload.
- **Close signal.** While the hook is `enabled` and `isLiveSaveDevice()` is
  true, register a `pagehide` listener in an effect with cleanup (R1). On
  `pagehide`, call `navigator.sendBeacon('/api/snapshot-close')`. If
  `sendBeacon` is missing or returns false, fall back to
  `fetch('/api/snapshot-close', { method: 'POST', keepalive: true })` with the
  rejection swallowed. The page is going away, so nothing can be reported.
- `pagehide` fires on a tab or window close, a reload and navigating away. A
  reload's marker is overtaken by the next save, so it never hides a stall.
  Use `pagehide`, not `beforeunload` or `unload`: `pagehide` is the one that
  fires reliably and doesn't block the back/forward cache. Don't use
  `visibilitychange`, because hiding a tab is not closing it.
- `src/main.tsx`: add `{ path: '/api/snapshot-close', method: 'POST' }` to
  the `initBotId` `protect` list, next to `/api/snapshot` (CLAUDE.md rule for
  any endpoint that calls `checkBot`).
- Tests:
  - owner, enabled and a live-save device → a `pagehide` event sends one
    beacon to `/api/snapshot-close`;
  - not a live-save device (mock `isLiveSaveDevice` false) → no live save
    and no beacon, while a past-date save still posts;
  - disabled (a guest, or nothing to save) → no beacon;
  - `sendBeacon` returning false → the keepalive fetch;
  - flipping the switch on re-enables live saves without a remount;
  - unmount removes the listener (a later `pagehide` sends nothing).

  Existing save tests stay unchanged, apart from mocking `isLiveSaveDevice`
  to true at the module boundary (R3).

**Acceptance:** `npm run review` green.
