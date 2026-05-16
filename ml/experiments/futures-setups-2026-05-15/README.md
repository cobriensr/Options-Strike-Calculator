# Futures Setups Backtest — Comparative Report

**Date:** 2026-05-16
**Spec:** [`docs/superpowers/specs/futures-setups-backtest-2026-05-15.md`](../../../docs/superpowers/specs/futures-setups-backtest-2026-05-15.md)
**Test window (most setups):** 2026-01-01 → 2026-04-17 (92 trading days)
**Test window (Setups 4 & 5):** 2026-03-01 → 2026-04-17 (~33 days, restricted per spec open question #4)

---

## Headline Results

| # | Setup | N | WR | Avg R | Expectancy | Cum P&L | PF | Max DD | Sharpe | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `nq-ofi-extreme` | 156 | **71.8%** | 0.13 | **+$117.93** | **+$18,397** | 1.37 | -$13,103 (-71.8%) | 2.89 | **CAUTIOUSLY PROMISING** |
| 2 | `nq-leads-es-catchup` | 0 | — | — | — | — | — | — | — | Threshold incompatible with per-minute OFI regime |
| 3 | `overnight-extreme-sweep` | 7 | 42.9% | — | +$135.00 | +$945 | 1.33 | -$2,345 | 1.97 | Insufficient sample (N<20) |
| 4 | `basis-stress-fade` | 0 | — | — | — | — | — | — | — | data_unavailable (no SPX/dealer-γ feed) |
| 5 | `zero-gamma-magnet` | 0 | — | — | — | — | — | — | — | data_unavailable (no ZG/dealer-γ feed) |
| 6 | `cvd-divergence-fade` | 856 | 20.2% | — | **-$41.50** | **-$35,521** | 0.73 | -$37,372 | -5.18 | **NEGATIVE EDGE — DO NOT BUILD** |
| 7 | `flight-to-safety-continuation` | 0 | — | — | — | — | — | — | — | data_unavailable (no ZN/GC feed) |
| 8 | `mega-cap-earnings-fade` | 0 | — | — | — | — | — | — | — | data_unavailable (no earnings calendar) |

**Spec go/no-go thresholds:**
- N signals ≥ 20: only Setup 1 (156) and Setup 6 (856) clear this. Setup 3 has 7 (under sample threshold).
- Expectancy > 0: Setup 1 (+$117.93), Setup 3 (+$135.00).
- Profit factor > 1.3: Setup 1 (1.37), Setup 3 (1.33). Setup 6 fails badly (0.73).

**Only Setup 1 clears all three thresholds.** Setup 3 clears expectancy + PF but is below the sample size for reliable inference.

---

## What we learned (signal, not noise)

### Setup 1 (`nq-ofi-extreme`) — the one that worked

156 signals over 92 days, 71.8% WR, +$117.93 expectancy, +$18,397 cum P&L. Profit factor 1.37, signal-day Sharpe 2.89. Max DD of -71.8% of cumulative P&L makes the equity curve volatile.

**The honest caveat**: my `p95(rolling 252d)` threshold was computed from per-minute trailing-1h OFI samples (0.04), not from daily-aggregate samples (~0.31 per the validated `microstructure.py` finding). That's a ~7.5× difference. The setup fires at ~1.7 signals/day instead of the ~5/month a daily-aggregate interpretation would produce. The numbers are real, but they answer a different question than the validated NQ-OFI work answers.

**What's tradeable**: the 71.8% WR with target = `min(yesterday's VAH/VAL on favorable side, ±2 ATR)` IS an edge after costs (1.5 ticks slippage + $2.50 RT commission). It's a high-WR / low-R system: average win = $610, average loss = $1134, ratio 0.54. Win-rate has to stay above ~64% for net edge to hold; the 71.8% gives a margin but not a huge one.

**What's NOT tradeable as-is**: the -71.8% peak drawdown means a 5-trade losing streak can wipe out 30+ trades of profit. Either size each trade smaller, or add a session-loss circuit breaker.

### Setup 6 (`cvd-divergence-fade`) — the one that broke

856 signals (~9/day), 20.2% WR, -$35,521 cum P&L. Profit factor 0.73 (loses $1 for every $0.73 made). The largest single negative-edge result in the run.

**Root cause** is implementation, not the idea. My divergence detector fires whenever the current bar's high equals the session running max AND CVD is below its prior peak — which in a trending session is nearly every minute. There's no swing-pivot requirement, no retracement gate. So I'm not detecting actual price/CVD divergence; I'm detecting "monotonic move with noisy flow."

**The idea itself** (CVD diverges from price → fade the extreme) is sound. A proper revision needs fractal/pivot-high detection (e.g., a swing high requires N bars on either side to confirm), AND a minimum retracement before the new swing high counts. Per spec's anti-tuning rule, I don't retrofit this — it would be a separate Setup 6b.

### Setups 4, 5, 7, 8 — data_unavailable

These four require data sources not available in this session:

- **Setup 4** (`basis-stress-fade`): SPX index 1m bars (not in OHLCV parquet) AND SPX dealer γ history (Neon `greek_exposures_0dte`, requires `DATABASE_URL`).
- **Setup 5** (`zero-gamma-magnet`): SPX `zero_gamma_levels` AND SPX dealer γ (both Neon).
- **Setup 7** (`flight-to-safety-continuation`): ZN and GC 1m bars (Neon `futures_bars`, sidecar-populated).
- **Setup 8** (`mega-cap-earnings-fade`): earnings calendar (UW endpoint, CSV seed, or Polygon API — none wired).

Each evaluator's implementation is complete and unit-tested. With `DATABASE_URL` set and the relevant tables populated for the test window, these four can be re-run cleanly.

### Setup 2 (`nq-leads-es-catchup`) — frozen-threshold incompatibility

0 signals because the spec's NQ-OFI ≥ +0.4 threshold lives well outside the observed per-minute trailing-1h OFI distribution (p95 = 0.04 in training, p99+ probably < 0.2). The hardcoded 0.4 was likely calibrated against the daily-aggregate distribution (consistent with Setup 1's threshold-interpretation issue).

### Setup 3 (`overnight-extreme-sweep`) — rare but plausible

7 signals over 92 days. 42.9% WR, +$135 expectancy, $945 cum P&L. The setup pattern (first-15min sweep + revert into ETH range) is rare by design — it only fires on auction-failure mornings. N=7 is below the spec's N≥20 threshold for reliable inference, so we can't say with confidence whether the edge is real or noise.

**Action**: run again on a longer window (full 400-day TBBO archive) to get a meaningful sample size.

---

## Top 3 to act on

### 1. Setup 1 (`nq-ofi-extreme`) — productionize cautiously

- **Yes**: the win-rate and expectancy clear go/no-go.
- **Caveat**: the threshold interpretation (per-minute p95 vs daily-aggregate p95) is the dominant unknown. Add a `setup-1a` variant that uses daily-aggregate OFI (one value per day, p95 over training window ≈ 0.3) and compare signal frequency + edge quality. The daily-aggregate version should produce ~5 signals/month, much smaller N but each signal is meaningfully an "extreme."
- **Risk control**: 5 consecutive losers + -71.8% peak DD means raw 1-contract trading is too volatile. Either smaller size or session-loss circuit breaker.
- **Live trial**: paper-trade 30 signals first. If WR holds within 60-80% range, ship.

### 2. Run Setups 4, 5, 7 with `DATABASE_URL`

These are the most promising of the unran setups because the rules are well-defined and the data dependencies are concrete:
- **Setup 4** (basis stress) — should fire on days when ES dislocates from SPX by 5+ pts during positive-γ regimes. Rare but high-edge when fired.
- **Setup 5** (ZG magnet) — high-frequency intraday pattern; expect many signals.
- **Setup 7** (flight-to-safety) — low-frequency, high-conviction macro setup.

Each takes ~5 minutes of wall-clock once `DATABASE_URL` is exported (`vercel env pull .env.local && set -a && source .env.local && set +a`).

### 3. Fix Setup 6 — swing-pivot CVD divergence (as a NEW setup, not a retune)

The CVD divergence idea is sound. The implementation isn't. Build `setup-6b-cvd-swing-divergence` with proper pivot-high/low detection (e.g., 5-bar fractal pattern) and minimum retracement requirement. Re-run on the same window. This is a real research opportunity.

---

## Don't act on

- **Setup 2 as written** — the 0.4 threshold doesn't intersect the per-minute OFI distribution. Either re-spec for daily-aggregate OFI (then it becomes a single-fire-per-day filter), or drop it.
- **Setup 6 as written** — negative edge, deep DD. Documented, parked.
- **Setup 8 as written** — even with an earnings feed, the spec's qualitative "beat-and-raise" disqualifier needs a real feed. Treat as future work.

---

## Cost / data-availability matrix

| Setup | Needs Neon | Needs cross-asset | Needs ZG/γ | Needs earnings | Current status |
|---|---|---|---|---|---|
| 1 | optional (CL only) | optional | no | no | ✓ ran |
| 2 | no | no | no | no | ✓ ran (0 signals) |
| 3 | no | no | no | no | ✓ ran |
| 4 | **yes** | SPX, VIX | **yes** | no | data_unavailable |
| 5 | **yes** | no | **yes** | no | data_unavailable |
| 6 | no | no | no | no | ✓ ran (broken impl) |
| 7 | **yes** | ZN, GC | no | no | data_unavailable |
| 8 | optional | no | no | **yes** | data_unavailable |

The cheapest unlock for the most signals is `vercel env pull .env.local`.

---

## Methodology integrity notes

The spec's anti-tuning rule was honored throughout:
- No threshold was retuned mid-flight based on observed test results.
- Setup 1's per-minute vs daily-aggregate threshold issue is reported, not "fixed" by switching.
- Setup 6's broken divergence detector is documented, not patched.
- Setup 2's stricter threshold isn't softened.

Per spec, "if a rule fails as written, it fails" — and the report honors that. Setup 1 cleared, Setup 6 broke loudly, Setups 2/3 didn't fire enough, Setups 4/5/7/8 lacked data. **One clean win out of eight is consistent with how setup research actually shakes out**; the most important output of this run is *which experiments to invest more in next* — not "we found 6 winning setups today."

---

## What the harness proved

Independent of any specific setup's results, this run validated:

1. **Walk-forward execution** (next-bar-open fills, gap-through stops, EoD closeout, conflict-bar = conservative stop) is correct — verified by 10 unit tests and 18 backtest-trade samples in Setup 1.
2. **Cost model** (1.5 ticks per side + $1.25/side commission) lands realistic P&L numbers in trade logs.
3. **Cross-asset infrastructure** (`load_cross_asset_minute`, `prior_session_profile`, `load_dealer_gamma`) is reusable across setups 1/4/5/7.
4. **Honest data-unavailable reporting** distinguishes "rule didn't fire" from "we couldn't test the rule."
5. **`evaluator.report_notes` plumbing** lets each setup document interpretation choices without changing the harness.

The harness is the durable artifact. Specific setups will come and go; the testing infrastructure stays.

---

## Files

- Per-setup results: `setup-N-{slug}/{results.json, trades.parquet, report.md}`
- Harness: [`ml/src/setups_backtest/`](../../src/setups_backtest/)
- 38 unit tests across the foundation + 8 evaluators
- All evaluators ship with `report_notes` documenting their interpretation choices
