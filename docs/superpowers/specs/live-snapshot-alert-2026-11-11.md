# Live snapshot alert

**Date:** 2026-11-11 · **Status:** approved by the owner (option B), in progress

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

## Thresholds / constants

| Name | Value | Why |
| --- | --- | --- |
| `STALE_AFTER_MIN` | 30 | Live rows save every 5 min while the page is open; 30 min is six missed slots. |
| Window start | 09:00 CT (10:00 ET) | 30 min after the 08:30 CT open, so the first check can already be stale. |
| Window end | the day's close − 15 min (14:45 CT; 11:45 CT on a half-day) | The last check that can still help this session. |
| Cadence | every 15 min | Worst-case detection is 30 + 15 = 45 min. |
| `CLAIM_TTL_SEC` | 24 h | The claim only has to outlive one day's window (under 6 h). |
| `PUSH_TTL_SEC` | 1 h | A late delivery is still useful within the session; the claim blocks a retry once the push service accepted it. |
| Sentry monitor `failureIssueThreshold` | 2 | At the ~5% transient check-in miss rate, 24 ticks a day would raise a false monitor issue on about 70% of days at 1; 2 misses in a row page within 30 min, and an undelivered run errors on consecutive ticks. |

Example: saves stop at 11:10 AM CT. The 11:30 check sees a 20-minute gap (no
push); the 11:45 check sees 35 minutes and pushes "Last live snapshot 11:10 AM
CT". The later checks find the day's claim and skip.

"No row yet today" measures from the 08:30 CT open, so at 9:00 a day with no
live row is exactly 30 minutes stale and pushes.

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
  alerted day: `snapshot-stale-alert:{date}`.
- New Vercel cron: `/api/cron/check-live-snapshots`.

## Open questions (defaults picked)

1. **Frozen-values rule** ("the last 3 live rows have identical SPX"). Default:
   not built. The owner can ask for it later; it would be a second check in the
   same job.
2. **No-trade days** (owner away on a trading day). Default: no snooze. The
   cost is one push that day.

## Phases

1. **Extract the claim-then-push protocol** (Task 1, ~4 files). The
   re-auth reminder's SET NX claim, send, fenced release on no delivery is
   about 60 lines. The new cron needs exactly the same protocol, so it moves
   to a shared module first and the reminder uses it. Behavior unchanged.
2. **The new cron** (Task 2, 4 files + this doc). Shippable on its own after
   Task 1.

## Files

- Task 1: `api/_lib/push-once.ts` (new), `api/__tests__/push-once.test.ts`
  (new), `api/cron/schwab-reauth-reminder.ts`, and
  `api/__tests__/cron-schwab-reauth-reminder.test.ts` only if it needs a
  change.
- Task 2: `api/cron/check-live-snapshots.ts` (new),
  `api/__tests__/cron-check-live-snapshots.test.ts` (new), `vercel.json`,
  `api/_lib/cron-schedules.ts`.

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
