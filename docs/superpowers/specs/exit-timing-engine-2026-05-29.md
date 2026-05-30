# Exit-Timing Engine — Project A (offline brain)

**Status:** Design approved 2026-05-29 (brainstorming). Awaiting spec review → writing-plans.
**Author:** brainstormed with Claude.

## Goal

Build an offline, walk-forward-validated **exit-timing engine** that, scored each minute on a
held lottery contract, decides **HOLD vs EXIT** to **maximize total realized return** — and that
**provably captures more of each trade's peak than the current exit policies** without fatter
givebacks. This is the "brain" that later Projects B (live signal + push alert) and C (Schwab
one-click execution) stand on. Project A ships **no live infra and no Schwab integration.**

### The problem being solved

Winners are cut far too early (e.g. +500% realized when the contract peaked +2000%, on multi-day
holds that should have been held into the next session). On a fat-tailed lottery payoff, a single
trailing stop is tuned to the median trade while ~all P&L lives in the rare tail — so the fix is a
learned stopping rule that knows when upside is genuinely exhausted, not a tighter stop.

## Scope decisions (locked in brainstorming)

| Decision | Choice |
| --- | --- |
| Universe | `lottery_finder_fires`, **mode A (`A_intraday_0DTE`) + mode B (`B_multi_day_DTE1_3`)** from day one. Silent Boom deferred (different schema; no `mode`, no policy baselines). |
| Objective | **Phase 1: total realized R (pure expectancy), walk-forward.** Phase 2: sweep the λ giveback-penalty frontier and report what protecting gains costs. |
| Modeling | **Brain = supervised "upside-remaining" XGBoost** scored per minute; exit when remaining upside no longer beats giveback risk. **Baseline it must beat = parametric generalization of the shipped rules** (trail / hard-stop / tier, searchable knobs). If the rule ties the model, ship the rule. RL / true optimal-stopping policy **deferred**. |
| Output shape | **Single all-out exit** per contract (one stopping decision). Scale-out is explicitly out of scope for Project A. |
| Fills | Exits priced at **NBBO mid**, net **$0.65 round-trip commission** and **half-spread-per-leg slippage** (the real model — see Constants). Never last-trade prints. |
| Leakage guard | Strictly **causal features** at minute *t*; **walk-forward-by-date** evaluation; explicit test for the **uniform-cross-bucket-lift** leakage fingerprint. |

## The decision unit & objective

Each held contract is a per-minute sequence of HOLD/EXIT choices — an optimal-stopping problem.
Because the full historical post-entry path is known, the future-from-any-point is known, so the
stopping boundary is learnable and the policy is honestly backtestable.

- **Primary objective (Phase 1):** maximize **summed realized R across all trades, equal-weighted per
  trade**, out-of-sample, walk-forward. (Equal-weight ≈ real P&L because the owner stakes roughly equal
  dollars per lottery — see Scorecard weighting.) The tail dominates; the engine may give back on a
  winner if that's the price of catching the runner.
- **Frontier (Phase 2):** maximize `realized_R − λ · giveback_from_peak − (downside term)`, sweeping
  λ from 0 upward. Report the full frontier so a *followable* operating point can be chosen — the
  cost of protecting gains is measured, not assumed.

## Model & baseline

**Brain — supervised "upside-remaining" model.**
At minute *t* (relative to entry), build causal features; the supervised target is the
**future behaviour of the executable-mid path from *t* onward.** Default framing:

**Upside is measured from the current mark, not from entry** (resolved 2026-05-29). What's at risk
when deciding to hold is the contract's *current* value, so "how much higher from here" is the honest
quantity — and it stays meaningful whether the trade is +10% or +800% (a move from $9 → $10 on an
+800% winner is only +11% from here, not "+100 points"). All targets below use forward move from the
current price.

- **Classification:** `P(price rises ≥ θ% above the current mark before the path ends)`. Exit at the
  first minute the score drops below a tuned threshold (with an arming guard so we don't exit on
  minute-1 noise).
- **Alternative (decided in plan):** regression on `log1p(future_max_mid / current_mid)` — "how much
  higher from here." `log1p` of the forward max is the most predictable target per prior EDA, so this
  stays a live option. Exit when predicted forward upside no longer exceeds holding cost.

Greedy stopping (exit at first sub-threshold minute) is an approximation to true optimal stopping —
accepted for v1; the exit threshold is tuned directly on the Phase-1 objective on train folds.

**Mode B — the overnight decision is its own model (resolved 2026-05-29).** Multi-day trades can't be
managed minute-by-minute overnight (market closed), so the "carry into tomorrow vs flatten before the
close" call is a **separate, once-per-day, end-of-day decision** trained and tuned on its own — it
answers a structurally different question (time left on the option, close-strength, overnight gap
risk) than the intraday "still climbing?" model. This decision targets the headline pain ("should've
held one more day") directly. The intraday per-minute model is shared across modes A and B; the EOD
carry model fires only for mode-B positions still open near the close.

**Baseline — parametric dynamic-rule family.**
Generalize the shipped exits into one searchable rule: trail activation `A%`, trail width `W%`
(optionally widening for high-predicted-upside trades), hard time-stop minute `M`, optional
flow-inversion gate, optional power-hour / overnight hold flag. Grid / Bayesian search the knobs to
maximize Phase-1 objective on train folds; evaluate OOS. **If the rule ties the model, ship the rule.**

## Features (all strictly causal — available by minute *t*)

Trajectory: `current_return_pct`, `drawdown_from_running_peak_pct`, `running_peak_pct`,
`minutes_since_entry`, `minutes_to_close` (session-relative), price slope over {3,5,10}-min windows,
realized vol of minute returns, print-rate and size-rate vs the trade's early baseline, matched-side
net-flow slope (building vs fading), IV level + IV change, delta, gamma, OTM distance, spot move
since entry. Entry-time: `mode` (A/B), `dte`, time-of-day bucket, lottery score, `takeit_prob`, and
features derived from `takeit_top_features`. **Overnight state flag** for mode B (carrying a position
across the close).

## Backtest protocol

- **Walk-forward by date** (train on past days, test on a forward block, roll). OOS aggregate
  realized R is the headline number.
- **Benchmarks:** the four shipped realized policies (`realized_trail30_10_pct`,
  `realized_hard30m_pct`, `realized_tier50_holdeod_pct`, `realized_flow_inversion_pct`),
  `realized_eod_pct`, a naive hold-to-EOD, and `peak_ceiling_pct` as the unrealizable upper bound.
- **Leakage test:** stratify lift by mode / TOD / score bucket; **uniform lift across every bucket is
  the leakage fingerprint** and fails the run.
- **Fill realism:** reuse `apply_costs()` semantics (mid-based, commission + half-spread-per-leg).

## Success criteria (OOS, walk-forward)

1. Higher **total realized R** than `realized_trail30_10_pct` and `realized_hard30m_pct`.
2. **Median giveback no worse** than trail-30/10.
3. A visible chunk of the **peak-ceiling gap closed**, concentrated on the **high-upside tail**
   (where the account's money is) — not a uniform smear (which would signal leakage).
4. Mode B specifically: demonstrates the engine **holds overnight** when the runner is still alive,
   capturing multi-session upside the current intraday policies structurally cannot.

## Phases

- **A1 — Path reconstruction + decision dataset.** Per-fire, per-minute executable-mid path from the
  parquet archive (modes A + B, **multi-session concatenation** for B with an overnight-gap state).
  Emit the per-minute feature matrix + causal labels. Verify reconstructed paths reproduce the
  already-stored `peak_ceiling_pct` / `minutes_to_peak` within tolerance (sanity check on the rebuild).
- **A2 — Parametric rule baseline.** Implement + walk-forward search the rule family; record OOS
  realized R and the full benchmark table. This is the bar the model must clear.
- **A3 — Upside-remaining model.** Train the XGBoost stopping model; tune the exit threshold on the
  Phase-1 objective; walk-forward OOS; SHAP interpretability; leakage test.
- **A4 — λ frontier + verdict.** Sweep the giveback penalty; produce the frontier plot; write the
  results doc with the chosen v1 policy (model or rule) and the operating point.

Each phase is independently shippable and ends in a results artifact under `ml/experiments/` +
plots in `ml/plots/`.

## Files to create / modify

**Create (ml/, Python — research lives here):**
- `ml/src/exit_engine/path_reconstruction.py` — parquet → per-fire per-minute executable-mid +
  flow series; multi-session concat for mode B.
- `ml/src/exit_engine/features.py` — causal per-minute feature builder.
- `ml/src/exit_engine/labels.py` — future-from-t targets (classification + log1p regression).
- `ml/src/exit_engine/rule_family.py` — parametric baseline + search.
- `ml/src/exit_engine/model.py` — XGBoost upside-remaining model + greedy stopping.
- `ml/src/exit_engine/backtest.py` — walk-forward harness, benchmark table, leakage test, λ frontier.
- `ml/experiments/exit-timing-engine/run_*.py` — phase drivers; markdown + plot outputs.
- Tests under `ml/tests/` for path reconstruction (vs stored peak), causal-feature no-leakage, and
  the stopping-rule mechanics.

**Reuse (do not rewrite):**
- `scripts/enrich_lottery_outcomes.py` — parquet loaders, `resample_minute_mid()`, canceled/`price>0`
  filters (the reconstruction template).
- `ml/experiments/lottery-net-flow-eda/exit_simulation.py` — `apply_costs()`, the mid-based sim
  pattern, cost constants.
- `scripts/exit_policy_search.py` — exhaustive policy-search pattern.
- `ml/src/lottery_exit_policies.py` / `api/_lib/lottery-exit-policies.ts` — shipped policies as
  benchmarks.

**No api/ or src/ changes in Project A** (those land in Projects B and C).

## Data dependencies (verified against source 2026-05-29)

- **Parquet tape archive = source of truth (full tape).** `~/Desktop/Bot-Eod-parquet/{date}-trades.parquet`
  (`-fulltape.parquet` variant for Jan–Apr 2026). `DEFAULT_PARQUET_DIR` in
  `enrich_lottery_outcomes.py:128`. Project A trains and backtests entirely off this. Path
  reconstruction columns: `executed_at`, `option_chain_id`, `price`, `canceled` (main), plus
  `nbbo_bid`, `nbbo_ask`, `size` (per-minute mid + flow). Filters: drop `canceled`, keep `price > 0`,
  sort by `(option_chain_id, executed_at)`.
- **`lottery_finder_fires`** (migration #110): `entry_price`, `entry_time_ct`, `option_chain_id`,
  `spot_at_trigger`, `mode` (`A_intraday_0DTE | B_multi_day_DTE1_3 | OUT_OF_UNIVERSE`),
  `peak_ceiling_pct`, `minutes_to_peak`, `realized_trail30_10_pct`, `realized_hard30m_pct`,
  `realized_tier50_holdeod_pct`, `realized_eod_pct`; `realized_flow_inversion_pct` (#124);
  `takeit_prob`, `takeit_top_features` (JSONB), `takeit_model_version` (#155). `dte` per fire.
- **Net-flow history** for matched-side flow features (per-minute flow series; reuse flow-inversion
  second-pass logic and `backfill_net_flow_history.py`).
- **Not used by Project A:** `ws_option_trades` (migration #109) holds a **2-day hot window**, then
  rows are **archived to Vercel Blob** (not deleted) — so live history is preserved, just tiered. That
  table is the *live* substrate for Project B only; Project A reads the parquet full tape, which
  remains the source of truth.

## Constants / thresholds (verified)

- `COMMISSION_USD_PER_CONTRACT_RT = 0.65` (round-trip).
- `SLIPPAGE_PCT_OF_SPREAD = 0.5` per leg → total `2 × 0.5 × spread_pct_of_price`. Exits on **NBBO mid**.
- `θ` (minimum meaningful further upside, **measured from the current mark** — forward % move from
  where the contract is *now*, not from entry) — default **+15%**, swept in A3.
- Exit-score threshold, trail `A`/`W`, hard-stop `M`, walk-forward train/test block sizes — all tuned
  in-phase; record final values here when locked.
- `λ` frontier grid — set in A4; start at 0 (pure expectancy).

## Open questions (with default picks)

1. **Reference frame** → **RESOLVED 2026-05-29: measure forward upside from the current mark, not
   from entry.** Classification-vs-regression target form and the exact threshold are tuning details
   resolved during the build (A3), not pre-committed here.
2. **Mode-B overnight modeling** → **RESOLVED 2026-05-29: a dedicated end-of-day "carry vs flatten"
   model**, separate from the intraday per-minute model (see Model & baseline). Aimed straight at the
   "should've held one more day" leak.
3. **Training depth** → **RESOLVED 2026-05-29: 90+ days of parquet full-tape confirmed available and
   sufficient.** A1 still reports the exact clean day count (sets walk-forward fold count), but data
   volume is not a constraint.
4. **Scorecard weighting** → **RESOLVED 2026-05-29: equal-weight per-trade % return.** The owner sizes
   each lottery to roughly equal dollars (entry price sets contract count, dollar stake ~constant), so
   equal-weight % return ≈ real account P&L. No size-weighting in the primary metric.

## Out of scope (later projects)

- **Project B:** position tracker, per-minute live scoring off `ws_option_trades`, push alert on the
  held contract.
- **Project C:** Schwab buy/sell-at-mid button, one-click then automated execution.
- **Scale-out** schedules; Silent Boom universe; RL stopping policy.
