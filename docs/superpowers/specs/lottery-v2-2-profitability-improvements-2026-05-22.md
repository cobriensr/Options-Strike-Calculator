# Lottery V2.2 — Profitability Improvements (2026-05-22)

## Goal

A 9-item batch of improvements derived from the working feedback loop. Each improvement either tightens the scoring model (more accurate alerts) or adds new operational signal (better trade execution). All work uses existing data — no new feeds or schema migrations beyond per-feature weight additions.

## Background

V2 rescore shipped + nightly outcome-mining + Monday TOD overlay all landed today (commits `a7583af9` through `b0a0eb4d`). User asked: "what else can I do with existing data to make alerts more profitable?"

This spec packages the top 9 ideas into a coordinated batch.

## Phase A — Analysis sprint (parallel, pure-SQL, no model changes)

These are read-only investigations that surface candidate signal. Each writes a focused Markdown memo to `docs/tmp/`. Used to inform Phase B-E decisions.

### A.3 Stop/target backtest by tier

For last 30 days of aligned tier1/tier2 fires, simulate:

- Trail-30/10 vs hard-30m vs flow-inversion vs hold-to-EOD exit policies
- Per-tier optimal stop-loss (-15%, -25%, -40%) and take-profit (+50%, +100%, +200%)
  Output: `docs/tmp/v22-stop-target-backtest-2026-05-22.md` with the optimal exit policy per tier.

### A.4 Co-fire amplification

Identify "cluster" moments: ≥3 distinct tickers firing tier1 within 10-min window. Compare mean outcome of cluster-fires vs isolated tier1 fires. If cluster fires outperform by >20pp, candidate `cluster_bonus` overlay.
Output: `docs/tmp/v22-co-fire-analysis-2026-05-22.md`.

### A.5 VIX-conditioned tier performance

Pull VIX close on each fire date; bucket tier1 outcomes by VIX regime (<15 / 15-20 / 20-25 / 25+). If tier1 fires perform dramatically worse in any regime, candidate `vix_gate` overlay.
Output: `docs/tmp/v22-vix-regime-2026-05-22.md`.

### A.6 Tier1 intra-day sub-ranking

For each tier1 fire, compute an "expected outcome percentile" via nearest-neighbor lookup over historical lookalikes (same ticker + tod + dte + similar quintiles). Rank today's tier1 fires by this percentile. If top-3 perform meaningfully better than the rest, candidate `tier1_priority` UI rendering.
Output: `docs/tmp/v22-tier1-subrank-2026-05-22.md`.

### A.9 Direction-gated tier1 audit

For last 30 days, compute mean outcome of `direction_gated=true` tier1 fires vs `direction_gated=false`. If gate is too aggressive (gated fires actually outperform), candidate to relax or remove the gate.
Output: `docs/tmp/v22-direction-gate-audit-2026-05-22.md`.

## Phase B — Composite overlays (items 1 + 2)

Apply the highest-confidence findings from the existing mining report. Pattern matches the Monday TOD override (e874f419).

### B.1 Winning composite bonuses

Top winning combos from `docs/tmp/lottery-composite-candidates-2026-05-22.md`:

- `SNDK + AM_open + gamma_q=0` (265/278 = 95.3% win) → +3 bonus
- `RKLB + AM_open + gamma_q=1` (20/21 = 95.2% win) → +3 bonus
- `TQQQ + AM_open + gamma_q=4` (41/43 = 95.3% win) → +3 bonus
- `SNDK + AM_open + gamma_q=0` is the canonical "smoking gun"

Schema: add `composite_bonuses` array to weights JSON. Each entry: `{features: {ticker: "SNDK", tod: "AM_open", gamma_q: 0}, bonus: 3, support: 278, win_rate: 0.953}`. computeLotteryScoreV2 iterates and applies any matching bonus.

### B.2 Losing composite penalties

Same pattern, negative weights:

- `WDC + ask_pct_q=0` (12/12 lost) → -5 penalty
- `SHOP + gamma_q=4` (16/17 lost) → -4 penalty
- `RGTI + LUNCH + vol_oi_q=4` (27/31 lost) → -3 penalty
- `POET + vol_oi_q=4` (12/13 lost) → -3 penalty

Add a UI "💀 AVOID" badge for any fire matching a losing combo (regardless of final score).

## Phase C — Regime overlays (items 4 + 5 + 6, driven by Phase A findings)

Only ship items where Phase A analysis confirmed enough lift. Phase C decisions deferred until Phase A reports land.

### C.4 Cluster bonus (if A.4 confirms)

If A.4 shows cluster fires outperform isolated by >20pp mean, add a runtime check: when a fire is scored, look at recent tier1 fires in the last 10 min — if ≥3 distinct tickers, add `+cluster_bonus`.

### C.5 VIX gate (if A.5 confirms)

If A.5 shows tier1 performance collapses in a specific VIX bucket, add a runtime check using `vix_close` from `vix_ohlc` table — auto-downgrade tier1 to tier2 in the bad regime.

### C.6 Tier1 sub-ranking (if A.6 confirms)

If A.6 shows top-percentile tier1 fires meaningfully outperform other tier1, render a `🏆 priority` badge for top-3 daily.

## Phase D — Pre-fire context gates (item 7, "carefully")

**Most invasive change in this batch.** Add macro-context features to V2 scoring.

Candidate features (existing DB columns):

- `mkt_tide_otm_diff` — already used for `direction_gated`
- `spx_spot_gamma_oi` — dealer gamma regime
- `spx_spot_charm_oi` — charm pressure
- `mkt_tide_diff` — overall flow direction
- `vix_close` (from vix_ohlc lookup)

Approach (carefully):

1. Compute univariate lift for each context feature against `outcome_pct` over 90 days
2. If a context feature shows monotonic lift, bucket it into quintiles and add as a new score component (same pattern as vol_oi / gamma / ask_pct)
3. Re-train V2 model with new features
4. Re-backfill scores
5. Compare new model's tier1 hit rate vs current

**Done-when:** Phase 7 ships only if the new features improve tier1 hit rate by ≥3pp on held-out validation. Otherwise abandoned.

## Phase E — Online ticker weight updates (item 8)

Nightly: for each ticker, blend today's mean outcome into the existing ticker weight via exponential smoothing:

```python
new_weight = round(0.95 * old_weight + 0.05 * 5 * (today_mean - global_mean) / spread)
```

Captures regime change within ~10 trading days instead of waiting for full retrain.

**Files:** `scripts/online_ticker_update.py` (new) + Makefile addition. Runs after `make refit` (which is still guarded but this runs independently).

## Done when

- Phase A: 5 memos in `docs/tmp/`, decision points for B/C/D recorded
- Phase B: composite overlay infrastructure shipped + 8 initial composites configured
- Phase C: regime overlays shipped for whichever sub-items survived Phase A's lift threshold (≥3pp)
- Phase D: ships only if pre-fire context shows lift ≥3pp tier1 hit rate
- Phase E: online ticker updates running nightly
- `make nightly update` produces all the new outputs without errors
- `npm run review` green

## Open questions

1. **Composite stacking** (Phase B) — if a fire matches BOTH a winning composite AND a losing composite (overlap), which wins? Default: sum both. Revisit if overlap turns out to matter.
2. **Backfill scope** (Phases B, C, D) — re-backfilling 644k rows after each overlay add is slow but the gold standard. Decide per phase whether to backfill or just apply going-forward.
3. **VIX data freshness** (Phase C.5) — `vix_ohlc` is fetched by a cron. If it's stale at fire time, gate fails silently. Add a freshness check.

## Out of scope

- New data sources (sticking to what's in the DB)
- Frontend refactors (just adding badges)
- Multi-model serving / A/B
- Anything that requires user trader-feedback ingestion
