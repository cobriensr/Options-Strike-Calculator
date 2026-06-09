# Sentry + Railway Triage Fixes — 2026-06-08

**Goal:** Close the actionable issues surfaced by the 2026-06-08 Sentry/Railway
review: the Neon 64MB 507 crash in the flow-regime crons, the classifier
open-window OOM restarts, and the four chronic "missed" cron monitors.

Branch: `fix/sentry-railway-2026-06-08` (isolated worktree).

## Context (from the 24–48h review)

One active market day in the window (Mon 06-08). Distinct findings:

- **EB/EE/E9/ED** — `NeonDbError 507 "response too large (64MB)"` in
  `capture-flow-regime` and `capture-flow-regime-daily`. Root cause verified:
  both crons `SELECT` raw `ws_option_trades` rows for a time window and reduce
  them in JS via `computeFlowMetrics`. With the full ~50-ticker uw-stream
  `option_trades` universe now writing, 30 min (live) / full-day (daily) of rows
  serialize past Neon's serverless HTTP 64MB cap → 507 → cron aborts → no
  check-in → the E9/ED "cron failure" monitor events are **downstream symptoms**.
- **8Q/EA + Railway classifier** — classifier returns `sidecar_non_2xx` /
  `high_null_rate` and silently OOM-restarts (~16×) clustered 13:31–14:09 UTC =
  the market open. The 06-06 concurrency 4→2 + cap-500K fix improved
  *reachability* (`sidecar_unreachable` 2770→1) but the service still falls over
  under open-window load. `classifier/railway.toml` sets no memory limit and no
  Railway healthcheck.
- **9B/B3/8S/96** — four high-freq market-hours crons accumulate hundreds of
  "missed" check-in events. They ALREADY use `withCronInstrumentation` (direct
  HTTP check-in) and ALREADY carry `failureIssueThreshold: 3`. Root cause is NOT
  a simple config gap — needs real check-in-history diagnosis before tuning, or
  we risk masking a genuine market-hours outage.

## Phases

### Phase 1 — Flow-regime crons: aggregate in SQL (HIGH priority)

Push the metric reduction into Postgres so the crons return scalar component
sums instead of streaming raw rows. The SQL MUST mirror `build_neon_metrics` in
`scripts/build-flow-regime-baseline.py` (already validated to match
`computeFlowMetrics`) so the **consistency rule** holds — same universe,
side_sign map, premium = price·size·100, 0DTE index-put test.

**Files:**
- `api/cron/capture-flow-regime.ts` — replace raw-row read + `toFlowTradeRow` +
  `computeFlowMetrics` with one aggregation query returning
  `{ n_trades, nd_num, nd_den, idx_put_premium, total_premium }`; feed sums
  straight into `evaluateFlowRegime`.
- `api/cron/capture-flow-regime-daily.ts` — replace `accumulateDate`'s raw read
  + `accumulateDailySlots` with one `GROUP BY slot` aggregation query.
- `api/_lib/flow-regime-rows.ts` — add a shared SQL-aggregation helper (the
  universe/index/side-map → SQL expressions) so both crons stay byte-consistent;
  keep `computeFlowMetrics`/`accumulateDailySlots` for the unit tests + offline
  parity.
- Tests: `api/__tests__/` cron tests updated for the new single-query shape;
  a parity unit test asserting the SQL-shaped sums equal `computeFlowMetrics`
  on a fixture (run the reducer over the same fixture rows the SQL would group).

**Consistency invariants (do not break):**
- universe filter on ALL sums; `n_trades = count(*)` over the time window with
  NO universe filter (matches current `rows.length` / `bucket.length`).
- `side_sign = CASE side WHEN 'ask' THEN 1 WHEN 'bid' THEN -1 ELSE 0 END`.
- `delta::double precision` (NULL skipped by SUM = 0 contribution, matches
  JS null→0); `premium = price::double precision * size * 100`.
- idx-put numerator: `ticker = ANY(index_set) AND option_type = 'P' AND
  expiry = <ET trade date>::date`.
- live cron: window = the in-progress slot; daily cron: per-slot `GROUP BY`,
  slot via `(extract(hour)*60+extract(minute) - 570)/30` on the ET-localized
  `executed_at`, bounded `0 <= slot < 13`.

### Phase 2 — Classifier OOM hardening (MEDIUM priority)

**Files:**
- `classifier/railway.toml` — add an explicit memory `limitOverride` and a
  Railway `healthcheckPath = "/health"` so OOM is deterministic/observable and
  Railway (not just the kernel) can recycle unhealthy instances.
- Investigate `classifier/src/multileg_routes.py` + `_vendored_ml` for a tighter
  per-request peak-memory bound at the open (the 500K cap is per cross-join; the
  open burst stacks concurrent requests). Apply only a low-risk bound if clearly
  warranted; otherwise rely on the memory ceiling + healthcheck and document.
- Tests: classifier pytest suite stays green; add coverage if a code path
  changes.

### Phase 3 — Missed-cron monitors: diagnose then fix (MEDIUM priority)

DO NOT blindly tune. First pull the real Sentry check-in history for the four
monitors to classify the failure as platform-skip (Vercel didn't invoke) vs
slow-run (exceeds maxRuntime) vs handler-fail. Then apply the correct targeted
fix in `api/_lib/cron-schedules.ts` (margin/runtime/threshold) — preferring the
change that silences platform noise WITHOUT masking a true 3+-window outage.

**Files:**
- `api/_lib/cron-schedules.ts` (+ its cross-check test) — only the four entries.

## Open questions / defaults

- Classifier memory ceiling value: default to a conservative bump (e.g. match
  sidecar's headroom pattern) unless Railway metrics show a specific peak.
- Phase 3 fix shape depends on the check-in diagnosis; default to widening
  `checkinMargin` (reversible, alerting-only) if the data shows platform skips.

## Verification

`npm run review` (tsc + eslint + prettier + vitest --coverage) green; classifier
`pytest` green; code-reviewer subagent pass per phase before commit.
