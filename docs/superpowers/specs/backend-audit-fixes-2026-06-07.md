# Backend Audit Fixes — 2026-06-07

## Goal

Fix the bugs and stability issues surfaced by the 6-agent backend audit (cron system,
DB layer, analyze endpoint, security, silent failures, Python sidecar). Theme: eliminate
"silent green" — crons returning success on total failure, the analyze endpoint returning
200 on empty output, and feature/context paths swallowing errors with no Sentry signal.

## Execution

Subagent-driven, one code-reviewer subagent per phase (per `feedback_per_phase_loop`).
Branch `fix/backend-audit-2026-06-07` → PR. Tests ship with every code change.
Implementers run sequentially (shared working tree). Each phase ≤5 files.

## Verified facts (pre-flight)

- `neonDateStr(v)` exists in `api/_lib/db-date.ts` → use for C2.
- `withDbRetry<T>()` exists in `api/_lib/db.ts:132` → use for H7.
- `market_snapshots` has `created_at TIMESTAMPTZ` + `id` → use for M1 chronological sort.
- `cronGuard` default is `marketHours: true` (`cron-helpers.ts:186`) → confirms C1.
- `getGreekExposure(date, ticker)` has no `asOf` cutoff → confirms H3.

## Phases

### Phase 1 — Cron schedule & config (config-heavy, low risk)
- **C1**: `audit-takeit-calibration.ts:340` — add `{ marketHours: false }` so the weekly
  07:00 ET calibration cron actually runs (currently always skipped).
- **H6**: Remove the three dead GEXBot schedule-3 entries in `vercel.json`
  (`fetch-gexbot-fast`, `fetch-gexbot-strikes`, `populate-periscope-from-gexbot` fire at
  21:xx UTC but `isFuturesRthCt` closes 20:55 UTC). Also trim the `20:56–20:59` tail on the
  schedule-2 entries.
- **M8**: Move one of the triple-booked `3,8,13,…` UW crons (`fetch-strike-exposure` /
  `fetch-strike-all` / `fetch-greek-flow`) to a free offset to spread UW rate pressure.
- **embed-yesterday**: replace ignored module-level `export const config = { maxDuration }`
  with a `vercel.json` `functions{}` entry.
- Files: `api/cron/audit-takeit-calibration.ts`, `vercel.json`, `api/cron/embed-yesterday.ts`, tests.

### Phase 2 — Neon DATE type bug (C2)
- `db-flow.ts` `getGreekExposure`: `expiry: neonDateStr(r.expiry)` instead of `as string`;
  null-guard `call_charm/put_charm/call_delta/put_delta/call_vanna/put_vanna` (currently
  `Number(null) === 0` fabricates zeros).
- `max-pain.ts:97-139`: comparisons now work against normalized `YYYY-MM-DD` strings.
- `formatGreekExposureForClaude` in `db-flow.ts`: verify date label renders correctly.
- Files: `api/_lib/db-flow.ts`, `api/_lib/max-pain.ts`, tests.

### Phase 3 — DB retry + snapshot sort (H7, M1)
- Wrap reads/writes in `withDbRetry` in `db-snapshots.ts`, `db-analyses.ts`, `db-positions.ts`.
- `db-snapshots.ts:264`: `ORDER BY created_at ASC` (or `id ASC`) instead of TEXT `entry_time`.
- Files: `db-snapshots.ts`, `db-analyses.ts`, `db-positions.ts`, tests.

### Phase 4 — Cron silent-success hardening (H4)
- `fetch-etf-tide.ts`, `fetch-net-flow.ts`: count failures; return `error`/`partial` instead
  of unconditional `success`.
- `fetch-etf-candles-1m.ts`, `fetch-vol-surface.ts`, `fetch-greek-flow-etf.ts`: replace bare
  `Promise.all` over external fetches with `Promise.allSettled`; handle rejected legs.
- Files: the 5 crons above, tests.

### Phase 5 — Sentry-capture gaps (H5 partial + Low)
- `analyze-context.ts`: import `Sentry`, add `captureException` to the 6 swallowing catches.
- `fetch-net-flow-history.ts`: add Sentry capture on per-ticker errors.
- `build-features-phase2.ts`: add Sentry capture to the 5 feature-extraction catches.
- `alerts.ts`: add Sentry capture to the Twilio network-throw path.
- Files: `analyze-context.ts`, `fetch-net-flow-history.ts`, `build-features-phase2.ts`, `alerts.ts`, tests.

### Phase 6 — Analyze endpoint correctness (H3, M2, M3)
- **H3**: add `asOf` to `getGreekExposure` and `getNetGexHeatmap` (`db-strike-helpers.ts`);
  thread it from `analyze-context-fetchers.ts`.
- **M2**: give `runAnalysisPreCheck` an independent timeout (`Promise.race`).
- **M3**: treat empty Claude `text` as a 502 (so the frontend retry fires) + Sentry.
- Files: `analyze.ts`, `db-flow.ts`, `db-strike-helpers.ts`, `analyze-context-fetchers.ts`, tests.

### Phase 7 — Security hardening (M4, M5, M6, guest-key)
- `positions.ts`: stop leaking raw `err.message`; validate `?date=` as `YYYY-MM-DD`.
- `bulk-upsert.ts`: identifier allowlist regex on table/column names.
- `sentry.ts`: scrub `event.request.cookies` (sc-owner/sc-guest).
- `guest-auth.ts`: constant-length compare to remove key-length timing side-channel.
- Files: `positions.ts`, `bulk-upsert.ts`, `sentry.ts`, `guest-auth.ts`, tests.

### Phase 8 — Sidecar memory leak (M7)
- `sidecar/src/options_router.py`: prune past-expiry entries from `option_definitions`
  (unbounded growth + reconnect reseed). pytest under `sidecar/tests/`.
- Files: `sidecar/src/options_router.py`, sidecar test.

## Deliberately NOT changing
- Single-owner plaintext cookie, public data reads, OWNER_SECRET empty in prod — intentional.
- `/api/health` as a cron entry — public endpoint anyway; low value, leaving as-is.
- Sidecar non-idempotent TBBO writes, keepalive-ping framing — documented/tolerated.
- The split-system-prompt cache design — correct as-is.

## Verification
`npm run review` (tsc + eslint + prettier + vitest --coverage) green before PR.
Sidecar: `cd sidecar && python -m pytest` for Phase 8.
