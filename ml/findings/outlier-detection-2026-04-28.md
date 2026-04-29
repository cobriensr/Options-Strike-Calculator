# Outlier Detection — Phase 5 Findings (2026-04-28)

First-pass results from running the multi-criteria outlier scoring + touch-ITM win rule against the 12-day archive (2026-04-13 → 2026-04-28).

## Headline numbers

- **1,387 outliers** across 12 days (median 106/day, range 36–237)
- **619 buyer/seller wins** (touch-ITM rule)
- **634 losses**
- **134 undirected** (`no_side` / `mid` prints — neither buyer nor seller semantics applies)
- **49.4% baseline win rate** (619 / 1253 directed prints) — essentially coin-flip overall
- **18 of 51 stratified buckets** show win rate ≥ 60% (the spec's "exploitable edge" threshold)
- **Concentration check passes**: edge is concentrated in specific buckets, not uniformly elevated → matches the "real signal, not leakage" fingerprint

## Top edge buckets (n ≥ 5)

| Direction         | Time      | DTE   | Family      | n   | Win rate | Wins |
| ----------------- | --------- | ----- | ----------- | --- | -------- | ---- |
| bullish_call_buy  | afternoon | 0DTE  | index_etf   | 18  | 100%     | 18   |
| bearish_put_buy   | open      | 0DTE  | index_etf   | 11  | 100%     | 11   |
| bullish_call_buy  | open      | 0DTE  | index_etf   | 10  | 100%     | 10   |
| bullish_call_buy  | open      | 0DTE  | spx_complex | 9   | 100%     | 9    |
| bullish_call_buy  | afternoon | 0DTE  | single_name | 8   | 100%     | 8    |
| bullish_call_buy  | open      | 8DTE+ | spx_complex | 64  | 68.75%   | 44   |
| bearish_call_sell | close     | 8DTE+ | spx_complex | 27  | 64.0%    | 16   |
| bullish_call_buy  | morning   | 8DTE+ | spx_complex | 47  | 63.8%    | 30   |
| bearish_put_buy   | open      | 8DTE+ | spx_complex | 36  | 61.1%    | 22   |
| bullish_put_sell  | morning   | 8DTE+ | spx_complex | 36  | 61.1%    | 22   |

Two distinct edge regimes emerge:

1. **0DTE index/SPX-complex prints during opening or afternoon** — small samples (n=8–18) but 100% touch-ITM rates. These are the institutional flow patterns the user wanted to find.
2. **8DTE+ SPX-complex prints during open or morning** — larger samples (n=36–64) at 61–69% win rates. Less spectacular but more statistically robust.

## Path-shape splits (within wins)

| Time to ITM                                 | n   | Median MFE (pts) | Close-won rate |
| ------------------------------------------- | --- | ---------------- | -------------- |
| null (sellers — never touched)              | 244 | 122.5            | 100%           |
| Q1_fast (immediate / under quartile cutoff) | 341 | 78.7             | 91%            |
| Q4_slow (slowest quartile)                  | 34  | 2.2              | 44%            |

**Key finding:** the path matters massively.

- **Seller wins** (null time_to_itm = NEVER breached) have the largest median MFE and 100% close-won rate. These are the cleanest signal class — strike never tested at all.
- **Fast-ITM buyer wins** keep their gains 91% of the time at close. Real conviction moves.
- **Slow-ITM buyer wins** round-trip back below the strike 56% of the time. **Lottery tickets** — the touch-ITM rule counts them as wins, but a buyer who held to close would have lost on most of them.

Implication: when this scoring scheme produces a buyer alert mid-session, the **first 30–60 minutes of price action** are highly predictive of whether the win is real. If the underlying is moving toward the strike fast, the trade tends to keep working. If it's grinding slowly toward the strike, hedge or take small profits.

## What worked, what didn't

**Worked:**

- Touch-ITM as the win rule is a clean, interpretable success criterion that matches how 0DTE actually pays
- Per-ticker minute bars synthesized from `underlying_price` are dense enough for the index/ETF universe (no gaps observed in the 33 tickers that produced outliers)
- Multi-criteria scoring at min_score=4 produces ~100 outliers/day — within the 10–500 sweet spot, neither too sparse nor too noisy
- Concentration is real: 18 of 51 buckets at ≥60% with overall baseline 49% is not a uniform lift

**Didn't work / open questions:**

- Many "no_side" / "mid" prints get null `won` (134 of 1387 = 9.6%) — these are aggressive enough by other criteria to score 4+ but UW couldn't classify the aggressor. Worth investigating whether these have systematic patterns the scoring is missing.
- The qcut on time_to_itm_min has heavy duplicates (many wins are immediate, time_to_itm = 0). The Q1_fast / Q4_slow split works but the middle quartiles collapse. Switch to fixed bins (e.g. 0–15min, 15–60min, 60–180min, 180+min) for cleaner buckets.
- Sample sizes for the 100%-win-rate 0DTE buckets are small (8–18). Need 30+ days of data for these to be statistically robust.

## Next steps (recommendations, not committed)

1. **Re-run weekly** as the archive grows. The 8DTE+ patterns at n=36–64 are ready to validate against more data; the 0DTE patterns need n=30+ before believing them.
2. **Investigate `no_side` prints** — these score 4+ on the criteria but lack direction. Are they large blocks negotiated at mid?
3. **Calibrate the user's existing 2 intraday detectors** against the high-edge buckets — see if the detectors are firing on the patterns this analysis flags as profitable.
4. **Consider adding a fast-vs-slow filter to live alerts** — based on the path-shape data, suppress alerts where the underlying isn't moving toward the strike within 30 minutes.

## Reproducibility

```bash
set -a; source .env.local; set +a
ml/.venv/bin/python ml/notebooks/outlier-discovery.py
```

Runs in ~34s on a populated local cache. ~3 min on a cold cache (downloads 6.3 GB from Vercel Blob).

Override the threshold via env: `MIN_SCORE=5 ml/.venv/bin/python ml/notebooks/outlier-discovery.py`.

---

## Update: per-ticker drilldown (2026-04-29)

Generated by `ml/notebooks/per-ticker-summary.py` and `ml/notebooks/outlier-plots.py`. Plots in `ml/plots/outlier-discovery/`.

### The headline ticker insight: SPY > SPX

| Ticker | n_directed | Win rate | Median premium |
| --- | --- | --- | --- |
| **SPY** | **138** | **63.0%** | $0.05M |
| SPXW | 182 | 52.7% | $8.2M |
| QQQ | 37 | 54.1% | $0.06M |
| SPX | 790 | 46.0% | $8.8M |

**SPY is the only large-sample ticker that meaningfully beats the 50% baseline.** SPX dominates by raw outlier count (892 outliers, 363 wins) but its win rate is 46% — essentially a coin flip. SPXW is similar.

Hypothesis: SPX whale prints are mostly **portfolio rebalancing / institutional crossing** at the index level, not directional bets. They're huge by premium ($8M median) but uninformative for direction. SPY prints are smaller in dollars ($50K median) but represent **directional positioning by parties expressing a view on the index** — and that view is right 63% of the time.

This inverts the natural intuition that "follow the biggest money" works. The biggest money in SPX is mostly hedging; the smaller-but-directional money in SPY is the actual signal.

### Single-name standouts (small n, treat as leads)

These won every directed outlier in the 12-day sample but have small n — promising patterns to track as the archive grows:

- **TSM**: 6/6 wins (100%, all directed)
- **RUT**: 4/4 wins
- **NFLX**: 2/2 wins
- **META**: 4/5 wins (80%)

### Single-name losers

- **NVDA**: 2 wins / 6 losses (25%) — flagged outliers tend to NOT predict its direction
- **MU**: 1/4 (20%)
- **TSLA**: 7/9 directed = 44%
- **MSFT**: 30%, **AMD**: 38%

When the scoring scheme flags an NVDA or MU print, do the opposite of what the print suggests, or ignore.

### Score distribution sanity check

From the 3-day score histogram (~30M prints):

- score 0: 21M (71%)
- score 1: 8.5M (29%)
- score 2: 320K
- score 3: 30K
- **score 4: ~340 (~110/day)** ← our threshold
- score 5: 1 (across 3 days)

`min_score=4` sits in the right zone — score 3 would balloon to 10K outliers/day (unmanageable), score 5 would give us ~3/day (too sparse). The 4→3 boundary represents a 100× reduction in count.

### Implications for the live detectors

1. **Filter live alerts to SPY + index_etf family by default.** Single-name alerts will be mostly noise unless they're TSM/RUT/META class.
2. **Drop alerts on NVDA/MU/MSFT/AMD** — historically anti-predictive at the score≥4 threshold.
3. **0DTE bullish_call_buy in afternoon (index_etf)** is the highest-conviction setup the data shows — but small n. Track aggressively as more data lands.
4. **8DTE+ SPX-complex bullish_call_buy in open/morning** is the most statistically robust edge (n=64, 69%). Consider adding a "morning index-call-buy on size" alert to the live system if not already covered.
