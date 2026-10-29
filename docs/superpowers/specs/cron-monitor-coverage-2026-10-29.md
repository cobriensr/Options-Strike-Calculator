---
status: Done
date: 2026-10-29
---

# Cron monitor coverage: every Vercel cron gets a Sentry monitor or a written exemption

## Goal

Give each of the nine unmonitored `/api/cron/*` jobs a Sentry cron monitor, exempt `/api/health` in writing, and add a test that fails when a `vercel.json` cron has neither. Today a cron with no `SCHEDULE_MAP` entry sends no check-ins, and nothing notices when it stops. Scope approved by the owner on 2026-10-29.

## How monitoring works today

- `SCHEDULE_MAP` in `api/_lib/cron-schedules.ts` drives Sentry cron monitors. The key is the job name: the `vercel.json` path minus `/api/cron/`.
- `withCronInstrumentation` and `withCronCheckin` (`api/_lib/cron-instrumentation.ts`) POST check-ins straight to Sentry's Crons ingest endpoint and send `monitor_config` on a run's first `in_progress`. When the job has no entry, they send nothing. This fail-open is deliberate and pinned by tests in `cron-instrumentation.test.ts`; it stays.
- Before this change, `api/__tests__/cron-schedules.test.ts` looped only over the `SCHEDULE_MAP` keys, so a `vercel.json` cron with no entry passed.

## The gap on origin/main (2026-10-29, `1539b764`)

Ten `vercel.json` cron paths had no entry. Each schedule below was copied verbatim from `vercel.json`.

| Job                           | vercel.json schedule (UTC) | Wrapper before this change                                 | maxDuration      | Monitor added                    |
| ----------------------------- | -------------------------- | ---------------------------------------------------------- | ---------------- | -------------------------------- |
| check-gamma-setup-drift       | `45 21 * * 5`              | withCronInstrumentation, `marketHours:false`               | 30 s             | default runtime, threshold 1     |
| backfill-gamma-setup-outcomes | `30 21 * * 1-5`            | withCronInstrumentation, `marketHours:false`               | 120 s            | default runtime, threshold 1     |
| detect-gamma-setups           | `* 13-21 * * 1-5`          | withCronInstrumentation, `requireApiKey:false`             | 30 s             | default runtime, threshold 3     |
| takeit-fill-shap              | `*/2 13-21 * * 1-5`        | withCronInstrumentation                                    | 60 s             | default runtime, threshold 3     |
| wave2-confirmation            | `*/5 13-21 * * 1-5`        | withCronInstrumentation, `requireApiKey:false`             | 60 s             | default runtime, threshold 3     |
| audit-takeit-calibration      | `0 11 * * 1`               | withCronInstrumentation, `marketHours:false`               | 60 s             | default runtime, threshold 1     |
| audit-takeit-health           | `30 23 * * *`              | withCronCheckin                                            | platform default | default runtime, threshold 1     |
| audit-migration-drift         | `0 12 * * *`               | withCronCheckin                                            | platform default | default runtime, threshold 1     |
| cleanup-ws-gex-strike-expiry  | `0 12 * * 1-5`             | none: raw `cronGuard`, no `reportCronRun`, so no Axiom row | 300 s            | LONG_RUNNER runtime, threshold 1 |
| `/api/health`                 | `25 13 * * 1-5`            | none (public endpoint)                                     | —                | exempt (`UNMONITORED_CRONS`)     |

"Default runtime" is `DEFAULT_MAX_RUNTIME` (5 min), "LONG_RUNNER" is `LONG_RUNNER_MAX_RUNTIME` (10 min), and every entry uses `DEFAULT_MARGIN` (5 min). "Threshold 3" is `HIGH_FREQ_FAILURE_THRESHOLD`.

### Why these values

- **UTC, verbatim.** All nine use the `vercel.json` crontab as-is, with no `timezone`. Each tick Vercel fires checks in, either as a live run or as the wrapper's paired skip check-in when the market-hours gate is closed (`DST_TAIL_NOTE`, Layer 1). So the monitor never expects a tick that won't arrive, and the ET-local anchoring (Layer 2) isn't needed. That matches `detect-lottery-fires`, `detect-silent-boom` and `check-cone-breach`.
- **Threshold 3 for the market-hours jobs.** detect-gamma-setups (every minute), takeit-fill-shap (every 2 min) and wave2-confirmation (every 5 min) take the high-frequency policy their siblings use, so a single dropped completion check-in doesn't page.
- **Threshold 1 for everything else.** These run daily or weekly, so one miss is a real signal.
- **cleanup-ws-gex-strike-expiry: LONG_RUNNER, threshold 1.** maxDuration is 300 s, so a run that uses its whole budget needs the 10-min runtime (same rule as `archive-gexbot` and `rollup-ws-gex-strike-expiry`). It runs once a weekday, so a failed sweep isn't retried until the next day. `cleanup-ws-option-trades` uses threshold 2 only because it runs hourly and self-heals.
- **No maxDuration (the two `withCronCheckin` audits).** Both finish in seconds, so `DEFAULT_MAX_RUNTIME` applies, the same as `audit-gexbot-health`.

## Owner decisions (2026-10-29)

1. **Monitor all nine jobs**, including the three that run during market hours: detect-gamma-setups, takeit-fill-shap and wave2-confirmation.
2. **`/api/health` stays exempt.** It returns 503 whenever any dependency is degraded (`api/health.ts`: postgres, redis or the Schwab token), so an expired Schwab token would page the owner at the open. `docs/superpowers/specs/backend-audit-fixes-2026-06-07.md` ("Deliberately NOT changing") had already left it alone, but gave a different reason: "public endpoint anyway; low value". The reason recorded here is the 503 behaviour.
3. **Reversal: the three audit-\* crons get monitors.** `docs/superpowers/specs/migration-drift-audit-cron-2026-05-29.md` (Schedule section) left `audit-migration-drift` out of `SCHEDULE_MAP` only "for consistency" with the sibling `audit-takeit-*` crons, which were also unmonitored. This spec reverses that for all three. Why: the audits are the safety net. If a weekly or daily audit silently stops running, it raises no alert, and nothing else checks it. A missed check-in is the only signal for that failure.

## Phases

Both phases ship in one push; the main session pushes after the 15:00 CT close.

### Phase 1: entries, enforcement test, comments (~1 h)

- `SCHEDULE_MAP` entries for all nine jobs. The cleanup-ws-gex-strike-expiry entry does nothing until Phase 2 wraps its handler, because nothing reads it until then.
- A reverse-direction test in `cron-schedules.test.ts`:
  - It reads raw `vercel.json` `crons[].path`, deduplicated, so paths outside `/api/cron/` count too.
  - Every path needs either a `SCHEDULE_MAP` entry (`/api/cron/<job>` → `<job>`) or an entry in the inline `UNMONITORED_CRONS: Record<string, string>`, keyed by full path, whose value is a reason citing a spec.
  - For each exemption, the test also asserts that it is still in `vercel.json`, that it has no `SCHEDULE_MAP` entry, and that its reason is non-empty and cites a `docs/superpowers/specs/*.md` file that exists.
  - `/api/health` is the only exemption.
- A source scan in the same file (added after review): an entry alone sends nothing, so for every `SCHEDULE_MAP` key, `api/cron/<job>.ts` must pass that job name to `withCronInstrumentation(` or `withCronCheckin(`. The name is read from the call's first argument, either a string literal or a `const JOB = '<job>'` in the same file (six crons name themselves through a constant). Any other mention of the name, such as a `Sentry.setTag`, doesn't count. The coverage test alone was green at the Phase 1 commit while the cleanup job had an entry and no wrapper; the scan fails on that state.
- Fix the stale `cron-schedules.ts` header, which said the map is fed to `Sentry.withMonitor()` / `captureCheckIn()`. Check-ins have been direct HTTP for a while.
- Fix the `cron-instrumentation.ts` comment that said `cron-schedules.test.ts` "catches stale entries the other direction". It now names both directions accurately.

### Phase 2: wrap the cleanup job, fix stale headers (~1 h)

- `api/cron/cleanup-ws-gex-strike-expiry.ts`:
  - Wrap it in `withCronCheckin`, following `api/cron/cleanup-ws-option-trades.ts`.
  - Lower `WALL_BUDGET_MS` from 295 000 to 280 000. The in-progress and completion check-ins (each up to 5 s) then fit inside maxDuration 300 alongside the last batch.
  - No `reportCronRun`: the sibling `cleanup-ws-option-trades.ts` doesn't call it either.
- `api/__tests__/cleanup-ws-gex-strike-expiry.test.ts`: drive the real wrapper with a stubbed `fetch`. Assert the slug, the `monitor_config` schedule, `in_progress → ok` on success, and `in_progress → error` when a DELETE rejects (R4). Also assert that an unauthenticated request sends no check-ins.
- Headers that disagree with `vercel.json`:
  - `api/cron/backfill-gamma-setup-outcomes.ts` says 20:30 UTC; vercel.json says 21:30.
  - `api/cron/check-gamma-setup-drift.ts` says Friday 21:30 UTC; vercel.json says 21:45.

### Review follow-ups (2026-10-29)

The code review of both phases returned "continue". Beyond the source scan and the cited-spec existence check (Phase 1 bullets above), it led to three fixes:

- **Cleanup budget is checked before every batch (item 2).** cleanup-ws-gex-strike-expiry checked its budget only after a non-empty batch, so a pass 1 that drained late went straight into pass 2's first DELETE past 280 s. A run killed at maxDuration now pages as a monitor timeout at threshold 1. It now uses the predictive rule from `cleanup-ws-option-trades`: before every batch after the first, pass 2's first included, stop when elapsed time plus the slowest batch so far would pass 280 s. Tests pin both sides of the rule (a projection of 279.5 s runs the next batch, 280.5 s stops) and the pass boundary (a pass 1 ending at 281 s runs no pass 2 DELETE).
- **No UW key for two crons that never use UW (item 4).** `takeit-fill-shap` (sidecar only) and `audit-takeit-calibration` (DB only) took `cronGuard`'s default `requireApiKey: true`. Once monitored, a missing or rotated `UW_API_KEY` would 500 in `cronGuard` before the check-in and page a missed run for a dependency they don't have. Both now pass `requireApiKey: false`, like detect-gamma-setups and wave2-confirmation.
- **backfill-gamma-setup-outcomes retries the last two _trading_ days (item 5, bug fix).** Its header promised the last two trading days, but the query bound was `fired_at >= NOW() - 2 days` (calendar). At Monday's 21:30 UTC run that bound was Saturday 21:30 UTC, so Friday's unresolved fires were never retried; the same after any holiday. The bound is now ET midnight of the earlier of the last two trading days on or before the run's ET date, from `isTradingDay` / `priorTradingDay` in `src/data/marketHours.ts` (the NYSE calendar in `MARKET_CLOSED_DATES`):
  - Monday → Friday.
  - Tuesday after Memorial Day → the Friday before.
  - Memorial Day itself (the cron still fires) → Thursday.
  - An ordinary Wednesday → Tuesday, the same two sessions the old bound held, since Monday 21:30 UTC is after Monday's close.

  The Axiom metadata `lookback_days: 2` became `lookback_trading_days: 2` plus `window_start`.
  - **History.** Fires from before the deploy that the old window skipped stay unresolved: the fixed cron only reaches back two trading days. Neither table is pruned (no DELETE on `ws_gamma_setup_fires` or `index_candles_1m` anywhere in `api/` or `scripts/`), so a one-off backfill can resolve any of them whose SPX bars exist. The read-only production count of affected fires wasn't run in this session (production reads need the owner's permission). The probe and a backfill UPDATE that mirrors the handler's per-row logic are in the session report.

## Files

| Phase  | File                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 1      | `docs/superpowers/specs/cron-monitor-coverage-2026-10-29.md` (this file)                                |
| 1      | `api/_lib/cron-schedules.ts`                                                                            |
| 1      | `api/__tests__/cron-schedules.test.ts`                                                                  |
| 1      | `api/_lib/cron-instrumentation.ts` (comment only)                                                       |
| 2      | `api/cron/cleanup-ws-gex-strike-expiry.ts`                                                              |
| 2      | `api/__tests__/cleanup-ws-gex-strike-expiry.test.ts`                                                    |
| 2      | `api/cron/backfill-gamma-setup-outcomes.ts`, `api/cron/check-gamma-setup-drift.ts` (header comments)    |
| Review | `docs/superpowers/specs/migration-drift-audit-cron-2026-05-29.md` (superseded note)                     |
| Review | `api/cron/takeit-fill-shap.ts`, `api/cron/audit-takeit-calibration.ts` and their tests                  |
| Review | `api/cron/backfill-gamma-setup-outcomes.ts`, `api/__tests__/cron-backfill-gamma-setup-outcomes.test.ts` |

## Data dependencies

None. No tables, migrations, env vars or external APIs. The new monitors are created in Sentry by the first `in_progress` check-in that carries `monitor_config` (an upsert), and they read the existing `SENTRY_DSN`.

## Thresholds and constants

- `DEFAULT_MARGIN` 5 min, `DEFAULT_MAX_RUNTIME` 5 min, `LONG_RUNNER_MAX_RUNTIME` 10 min, `HIGH_FREQ_FAILURE_THRESHOLD` 3, all existing.
- cleanup-ws-gex-strike-expiry `WALL_BUDGET_MS`: 295 000 → 280 000 ms, checked before each batch as elapsed + slowest batch so far.
- backfill-gamma-setup-outcomes `BACKFILL_TRADING_DAYS` 2 (was `BACKFILL_LOOKBACK_DAYS` 2 calendar days).

## Open questions

- Historical gamma-setup outcomes: run the read-only count of fires the old window skipped, then the one-off backfill (see History under the review follow-ups).
- Possible follow-up: neither `cleanup-ws-*` cron calls `reportCronRun`, so neither leaves an Axiom row. That matches the sibling and is out of scope here.
