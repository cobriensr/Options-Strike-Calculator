# Microstructure OFI Signal — Validated on NQ, Null on ES

**Status:** Shipped. Phase 5a wiring complete — dual-symbol OFI + historical percentile rank now in Claude's cached system prompt on every analyze call. Re-validation schedule (quarterly) is the remaining governance.
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

| Symbol | Best feature | Spearman ρ | Raw p | Bonferroni p (n=46) | Verdict |
|---|---|---|---|---|---|
| **NQ** | `ofi_1h_mean` | **+0.313** | 0.000 | **0.000** | **Significant** |
| **NQ** | `ofi_15m_mean` | +0.278 | 0.000 | 0.000 | Significant |
| **NQ** | `ofi_5m_mean` | +0.235 | 0.000 | 0.001 | Significant |
| ES | `ofi_1h_std` | +0.141 | 0.014 | 0.624 | Not significant |
| ES | `ofi_1h_mean` | +0.131 | 0.022 | 1.000 | Not significant |

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
  context. Keep them as *tape-flavor* context (Claude can read them as
  qualitative signal), but treat quantitative claims like "positive ES
  OFI implies positive ES return" as unsupported.
- **Do NOT train a classifier on ES microstructure features.** They
  carry no Bonferroni-significant signal vs next-day outcomes.

## Feature redundancy (Q2 correlation findings)

The feature matrix has 11 pairs with |ρ| > 0.9, meaning ML should pick
one representative per family rather than training on all 23 features:

| Family | Representative | Runner-up(s) |
|---|---|---|
| OFI (windows) | `ofi_1h_mean` | ρ≈0.92-0.96 with 5m/15m variants |
| Tick velocity | `tick_velocity_p95` | ρ=0.97 with `mean` |
| Spread widening | `spread_widening_max_zscore` | ρ>0.9 with count variants |
| TOB pressure | `tob_mean_abs_log_ratio` | moderate correlation with run-length features |

## Known limitations

- **Sample size:** 312 days per symbol. Small by ML standards. Findings
  should be re-validated after another 6 months of live data accumulates.
- **Regime coverage:** the 2025-04 → 2026-04 window includes a bull
  market. Effect size may differ in volatile or trending-down regimes.
  Phase 4d's `is_degraded` filter excluded 6 degraded days × 2 symbols
  (12 rows) from Q5/Q6.
- **Spread widening on ES:** 80.1% zero-rate (spread pinned at $0.25
  tick-size floor). Current `median(ask-bid)` aggregator is the wrong
  statistic for a minimum-tick-width product; `max(ask-bid)` or
  `percentile_cont(0.95)` would surface widening events the median
  collapses. Tracked as Phase 4c follow-up.
- **`ret_5d` approximation:** forward window is calendar-days-based
  (`[t+5, t+9]` first-available close on same contract) rather than
  trading-days-based. Coarse but bias-free; documented in code.

## Operational plan (Phase 5a — shipped)

All four planned changes are live:

1. **Sidecar:** `sidecar/src/databento_client.py:213-217` subscribes to
   `["ES.FUT", "NQ.FUT"]` TBBO on CME GLBX.MDP3 with `stype_in="parent"`.
   Both tables (`futures_trade_ticks`, `futures_top_of_book`) carry a
   `symbol` column; `_handle_tbbo` dispatches on it.
2. **Compute layer:** `api/_lib/microstructure-signals.ts:428`
   (`computeAllSymbolSignals`) runs ES and NQ in parallel via
   `Promise.allSettled` and returns `DualSymbolMicrostructure { es, nq }`.
3. **Analyze context:** `api/_lib/analyze-context-fetchers.ts` →
   `fetchMicrostructureBlock()` calls `computeAllSymbolSignals` +
   `fetchPercentileRanks` (historical 252-day rank per symbol via the
   sidecar `/archive/tbbo-ofi-percentile` endpoint) and passes both
   into `formatMicrostructureDualSymbolForClaude()`. Injected at
   `analyze-context.ts:376` under the header `## Dual-Symbol
   Microstructure Signals (ES + NQ, ...)`.
4. **Prompt interpretation rules:** `api/_lib/analyze-prompts.ts:958-987`
   inside `<microstructure_signals_rules>`. Tier ladder (BALANCED /
   MILD / AGGRESSIVE_BUY / AGGRESSIVE_SELL), cross-asset divergence
   rule, explicit note that ES OFI is qualitative only, reminder that
   intraday decay makes pre-11:00 ET OFI more predictive. The entire
   block is inside `SYSTEM_PROMPT_PART1`, which is glued into
   `stableSystemText` with `cache_control: { type: 'ephemeral', ttl: '1h' }`
   in `api/analyze.ts:158-161` — so the rule is cached, not re-sent on
   every call.

**Supporting infra:**

- Pre-warm cron `api/cron/warm-tbbo-percentile.ts` runs `0 13 * * 1-5`
  to exercise the sidecar percentile endpoint before market open,
  keeping the DuckDB parquet page cache warm (25–35s cold → 1–3s warm).
- Tests: `api/__tests__/microstructure-signals.test.ts`,
  `api/__tests__/analyze-context-microstructure.test.ts`,
  `api/__tests__/warm-tbbo-percentile.test.ts`,
  `api/__tests__/archive-sidecar.test.ts`.
- Phase 4b shipped the 1-year TBBO archive onto the Railway sidecar's
  `/data` volume so the historical percentile query has data to rank
  against.

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

## References

- Phase 4a converter spec: `docs/superpowers/specs/phase3a-tbbo-convert-2026-04-18.md`
- Phase 4c feature spec: `docs/superpowers/specs/phase4c-microstructure-features-2026-04-18.md`
- Phase 4d EDA spec: `docs/superpowers/specs/phase4d-microstructure-eda-2026-04-19.md`
- Max-leverage roadmap: `docs/superpowers/specs/max-leverage-databento-uw-2026-04-18.md`
