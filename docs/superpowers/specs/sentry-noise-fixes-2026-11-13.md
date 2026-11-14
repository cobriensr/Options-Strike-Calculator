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
  - The monitor may stay red during a lapse. It opens one incident after 3 failures (`failureIssueThreshold: 3`). Once the monitor is unmuted, a lapse becomes one monitor incident and one email, instead of 346 exception events. (The 173 failed check-ins on 11-11 emailed nobody, because the monitor was muted.)
- **Files.** `api/cron/fetch-spx-candles-1m.ts`, its test.
- **Deploy.** Vercel. Push outside market hours.
  - Precondition: push only after the `fetch-spx-candles-1m` monitor is unmuted and read back as unmuted (owner approved unmuting on 2026-11-13). Until then, the cron's exceptions are the only lapse alert that emails the owner: `login_lapsed` and `refresh_rejected` are warnings, which the email rule skips.

### Phase 2: a transient Neon error in a cron is a warning, not a Sentry error

- **Cause.** `api/_lib/cron-instrumentation.ts` ~838 calls `Sentry.captureException(err)` on any thrown error, with no test for `TransientDbError`. Endpoints already treat transients as a warning plus a metric, with no exception capture (`transient-db-response.ts:71-82`; policy stated in `request-scope.ts:133-143`).
- **Fix.** Use the same policy in the cron wrapper:
  - log at warning level, count the metric, and skip `captureException` for `TransientDbError`;
  - the check-in still reports `error`, because the run failed.
- **Files.**
  - `api/_lib/cron-instrumentation.ts` and its test.
  - `api/_lib/transient-db-error.ts`: the class, moved out of `db.ts` so the wrapper can classify without importing it. A first try that imported it from `db.js` failed 36 cron test files, because they mock `db.js` with a factory that lacks the class.
  - `api/_lib/db.ts`: re-exports the class, so existing imports keep working.
  - `api/__tests__/transient-db-error.test.ts`.
- **Deploy.** Vercel. Push outside market hours.
  - Precondition: push only after the cron monitors are unmuted and read back as unmuted. Every job wrapped in `withCronInstrumentation` (64 files in `api/cron/`) can take this path. "Unmuted" means each of those monitors reads back `isMuted: false` through the Sentry monitors API. Until then, a cron's exception is its only email path, because many monitors are muted. This change removes that exception for a transient Neon error, so a muted monitor would leave the failed run with no email at all.
- **Open question for the owner (no default applied).** The new `<job>.db_timeout` counter has no consumer.
  - A persistent slow-query regression is now a warning. One example is the takeit-fill-shap "db attempt timeout" storm from a missing index (SENTRY-EMERALD-DESERT-7J; see migration #184's description in `api/_lib/db-migrations.ts`, ~5161).
  - Once the monitors are unmuted, a cron that fails 3 runs in a row still emails.
  - A cron that times out on only some runs never reaches that threshold and stays silent.
  - Option: a Sentry metric alert on the `*.db_timeout` rate. That is an alert-rule change, so it needs the owner's OK.

### Phase 3: uw-stream reports a reconnect storm once per incident, and files each exception once

- **Cause.**
  - `uw-stream` `connector.py` `_maybe_alert_storm` (~544-561) calls `capture_message` on every reconnect past the threshold, with no cooldown. That made 30 events on 11-12 17:32 to 18:05 UTC.
  - `sentry_setup.py` logs at ERROR (~155-158) and then calls `capture_exception` (~168). The SDK's default `LoggingIntegration` (event level ERROR, sentry-sdk 2.73.0) turns the log record into a second event.
- **Fix.**
  - **Storm cooldown.** At most one alert per 3600 s, process-wide (`_maybe_alert_storm` in `connector.py` reads `RECONNECT_HORIZON` from `state.py` each time it runs, with no constant of its own; the timestamp is `state.storm_alerted_at`, one float). A test patches the horizon to ten minutes and checks the window follows it.
    - Why 3600 s: it equals the horizon `reconnects_last_hour` counts over, one constant, `RECONNECT_HORIZON` in `state.py`, that both read. Once a burst crosses the threshold the count stays above it until the burst ages out of that hour (11-12: 17:32 to 18:05 UTC, about one reconnect a minute, peak 55). A window as long as the horizon means every reconnect behind an alert has aged out when the window ends, so the next alert needs a threshold's worth of new reconnects. A shorter window would alert again on reconnects the first alert had already counted.
    - Why process-wide: the count and the threshold (base times the shard count) are both process-wide, and drops arrive as all-shard clusters about 41% of the time. A timestamp per connector would send one alert per shard for one incident.
    - Cost: a second incident that starts inside the hour of an earlier alert is not announced. Each of its drops still logs one line and shows in `/metrics` `reconnects_last_hour`. A storm still going when the hour ends alerts again.
  - **One event per failure.** `LoggingIntegration(level=INFO, event_level=None)`, as `nightly/src/monitoring.py:68` already does. An error log line is a breadcrumb on the next event, never an event.
  - **Explicit captures added where the log line was the only Sentry path.** Each sits beside its `log.error` and carries tags that say what it is:
    - `RateLimitedLogger.error` (`logger_setup.py`) sends a `capture_message` at level `error` for its head-of-window line, so the throttle bounds events as it bounds lines. This covers `futures_front_month._fail` and `futures_trades._note_failure`. A warning sends nothing.
    - The front-month clamp in `futures_front_month.py` (kind `front_month_clamped`).
    - `futures_trades._note_unknown` (kind `front_month_unknown`), a completed minute skipped for want of a front-month contract. It sends once per product per window with the running total and the cause.
    - `main._shutdown`'s "handler drain raised", sent with `capture_exception` and tags `component=main`, `stage=drain` and the handler name.
  - **Library loggers (review finding, fix round 1).** `event_level=None` also dropped the ERROR records of libraries, which log a failure and send nothing else. `init_sentry` now attaches an `EventHandler(level=ERROR)` to the `websockets` and `asyncio` loggers, once (a second call attaches nothing) and only after `sentry_sdk.init` succeeds, so a service with no DSN attaches nothing. What it catches, in the installed websockets 17.4 and CPython 3.12:
    - `websockets/asyncio/connection.py` "keepalive ping failed" (the socket stays open with no pings) and "unexpected internal error";
    - `websockets/protocol.py` "parser failed";
    - asyncio's "Exception in callback" (built in `asyncio/events.py`, `Handle._run`) and "Task exception was never retrieved" (built in `asyncio/futures.py`, `Future.__del__`; the C accelerator builds the same text). Both go through `call_exception_handler`, whose default handler in `asyncio/base_events.py` logs them at ERROR.
    WARNING records of these loggers stay breadcrumbs. The service's own logger is not touched, so its error lines still file nothing. One side effect handled: any handler on a logger ends the stdlib's last-resort stderr line for that logger. Neither logger has a handler of its own (websockets 17.4 adds no `NullHandler`) and nothing configures the root logger, so before this change both loggers' WARNING and ERROR records reached stderr, and so Railway's logs, through `logging.lastResort`. That is why `init_sentry` attaches `logging.lastResort` to each of them when no handler is in its chain, which keeps those lines. The choice is made once at init: if root logging is ever configured (`basicConfig`, a root handler), the `lastResort` branch must be dropped, or these loggers print every WARNING and ERROR line twice. It is skipped when `logging.lastResort` is `None`.
  - **What reaches Sentry now:** the explicit captures, the two library handlers, `AioHttpIntegration` (an exception the health handlers don't catch) and `ExcepthookIntegration` (an uncaught exception). Both integrations are active under the current `init` kwargs (a test checks this on a client built with the default integrations on).
- **Files.**
  - Source: `uw-stream/src/connector.py`, `state.py`, `sentry_setup.py`, `logger_setup.py`, `futures_front_month.py`, `handlers/futures_trades.py`, `main.py`.
  - Docs: `uw-stream/README.md`.
  - Tests: `uw-stream/tests/test_connector.py`, `test_sentry_setup.py`, `test_logger_rate_limit.py`, `test_futures_front_month.py`, `test_futures_trades_handler.py`, `test_main.py`.
- **Deploy.** Railway. Push after 15:00 CT only (`uw-stream/` is a Railway watch path, and a push redeploys the service).
  - Issues that came from logging records stop getting events. Plain-message issues replace them, so expect a few new-issue emails on first occurrence.
- **Open question for the owner (no default applied).** The storm alert is a `warning` `capture_message`, and nothing emails a warning:
  - the high-priority Issue Stream rule skips warnings;
  - rule 6262822 covers cron monitors only;
  - rule 6262727 matches `service=nightly` only.
  - So a reconnect storm is visible in Sentry and on `/metrics` but emails nobody. Options: raise the level to `error` (at most one email an hour during a storm, because of the window), or add a per-tag alert rule (`component=connector`). Either changes who is told when, so it needs the owner's OK. It stays `warning` until the owner decides.

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
- The Phase 2 rule covers only the `withCronInstrumentation` wrapper. `withCronCheckin` never captures, so the 17 crons that use it (about 32 `captureException` sites in those files) capture inside their own handlers. Across `api/cron/` there are about 91 such sites in 51 files, in both kinds of cron. They keep the old policy for now, so the transient rule is split across the two wrappers. Possible later sweep: move each site to the shared transient check.
