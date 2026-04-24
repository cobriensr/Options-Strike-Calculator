# PAC event classifier — XGBoost on win/loss + signed return

**Activates if:** the regime-gated sweep
([pac-regime-gated-sweep-2026-04-24.md](./pac-regime-gated-sweep-2026-04-24.md))
returns null on Phase 1 + Phase 2.
**Date:** 2026-04-24
**Status:** planning (fallback)

## Goal

Forget rule-search. Instead of asking "what filter combination makes
PAC entries profitable?" — a question Optuna failed to answer in 2.7M
configs at 30 trials, and that we're currently testing at 150 trials —
ask the more direct question:

> At every BOS / CHoCH / CHoCH+ event our engine emits, given the
> market context at that moment, what's the probability the trade
> wins?

Train two ML models on the answer. If either has predictive power
above well-defined thresholds, that IS the systematic strategy: take
high-confidence trades, skip low-confidence ones. Same engine, same
events, but the entry filter is learned from data instead of guessed
by Optuna.

## Why this is a different question

Every Optuna sweep we've run, including v3 (causally correct) and
Phase 1 (150 trials), is searching for a SINGLE STATIC RULE that
applies uniformly to every BOS event in a year. The model assumption
is that the right answer is some combination like "BOS_breakout in
session=lunch with iv_tercile=high and min_adx>20." If real-world edge
is conditional on dimensional INTERACTIONS the optimizer's discrete
filter space can't represent — e.g., "BOS_up wins when ATR is high
AND VIX is rising AND last 3 swings were lower-lows AND it's the
first hour" — Optuna at 30 trials has no chance, and 150 trials still
won't find it among 15 dimensions.

A trained classifier learns those interactions automatically from
labeled examples. If they exist, the model finds them. If they don't,
the model says so honestly with AUC ~0.50.

## Architecture

```
NQ 1m bars (3 years)             SPY/QQQ 1m + VIX            UW flow data (if archived)
       │                                  │                              │
       └─────────────────────┬────────────┴──────────────────────────────┘
                             │
                  PACEngine.batch_state (causally correct, v3)
                             │
                             ▼
        Event extractor — every row where BOS/CHOCH/CHOCHPlus != 0
                             │
                             ▼
   Feature builder — at each event ts, snapshot engine + cross-asset state
                             │
                             ▼
         Label builder — TWO labels per event:
             A) +1.5R win / -1R loss / timeout-NaN  (binary classifier)
             B) signed +30min return                 (regression)
                             │
                             ▼
                  Walk-forward train/test
                  (train: years N-2, N-1; test: year N)
                             │
                             ▼
        XGBoost classifier (A) + XGBoost regressor (B)
                             │
                             ▼
   Metrics:
     - AUC, Expected R/trade at confidence thresholds (Model A)
     - Sharpe of signed-prediction vs realized return (Model B)
     - Feature importance (both models)
```

## Decisions locked in (from this conversation)

- **Label A** — `+1.5R win` / `-1R loss` / `timeout-NaN at 4h`. Matches
  the existing backtest exit framework.
- **Label B** — signed +30-minute return (continuous regression target).
- **Both models trained on the same feature matrix.**
- **Universe** — signal-conditional. Every BOS / CHOCH / CHOCH+ event
  the engine emits is a row.
- **Cross-asset** — included from day 1 (SPY, QQQ, VIX as concurrent
  features at the event timestamp).
- **Edge bar** — Model A passes if **AUC > 0.55 AND Expected R/trade
  > 0.10** at the model's chosen confidence threshold. Model B passes
  if **directional sign accuracy > 0.55 AND Sharpe of model-weighted
  signed returns > 0.5**. Both required per model — discrimination AND
  dollar profitability.

## Phases

### Phase 1 — feature + label pipeline (~2 days)

Build deterministic, reproducible dataset construction:

- `ml/src/pac_classifier/events.py` — given a year of bars, run
  `PACEngine.batch_state`, return a DataFrame of (ts, signal_type,
  signal_direction) for every non-zero BOS/CHOCH/CHOCHPlus row.
- `ml/src/pac_classifier/features.py` — for each event row, snapshot:
  - **Engine features** (already computed in batch_state output):
    `atr_14`, `adx_14`, `di_plus_14`, `di_minus_14`, `z_close_vwap`,
    `ob_pct_atr`, `ob_volume_z_50`, `session_bucket`,
    `minutes_from_rth_open`, `minutes_to_rth_close`, `is_fomc`,
    `is_opex`, `is_event_day`.
  - **Derived rolling features**: prior 5 / 30 / 60 / 240-bar return,
    rolling realized vol, recent BOS density (count in last 60 bars).
  - **Cross-asset**: SPY 1m close + 5/30-bar return at same ts, QQQ
    1m close + return, VIX level + 5-bar change.
  - **Static**: day-of-week, expiry-proximity (days to next monthly
    opex), session phase (open/lunch/close).
  - Total target: 30–50 features.
- `ml/src/pac_classifier/labels.py` — given an event ts and price,
  walk forward bar-by-bar, simulate +1.5R-target / -1R-stop with 4h
  timeout. Emit binary win/loss + signed +30min return.
- `ml/src/pac_classifier/dataset.py` — assemble the full
  feature+label DataFrame, persist as parquet to
  `ml/experiments/pac_classifier/dataset_{year}.parquet`.

Test layer: synthetic OHLC fixtures with known patterns to verify
labels are computed correctly. **Critical**: the label simulator MUST
use the same fill model and bar-walking logic as `pac_backtest/loop.py`,
otherwise Model A's predictions won't transfer to backtest behavior.

### Phase 2 — model training + evaluation (~1 day)

- `ml/src/pac_classifier/model.py` — XGBoost classifier (Model A) and
  regressor (Model B). Standard hyperparameters, 5-fold CV grid
  search over `n_estimators`, `max_depth`, `learning_rate`,
  `min_child_weight`. Class imbalance handled via
  `scale_pos_weight` if win rate < 0.4. Persist trained models via
  XGBoost's native `save_model()` JSON format (NOT pickle — JSON is
  portable and avoids deserialization-trust risk).
- **Walk-forward split**: train on years 2022 + 2023, test on 2024.
  Then train on 2022 + 2024, test on 2023. Then train on 2023 + 2024,
  test on 2022. Three out-of-sample windows.
- **Metrics**:
  - Model A: AUC, log-loss, Brier score, precision/recall at multiple
    confidence thresholds (60/65/70/75/80%), Expected R per trade at
    each threshold (with 0.5-tick slippage + $1.90 round-trip costs).
  - Model B: MAE, sign accuracy, Sharpe of model-weighted directional
    bets, calibration plot.
- **Feature importance**: SHAP values for top 15 features.

### Phase 3 — interpret + document (~1 day)

- Write addendum: did either model pass both bars on at least one
  out-of-sample window? On all three?
- If yes: which features dominate? Are they consistent across years?
  Are there interactions only the tree finds?
- If no: document feature-by-feature ranking — even a null result
  tells us which dimensions look least informative, which guides
  future feature engineering.
- Out-of-sample stress test: if Model A passes 2024 OOS, simulate
  the model-filtered backtest on 2024 trade-by-trade. The dollar P&L
  in that simulation is the real-world preview.

## Files to create

- `ml/src/pac_classifier/__init__.py`
- `ml/src/pac_classifier/events.py`
- `ml/src/pac_classifier/features.py`
- `ml/src/pac_classifier/labels.py`
- `ml/src/pac_classifier/dataset.py`
- `ml/src/pac_classifier/model.py`
- `ml/src/pac_classifier/eval.py`
- `ml/scripts/build_pac_classifier_dataset.py`
- `ml/scripts/train_pac_classifier.py`
- `ml/tests/test_pac_classifier_events.py`
- `ml/tests/test_pac_classifier_features.py`
- `ml/tests/test_pac_classifier_labels.py`  ← **HIGHEST priority test**
- `ml/tests/test_pac_classifier_model.py`
- `ml/experiments/pac_classifier/` (output dir for parquet datasets,
  XGBoost JSON model artifacts, eval json, SHAP plots)

## Data dependencies

- **Existing**: NQ 1m archive on Railway volume + local Databento
  archive in `ml/data/archive/`.
- **Need to verify available**:
  - SPY 1m bars for 2022–2024 — likely in archive (was used for
    sidecar work).
  - QQQ 1m bars — same.
  - VIX intraday — need to check, may need to seed from another
    source or use VX futures basis as proxy.
- **Out of scope for first iteration** (Phase 4 if needed):
  - UW flow data (SPY 0DTE C/P, ask-skew z) — would require
    rebuilding the IV anomaly fixture set as a feature pipeline.

## Thresholds / constants

- Stop distance (for label A R-multiple): `1.5 × ATR_14_at_event` —
  matches the backtest's default `stop_atr_multiple`.
- Target distance: `2.25 × ATR_14_at_event` (1.5R from a 1.5×ATR stop).
- Timeout: 4 hours = 240 1m-bars.
- Return horizon for Label B: 30 minutes = 30 1m-bars.
- Costs: $1.90 round-trip + 0.5 tick slippage = matches backtest.
- Class-imbalance threshold: rebalance if base win rate < 0.40 or > 0.60.
- Confidence thresholds for Model A reporting: 60, 65, 70, 75, 80%.
- Edge bars (recap):
  - Model A: AUC > 0.55 AND Expected R/trade > 0.10
  - Model B: sign accuracy > 0.55 AND Sharpe > 0.5 of directional bets

## Open questions

- **Q1**: do we have SPY/QQQ/VIX 1m for the 2022–2024 window in the
  archive? Need to grep `ml/data/archive/` and `sidecar/` for source
  data before Phase 1 starts. If missing, add a "seed cross-asset
  data" mini-phase.
- **Q2**: how big is the resulting dataset?
  Estimate: ~3,000 events/year × 3 years × 50 features ≈ 9,000 rows ×
  50 cols ≈ small parquet (<5MB). Train/test fits trivially in memory.
- **Q3**: should we use the same `swing_length=5` PAC config that
  v3 used, or also include `swing_length` as a feature dimension by
  running multiple engine passes? **Default**: stick with
  `swing_length=5` — adding multi-config events 5× the dataset.
- **Q4**: feature leakage check. Some features (`is_event_day`) are
  known ex-ante; others (`atr_14`) are computed from the trailing
  window and are causally available at the event ts. We need a
  sanity test that asserts every feature column at event time T uses
  ONLY data with timestamp ≤ T. Same kind of test as the engine's
  causality test, but for the classifier's feature builder.
- **Q5**: should Model B regress on the +30min return AT THE
  EVENT BAR, or on the +30min return AFTER A 1-BAR DELAY (to account
  for live execution latency)? **Default**: 1-bar delay, more
  conservative.
- **Q6**: SHAP interpretation budget — full SHAP on 3K rows × 50
  features × 100 trees is fast but not free. **Default**: compute
  SHAP for top 15 features only, ranked by gain importance.

## Done-when

- **Go path**: Model A or Model B (or both) clears both edge bars on
  at least 2 of 3 out-of-sample windows. Document the winning model,
  feature importance, and run a model-filtered simulation through
  the existing backtest to confirm the $-edge holds with realistic
  execution. Move to live paper-trading design.
- **No-go path**: Both models fail both bars on all 3 windows.
  Together with the Phase 1+2 sweep null, this is the **definitive
  call** that PAC events don't have systematic edge as a directly
  tradable signal in the data we have. The natural next move is to
  pivot toward (3) PAC-as-context for discretionary use, or (4) PAC
  + flow composite — both are tools rather than systematic strategies.

## Non-goals

- **Not a real-time inference service.** This is research. If a model
  passes, building a serving layer is a separate effort.
- **Not a multi-asset portfolio.** Single instrument (NQ) at a time.
  Cross-asset features are CONTEXTUAL inputs, not separate models.
- **Not predictive of intraday paths.** We predict outcomes of
  specific entry events, not "where will SPX be in 30 min."
- **No deep learning.** XGBoost only. We don't have enough labeled
  events for any model with more than a few thousand parameters to
  generalize.

## Reference

- Engine: `ml/src/pac/engine.py` (causally correct as of `a9c53a9`)
- Existing sweep: `ml/src/pac_backtest/sweep.py` (15-dim Optuna)
- Causality test: `ml/tests/test_pac_engine_causality.py`
- v3 null result: `pac-v3-residual-fix-results-2026-04-24.md`
- Phase 1+2 in-flight: `pac-regime-gated-sweep-2026-04-24.md`
- Feature reference: `ml/src/pac/features.py` (existing per-bar features)
