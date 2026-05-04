# NQ Flow Leadership Analysis — 2026-05-02

**v2 — simplified to forward-return correlation per user feedback.**

Empirical investigation: which options-flow signatures (QQQ, SPY, SPX,
SPXW, NDX, NDXP) lead NQ futures returns at intraday horizons? Output
is a ranked correlation table — no a-priori event definitions, no
user-supplied thresholds. Same analysis shape as the validated NQ OFI
ρ=0.31 finding (`ml/docs/MICROSTRUCTURE-OFI-FINDING.md`).

This is research, not a production feature.

## Goal

Answer two questions empirically using 15 trading days
(2026-04-13 → 2026-05-01) of full UW EOD options trades parquet:

- **Question A** — across all flow features × all 6 predictor tickers ×
  all forward horizons, which combinations show meaningful Spearman
  rank correlation with forward NQ returns?
- **Question B** — do SPX-complex tickers (SPX, SPXW, SPY) rank higher
  or lower than NDX-complex tickers (NDX, NDXP, QQQ) in predictive
  power for NQ? This empirically resolves the "should I switch from
  NQ→ES" tooling question with data instead of intuition.

## Methodology principle

**No user-defined thresholds.** Any quantile, threshold, or boundary
needed (e.g. "what counts as a strong correlation") is derived from
the empirical NQ return distribution, never from the analyst or
user's prior. The user explicitly chose this framing to avoid baking
hypothesis confirmation into the analysis.

## Source data on hand

- **Options trades parquet** — `/Users/charlesobrien/Desktop/Bot-Eod-parquet/`
  - 15 files, ~10.3M rows/day, 30 cols
  - Cols include: `executed_at` (UTC µs), `underlying_symbol`, `side`
    (bid/ask = tape-side aggression), `strike`, `option_type`,
    `expiry`, `underlying_price`, NBBO + EWMA NBBO, `price`, `size`,
    `premium`, `volume`, `open_interest`, `iv`, full greeks
    (delta/theta/gamma/vega/rho), `theo`, `report_flags`,
    `upstream_condition_detail`
- **NQ minute bars** — sourced live from Neon Postgres (sidecar writes
  futures bars in real time). Confirmed Phase 0 task: query
  `futures_*` tables for NQ Apr 13 → May 1 2026.
- **Existing infra** — `ml/src/eod_flow_*.py` (~10 modules),
  `flow_outcomes.py`, `microstructure_eda.py`. Build on top.

## Predictor ticker universe

Six tickers split into two arms for Question B comparison:

- **NDX-complex** (direct NQ proxies): `NDX`, `NDXP`, `QQQ`
- **SPX-complex** (cross-correlation play): `SPX`, `SPXW`, `SPY`

`NDXP` existence in the parquet must be confirmed in Phase 0 — it's
PM-settled NDX and may be sparse compared to NDX.

## Open questions / decisions needed

Reduced from 7 to 3 after v1 simplification.

1. **Look-back window for flow features** — features are minute-bucketed,
   but signal might live in 1m / 5m / 15m / 30m rolling windows.
   - **Default pick**: compute features at all four windows, let
     correlation rank reveal which is meaningful per (feature × ticker).
2. **Forward NQ return horizons** — at what horizons is correlation
   measured?
   - **Default pick**: 5 / 15 / 30 / 60 minutes forward.
3. **Time-of-day stratification** — flow leadership is unlikely to be
   uniform across the session.
   - **Default pick**: stratify analysis across Open (8:30–9:30 CT),
     Morning (9:30–11:00), Lunch (11:00–13:00), PM (13:00–14:30),
     Power Hour (14:30–15:00). A correlation that only appears in one
     bucket is more credible than one that appears uniformly across all
     (uniform = potential leakage per `feedback_uniform_lift_is_leakage.md`).

## Design

Five phases. Each independently shippable; verification at end of each.

### Phase 0 — Data infra (1–2 hr)

- Query Neon Postgres for NQ minute bars Apr 13 → May 1 (15 days)
  using sidecar table conventions; export to
  `ml/data/nq-flow-leadership/nq_1m_bars.parquet`
- Verify NDX + NDXP presence in parquet (one-file ticker enumeration)
- Run a **50-row timing probe** on one parquet file BEFORE bulk ops
  (per `feedback_measure_before_bulk.md`)
- Pre-filter all 15 parquet files to {QQQ, SPY, SPX, SPXW, NDX, NDXP}
  subsets. Apply UW filter rules from memory:
  - drop `extended_hours_trade`
  - drop `contingent_trade`
  - drop `average_price_trade`, `derivative_price_trade` (synthetic)
  - restrict to 08:30–15:00 CT
- Output: `ml/data/nq-flow-leadership/options_filtered_2026-04-XX.parquet`
  (one file per day, all 6 tickers in each)
- Verify: row count audit, schema match, ticker presence per day

### Phase 1 — Flow feature engineering (3–4 hr)

For each (ticker, minute-bin), compute features at multiple rolling
windows (1/5/15/30 min):

- **PWDD** — Premium-weighted directional delta
- **OTM directional vega** — vega × delta-sign for |delta| < 0.30
- **Tape-side aggression ratio** — % premium hitting ask
- **Sweep clusters** — multi-strike same-side bursts (count + premium)
- **0DTE call/put premium imbalance** — restricted to expiry == today
- **Aggressive premium intensity** — ask-side premium / EMA(20m) of
  same-ticker ask-side premium

Output: `ml/data/nq-flow-leadership/features_minute.parquet` (long
format: rows = (timestamp, ticker, feature, window), cols = value)

Verify: sanity-plot one known-event day, eyeball feature traces.

### Phase 2 — Forward NQ returns (30 min)

- Compute forward NQ log-returns at horizons {5, 15, 30, 60} min from
  the minute bars
- Output: `ml/data/nq-flow-leadership/nq_forward_returns.parquet`
- Verify: distribution histograms per horizon, sanity-check tails

### Phase 3 — Question A: Correlation analysis (3–4 hr)

- Inner-join feature table to forward-return table on minute timestamp
- For each (ticker, feature, window, horizon, time-of-day-bucket):
  - Compute Spearman rank correlation
  - Bootstrap CI (1000 resamples)
  - Report n, ρ, p-value, p-value Bonferroni-corrected for the
    (feature × window × horizon) family
- **Concentration diagnostic**: for each significant correlation,
  check whether it concentrates in 1–2 time-of-day buckets or appears
  uniformly across all 5. Uniform lift across all buckets is a leakage
  fingerprint, not edge.
- Output:
  - `ml/experiments/nq-flow-leadership/correlations.parquet` (full grid)
  - `ml/experiments/nq-flow-leadership/top_correlations.json` (top 30)
  - `ml/plots/nq-flow-leadership/correlation_heatmaps.png`

### Phase 4 — Question B: NDX-complex vs SPX-complex (1 hr)

- Aggregate per-ticker correlation strength (max |ρ| across feature ×
  window × horizon, p<0.05 only)
- Side-by-side ranked table: NDX-complex vs SPX-complex
- Per-feature: which arm wins?
- Decision-support call: if SPX-complex consistently outranks NDX-complex
  for NQ prediction, switch to ES. If not, stay on NQ and use NDX-complex
  flow as primary signal source.
- Output: `ml/experiments/nq-flow-leadership/spx_vs_ndx_arm_comparison.json`

### Phase 5 — Findings report (1 hr)

- Markdown report at `docs/tmp/nq-flow-leadership-findings-2026-05-02.md`
  (per `feedback_scratch_files_in_docs_tmp.md`)
- Top 10 (ticker × feature × horizon) signatures with ρ, p, n,
  concentration profile
- Decision call on Question B: "switch to ES", "stay on NQ", or "unclear"
- Honest caveats section
- Recommended next step (e.g. "wire top signature into analyze
  context" or "request more historical data for OOS validation") —
  out of scope for this plan

## Files

### New (ml/)

- `ml/src/nq_flow_leadership/__init__.py`
- `ml/src/nq_flow_leadership/load_options_trades.py` — Phase 0 ingest + filter
- `ml/src/nq_flow_leadership/load_nq_bars.py` — Phase 0 Postgres pull
- `ml/src/nq_flow_leadership/flow_features.py` — Phase 1 feature engineering
- `ml/src/nq_flow_leadership/forward_returns.py` — Phase 2 NQ return labels
- `ml/src/nq_flow_leadership/correlate.py` — Phase 3 correlation engine
- `ml/src/nq_flow_leadership/arm_compare.py` — Phase 4 comparison
- `ml/tests/test_nq_flow_leadership.py` — unit tests for feature math + correlation logic

### New (docs/tmp)

- `docs/tmp/nq-flow-leadership-findings-2026-05-02.md` — Phase 5 deliverable

### New (ml/data/nq-flow-leadership/)

- `nq_1m_bars.parquet` (Phase 0)
- `options_filtered_2026-04-XX.parquet` per day (Phase 0)
- `features_minute.parquet` (Phase 1)
- `nq_forward_returns.parquet` (Phase 2)

### New (ml/experiments/nq-flow-leadership/)

- `correlations.parquet` (Phase 3)
- `top_correlations.json` (Phase 3)
- `spx_vs_ndx_arm_comparison.json` (Phase 4)

### New (ml/plots/nq-flow-leadership/)

- Sanity plots (Phase 1 verification)
- Correlation heatmaps (Phase 3)

### Modified

- None expected. Self-contained research module.

## Data dependencies

- NQ minute bars Apr 13 → May 1 (Postgres pull, Phase 0)
- UW options trades parquet 2026-04-13 → 2026-05-01 (have on Desktop)
- No new env vars, no DB migrations

## Honest caveats (must appear in Phase 5 report)

- **n=15 days** — exploratory, not confirmatory. Anything promising
  needs a 60+ day re-run.
- **Single regime** — Apr 13 → May 1 2026 is one VIX/macro regime.
- **In-sample** — no out-of-sample holdout. Re-running on a different
  month would be the cheapest cross-validation.
- **No transaction costs / slippage** — A "correlation" is theoretical
  signal, not P&L.
- **Multiple-comparison hazard** — testing many (ticker × feature ×
  window × horizon × time-bucket) combinations inflates false-positive
  rate. Bonferroni correction applied per family.

## Estimated effort

- Phase 0: 1–2 hr
- Phase 1: 3–4 hr
- Phase 2: 30 min
- Phase 3: 3–4 hr
- Phase 4: 1 hr
- Phase 5: 1 hr

**Total: ~10–13 hours of work**, splittable across sessions.
