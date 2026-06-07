# Flow Regime Recognition Badge — 2026-06-06

## Goal

A live badge that scores the **current** intraday options flow against the **same
time-of-day bucket historically**, surfacing in real time when today's flow is
abnormally bearish/bullish *for that time of day*. **Recognition only — NOT a
predictor.** The 106-day point-in-time backtest (see
[[project_0dte_put_share_downday_signal]] / `docs/tmp/intraday-1min-panel.parquet`)
showed options flow has **no forward edge** at any granularity; it is intraday-
*coincident*. The badge tells you "this is an abnormal-flow day, as it forms"
(useful for sizing / not fighting the tape), it does NOT forecast direction. The
UI copy must say so — no predictive language.

## What it computes

Two detrend-robust **ratio** metrics per intraday bucket (30-min; 13 slots/RTH):

- **net_delta_tilt** = Σ(side_sign · delta · size) / Σ(|delta| · size).
  side_sign = +1 buyer-initiated (ask), −1 seller-initiated (bid), 0 mid/none.
  Negative ⇒ aggressors net-short delta (bearish). Trend-robust (a ratio).
- **idx0dte_put_share** = Σ(premium | 0DTE index put) / Σ(premium).
  premium = price · size · 100. index = (SPXW,NDXP,SPY,QQQ,IWM) ∩ WS universe.
  0DTE = expiry == ET trade date.

Each bucket is scored as a **percentile vs the SAME slot across all PRIOR days**
(point-in-time, expanding, no lookahead). Low net_delta_tilt percentile and high
idx0dte_put_share percentile = "abnormally bearish for this time of day."

## Architecture — live vs baseline (the load-bearing decision)

- **Live current-bucket value:** read from Neon `ws_option_trades` (rolling 2-day
  window; has `side`, `delta`, `option_type`, `strike`, `expiry`,
  `underlying_price`, `size`, `ticker`). Stream covers the ~50-ticker Lottery
  universe; began 2026-06-02.
- **Historical baseline:** the WS live table rolls off to **parquet in Vercel
  Blob** (same universe + same schema as live) — this is the production-consistent
  historical source. Baseline = per-(slot, metric) distribution computed from the
  Blob WS-archive.
- **Depth bootstrap:** the Blob WS-archive is thin now (~4 days). For immediate
  depth, bootstrap the baseline from the 106-day Desktop full-tape
  (`~/Desktop/Eod-Full-Tape-parquet/`) **restricted to the WS universe + matched
  metric defs** — the full-tape contains the SAME option_trades, just unfiltered,
  so restricted-to-universe ≈ the WS archive. VALIDATE by comparing the two on the
  overlapping days (06-02..06-05); if they match, use the deep restricted full-tape
  for the initial baseline and transition to the Blob archive as it accumulates.
- **Consistency rule (critical):** baseline and live MUST use the identical ticker
  universe, the identical side_sign mapping, and premium = price·size·100. A
  mismatch makes the percentiles meaningless.

## Phases

### Phase 1 — Baseline artifact + pure evaluator (offline + lib)
- **Verify first:** exact `ws_option_trades.side` string values → side_sign map;
  the WS ticker universe (uw-stream `_LOTTERY_TICKERS`) and which index symbols are
  in it; the Blob WS-archive path/format (the roll-off destination).
- **Create** `scripts/build-flow-regime-baseline.py`: from the universe-restricted
  full-tape (and/or Blob WS-archive), compute per (slot, metric) the historical
  distribution as compact **percentile breakpoints** (e.g. deciles/percentile
  grid) → write `api/_lib/flow-regime-baseline.json` (small, committed). Validate
  full-tape-restricted vs WS-archive on overlapping days; log the comparison.
- **Create** `api/_lib/flow-regime.ts` (pure): given current-bucket component sums
  + the baseline for the active slot → `{ net_delta_tilt, idx0dte_put_share,
  nd_percentile, idxput_percentile, regime: 'normal'|'caution'|'bearish'|'bullish',
  color }`. No I/O. Unit-tested with a table of inputs.

### Phase 2 — Live compute (migration + cron + endpoint)
- **Migration** (`db-migrations.ts` + `db.test.ts`): `flow_regime_snapshots`
  (date, slot, computed_at, metrics + percentiles + regime, UNIQUE(date,slot),
  ON CONFLICT upsert). New-table-in-migrateDb convention.
- **Cron** `api/cron/capture-flow-regime.ts`: `withCronInstrumentation(...,
  {marketHours:true, requireApiKey:false})`; every 5 min reads the CURRENT 30-min
  bucket from `ws_option_trades`, computes component sums, calls the evaluator with
  the baseline, upserts the snapshot. Register in `vercel.json`.
- **Endpoint** `api/flow-regime.ts`: `guardOwnerOrGuestEndpoint`; serves the latest
  snapshot (+ today's slot series); `setCacheHeaders(res, 15, 15)`; if it calls
  `checkBot`, add to `initBotId` protect list in `src/main.tsx`. Tests: cron
  auth+happy-path (mock getDb), endpoint shape.

### Phase 3 — Frontend badge
- Mirror `PreTradeSignals`: a classifier + `SignalCard`/`SectionBox` badge in
  `MarketRegimeSection` showing the current regime (color + "Nth pctile bearish
  for this time" + explicit "recognition, not a forecast" tooltip).
- **Hook** `src/hooks/useFlowRegime.ts` via `useFetchedData`, gated on `marketOpen`,
  `POLL_INTERVALS` cadence (~60s). Tests: render + classifier states.

### Phase Verification (LAST)
- `npm run review` green; baseline-validation log shows full-tape-restricted ≈
  WS-archive; one live cron run writes a snapshot; badge renders the current slot.

## Thresholds / constants
- Bucket = 30 min (matches the analysis; signal/noise balance). Slots = (mod−570)//30.
- Regime colors (recognition, tunable): nd_percentile ≤10 OR idxput ≥90 → bearish
  (red); ≤25 / ≥75 → caution; mid → normal; ≥90 nd / ≤10 idxput → bullish (green).
- min prior days per slot for a valid percentile: ≥15.

## Open questions (defaults noted)
1. Exact `side` values (verify Phase 1; default map ask→+1/bid→−1/else 0).
2. Blob WS-archive path + format (verify Phase 1) — needed for prod baseline refresh.
3. Baseline refresh cadence: regenerate weekly as Blob days accumulate (script;
   automate later). Default: manual/script for now.
4. Single metric or both in the badge? Default: show both, color by the more-extreme.

## Files
- **Create:** `scripts/build-flow-regime-baseline.py`, `api/_lib/flow-regime.ts`,
  `api/_lib/flow-regime-baseline.json`, `api/cron/capture-flow-regime.ts`,
  `api/flow-regime.ts`, `src/hooks/useFlowRegime.ts`, frontend badge component +
  classifier, tests for each.
- **Modify:** `api/_lib/db-migrations.ts` (+ `api/__tests__/db.test.ts`),
  `vercel.json` (cron), `src/components/MarketRegimeSection.tsx` (wire badge),
  `src/main.tsx` (botid protect if needed).
