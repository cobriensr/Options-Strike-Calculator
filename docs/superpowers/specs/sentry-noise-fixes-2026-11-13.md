# Sentry noise fixes (2026-11-13)

## Goal

Make each Sentry email mean one real problem. Before the owner unmuted the cron monitors on 2026-11-13, a week of data showed:

- Most error volume came from a few reporters that send the same failure many times.
- Some check-ins were lost even though the job had run fine.

This plan removes the repeats and keeps every real failure visible.

## Findings this plan rests on (week of 2026-11-06 07:15 to 2026-11-13 07:15 UTC)

Source: three read-only passes on 2026-11-13. The full tables are scratch, gitignored, in `docs/tmp/sentry-checkins-2026-11-13.md` and `docs/tmp/sentry-errors-2026-11-13.md`. A verifier confirmed every code claim below against origin/main `7440d4db`.

- **Check-ins.**
  - 83 cron monitors: 70 clean all week, 13 with at least one bad check-in.
  - `fetch-vol-0dte` was an orphan: its job was removed in `82fde989` (2026-05-26). It accounted for 540 of 545 missed check-ins. The owner approved deleting it on 2026-11-13.
- **Error events.**
  - 499 events reached Sentry, in 33 issues. The SDKs dropped another 943 events (`network_error`), so every count is a floor.
  - One Schwab login lapse (11-11 17:49 to 20:41 UTC) produced 173 failed check-ins and 346 error events from `fetch-spx-candles-1m`, about 70% of the week.
- **Lost check-ins.**
  - On 11-12 at 21:55:21 UTC, `fetch-futures-snapshot` stored its data. Sentry then rejected its `ok` check-in with HTTP 503.
  - A `*/5` job with a 5-minute margin reads as "missed" after one lost check-in. The failure threshold of 3 already keeps these from alerting. No code change is needed.
- **Real timeouts.**
  - `backup-tables` timed out on 4 Sundays running (10-18 to 11-08, 300 s, 4281 MB used against 4096 MB). It was fixed on 11-11 (`59ed4910` and the deadline commits). The first real test is Sunday 2026-11-15 at 05:00 UTC.

## Phases

One implementer stream at a time, in this order. Each phase ships on its own, with tests, through the Get It Right loop.

### Phase 1: `fetch-spx-candles-1m` stops reporting a login lapse once per symbol per minute

- **Cause.**
  - `api/_lib/schwab.ts` `handleLapsedLogin` (~1033-1055) already reports `schwab.auth.login_lapsed` once.
  - `api/cron/fetch-spx-candles-1m.ts` then sets both ratios to null on any failed result (~258-266), with no check of `result.code`.
  - `ingestIndex` throws (~472-474), and the per-symbol catch calls `Sentry.captureException` (~604-609). That is two events per run.
- **Fix.** Treat `SCHWAB_TOKEN_EXPIRED` the way five other Schwab callers already do (`compute-cone.ts:188`, `fetch-outcomes.ts:121`, `fetch-market-internals.ts:160`, `fetch-strike-iv.ts:349` and `:551`, `vix-term-structure.ts:206`): no per-symbol Sentry capture.
  - The run must still not report success, because no data was written (R4).
  - The monitor may stay red during a lapse. It opens one incident after 3 failures (`failureIssueThreshold: 3`), which is one email, not 173.
- **Files.** `api/cron/fetch-spx-candles-1m.ts`, its test.
- **Deploy.** Vercel. Push outside market hours.

### Phase 2: a transient Neon error in a cron is a warning, not a Sentry error

- **Cause.** `api/_lib/cron-instrumentation.ts` ~838 calls `Sentry.captureException(err)` on any thrown error, with no test for `TransientDbError`. Endpoints already treat transients as a warning plus a metric, with no exception capture (`transient-db-response.ts:71-82`; policy stated in `request-scope.ts:133-143`).
- **Fix.** Use the same policy in the cron wrapper:
  - log at warning level, count the metric, and skip `captureException` for `TransientDbError`;
  - the check-in still reports `error`, because the run failed.
- **Files.** `api/_lib/cron-instrumentation.ts`, its test.
- **Deploy.** Vercel. Push outside market hours.

### Phase 3: uw-stream reports a reconnect storm once per incident, and files each exception once

- **Cause.**
  - `uw-stream` `connector.py` `_maybe_alert_storm` (~544-561) calls `capture_message` on every reconnect past the threshold, with no cooldown. That made 30 events on 11-12 17:32 to 18:05 UTC.
  - `sentry_setup.py` logs at ERROR (~155-158) and then calls `capture_exception` (~168). The SDK's default `LoggingIntegration` (event level ERROR, sentry-sdk 2.73.0) turns the log record into a second event.
- **Fix.**
  - Add a cooldown to the storm alert: at most one per incident window. The implementer picks the window from the reconnect data and documents it.
  - Set `LoggingIntegration(event_level=None)`, as `nightly/src/monitoring.py:68` already does.
- **Files.** `uw-stream/src/.../connector.py`, `uw-stream/src/.../sentry_setup.py`, their tests.
- **Deploy.** Railway. Push after 15:00 CT only.

### Phase 4: 429 reporting

- **UW.** `metrics.uwRateLimit` (`api/_lib/sentry.ts` ~159-167, called from `uw-fetch.ts:273`) sends one warning per 429 call, and the endpoint path is in the message, so each endpoint opens its own issue. Report once per run per endpoint, and only when the retries ran out.
- **GEXBot.**
  - `gexbot-client.ts` labels a 429 "quota", and `uw-fetch.ts:70` treats it as a daily quota.
  - The vendor contract quoted in `gexbot-client.ts:14-22` is a rate limit: one request per second per ticker per metric. The 11-06 to 11-13 week shows 4 calls in one tick and none after. Treat it as a short rate limit with backoff.
  - The "resets at midnight ET" quota applies only to the EOD endpoint, per the EOD spec.
- **Files.** `api/_lib/sentry.ts`, `api/_lib/uw-fetch.ts`, `api/_lib/gexbot-client.ts`, tests.
- **Deploy.** Vercel. Push outside market hours.

### Phase 5: detector deadlines save fires without features (investigation first)

- **Effect.** In the week, `detect-lottery-fires` (47 events), `detect-silent-boom` (7) and the Take-It prefetch hit 5-second deadlines. The fires were still saved, with NULL `cum_ncp_at_fire` / `cum_npp_at_fire`, a NULL V2 score and NULL Take-It columns. No per-row marker tells this NULL apart from "ticker outside the net-flow universe". 5 of 12 Take-It deadline hits were the 14:25 UTC first run of the day.
- **Investigate.**
  - Is it a cold start, Neon wake-up or Blob latency?
  - How many fires per day are affected over the last 30 days?
  - Can the missing fields be backfilled? `scripts/backfill-ticker-flow-at-fire.mjs` covers `cum_ncp_at_fire` only.
- **Then.** A spec section with the fix and the backfill. A marker column is a migration and needs the owner's approval for that migration.

### Phase 6: lost SDK events (investigation)

943 events were dropped as `network_error` in the week, and the drop stats carry no service name. Find which runtime drops them: Vercel functions frozen before flush, or uw-stream during reconnects. Then fix the flush or the transport.

## Owner decision, asked when Phase 6 is done

**`audit-gexbot-eod` runs at 22:30 and 23:30 UTC and raises the same missing-report error both times** (`audit-gexbot-eod.ts:45-47`, `:74-79`). `archive-gexbot-eod` retries at 23:00, so the 22:30 verdict can be early.
- Default if the owner agrees: the 22:30 run warns and the 23:30 run is the verdict.
- This changes when an alert fires. Per the no-silent-methodology-changes rule it is the owner's call, not a default the implementer applies.

## Not in scope

- `enrich-lottery-outcomes` turning red when one ticker has a tape gap (`option-outcome-aggregate.ts:829-836`) is a real data gap and is reported as designed.
- `check-live-snapshots` timed out once, on its first run (11-12 14:01 UTC), then ran 27 times clean. Watch only.
