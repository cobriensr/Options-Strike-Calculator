# Maximum Leverage — Databento Standard + UW — 2026-04-18

## Goal

Exhaust the signal value of existing data sources (Databento Standard
$179/mo, UW API, Schwab) before spending another dollar on new
subscriptions. Build out five phases of analytical depth and live
microstructure signals using only schemas + endpoints already paid for.

## Strategic context

- **Current spend:** $179/mo Databento CME Standard, UW API subscription.
- **Ruled out:** $199/mo Databento CFE add-on (borderline ROI;
  synthesizable from ES options IV).
- **Ruled out:** ThetaData (localhost architecture, no futures; defer
  until backtesting becomes a priority).
- **Ruled in:** everything you can build on data you already pay for.

## Constraints

- **Live L2/L3 (`mbp-10`, `mbo`) is NOT in Standard tier.** Do not wire
  these into the live sidecar. Use the 1-month rolling L2/L3 historical
  window for research only.
- **Live L1 (`mbp-1`, `tbbo`, `bbo-1s`) IS in Standard.** Fair game
  for sidecar live streaming.
- **Core schemas (`trades`, `ohlcv-*`, `definition`, `statistics`,
  `status`) live — covered.
- **15+ years core historical, 1 year L1 historical** included — fair
  game for any backfill we want.

## Phases

Each phase is independently shippable and goes through the project's
Get It Right loop. Most phases will get their own sub-spec in
`docs/superpowers/specs/` when picked up.

### Phase 1 — ES options IV term structure in analyze context ✅ ALREADY SHIPPED

**Status:** Pre-existing. `api/iv-term-structure.ts` already pulls
interpolated SPX IV term structure from UW
(`/api/stock/SPX/interpolated-iv`), classifies shape (CONTANGO, FLAT,
INVERTED, STEEP INVERSION), and injects into the analyze context at
`analyze-context-fetchers.ts:307`. SPX-native is actually preferable
to ES-options synthesis for our trading vehicle.

**Implication:** the VX term structure signal we were going to spend
$199/mo on is already covered for SPX via UW data. The CFE upgrade
decision is de-prioritized further.

### Phase 2 — Cross-asset composite + volume profile + VIX/SPX divergence

**Scope:** three analytical layers on data already in `futures_bars`
and SPX candles:

- Cross-asset risk regime: `(ES_ret + NQ_ret) / (ZN_ret - GC_ret)` +
  ES/NQ divergence + CL spike flag.
- Volume profile per trading day: POC, VAH, VAL from `futures_bars`.
- VIX spot / SPX divergence: 5-min returns, alert when
  `abs(VIX_ret) > 3% AND abs(SPX_ret) < 0.1%`.

**Why:** all pure analysis on existing data; tripling the information
Claude has at analyze-time, zero new schemas.

**Files:** `api/_lib/analyze-context.ts`, new computation helpers,
tests. Possibly a new `VolRegime` tile for the UI.

**Rough effort:** 6-8 hours.

### Phase 3 — Sidecar schema expansion (L1 live)

**Scope:** add live subscriptions in the sidecar for:

- `mbp-1` on ES (+ NQ optionally) — top-of-book bid/ask + sizes
- `tbbo` on ES — trade-with-book-before (aggressor classification)
- `bbo-1s` on ES — 1-second quote snapshots (spread widening detection)
- `trades` on ES (if not already) — tick data for microstructure

**New DB tables:**
- `futures_top_of_book` — MBP-1 events (symbol, ts, bid, bid_size,
  ask, ask_size)
- `futures_trade_ticks` — TBBO events (symbol, ts, price, size,
  aggressor_side)

**Compute layer:** crons or a new cron that runs every 5 min to
compute:
- Order flow imbalance (OFI) — rolling 1-min + 5-min
- Spread widening z-score — rolling vs 30-min baseline
- Top-of-book pressure ratio — `bid_size / ask_size`

**Why:** unlocks the Tier 1 leading indicators (spread widening,
OFI) as live signals — genuinely predictive, not just confirming.

**Files:** `sidecar/src/main.py`, `sidecar/src/db.py`,
`sidecar/src/trade_processor.py`, new cron `api/cron/compute-microstructure.ts`,
new migration, tests.

**Rough effort:** 12-16 hours (largest phase).

### Phase 4 — Historical L1 backfill + ML features

**Scope:** backfill 1 year of ES `mbp-1` + `tbbo` via Databento
Historical client into the new tables from Phase 3. Engineer
microstructure features in `ml/` for inclusion in regime-classifier
training.

**Features to engineer:**
- 1-min OFI means + tails
- Spread widening events per day
- Quote-stuffing detection
- Depth-weighted midpoint drift

**Why:** once Phase 3 is running live, backfilling gives the ML
pipeline a year of microstructure history to correlate with trade
outcomes. Phase 3's signals become more powerful with trained
priors.

**Files:** `scripts/backfill-mbp1-tbbo.ts` (or `.py`), `ml/src/features/microstructure.py`,
`ml/.venv/bin/python` pipelines, experiments.

**Rough effort:** 8-12 hours.

### Phase 5 — UW data deep leverage

**Scope:** enrich existing UW integrations with rate-of-change and
cumulative signals:

- Dark pool velocity (prints per 5-min window, not just levels)
- GEX intraday delta (`GEX_now − GEX_open`) — regime strengthening or
  weakening
- Whale flow net positioning (cumulative call − put premium over the day)
- ETF tide rate of change + cross-ETF divergence (SPY vs QQQ tide)

**Why:** UW provides the data but most consumption is "point-in-time
level" — the deltas and cumulative summaries are where the predictive
value lives.

**Files:** `api/_lib/analyze-context.ts`, UW helper modules in
`api/_lib/`, possibly new crons to snapshot UW values at fixed
intervals.

**Rough effort:** 6-8 hours.

## Phase order decision

Phase 1 first (highest leverage, smallest scope, proves ROI of the
whole program). Phase 2 next (analysis on existing data, no schema
changes). Phase 3 is the biggest chunk and gates Phase 4. Phase 5
can interleave with any phase — not dependent on schema work.

## Done when

- Phase 1: analyze output references ES IV term structure state on
  every request. Tests pass.
- Phase 2: analyze output references cross-asset regime + volume
  profile levels. VIX/SPX divergence alert fires on mock data in
  tests.
- Phase 3: sidecar streams MBP-1 + TBBO live; new DB tables populate
  during market hours; OFI + spread-widening signals visible in a
  new endpoint or the analyze context.
- Phase 4: ML pipeline has microstructure features; at least one
  experiment run in `ml/experiments/` showing feature importances.
- Phase 5: analyze context has at least four new UW-derived delta
  signals; composite signal shifts Claude's recommendations
  measurably on replay.

## Notes

- Every phase gets the full project Get It Right loop (implement →
  verify → review subagent → act).
- For Phase 3 onwards, write a phase-specific spec in
  `docs/superpowers/specs/` before starting.
- Revisit the CFE $199/mo decision only after Phase 1 ships — if ES
  IV term structure proves materially useful and you want intraday
  granularity you can't synthesize, then it's worth reopening.
- Phase 4 requires Databento historical usage — 1 year of MBP-1 for
  ES runs ~$40-80 depending on contract (cheap vs the $2,388/yr CFE
  alternative).
- All phases respect the $179/mo Standard tier. No upgrades.
