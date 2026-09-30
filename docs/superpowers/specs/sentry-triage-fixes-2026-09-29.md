# Sentry triage fixes — 2026-09-29

## Goal

Clear the still-firing Sentry issues from the 30-day triage that have a code
root cause, without hiding genuine new failure modes.

Source data: 30-day Discover pull grouped by issue (88 issues, ~159K events;
58 issues / ~93K events excluding the already-fixed UW 401 key incident).
Each cluster was root-caused by a read-only investigation and the
load-bearing claims were verified against source and prod.

## Phases (each independently shippable, one commit each)

### B — Retry UW/GexBot HTTP 500 (C0, HB)

- `withRetry` 5xx regex at `api/_lib/uw-fetch.ts:75` is `50[234]`; a 500 is
  never retried. UW 500 incidents are typically ~1 s multi-cron blips.
- Change to `50[0234]`, keeping the prefix-anchoring that stops a
  `UW API 400: …500…` body from matching.
- Tests (next to `api/__tests__/api-helpers.test.ts:507-545`): 500 retries
  then succeeds; three 500s throw; `UW API 400: …500…` not retried.

### C — Fail-fast Redis client for the UW limiters (HE)

- 2026-09-29 15:12–15:16 UTC Upstash connect-timeout outage. The limiters
  fail open correctly, but `@upstash/redis` 1.38 defaults to 5 retries and
  undici's 10 s connect timeout; `uwFetch` makes 3 sequential Redis calls
  per UW request → cron runs stalled to 206 s and 3 minutes of
  `strike_trade_volume` rows were partially lost.
- Add a dedicated limiter client in `api/_lib/redis.ts`:
  `retry: { retries: 0 }`, `signal: () => AbortSignal.timeout(1_500)`.
  **Must be the function form** — a static already-aborted signal makes
  Upstash return a fake 200 `{ result: "Aborted" }`
  (`node_modules/@upstash/redis/chunk-2X4SLXT7.mjs:177`).
- Use it in `api/_lib/uw-rate-limit.ts` and `api/_lib/uw-concurrency.ts`.
- Shared Sentry fingerprint on the two fail-open captures
  (`uw-rate-limit.ts:119`, `uw-concurrency.ts:155`) so an outage is one
  issue, not ~56 events across 20 cron transactions.
- Tests: Redis reject/timeout → limiter fails open within budget; aborted
  signal surfaces as an error (not the fake 200); capture carries the
  fingerprint.
- Out of scope: a 30 s module-level circuit breaker (possible follow-up).

### D — Gate GexBot crons to the live session (8F, 76, B1, 8E, D9, EV, FN)

- 99.8% of 30-day GexBot timeouts are in the 20:xx UTC hour (15:00–15:55
  CDT), after GexBot freezes at the 16:00 ET close. The rows lost are
  duplicates of the frozen 20:00 snapshot. Current gate `isFuturesRthCt`
  (`api/_lib/cron-helpers.ts`) runs to 16:55 ET.
- Add `isGexbotLiveCt()` to `cron-helpers.ts`: weekday, non-holiday,
  09:30 ET through `getMarketCloseHourET()` close + 1 minute (DST- and
  half-day-aware). Leave `isFuturesRthCt` untouched (other callers).
- Use it in `fetch-gexbot-fast.ts`, `fetch-gexbot-strikes.ts`,
  `populate-periscope-from-gexbot.ts`.
- D9: populate's first run at 09:30 ET races the same-minute strikes
  insert; when ALL panels miss within the first 3 minutes after 09:30 ET,
  log info + return skipped instead of `captureMessage`. A mid-session
  miss still warns.
- Fingerprint `['gexbot-fetch-failure', <cron>, err.name]` on both
  fetch crons' `captureException` so 8F/76 (same error, split by
  stack-vs-message grouping) merge.
- Trim `vercel.json` `0-55 21` → `0-1 21` for the two fetch crons (EST
  close + 1 min) and mirror in `api/_lib/cron-schedules.ts`.
- Tests: gate table (09:29 F, 09:30 T, 16:01 T, 16:02 F, half-day
  13:01 T / 13:02 F, weekend, holiday, both DST sides); open-race miss not
  captured, mid-session miss captured; fingerprint asserted; pre-close
  timeout still reaches Sentry.

### E — F0: `date = text` in enrich-periscope-lottery-outcomes

- `api/cron/enrich-periscope-lottery-outcomes.ts:189` binds
  `${expiries}::text[]`, compared to the DATE column
  `ws_option_trades.expiry` → every run has failed since commit dd2b68ff
  (2026-06-12). Nothing enriched since.
- **A cast alone corrupts data:** candidates are `ORDER BY fire_time ASC
  LIMIT 500` and a fire with no trades is locked at R = −1. Trades for
  most backlog fires are pruned, so ~3,100 fires would be locked as
  total losses.
- Change: `::date[]`; restrict candidates to fires inside the trade
  retention window (`fire_time >= NOW() - INTERVAL '2 days'`, matching
  the cleanup cron's retention) and order newest first.
- Tests: date-typed binding; out-of-window fires not selected; DB reject
  surfaces as an error.
- The ~4,800-fire backlog is a separate owner decision (see below).

## Deferred / owner decisions (not in this spec's commits)

- **A (Schwab)**: sliding `refreshExpiresAt` bug (`api/_lib/schwab.ts:216`)
  plus invalid_grant handling — held while the owner explores automating
  the 7-day re-auth.
- **F (Databento removal)**: rip out all Databento code, substitute the UW
  futures websocket — scoped separately; builds on the unpushed local
  commits c04d4c15 / d1ecc3c5 / 089c7ab1.
- **ES** (capture-flow-regime-daily full-day seq scan; `flow_regime_slot_daily`
  has 0 rows ever) and **ws_option_trades retention falling behind**
  (75 GB, rows back to 06-18 against a 2-day policy) — plan together.
- CK lottery_ticker_stats staleness, F0 backlog, vol_term_structure
  2026-09-28 gap, Sentry resolve/monitor cleanup — next session items.

## Files

- B: `api/_lib/uw-fetch.ts`, `api/__tests__/api-helpers.test.ts`
- C: `api/_lib/redis.ts`, `api/_lib/uw-rate-limit.ts`,
  `api/_lib/uw-concurrency.ts` + tests
- D: `api/_lib/cron-helpers.ts`, `api/cron/fetch-gexbot-fast.ts`,
  `api/cron/fetch-gexbot-strikes.ts`,
  `api/cron/populate-periscope-from-gexbot.ts`, `vercel.json`,
  `api/_lib/cron-schedules.ts` + tests
- E: `api/cron/enrich-periscope-lottery-outcomes.ts` + test

## Data dependencies

None — no migrations, no new env vars, no new tables.

## Thresholds / constants

- Limiter Redis budget: 1,500 ms, 0 retries.
- GexBot live window: 09:30 ET → close + 1 min.
- D9 open-race grace: 3 minutes after 09:30 ET.
- F0 candidate window: 2 days (trade retention).
