# IV Anomaly ML Study — Phase D (Deeper Analysis)

## Goal

Answer four classes of question Phase A/B/C left on the table — the
ones most likely to change how alerts are traded vs how alerts are
gated. Same dataset (15,886 backfill rows + ongoing live), four new
slices.

## Why now

Phase B told us "hold-to-EOD wins on 8 of 13 tickers." But it never
said _what the trade looked like along the way_ — was the eventual
winner down 80% first? Phase C told us "vol/OI 200×+ has 1.7% win
rate." But it bucketed the _ratio_, never the absolute volume that
might separate a $5M whale print from a $500 retail flurry on a thin
strike. Both gaps are actionable.

The bigger missing axis: **regime alignment**. The user does not
trade alerts in isolation — alerts are a _strike-selection filter_
on top of an already-formed directional thesis. A 10% headline
win rate blends the days where regime aligned with the alert (likely
high-edge) with days where it didn't (likely zero-edge or worse).
Conditioning on regime is a precondition for any other slice meaning
much.

This is a directional study, same caveats as Phase A/B/C: 10 days, no
slippage, mid-price assumption.

## Regime spine (anchors all sub-phases)

Every alert gets a single regime label per the **underlying ticker's
own daily % change** (open ≈ first observed spot of day, close ≈
last observed spot of day):

| Regime         | Threshold (` | Δ   | `)  |
| -------------- | ------------ | --- | --- |
| `chop`         | < 0.25%      |
| `mild_trend`   | 0.25–1.0%    |
| `strong_trend` | 1.0–2.0%     |
| `extreme`      | > 2.0%       |

Direction (`up` / `down`) is appended to all non-chop labels.
NVDA on a +1.5% NVDA day = `strong_trend_up` even if SPX is flat.
This is the cleanest mapping because each ticker's regime is its own
and removes cross-asset translation questions.

**Lookahead caveat:** using the day's close to label "what kind of
day it was" is a lookahead — at `alert_ts` you don't yet know how
the day will close. The result is still useful: it tells you "given
you correctly identify a trending-up day from your dashboard at
alert_ts, this is the edge available." Don't read these as
predictive numbers in isolation.

## Sub-phases

### D0 — Regime-conditional headline (~1h, priority)

Direct re-cut of Phase B and C numbers conditioned on
regime × side. Answers the immediate question: "if it's a
trending-up day and I get call alerts, what does that look like?"

**Script:** `ml/regime-conditional-iv-anomalies.py`

For each (ticker × regime × side) bucket:

- n alerts
- win rate using _per-(ticker, regime) re-picked best strategy_ (NOT
  Phase B's regime-blind pick)
- mean / median % PnL
- mean / median $ PnL per contract
- max single-trade $ loss
- max single-trade $ gain

Plus the regime-blind aggregate for comparison.

**Why re-pick BEST_STRATEGY per regime:** Phase B picked NVDA →
hold-to-EOD because it had the highest aggregate Sharpe-ish. But on
trending-up days NVDA peaks intraday and gives back, so the right
exit there is sell-on-ITM-touch (or sell-on-peak). The blind pick
hides this.

**Outputs:**

- `ml/findings/iv-anomaly-regime-conditional-2026-04-25.json`
- `ml/reports/iv-anomaly-regime-conditional-2026-04-25.md`
- `ml/plots/iv-anomaly-regime-conditional/`:
  - per-ticker regime × side bar chart of win rates
  - per-ticker regime × side $/contract distribution
  - aggregate "regime alignment" funnel (regime-aligned vs
    contradicted vs neutral)

D1–D4 below all reuse D0's regime labels and per-(ticker, regime)
best strategy.

## Four sub-phases

### D1 — Path-shape (~2h)

The biggest miss in Phase B. We treated each alert as a single point
("did it eventually win?") and never looked at how it got there.

**Script:** `ml/path-shape-iv-anomalies.py`

Requires extending the outcome extraction. Add to per-alert features:

| Feature                | Definition                                                    |
| ---------------------- | ------------------------------------------------------------- |
| `min_premium_to_peak`  | min(mid_price) between alert and peak                         |
| `mae_to_peak_pct`      | (min_premium_to_peak - entry) / entry — max adverse excursion |
| `mfe_pct`              | (peak - entry) / entry (= peak_premium_pct, already in D0)    |
| `min_premium_to_close` | min(mid_price) between alert and EOD                          |
| `mae_to_close_pct`     | drawdown floor for hold-to-EOD strategy                       |
| `time_to_mae_min`      | minute index of MAE                                           |
| `peak_before_itm`      | true if `time_to_peak_min < time_to_itm_min`                  |
| `time_in_itm_pct`      | % of post-touch minutes spot stayed ITM                       |
| `n_itm_re_entries`     | count of ITM→OTM→ITM transitions                              |

**Per-ticker, hold-to-EOD strategy aggregates:**

- median MAE for eventual winners (% peak-to-trough before EOD profit)
- median MAE for eventual losers
- "psychological-viability" %: alerts where MAE never went below -50%
  AND eventual EOD profit was positive

**Per-ticker, ITM-touch strategy aggregates:**

- "give-it-X-minutes" curves: P(stay-ITM | minutes-after-first-touch)
- `n_itm_re_entries` distribution — does NDXP stay ITM cleanly while
  TSLA whips?
- separate winners from "trap" alerts that bounced ITM once and gave
  back

**Outputs:**

- `ml/data/iv-anomaly-path-shape.parquet` — extended per-alert features
- `ml/reports/iv-anomaly-path-shape-2026-04-25.md`
- `ml/plots/iv-anomaly-path-shape/`:
  - per-ticker MAE distribution (winners vs losers)
  - per-ticker time-in-ITM after first touch (CDF)
  - "drawdown-before-peak" scatter: MFE vs MAE per ticker

### D2 — Signal magnitude (~1h)

Phase C bucketed signal _count_. We never bucketed signal _strength_.
A 5σ skew_delta and a 2σ skew_delta both counted as "skew_delta
fired."

**Script:** `ml/signal-magnitude-iv-anomalies.py`

Bucket by magnitude per signal, **per ticker**:

| Signal                           | Buckets                         |
| -------------------------------- | ------------------------------- |
| `z_score`                        | <2.0, 2.0-3.0, 3.0-5.0, 5.0+    |
| `skew_delta`                     | <2σ, 2-3σ, 3-5σ, 5σ+            |
| `ask_mid_div`                    | 0.0-0.3, 0.3-0.5, 0.5-0.7, 0.7+ |
| `vol_oi_ratio` (absolute volume) | <500, 500-2k, 2k-10k, 10k+      |
| `side_skew`                      | 0.65-0.80, 0.80-0.95, 0.95+     |

For each: win rate, mean PnL using per-ticker best strategy, n.

Plus a **composite intensity score**: z-score of standardized
magnitudes summed (only signals that fired). Bin the score by
quartile and check whether intensity predicts win rate per ticker.

**Outputs:**

- `ml/findings/iv-anomaly-signal-magnitude-2026-04-25.json`
- `ml/reports/iv-anomaly-signal-magnitude-2026-04-25.md`

### D3 — Population / cohort (~1h)

Phase C never asked about _day-level_ homogeneity or _firing-sequence_
position.

**Script:** `ml/cohort-iv-anomalies.py`

Compute per-alert:

- `firing_index` — 1st, 2nd, ... Nth firing of that compound key on
  that day (derive from `iv_anomalies.ts` ordering)
- `is_first_of_day` — first firing in that compound key on that
  trading day
- `firings_in_compound_key` — total count for that key/day
- `alerts_on_day` — total alerts across all tickers that day (regime
  proxy)
- `day_of_week`

Slices to compute:

1. **Win rate by `firing_index`** — does the 1st firing beat the 38th?
2. **Win rate by `firings_in_compound_key`** — single-firing alerts
   (whose key never repeats) vs persistent alerts (key fires 30+
   times)
3. **Per-day win rate** — were the 14.5% headline numbers driven by
   one anomalous day?
4. **`alerts_on_day` regime correlation** — is win rate higher on
   high-density days or low?
5. **Day-of-week** — caveat n=2 per weekday so directional only

**Outputs:**

- `ml/findings/iv-anomaly-cohort-2026-04-25.json`
- `ml/reports/iv-anomaly-cohort-2026-04-25.md`
- `ml/plots/iv-anomaly-cohort/`:
  - per-day win rate bar chart
  - alerts-per-day vs win-rate scatter
  - firing_index distribution per ticker

### D4 — Detector internals (~1h)

How long do alerts last and does duration predict outcome?

**Script:** `ml/detector-internals-iv-anomalies.py`

Aggregate per-compound-key per-day:

- `first_seen_ts`, `last_fired_ts`, `firing_count`
- `duration_min` = `last_fired_ts - first_seen_ts`
- `time_to_first_firing_min` = `first_seen_ts - 08:30 CT`
- Tag as `flash` (duration <5 min, count <3), `persistent` (duration
  > 60 min OR count >20), or `medium`

Slices:

1. **Win rate by alert duration bucket** — flash vs medium vs
   persistent
2. **Win rate by firing_count bucket** — 1, 2-5, 6-20, 21+
3. **Win rate by time_to_first_firing_min** — first-30-min,
   first-2hr, midday, afternoon
4. **Single-firing alerts** — what % of compound keys fired exactly
   once? Better/worse than multi-firers?

**Outputs:**

- `ml/findings/iv-anomaly-detector-internals-2026-04-25.json`
- `ml/reports/iv-anomaly-detector-internals-2026-04-25.md`

## Decision artifact

A **rolled-up findings note** at
`ml/reports/iv-anomaly-phase-d-summary-2026-04-25.md` listing the
top-level "what changes for production" answers from each sub-phase:

- D1: per-ticker recommended exit (with confidence)
- D2: per-ticker signal weights (which magnitude bucket actually
  predicts)
- D3: cohort filters (avoid Nth firing of same key, etc.)
- D4: detector quality flags (is `flash` better than `persistent`?)

## Constraints

- 10-day sample; per-bucket subsets get small fast. Treat all D-phase
  results as directional.
- Path-shape requires re-reading `strike_iv_snapshots` per alert —
  the same data Phase A used but with full trajectory retention. For
  alerts whose strike has no snapshots (deep-OTM cash-index), MAE/MFE
  are NULL not zero.
- Composite intensity score is _only_ meaningful when a signal fired;
  don't standardize across alerts where the signal was missing.
- Day-of-week: n=10 days total spread Mon-Fri unevenly. Surface but
  don't draw conclusions.

## Out of scope (saved for Phase E or later)

- **Catalyst questions** (dark prints, NQ leadership, VIX regime,
  macro events) — separate cross-asset enrichment spec
- **Counterfactual gate sweeps** (excluding puts, vol/OI ceiling) —
  requires re-running detector, separate spec
- **Predictive ML** — still need 4-6 weeks live data
- **Drawdown-aware exit strategies** (trailing stop, scale-out) —
  this study identifies that exits _should_ be path-aware; designing
  the actual rule is a separate feature

## Time estimate

**~5h total** — D1 (~2h) + D2 (~1h) + D3 (~1h) + D4 (~1h)

## Dependencies

- `ml/.venv` (already installed)
- Read-only Neon access via DATABASE_URL (already wired)
- Existing `ml/data/iv-anomaly-outcomes.parquet` from Phase A
- Existing `ml/data/iv-anomaly-backtest-2026-04-25.parquet` from
  Phase B (carries `BEST_STRATEGY` per ticker)
- Live access to `strike_iv_snapshots` for D1's path extraction
- No new tables, no production code changes

## Deliverables

- `ml/path-shape-iv-anomalies.py` (D1)
- `ml/data/iv-anomaly-path-shape.parquet` (D1)
- `ml/reports/iv-anomaly-path-shape-2026-04-25.md` (D1)
- `ml/plots/iv-anomaly-path-shape/*.png` (D1)
- `ml/signal-magnitude-iv-anomalies.py` (D2)
- `ml/findings/iv-anomaly-signal-magnitude-2026-04-25.json` (D2)
- `ml/reports/iv-anomaly-signal-magnitude-2026-04-25.md` (D2)
- `ml/cohort-iv-anomalies.py` (D3)
- `ml/findings/iv-anomaly-cohort-2026-04-25.json` (D3)
- `ml/reports/iv-anomaly-cohort-2026-04-25.md` (D3)
- `ml/plots/iv-anomaly-cohort/*.png` (D3)
- `ml/detector-internals-iv-anomalies.py` (D4)
- `ml/findings/iv-anomaly-detector-internals-2026-04-25.json` (D4)
- `ml/reports/iv-anomaly-detector-internals-2026-04-25.md` (D4)
- `ml/reports/iv-anomaly-phase-d-summary-2026-04-25.md` (rollup)
