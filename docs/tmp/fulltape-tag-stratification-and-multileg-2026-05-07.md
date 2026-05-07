# Full Tape × lottery_finder: tag stratification + delta-based multi-leg filter

**Date:** 2026-05-07
**Data:** 3 trading days (2026-05-04 / 05 / 06), 30,458,824 Full Tape rows, 19,849 lottery_finder fires

## TL;DR — two findings worth acting on

1. **`earnings_this_week` is a clear signal-quality flag.** Lottery fires tagged `earnings_this_week` win at 15.2% vs 31.3% without (-16.1 pp lift). Filtering them out would have improved the 3-day median peak ceiling from +25.3% → +25.3% on a healthier subset.
2. **76% of $1M+ "whales" are spread legs, not naked directional bets.** The delta-based multi-leg filter (now properly computed) classifies whale candidates with high confidence. The bigger the trade, the more likely it's a spread leg.

Caveats: 3 days is too small for statistical significance. Some tags (`index`, `china`) have <200 fires. Re-run at 5-10 days before trusting numbers.

---

## Analysis 1 — Tag stratification of lottery fires

### Tag presence rates among 19,849 fires

| Tag                   | Fires with tag | % of fires                                |
| --------------------- | -------------- | ----------------------------------------- |
| `bullish` / `bearish` | ~19,845 each   | ~100% (universal — useless as a filter)   |
| `earnings_this_week`  | 2,984          | 15.0%                                     |
| `etf`                 | 1,950          | 9.8%                                      |
| `earnings_next_week`  | 804            | 4.0%                                      |
| `index`               | 149            | 0.75%                                     |
| `china`               | 136            | 0.69%                                     |
| `heavily_shorted`     | 0              | none — never tagged on lottery candidates |
| `dividend`            | 0              | none                                      |
| `arbitrage`           | 0              | none                                      |

The "earlier-pitched" rare tags (`heavily_shorted`, `dividend`, `arbitrage`) **don't appear in lottery_finder candidates at all**. Lottery's filter pre-excludes them. That's a useful negative finding.

### Realized P&L by tag presence

| Tag                    | n_with | n_without | med peak with | med peak without | med EOD with | med EOD without |
| ---------------------- | ------ | --------- | ------------- | ---------------- | ------------ | --------------- |
| **earnings_this_week** | 2,984  | 16,865    | **+15.0%**    | +25.3%           | -2.2%        | -11.1%          |
| earnings_next_week     | 804    | 19,045    | +19.1%        | +23.2%           | -0.5%        | -9.8%           |
| etf                    | 1,950  | 17,899    | +8.6%         | +24.4%           | -10.5%       | -9.0%           |
| **index**              | 149    | 19,700    | **+25.3%**    | +22.9%           | -12.1%       | -9.4%           |
| china                  | 136    | 19,713    | +20.3%        | +23.0%           | +1.7%        | -9.5%           |

### Win rate (peak ceiling ≥ 50%) by tag presence

| Tag                    | with tag  | without tag | lift         |
| ---------------------- | --------- | ----------- | ------------ |
| **earnings_this_week** | 15.2%     | 31.3%       | **-16.1 pp** |
| earnings_next_week     | 23.5%     | 29.1%       | -5.6 pp      |
| etf                    | 23.6%     | 29.4%       | -5.8 pp      |
| **index**              | **43.6%** | 28.7%       | **+14.9 pp** |
| china                  | 27.2%     | 28.9%       | -1.7 pp      |

### Reads

- **`earnings_this_week` is the strongest negative signal in this 3-day window.** Fires on tickers reporting earnings within the week peak lower (+15 vs +25) and win less often (15% vs 31%). Mechanism is plausible: post-earnings IV crush eats premium even when direction is right. **This is the most actionable finding.**

- **`index` (SPX/NDX options) is unexpectedly positive** — 44% win rate vs 29% baseline. Tiny sample (149) but worth confirming. If real, it might mean lottery_finder's signal-to-noise is much higher on index options than equities. Counterintuitive given how crowded SPX flow is.

- **`etf` and `earnings_next_week` both -5 to -6 pp** — small but consistent drag.

- **The EOD column is harder to interpret.** Earnings-week fires have HIGHER EOD (-2.2 vs -11.1) but LOWER peaks. That implies their P&L is more bimodal: less explosive upside, but also less drift back to zero. Worth a closer look once corpus is bigger.

---

## Analysis 2 — Delta-based multi-leg filter on whale candidates

This is the corrected version after learning that `multi_vol` is a cumulative strike-level rollup. Per-trade multi-leg detection requires:

```python
ft.sort(["option_chain_id", "executed_at"])
  .with_columns(
      (pl.col("multi_vol") - pl.col("multi_vol").shift(1).over("option_chain_id"))
        .fill_null(pl.col("multi_vol"))
        .alias("mv_delta"),
  )
```

`mv_delta > 0` ⇒ this trade was a multi-leg trade (or one of its legs).

### Multi-leg rate by premium threshold

| Premium ≥ | n whales    | multi-leg  | %         | stock+option | %    |
| --------- | ----------- | ---------- | --------- | ------------ | ---- |
| $25K      | 590,568     | 267,324    | 45.3%     | 7,475        | 1.3% |
| $50K      | 279,929     | 145,171    | 51.9%     | 4,701        | 1.7% |
| **$100K** | **133,059** | **78,044** | **58.7%** | 2,828        | 2.1% |
| $250K     | 50,340      | 34,150     | 67.8%     | 1,239        | 2.5% |
| $500K     | 23,934      | 17,509     | 73.2%     | 600          | 2.5% |
| **$1M+**  | **10,608**  | **8,025**  | **75.7%** | 292          | 2.8% |

**Baseline (all 30.4M trades): 24.7% multi-leg.**

### Sanity check on $100K+ whales (n=133,059)

- 56.4% — `mv_delta == size` exactly: the entire trade is a multi-leg leg
- 2.3% — `mv_delta > 0` but `≠ size`: partial multi-leg attribution (likely a complex spread split across rows)
- 38.8% — `mv_delta == 0`: purely naked directional bet

The remaining ~2.5% are negative-delta edge cases (sort artifacts, tiny number).

### What the top whales actually are

The 10 highest-premium whales in the 3-day window are all **SPX index calls at round strikes 5000-6500, expiries June/Sep/Dec 2026**, with sizes of 2,500-3,500 contracts and premiums of \$340M-\$700M each. Tags: `{bid_side,bearish,index}` or `{ask_side,bullish,index}`. These look like:

- Dealer hedging via long-dated SPX wings
- Institutional risk transfer via complex spreads
- NOT directional 0DTE conviction bets

This is exactly the kind of trade you'd want filtered OUT of "whale" lists when building intraday directional signals. The current pipelines treat them indistinguishably.

### Reads

- **The "naked vs spread leg" filter is load-bearing.** 76% of $1M+ trades the system would currently flag as whales are actually multi-leg. Filtering them out would shrink the whale pool by ~75%, but the remaining trades would be much higher signal-to-noise.
- **The relationship is monotonic with size:** as premium goes up, % multi-leg goes UP, not down. Counter to intuition that "bigger = more conviction" — bigger means more likely to be hedged/spread-structured.
- **Stock+option combos are tiny (~2-3%)** — minor source of noise, but worth flagging for completeness.

---

## What I'd actually do with this (no rush)

Two distinct, non-blocking research items:

1. **Add `earnings_this_week` as a lottery scoring penalty.** Conservative: weight fires with this tag at 0.7×. Aggressive: filter them out entirely. Either way, validate against ≥10 days of corpus first.

2. **Add multi-leg classification to the whale-detection pipeline.** Compute `mv_delta` per row at ingest time, store as a column. Whale-detection scoring then becomes: (premium × naked_directional_flag) instead of (premium × side). Big infrastructure work — a separate spec.

Don't act on these yet. Wait until the corpus has 5-10 days, re-run the analysis, confirm the directions hold.

## Reproduction

Script: `/tmp/fulltape-analysis.py` (throwaway). To re-run:

```bash
ml/.venv/bin/python /tmp/fulltape-analysis.py
```

Re-runs against whatever Full Tape parquets are in `~/Desktop/Eod-Full-Tape-parquet/` plus the live `lottery_finder_fires` table.
