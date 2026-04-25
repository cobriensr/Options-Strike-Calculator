# IV Anomaly ML Study — Phase E (Cross-Asset Enrichment)

## Goal

Enrich each `iv_anomalies` alert with a small bundle of cross-asset
context features computed _at alert_ts_ — the things the user
actually watches alongside the alerts but that we never joined into
the dataset:

- **Index leadership** — was NQ leading SPX (or vice versa) in the
  10–30 min window before the alert?
- **Dark-print proximity** — was there a large unlabeled dark-pool
  block on or near this strike within ±5 minutes?
- **VIX direction** — was VIX rising or falling in the 30 min before
  the alert?
- **GEX position** — was the alerted strike _above_ or _below_ the
  nearest large GEX strike?
- **Macro window** — was the alert within 30 min of a high-impact
  econ event (FOMC, CPI, NFP, etc.)?

Phase D ended on the note "regime-conditional win rates separate the
data 4×, but cross-asset is the missing axis." This is that axis.

## Why now (vs. waiting)

Two independent reasons:

1. **All 5 features can be computed retroactively** from existing
   tables (`futures_bars`, `dp_recent`, `market_snapshots`,
   `spot_exposures_strike`, `economic_calendar`). No new data
   ingestion required — just join logic and feature extraction.
2. **The user trades these signals already.** The Phase D regime
   spine confirmed that _the user's directional thesis is what makes
   alerts work_ — but their thesis is built from these exact 5
   inputs. Computing them retroactively lets us measure: "given
   these 5 inputs would have agreed with the alert direction, what
   was the win rate?" That's the closest the dataset can come to
   simulating the user's actual decision process.

## What's already in the database

All five enrichments map to existing tables (no new ingestion
required):

| Concept                    | Source table                                     | Coverage               |
| -------------------------- | ------------------------------------------------ | ---------------------- |
| NQ / ES / RTY / DX 1m bars | `futures_bars`                                   | full backfill window ✓ |
| SPX 1m candles             | `spx_candles_1m`                                 | full ✓                 |
| Dark-pool prints           | `darkpool_prints` (or rolling cron-fed)          | full ✓                 |
| VIX level (1m or daily)    | `market_snapshots`                               | full ✓                 |
| GEX per strike             | `spot_exposures_strike`, `greek_exposure_strike` | full ✓                 |
| Economic events            | `economic_calendar`                              | full ✓                 |

## Five sub-phases

### E1 — Index leadership feature (~2h)

For each alert, compute correlation/lead between the underlying
ticker and a basket of leadership candidates over the 10/15/30 min
windows ending at `alert_ts`.

**Script:** `ml/extract-iv-anomaly-leadership.py`

Per alert, compute:

| Feature                     | Definition                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --- | ------------------------------------------------ |
| `corr_nq_to_spx_15m`        | Pearson(SPX returns, NQ returns) over previous 15 min                                          |
| `lag_nq_to_spx_15m`         | Argmax-correlation lag in minutes (NQ leading = positive)                                      |
| `corr_es_to_spx_15m`        | Same for ES                                                                                    |
| `corr_underlying_to_es_15m` | For the alerted ticker, corr to ES                                                             |
| `direction_consistent`      | bool: 5 of (NQ, ES, RTY, SPX, underlying) all moving the same direction over the 15-min window |
| `magnitude_15m_pct`         |                                                                                                | Δ   | of the alerted underlying over the 15-min window |

**Aggregation:** D0/D2 numbers re-cut by `direction_consistent ×
regime × side`. Hypothesis: when `direction_consistent` is true AND
regime is aligned, win rate jumps further than either alone.

### E2 — Dark-print proximity (~1h)

For each alert (limited to SPX cash-feed tickers — SPXW, NDXP — and
SPY/QQQ where dark prints are attributable), compute:

| Feature                         | Definition                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `nearest_dp_strike_dollar_dist` | Distance from alert strike to nearest dark print's "implied strike" (price × 100, mapped to nearest contract strike) within ±5 min |
| `dp_premium_in_window`          | Sum of dark-print premium within ±5 min of alert                                                                                   |
| `dp_count_in_window`            | Number of dark prints within ±5 min                                                                                                |
| `dp_largest_premium`            | Largest single print within ±5 min                                                                                                 |

Filtered per the project's three darkpool rules (drop
`average_price_trade`, `derivative_price_trade`,
`extended_hours_trade`; per-session price envelope for
`contingent_trade`).

**Aggregation:** D0 win rate by `dp_premium_in_window` quartile ×
regime × side. Hypothesis: alerts coinciding with large attributed
dark prints have higher win rates.

### E3 — VIX direction (~30 min)

Lightweight. For each alert:

| Feature              | Definition                                          |
| -------------------- | --------------------------------------------------- |
| `vix_level_at_alert` | Latest VIX from `market_snapshots`                  |
| `vix_change_30m`     | VIX change over previous 30 min                     |
| `vix_regime`         | 'rising' (Δ > +0.2) / 'falling' (Δ < -0.2) / 'flat' |

**Aggregation:** D0 win rate by `vix_regime × regime × side`.
Hypothesis: rising VIX alerts on calls don't pay; falling VIX
alerts on calls outperform.

### E4 — GEX position (~1h)

For each alert, find the nearest top-3 GEX strike at `alert_ts`
(top-3 absolute GEX from `spot_exposures_strike`):

| Feature                   | Definition                                         |
| ------------------------- | -------------------------------------------------- |
| `nearest_gex_strike`      | Strike of nearest top-3 GEX                        |
| `gex_above_or_below`      | 'above' / 'below' relative to current spot         |
| `alert_strike_inside_gex` | bool: alert strike is between spot and nearest GEX |
| `dist_to_gex_pct`         | (gex_strike - spot) / spot                         |

**Aggregation:** D0 win rate by `gex_above_or_below × side ×
regime`. Hypothesis: call alerts on strikes _between spot and nearest
above-spot GEX_ (the gamma flip zone) have higher win rate than
call alerts above the GEX wall.

### E5 — Macro event proximity (~30 min)

For each alert:

| Feature                 | Definition                                                                  |
| ----------------------- | --------------------------------------------------------------------------- | ------- | ---- |
| `nearest_event_minutes` | minutes to nearest high-impact event (FOMC, CPI, NFP, PPI, retail sales)    |
| `is_in_event_window`    | bool:                                                                       | minutes | < 30 |
| `event_direction`       | up/down 30-min spot reaction post-event (filled in E5 from spot trajectory) |

**Aggregation:** D0 win rate by `is_in_event_window × side ×
regime`. Hypothesis: alerts in 30-min event windows have higher
variance — bigger wins AND bigger losses.

## Decision artifact

A combined **"all 5 cross-asset features × win rate"** report at
`ml/reports/iv-anomaly-cross-asset-2026-04-25.md` listing:

- Headline: per-feature win rate uplift vs the regime baseline
- Top 5 ticker × regime × cross-asset filters with the highest
  conditional win rate (e.g., "QQQ × mild_trend_up × VIX falling ×
  direction_consistent" → win rate %)
- Per-ticker recommendations: which 2-3 cross-asset features add
  the most signal for that ticker

## Constraints

- **Data sparsity per feature.** GEX is only stored at 5-min cron
  intervals; alerts at sub-minute granularity will snap to the
  nearest 5-min sample. Document the approximation.
- **Dark print attribution.** Only SPX-cash-feed tickers (SPXW,
  NDXP) get cleanly-attributed dark prints. Single-name dark prints
  are out of scope (would need separate ingestion).
- **Macro events.** `economic_calendar` may have gaps. Surface
  unmatched alerts as "no nearby event" rather than mis-claiming.
- **No re-extraction.** All features computable from current
  `iv_anomaly_outcomes.parquet` + Postgres tables. No new cron
  needed; this is pure analysis.

## Out of scope

- **Periscope gamma levels.** Third-party tool; not in DB. Could
  approximate from `greek_exposure_strike` but that's its own
  feature.
- **NOPE.** Computable from `net_flow` + spot but requires a
  separate derivation script. Defer to E2.5 if needed.
- **Cross-asset feature engineering for the live detector.** This
  spec is RETROACTIVE analysis. Wiring these as live signals into
  `detectAnomalies()` is a separate production change.
- **D5 — exposure / sizing.** Still deferred — Phase E focuses on
  signal alignment first; sizing is a downstream question.

## Time estimate

**~5h total** — E1 (~2h) + E2 (~1h) + E3 (~30 min) + E4 (~1h) +
E5 (~30 min) + rollup (~30 min)

## Dependencies

- `ml/.venv` (already installed)
- Read-only Neon access via DATABASE_URL (already wired)
- Existing `ml/data/iv-anomaly-outcomes.parquet` and
  `iv-anomaly-backtest-2026-04-25.parquet`
- No new tables, no production code changes

## Deliverables

- `ml/extract-iv-anomaly-leadership.py` (E1)
- `ml/extract-iv-anomaly-darkprint.py` (E2)
- `ml/extract-iv-anomaly-vix.py` (E3)
- `ml/extract-iv-anomaly-gex.py` (E4)
- `ml/extract-iv-anomaly-macro.py` (E5)
- `ml/data/iv-anomaly-cross-asset.parquet` — combined feature
  parquet (all 5 enrichments joined to outcomes)
- `ml/findings/iv-anomaly-cross-asset-2026-04-25.json`
- `ml/reports/iv-anomaly-cross-asset-2026-04-25.md`
- `ml/plots/iv-anomaly-cross-asset/*.png`

## After Phase E

If E results show meaningful conditional uplift (>5pt win rate
boost over regime baseline), the natural Phase F is to **wire the
top-2 features into the production detector's UI** — surfacing
"NQ leading SPX" or "VIX falling" as a confidence indicator next
to the alert. That's a separate spec because it requires a live
cron path, not just retroactive analysis.

If E results are weak (no conditional uplift), the lesson is that
the user's dashboard signals are NOT improvable from these
particular cross-asset features — and the next spec should look
elsewhere (e.g., flow-leadership: net premium flowing to SPY before
SPXW alerts fire).
