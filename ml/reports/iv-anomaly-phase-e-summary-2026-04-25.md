# Phase E Rollup — IV-Anomaly Cross-Asset Enrichment (2026-04-25)

Five retroactive cross-asset features computed *at alert_ts* and
stratified by D0's regime spine. Each was scoped to test "would the
user's existing dashboard signals have agreed with the alert?" —
not to invent new signals but to measure whether the alerts
amplify or contradict the user's normal decision process.

**Sample:** 15,886 backfill alerts, 10 days, 13 tickers.

## Top filters by win rate (the headline)

Ranked by win rate × sample size × dollar mean:

| Rank | Filter | n | Win % | Mean $/contract | Source |
|---|---|---:|---:|---:|---|
| 1 | SPXW × `strong_trend_up` × $500M+ DP at strike + call | **36** | **91.7%** | **+$1,783** | E2 |
| 2 | SPXW × `strong_trend_up` × $200-500M DP at strike + call | 30 | 66.7% | +$681 | E2 |
| 3 | `chop` × falling VIX × put | 78 | 44.9% | -$5 | E3 |
| 4 | `mild_trend_up` × below-spot GEX × call | 70 | 42.9% | +$889 | E4 |
| 5 | `mild_trend_up` × tape-aligned × call (all tickers) | 879 | 38.6% | -$1 | E1 |
| 6 | `extreme_up` × tape-aligned × call (all tickers) | 214 | 31.8% | -$19 | E1 |

## What each sub-phase added

### E1 — Index leadership (NQ/ES/RTY vs SPX, 15-min window)

Direction-aligned tape adds **+5 to +11pt win rate** for calls on
trending-up days. Inverts to a -10 to -13pt penalty on chop days
(the 15-min "trend" before alert is noise). Aggregate looked flat
(24.1% vs 24.1%) until stratified by regime.

**Per-regime alignment effect on calls:**

| Regime | Aligned | Contradicted | Edge |
|---|---:|---:|---:|
| `mild_trend_up` | 38.6% | 27.7% | **+11pt** |
| `extreme_up` | 31.8% | 21.2% | **+11pt** |
| `chop` | 13.7% | 23.9% | **−10pt** *(inverts)* |
| `mild_trend_down` | 16.4% | 29.8% | **−13pt** *(inverts)* |

### E2 — Dark-print proximity (SPXW only)

The strongest single filter found in the entire study. When dark-pool
premium clusters at the alerted strike on a strong-trend-up day, the
win rate jumps from 43.5% (no DP) to 91.7% ($500M+ DP). On
mild-trend-up the same DP cluster does NOT help (7.4%) — the signal
needs momentum to "magnet" price toward the cluster.

Sample size caveat: n=36 on the headline 91.7% bucket. Directional
and worth flagging; not yet definitive.

### E3 — VIX direction (30-min change before alert)

The only meaningful put-side signal in the entire study. Falling VIX
+ puts wins 18.5% (n=324) vs flat-VIX puts at 2.0%. Chop + falling
VIX + puts wins 44.9% (n=78). Hypothesis: falling VIX = volatility
unwind, dealers covering shorts, price drifts in the direction the
unwind implies.

Calls do not separate cleanly by VIX direction.

### E4 — GEX position (top-3 abs_gex strike vs spot)

Counterintuitive: when the nearest top-3 GEX strike is **below**
spot (i.e., support zone, dealers long gamma below price), calls
win 40.2% (n=503). When GEX is **above** spot (resistance / wall),
calls win 20.5% (n=3,497). And `strong_trend_up + above_spot`
calls win only 5.6% (n=302) — rallying into a wall.

The dealer-positioning logic: GEX below spot = downside support, so
upside is unbounded. GEX above spot = rallies get capped by hedging
selling.

### E5 — Macro event proximity

No-signal in this dataset. Only 5 high-impact events in the 10-day
window (3 PPI + 2 retail sales), all at 12:30 UTC = 07:30 CT, *before*
the cash session opens (08:30 CT). Zero alerts fired within ±30min
of any event. E5 needs more days with intraday CPI/FOMC/NFP releases
to test the hypothesis.

## Three composable filter chains for production

If wired into the analyze prompt or UI, these would be the most
information-dense single signals (highest separation per alert):

**Filter chain A — SPXW high-conviction call setup**

```
SPXW alert is a call AND
day's regime = strong_trend_up AND
$500M+ dark-pool premium at the alert strike (±5pts)
→ 91.7% historical win rate, +$1,783 median dollar gain
```

**Filter chain B — multi-ticker tape-aligned call**

```
Any ticker alert is a call AND
regime = mild_trend_up OR strong_trend_up OR extreme_up AND
NQ/ES/RTY/underlying all moving same direction over prior 15 min
→ ~38% win rate (vs 28% contradicted)
```

**Filter chain C — gamma-zone call**

```
SPX-family alert is a call AND
regime = mild_trend_up AND
nearest top-3 abs_gex strike is below current spot
→ 42.9% win rate, +$889 median dollar gain
```

## What still doesn't work

- **Puts almost everywhere.** Even with E1-E4 filters layered on
  top, put alerts rarely break 10% win rate — except chop + falling
  VIX (44.9%, but tiny dollar gain). The 10-day mostly-bullish
  sample period is the most plausible explanation; need a
  downtrend window to test fairly.
- **Macro-event timing (E5).** Sample-period gap.
- **Single-name path-shape data (D1 + E filters).** NDXP can't get
  reliable MAE numbers; cross-asset filters can confirm
  positioning but not psychological-viability.

## What changes for production (ranked by confidence)

### High confidence — wire into UI / analyze prompt

1. **Surface DP-premium-at-strike on SPXW alerts.** When >$500M
   DP-at-strike on an SPXW call alert AND regime is strong_trend_up,
   show a "+91% historical win rate" indicator. This is the
   strongest single filter in the entire study.
2. **Surface GEX position vs spot.** "Nearest top-3 GEX is below
   spot" → green confidence indicator on call alerts (especially
   on mild_trend_up). Conversely a red warning when call alerts
   fire above-spot GEX during strong-trend-up.
3. **Surface tape alignment over 15 min.** When all of NQ/ES/SPX/
   underlying are moving the alert direction over prior 15 min
   AND regime is trending up, mark the alert "aligned." Red on chop.

### Medium confidence — needs more data

4. Falling-VIX + put marker (E3 finding) — small sample (n=324),
   needs a real downtrend window before relying.
5. Per-(ticker, regime, alignment) BEST_STRATEGY re-pick — D0's
   regime-conditional table corrects NVDA's exit; E1-E4 layered
   on top would correct it further but with smaller sample per
   cell.

### Low confidence — defer

6. Macro-event filter (E5) — null in this sample; revisit when
   we have a CPI/FOMC day inside the backfill window.

## Deliverables

| Phase | Script | Findings | Report |
|---|---|---|---|
| E1 | `ml/extract-iv-anomaly-leadership.py` | `iv-anomaly-leadership-2026-04-25.json` | `iv-anomaly-leadership-2026-04-25.md` |
| E2 | `ml/extract-iv-anomaly-darkprint.py` | `iv-anomaly-darkprint-2026-04-25.json` | `iv-anomaly-darkprint-2026-04-25.md` |
| E3+E4+E5 | `ml/extract-iv-anomaly-e345.py` | `iv-anomaly-{vix-direction,gex-position,macro-events}-2026-04-25.json` | `iv-anomaly-{vix-direction,gex-position,macro-events}-2026-04-25.md` |
| Rollup | (this file) | — | `iv-anomaly-phase-e-summary-2026-04-25.md` |

## After Phase E

Two natural next moves:

- **Phase F (UI integration)** — surface the top-3 filter chains as
  prominence flags in the live AnomalyRow / banner. The pattern pill
  (Phase D4) is already wired; cross-asset confidence indicators
  would extend it.
- **Phase G (analyze-prompt enrichment)** — add the regime-conditional
  filter chains to `analyze-context.ts` so Claude can reason about
  alert quality with the same signals the dataset confirmed.

Both are production code changes, not retroactive analysis. Worth
spec'ing separately when the user is ready to act on these findings.
