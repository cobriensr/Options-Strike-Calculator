# Phase E Rollup — IV-Anomaly Cross-Asset Enrichment (2026-04-25, REVISED)

**Status:** corrected after the Phase A-E review (commit `f9fa0e2`)
fixed the regime-classification bug. Several findings shifted; the
"91.7% / n=36" headline survived but moved from `strong_trend_up` to
`mild_trend_up` — the underlying alerts didn't change, only the
regime label they were sitting under. Read this version, not the
pre-revision one.

Five retroactive cross-asset features computed _at alert_ts_ and
stratified by D0's regime spine.

**Sample:** 15,886 backfill alerts, 10 days, 13 tickers.

## What changed in the revision

The previous regime labels came from clustering of alert
`spot_at_detect` / `close_spot` values, not from full session bounds.
For tickers whose alerts cluster in narrow windows (NDXP, single
names, IWM), this systematically biased labels toward "less trending"
buckets — but for SPXW/SPY it accidentally went the OTHER direction
because the alert window often anchored on early spot and end-of-day
spot, exaggerating the move. The fix uses the actual day's earliest
and latest snapshot from `strike_iv_snapshots`.

Notable label shifts:

- SPXW 4/14: `strong_trend_up` (+1.02%) → `chop` (+0.24%)
- SPXW 4/13: `strong_trend_up` (+1.71%) → `mild_trend_up` (+0.57%)
- SPXW 4/16: `strong_trend_up` (+1.34%) → `mild_trend_up` (+0.26%)
- The previous `strong_trend_up` bucket was 7 of 10 SPXW days; now
  it's 0. Most days that _felt_ like strong-trend days were actually
  mild_trend or chop by the strict open-to-close measure.

## Top filters by win rate (revised)

Ranked by win rate × sample size × dollar mean, n ≥ 30:

| Rank | Filter                                                 |      n |     Win % |          Mean $/contract | Source |
| ---- | ------------------------------------------------------ | -----: | --------: | -----------------------: | ------ |
| 1    | SPXW × `mild_trend_up` × $500M+ DP at strike + call    | **36** | **91.7%** |              **+$1,783** | E2     |
| 2    | NDXP × `chop` + call                                   |     39 | **82.0%** | +$1,584 (median +$1,700) | D0     |
| 3    | SPXW × `mild_trend_up` × $200-500M DP at strike + call |     42 | **71.4%** |                    +$673 | E2     |
| 4    | SPX-family × `mild_trend_up` × below-spot GEX + call   |    195 | **68.7%** |                **+$854** | E4     |
| 5    | MSFT × `mild_trend_up` + call                          |     45 |     66.7% |          +$2 (mean +$44) | D0     |
| 6    | NDXP × `mild_trend_up` + call                          |     57 |     52.6% |                  +$1,085 | D0     |
| 7    | META × `mild_trend_up` + call                          |     44 | **88.6%** |                     +$77 | D0     |

Note that the 91.7% (n=36) E2 finding is **the same alerts** as
before — the dollar magnitude and win rate are identical. The
bucket label changed because those days are now correctly classified
as `mild_trend_up` instead of `strong_trend_up`.

## What each sub-phase added (revised)

### E1 — Index leadership (NQ/ES/RTY vs SPX, 15-min window)

The "alignment inverts by regime" pattern is weaker than originally
reported. Per-regime alignment effect on calls (n ≥ 100):

| Regime          |         Aligned |    Contradicted |                 Edge |
| --------------- | --------------: | --------------: | -------------------: |
| `mild_trend_up` | 40.8% (n=1,208) |   38.4% (n=451) |                 +2pt |
| `chop`          | 13.1% (n=1,730) | 20.7% (n=1,521) | **−8pt** _(inverts)_ |

The chop-day inversion still holds (−8pt). The trending-up alignment
edge collapsed from +11pt to +2pt — the previous +11pt was partly
a regime-mislabeling artifact. Practical takeaway: **alignment is a
weak filter on trending days; on chop days, contradicted tape
genuinely outperforms aligned**.

### E2 — Dark-print proximity (SPXW only)

Strongest single filter found in the dataset, label-corrected.
SPXW call alerts on `mild_trend_up` days with $500M+ dark-pool
premium clustered at the alerted strike: **91.7% win (n=36),
+$1,783 median**. Tighter pairs:

| DP at strike |      n |     Win % |    Median $ |
| ------------ | -----: | --------: | ----------: |
| $200-500M    |     42 |     71.4% |       +$673 |
| $500M+       | **36** | **91.7%** | **+$1,783** |

Sample-size caveat (n=36, 10 days) still applies. The "tentative"
flag in the UI tooltip remains appropriate.

### E3 — VIX direction (30-min change before alert)

Falling VIX is no longer the cleanest put-side signal. Strongest cell:
**chop × falling VIX × put: 27.7% win, +$66 mean (n=137)** — down
from the pre-revision 44.9% (n=78). Sample size larger, signal
weaker. Still the only put-side bucket with positive mean dollar.

### E4 — GEX position (top-3 abs_gex strike vs spot)

The "GEX below spot helps calls" finding got _stronger_ under
correct labels:

| Filter                                  |     n |     Win % |    Mean $ |
| --------------------------------------- | ----: | --------: | --------: |
| `mild_trend_up` × below-spot GEX + call |   195 | **68.7%** | **+$854** |
| `mild_trend_up` × above-spot GEX + call |   827 |     39.7% |      +$19 |
| `chop` × below-spot GEX + call          |   308 |     22.1% |     +$114 |
| `chop` × above-spot GEX + call          | 2,048 |     13.7% |      -$29 |

Below-spot GEX is the cleanest single signal in the entire study
when the regime is mild_trend_up. The dealer-positioning logic
(GEX below spot = support zone, room to run) holds and amplifies.

### E5 — Macro event proximity

Still null. 5 high-impact events in the window, all pre-market,
zero alerts within ±30min. Re-test when CPI/FOMC/NFP days are in
the data.

## Three composable filter chains (revised)

If wired as production prominence flags:

**Chain A — SPXW high-conviction call setup**

```
SPXW alert is a call AND
day's regime = mild_trend_up AND
$500M+ dark-pool premium at the alert strike (±5pts)
→ 91.7% historical win rate, +$1,783 median dollar gain (n=36)
```

**Chain B — Gamma-zone call**

```
SPX-family alert is a call AND
regime = mild_trend_up AND
nearest top-3 abs_gex strike is below current spot
→ 68.7% win rate, +$854 mean dollar gain (n=195)
```

**Chain C — NDXP chop call**

```
NDXP alert is a call AND
regime = chop
→ 82.0% win rate, +$1,584 mean dollar (n=39)
```

The original "tape-aligned + trending up" Chain B from the
pre-revision rollup is no longer worth flagging — only +2pt edge
in the corrected data.

## What still doesn't work

- **Puts almost everywhere.** Still capped at ~10% win rate across
  most regimes. The 10-day mostly-bullish window remains the
  simplest explanation; need a real downtrend window to test fairly.
- **Macro-event timing (E5).** Sample-period gap.
- **`strong_trend_up` and `extreme_up` buckets.** With session
  bounds, these are mostly empty (n=7 strong, n=3 extreme on
  SPXW); cell-level conclusions there require more data.
- **Alignment as a standalone filter.** Now too weak to act on.

## What changes for production (revised)

### High confidence — wire into UI / analyze prompt

1. **Surface DP-premium-at-strike on SPXW alerts.** When >$500M
   DP-at-strike on an SPXW call alert AND regime is
   `mild_trend_up`, show a green confidence indicator with
   "+91.7% historical (n=36, tentative)".
2. **Surface GEX position vs spot.** "Nearest top-3 GEX is below
   spot" → green confidence on call alerts (especially on
   `mild_trend_up`). 68.7% win at that combo.
3. **NDXP chop calls** — surface as a high-conviction setup.
   82.0% win (n=39) on chop days; the "NDXP behaves differently"
   finding is louder than ever.

### Medium confidence — needs more data

4. Falling-VIX + put marker — n=137 in chop, 27.7% win. Still
   directional, weaker than before.
5. Per-(ticker, regime) BEST_STRATEGY — D0's regime-conditional
   table still corrects ticker-level picks but with smaller per-
   cell sample.

### Low confidence — defer

6. Tape-alignment filter (E1) — only +2pt edge on trending days
   now. Drop from production unless re-validated.
7. Macro-event filter (E5) — null in this sample.

## Deliverables

| Phase    | Script                                | Findings                                                               | Report                                                               |
| -------- | ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Builder  | `ml/build-regime-labels.py`           | `iv-anomaly-regime-labels-2026-04-25.parquet`                          | —                                                                    |
| Utils    | `ml/iv_anomaly_utils.py`              | (shared library)                                                       | —                                                                    |
| E1       | `ml/extract-iv-anomaly-leadership.py` | `iv-anomaly-leadership-2026-04-25.json`                                | `iv-anomaly-leadership-2026-04-25.md`                                |
| E2       | `ml/extract-iv-anomaly-darkprint.py`  | `iv-anomaly-darkprint-2026-04-25.json`                                 | `iv-anomaly-darkprint-2026-04-25.md`                                 |
| E3+E4+E5 | `ml/extract-iv-anomaly-e345.py`       | `iv-anomaly-{vix-direction,gex-position,macro-events}-2026-04-25.json` | `iv-anomaly-{vix-direction,gex-position,macro-events}-2026-04-25.md` |
| Rollup   | (this file)                           | —                                                                      | `iv-anomaly-phase-e-summary-2026-04-25.md`                           |
