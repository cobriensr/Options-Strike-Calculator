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

### Phase 3 — Sidecar schema expansion (L1 live) ✅ SHIPPED 2026-04-18

**What shipped:** `tbbo` live stream for ES on GLBX.MDP3 — single
schema gives trade events + pre-trade BBO in one stream (superset
of what mbp-1/bbo-1s/trades would have given separately). See
`docs/superpowers/specs/phase2a-sidecar-l1-ingest-2026-04-18.md`
and `phase2b-microstructure-signals-2026-04-18.md`.

**Deviation from original plan:** shipped TBBO-only rather than the
mbp-1 + tbbo + bbo-1s + trades combo originally listed. Reason: TBBO
emits an MBP1Msg on every trade with `levels[0]` carrying the
pre-trade BBO, so subscribing to multiple schemas would have
delivered duplicate trade events. Single subscription, same signal
surface, cleaner dispatch. Critical bug caught during code review:
rtype cannot distinguish MBP-1 and TBBO (both emit rtype=1), which
would have silently broken the original multi-schema design.

**Live tables:** `futures_top_of_book` + `futures_trade_ticks` both
populating on Railway sidecar. Compute layer (`microstructure-signals.ts`)
reads them on every analyze call and injects OFI/spread-widening/TOB-pressure
into Claude's context.

### Phase 4 — Historical L1 backfill + ML features 🟡 IN PROGRESS

**Sub-phase status:**

- **4a — Converter (TBBO DBN → Parquet):** ✅ SHIPPED 2026-04-18.
  See `phase3a-tbbo-convert-2026-04-18.md`. Commits `9d51ab6` +
  `1b75643`. 210.6M rows / 16 instruments / 3.9GB Parquet at
  `ml/data/archive/tbbo/year={2025,2026}/part.parquet`. Sidecar:
  `ml/src/tbbo_convert.py`.
- **4b — Blob upload + Railway seed + sidecar DuckDB queries:**
  ⏸️ PAUSED. Would extend `upload-archive-to-blob.mjs`,
  `archive_seeder.py`, `archive_query.py` — all files a parallel
  session is actively editing for day-embeddings work. Coming back
  once that settles OR once Phase 4c proves signal value and we
  want Claude runtime access.
- **4c — ML feature engineering on local Parquet:** NOT STARTED.
  `ml/src/features/microstructure.py` — rolling OFI, spread widening
  events, TOB pressure persistence, tick velocity. Runs against local
  `ml/data/archive/tbbo/` via DuckDB; doesn't need Railway.
- **4d — EDA / signal validation:** NOT STARTED. matplotlib plots +
  correlation analysis proving features have signal before training.

**Why 4b is paused:** validate signal in 4c/4d before spending effort
on Railway distribution. If the microstructure features don't improve
regime prediction, we don't need to ship them to production; the
local Parquet is enough for research.

**Original scope pivots:**

- Requested MBP-1 originally but the Databento bulk tool quoted
  **2.3 TB** for 1 year ES+NQ. Pivoted to TBBO which is ~5 GB DBN,
  ~4 GB Parquet. TBBO is a strict subset of MBP-1 (trade events
  only, no between-trade quote updates). Adequate for the features
  Phase 2b computes today; if richer features require between-trade
  quotes later, revisit MBP-1 with a shorter window.
- ES futures options dropped from the request. Existing 17-year
  OHLCV-1m archive covers options adequately.

**Next to do:** 4c (feature engineering), then 4d (EDA validation),
then consider 4b (Railway distribution).

**Rough remaining effort:** 4c ~4h, 4d ~2-3h, 4b ~6-8h (when resumed).

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
