# Microstructure OFI Signal — Validated on NQ, Null on ES

**Status:** Open, positive result on NQ. Actionable rule adopted. Wiring to analyze context pending (Phase 5a).
**Date range studied:** 2025-04-20 → 2026-04-17 (312 trading days × 2 symbols)
**Data cost:** ~$0 (1-year TBBO pull is included in the $179/mo Databento Standard L1 allowance)
**Code:** `ml/src/features/microstructure.py`, `ml/src/microstructure_eda.py`
**Raw findings:** `ml/findings_microstructure.json` + `ml/plots/microstructure_q{1..6}_*.png`

---

## Question

Does aggressor-classified order flow on ES or NQ front-month futures
predict same-day or next-5-day returns? If yes, at what timeframe and
with what effect size?

Motivation: the live Phase 2b analyze context already computes OFI,
spread-widening z-score, and TOB pressure as signals, but none of
those have been empirically validated against trade outcomes. Before
spending engineering hours wiring more microstructure features into
Claude's prompt, confirm the signal exists.

## Data

- Databento TBBO, dataset `GLBX.MDP3`, parent symbols `ES.FUT` + `NQ.FUT`,
  2025-04-20 → 2026-04-17 (312 daily DBN files, ~5 GB compressed).
- Converted to year-partitioned Parquet via `ml/src/tbbo_convert.py`
  (Phase 4a). Output: 210.6M trade events across 16 contracts.
- Per-day microstructure features computed via
  `ml/src/features/microstructure.py` (Phase 4c). Output: 624 rows × 28
  columns at `ml/data/features/microstructure_daily.parquet`.
- Outcomes (`ret_day`, `ret_5d`, `regime_label`) derived from the 17-year
  OHLCV archive via `derive_outcomes()` in the EDA module.
- Total engineering time: ~6 hours across 4 sub-phases (converter,
  features, EDA, fix-pass).

## Key result

| Symbol | Best feature   | Spearman ρ | Raw p | Bonferroni p (n=46) | Verdict         |
| ------ | -------------- | ---------- | ----- | ------------------- | --------------- |
| **NQ** | `ofi_1h_mean`  | **+0.313** | 0.000 | **0.000**           | **Significant** |
| **NQ** | `ofi_15m_mean` | +0.278     | 0.000 | 0.000               | Significant     |
| **NQ** | `ofi_5m_mean`  | +0.235     | 0.000 | 0.001               | Significant     |
| ES     | `ofi_1h_std`   | +0.141     | 0.014 | 0.624               | Not significant |
| ES     | `ofi_1h_mean`  | +0.131     | 0.022 | 1.000               | Not significant |

**NQ**: three OFI features survive Bonferroni correction at p < 0.001
with Spearman ρ strictly monotone in window length (5m < 15m < 1h).
Positive ρ — aggressive buying predicts higher same-day return.

**ES**: no feature survives Bonferroni correction. Best raw-p would
look significant in a naive analysis but falls apart under the
multiple-testing threshold.

## Why the asymmetry

Two reinforcing explanations, both consistent with the data:

1. **ES is too arbitraged.** It is the most liquid stock-index futures
   contract on Earth. Microstructure imbalances get absorbed by HFT
   and informed flow within minutes, so aggregate OFI-over-the-day
   doesn't leak into end-of-day return.
2. **SPX 0DTE options soak up ES-directional flow.** 0DTE volume on
   SPX options exceeds ES futures volume on a typical day. Institutional
   directional exposure routes through SPX options instead of ES
   futures, bypassing ES microstructure entirely. NDX doesn't have a
   comparable 0DTE-options ecosystem, so NQ microstructure still
   carries the directional flow.

## What this means for the product

- **Do wire NQ 1h OFI into the analyze context.** Effect size ρ=0.31 is
  tradeable as a factor (not as a standalone strategy). Primary use:
  same-day regime gate on NQ-correlated decisions + cross-asset
  divergence warning ("SPX setup looks bullish, NQ tape says otherwise").
- **Do NOT wire ES microstructure as a directional predictor.** Phase 2b
  already computes ES OFI/spread/TOB and surfaces them in the analyze
  context. Keep them as _tape-flavor_ context (Claude can read them as
  qualitative signal), but treat quantitative claims like "positive ES
  OFI implies positive ES return" as unsupported.
- **Do NOT train a classifier on ES microstructure features.** They
  carry no Bonferroni-significant signal vs next-day outcomes.

## Feature redundancy (Q2 correlation findings)

The feature matrix has 11 pairs with |ρ| > 0.9, meaning ML should pick
one representative per family rather than training on all 23 features:

| Family          | Representative               | Runner-up(s)                                  |
| --------------- | ---------------------------- | --------------------------------------------- |
| OFI (windows)   | `ofi_1h_mean`                | ρ≈0.92-0.96 with 5m/15m variants              |
| Tick velocity   | `tick_velocity_p95`          | ρ=0.97 with `mean`                            |
| Spread widening | `spread_widening_max_zscore` | ρ>0.9 with count variants                     |
| TOB pressure    | `tob_mean_abs_log_ratio`     | moderate correlation with run-length features |

## Known limitations

- **Sample size:** 312 days per symbol. Small by ML standards. Findings
  should be re-validated after another 6 months of live data accumulates.
- **Regime coverage:** the 2025-04 → 2026-04 window includes a bull
  market. Effect size may differ in volatile or trending-down regimes.
  Phase 4d's `is_degraded` filter excluded 6 degraded days × 2 symbols
  (12 rows) from Q5/Q6.
- **Spread widening on ES:** ~~80.1% zero-rate~~ **RESOLVED in Phase 4c1
  (2026-04-20).** Aggregator switched from `median(ask-bid)` to
  `MAX(ask-bid)`; zero-rate dropped ES 80.1%→3.5%, NQ stayed 0.0%.
  See "Phase 4c1 retest" section below.
- **`ret_5d` approximation:** forward window is calendar-days-based
  (`[t+5, t+9]` first-available close on same contract) rather than
  trading-days-based. Coarse but bias-free; documented in code.

## Operational plan (Phase 5a — separate spec)

Wire NQ 1h OFI into the analyze context as a dedicated block. Four
concrete changes:

1. **Sidecar:** add `NQ.FUT` to the existing `tbbo` live subscription
   in `sidecar/src/databento_client.py`. Both tables (`futures_trade_ticks`
   and `futures_top_of_book`) already take a `symbol` column, so no
   schema change is needed.
2. **Compute layer:** extend `api/_lib/microstructure-signals.ts` to
   compute NQ OFI in parallel with ES. Return structure becomes
   per-symbol.
3. **Analyze context:** add a new formatter block exposing NQ 1h OFI +
   classification (`AGGRESSIVE_BUY`, `AGGRESSIVE_SELL`, `BALANCED`)
   alongside the existing ES microstructure block.
4. **Prompt interpretation rules:** add to the cached system prompt —
   "NQ 1h OFI predicts next-day NQ return at ρ=0.31 (p<0.001, n=312).
   Positive = buyer aggression, negative = seller aggression. Use as
   a regime gate and cross-asset confirmation for SPX decisions, not
   as a standalone trigger."

Estimated effort: ~8 hours across 4 files + tests.

## Historical re-validation schedule

- Re-run `.venv/bin/python -m src.microstructure_eda ...` quarterly
  against the rolling 1-year TBBO archive as live data extends the
  window.
- If NQ OFI ρ drops below 0.15 or p_bonf rises above 0.01 on a rolling
  basis, revisit the feature's inclusion in analyze context. Sample
  every ~3 months or after significant regime changes (FOMC pivot,
  VIX regime shift, etc.).
- If ES OFI ever surfaces signal in a future run (e.g., regime shift
  makes SPX 0DTE less liquid and flow returns to ES), reopen the ES
  decision.

## Phase 4c1 retest (2026-04-20)

After switching the per-minute spread aggregator from
`percentile_cont(0.5)` (median) to `MAX(ask - bid)` at commit
`3ec1cdc`, the 1-year backfill was re-run and Phase 4d EDA re-executed
against the fresh feature matrix. Same 624 rows, same date range.

### Zero-rate change (Q3)

| Symbol | Pre-fix (median) | Post-fix (max) | Delta     |
| ------ | ---------------- | -------------- | --------- |
| ES     | 80.1%            | **3.5%**       | −76.6 pp  |
| NQ     | 0.0%             | 0.0%           | no change |

The ES zero-rate collapse confirms the Phase 4c hypothesis: median
was hiding widening events behind the $0.25 tick-size floor. Under
MAX, any single widened quote in a minute registers, so 96.5% of ES
days now show at least one widening event.

### Q5 signal impact (this is the load-bearing result)

**NQ signals unchanged.** The validated OFI trio survives Bonferroni
at identical ρ values to Phase 4d:

- `ofi_1h_mean` ρ=+0.313, p_bonf<0.001
- `ofi_15m_mean` ρ=+0.278, p_bonf<0.001
- `ofi_5m_mean` ρ=+0.235, p_bonf=0.001

**Spread widening family still does not surface Bonferroni-significant
signal on either symbol.** ES top-7 is OFI-dominated (top
`ofi_1h_std` ρ=0.141, p_bonf=0.624); no spread feature appears.
NQ top-7 is OFI + tick-velocity; no spread feature appears.

### Interpretation

The fix was worth shipping — it eliminates a data-quality bug and
makes the feature analytically sound. But the fix did NOT produce a
new validated signal. Two reasonable readings:

1. **ES is still too arbitraged.** The "ES OFI carries no signal
   because SPX 0DTE soaks up directional flow" hypothesis from the
   original Phase 4d finding applies to spread widening too. The
   spread information is real (we can now see it), but it gets
   arbitraged before it predicts end-of-day return.
2. **Daily aggregation dilutes the signal.** MAX-based widening
   events may carry intraday predictive value that a daily
   aggregation hides. If a future phase backtests intraday signals,
   this feature may still earn its keep.

### What changed in the operational stack

- `ml/src/features/microstructure.py` — aggregator swap (commit `3ec1cdc`)
- `ml/data/features/microstructure_daily.parquet` — regenerated 2026-04-20
- `ml/findings_microstructure.json` — regenerated 2026-04-20
- `ml/plots/microstructure_q{1..6}_*.png` — regenerated 2026-04-20

### What did NOT change

- Analyze context wiring (Phase 5a) — still surfaces NQ 1h OFI live.
  No new feature promoted.
- Cached prompt interpretation rules (Phase 5a) — still reference
  the unchanged NQ OFI validation (ρ=0.313, p_bonf<0.001, n=312).
- ES-microstructure-is-tape-flavor-only guidance — still holds.

## References

- Phase 4a converter spec: `docs/superpowers/specs/phase3a-tbbo-convert-2026-04-18.md`
- Phase 4c feature spec: `docs/superpowers/specs/phase4c-microstructure-features-2026-04-18.md`
- Phase 4c1 aggregator fix: commit `3ec1cdc` (2026-04-19)
- Phase 4d EDA spec: `docs/superpowers/specs/phase4d-microstructure-eda-2026-04-19.md`
- Max-leverage roadmap: `docs/superpowers/specs/max-leverage-databento-uw-2026-04-18.md`
