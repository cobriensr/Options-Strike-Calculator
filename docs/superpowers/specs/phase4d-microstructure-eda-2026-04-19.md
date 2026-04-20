# Phase 4d — Microstructure EDA + Signal Validation — 2026-04-19

Part of the max-leverage roadmap. Phase 4d analyzes the
`microstructure_daily.parquet` output from Phase 4c against derived
OHLCV outcome labels to determine which features carry real signal
before ML model training.

## Goal

Answer six concrete EDA questions, each producing one plot + one
findings-JSON entry:

1. Feature distributions — do features look sane, outliers in check?
2. Feature correlation matrix — where's the redundancy?
3. Spread widening feature prevalence — confirm the "always zero"
   finding quantitatively. If true, propose a spec-level remedy for
   a Phase 4c follow-up.
4. Derive per-day outcomes from the OHLCV archive (ret_day,
   ret_5d, regime_label).
5. Feature → outcome correlations — Spearman per feature pair; rank
   features by |effect size|.
6. Cohort analysis — split days by top/bottom quartile of the top-3
   features from Q5; do outcome distributions differ meaningfully?

## Input

- `ml/data/features/microstructure_daily.parquet` — 624 rows × 28 cols
  from Phase 4c.
- `ml/data/archive/ohlcv_1m/year={2010..2026}/part.parquet` — 17-year
  OHLCV archive for outcome derivation.
- `ml/data/archive/symbology.parquet` — instrument_id → symbol.
- `ml/data/archive/tbbo_condition.json` — degraded-day flags (already
  surfaced in the feature Parquet as `is_degraded`).

## Output

- `ml/plots/microstructure_q1_distributions.png` — histogram panel (4x6 grid)
- `ml/plots/microstructure_q2_correlation.png` — correlation heatmap
- `ml/plots/microstructure_q3_spread_zero_rate.png` — bar chart:
  % of rows with `spread_widening_max_zscore == 0` per symbol
- `ml/plots/microstructure_q4_returns.png` — ret_day + ret_5d histograms,
  up/flat/down class balance
- `ml/plots/microstructure_q5_feature_vs_return.png` — ranked bar of
  Spearman |ρ| between each feature and ret_day, per symbol, with
  significance markers at p<0.05 after Bonferroni correction
- `ml/plots/microstructure_q6_cohorts.png` — outcome distribution
  boxplots split by top vs bottom quartile of the top-3 features
- `ml/findings_microstructure.json` — machine-readable summary of all
  six findings (schema below)

## Findings JSON schema

```json
{
  "generated_at": "2026-04-19T...",
  "feature_file": "ml/data/features/microstructure_daily.parquet",
  "outcome_source": "ml/data/archive/ohlcv_1m/",
  "n_rows": 624,
  "n_symbols": 2,
  "date_range": { "start": "2025-04-20", "end": "2026-04-17" },
  "questions": [
    {
      "id": "q1_distributions",
      "summary": "<one-sentence finding>",
      "per_feature": {
        "ofi_5m_mean": {
          "mean": 0.01,
          "std": 0.05,
          "p01": -0.15,
          "p99": 0.18,
          "n_missing": 0,
          "outlier_fraction": 0.004
        },
        "...": {}
      }
    },
    {
      "id": "q2_correlation",
      "summary": "...",
      "high_correlations": [
        { "a": "ofi_5m_mean", "b": "ofi_15m_mean", "rho": 0.92 },
        "..."
      ]
    },
    {
      "id": "q3_spread_zero_rate",
      "summary": "...",
      "per_symbol": {
        "ES": { "zero_rate": 0.95, "n_rows": 312 },
        "NQ": { "zero_rate": 0.97, "n_rows": 312 }
      },
      "recommendation": "<if zero_rate > 0.9, recommend changing per-minute aggregator from median → max or percentile_cont(0.95) in Phase 4c follow-up>"
    },
    {
      "id": "q4_returns",
      "summary": "...",
      "per_symbol": {
        "ES": {
          "n_rows": 312,
          "ret_day_mean": 0.001,
          "ret_day_std": 0.012,
          "class_counts": { "up": 120, "flat": 80, "down": 112 }
        },
        "NQ": { "..." }
      }
    },
    {
      "id": "q5_feature_vs_return",
      "summary": "...",
      "top_features_es": [
        { "feature": "ofi_1h_mean", "spearman": 0.18, "p_value": 0.002, "p_bonf": 0.046 },
        "..."
      ],
      "top_features_nq": [ "..." ]
    },
    {
      "id": "q6_cohorts",
      "summary": "...",
      "cohorts": [
        {
          "feature": "ofi_1h_mean",
          "q4_median_ret_day": 0.003,
          "q1_median_ret_day": -0.002,
          "mannwhitney_p": 0.01
        },
        "..."
      ]
    }
  ]
}
```

## Outcome derivation (Q4)

For each `(date, symbol)` in the feature Parquet, query the OHLCV
archive for the front-month contract on that date:

```
SELECT FIRST(open ORDER BY ts_event) AS day_open,
       LAST(close ORDER BY ts_event) AS day_close
FROM read_parquet('ml/data/archive/ohlcv_1m/year=*/part.parquet') AS bars
JOIN read_parquet('ml/data/archive/symbology.parquet') AS sym USING (instrument_id)
WHERE sym.symbol = ?
  AND CAST(date_trunc('day', bars.ts_event AT TIME ZONE 'UTC') AS DATE) = ?::DATE
```

Use **the same front-month contract symbol** the feature row already
stores in `front_month_contract`. Then:

- `ret_day = (close - open) / open`
- `ret_5d = (close_{t+5d} - close_t) / close_t` — forward-looking 5-trading-day
  return; skip rows where t+5 would fall outside the archive
- `regime_label` ∈ {up (ret_day > 0.005), flat (|ret_day| ≤ 0.005),
  down (ret_day < −0.005)}

**Remember UTC bucketing** — use `AT TIME ZONE 'UTC'` or `SET TimeZone='UTC'`
on the DuckDB connection. The Phase 4c-day-1 bug happened exactly here.

## Files

### New

- `ml/src/microstructure_eda.py` — EDA module with CLI entrypoint.
  Follows the existing `ml/src/flow_eda.py` / `ml/src/moc_eda.py`
  pattern. Each question is its own function that produces its plot
  + returns its findings dict; a main orchestrator composes them.

  Core exports:
  ```python
  def derive_outcomes(feature_df: pd.DataFrame, ohlcv_glob: str,
                      symbology_path: str) -> pd.DataFrame: ...
  def run_all_questions(feature_path: Path, ohlcv_glob: str,
                        symbology_path: str, out_plots_dir: Path,
                        out_findings_path: Path) -> dict: ...
  ```

  Individual `q1_distributions`, `q2_correlation`, ..., `q6_cohorts`
  functions.

  CLI:
  ```
  cd ml
  .venv/bin/python -m src.microstructure_eda \
      --features data/features/microstructure_daily.parquet \
      --ohlcv-root data/archive \
      --plots-dir plots \
      --findings out/findings_microstructure.json
  ```

- `ml/tests/test_microstructure_eda.py` — focused unit tests.
  **Don't** test plot rendering (tight scope). Do test:
  - `derive_outcomes` happy path with synthetic OHLCV + feature fixtures
  - `derive_outcomes` UTC boundary (trade at 00:01 UTC goes to correct date)
  - Outcome classification thresholds (up/flat/down boundaries exactly)
  - Q5 significance marker uses Bonferroni-corrected p<0.05 (not raw p)
  - Q6 cohort split uses quartiles, not halves
  - `run_all_questions` emits all six question entries in findings

### Not modified

- `ml/src/features/microstructure.py` — Phase 4c, done. Even if Q3
  reveals the spread-zero issue, **do not change the feature computation
  in this phase** — EDA ships first, feature remediation is a Phase 4c
  follow-up tracked separately.
- `ml/findings.json` — shared file actively edited by a parallel
  session. Phase 4d writes to `ml/findings_microstructure.json` instead.

## Constraints

- **No model training.** Pure EDA.
- **No feature changes.** Q3 may recommend one; implementation is
  separate.
- **Tests are small and fast.** Don't test plotting.
- **Runtime target:** < 5 minutes for the full EDA pipeline over the
  624-row feature matrix + outcome derivation via DuckDB. Should be
  trivial — OHLCV day-aggregates for 624 rows run in seconds.
- **Matplotlib conventions:** match the existing plot style from
  `ml/src/flow_eda.py` / `moc_eda.py` (read those first to see
  figsize, colors, tight_layout usage, etc.). Save as PNG at 150 DPI.
- **Statistical rigor:** Spearman for non-parametric feature-outcome
  correlations; Mann-Whitney U for cohort difference tests; Bonferroni
  correction for multiple comparisons (23 features × 2 symbols = 46 tests,
  so significant threshold = 0.05 / 46 ≈ 0.001).

## Done when

- `ml/src/microstructure_eda.py` runs via CLI and produces:
  - 6 PNG files in `ml/plots/microstructure_q{1..6}_*.png`
  - `ml/findings_microstructure.json` with all 6 question entries
- `ml/tests/test_microstructure_eda.py` has ~6-8 tests, all passing
- `cd ml && .venv/bin/pytest tests/test_microstructure_eda.py` green
- `cd ml && .venv/bin/pytest tests/test_microstructure_features.py tests/test_tbbo_convert.py tests/test_archive_convert.py` all still green (regression)
- `ruff check ml/src/microstructure_eda.py ml/tests/test_microstructure_eda.py` clean
- Q3 either confirms or refutes the spread-widening-zero hypothesis
  with a concrete number (e.g., "95% of ES rows, 97% of NQ rows have
  `spread_widening_max_zscore == 0`")

## Out of scope for Phase 4d

- ML model training / cross-validation.
- Feature selection via L1/importance-based methods (Q5 ranks by
  correlation, not by model-driven methods).
- Spread widening feature remediation (Phase 4c follow-up).
- Backtesting any decision rule derived from findings.
- Railway / Vercel integration. All local file I/O.

## Open questions

- **Outcome window.** Primary = `ret_day` (same-day open-to-close).
  Secondary = `ret_5d` (forward 5-day from close). If other windows
  are obviously interesting (e.g., overnight gap), add in Q4 but
  don't let scope creep beyond 3 windows.
- **Directional vs magnitude signal.** Q5 asks "do features predict
  return *direction*?" via Spearman. If Q5 shows weak direction signal
  but feature values vary widely, a follow-up might ask about magnitude
  (|return|) — flagging as a potential Phase 5 analysis.
