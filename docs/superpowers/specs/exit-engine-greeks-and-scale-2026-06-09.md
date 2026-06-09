# Exit-Timing Engine — Greek/IV Enrichment + A2/A3 at Scale

**Status:** Design draft 2026-06-09. Extends `exit-timing-engine-2026-05-29.md`. Awaiting review → plan → subagent-driven build.
**Branch:** `feature/exit-timing-engine` (worktree).

## Where we are

A1 (the offline decision dataset) is **built and validated** on the 106-day full tape:

- **686,178 fires** reconstructed (100% of in-universe, Jan 2 → Jun 5).
- **Mode split: 309,382 0DTE (45%) / 376,796 1+DTE (55%)** — 1+DTE is ~half the data, validating the wider-universe decision.
- **220,320,956 decision rows**, 6.6 GB parquet.
- Features present: 10 **price-trajectory** features only (`ret_from_entry_pct`, `running_peak_pct`, `drawdown_from_peak_pct`, `spread_pct`, `slope_{3,5,10}m`, `realized_vol_5m`, `minutes_since_entry`, `minutes_to_close`) + labels (`forward_ratio`, `y_has_upside`, `y_log_upside`) + identity.
- **No greeks/IV** — the original spec's feature wishlist (IV level/change, delta, gamma, OTM distance) was under-built because reconstruction only carried NBBO mid/spread.
- Peak-rebuild sanity 47.6% within 5pp = the **mid (engine) vs trade-price (stored)** basis gap, not a reconstruction bug (confirmed against `enrich_lottery_outcomes.py` which uses last-trade `price`).

## Decisions locked (2026-06-09)

- **A — Add greeks now** (re-run A1 with the richer feature set) before A2/A3.
- **B — Sample-for-train, full-for-eval**: train the model on a stratified fire subsample; run the realized-R scorecard on all 686K fires.
- **Benchmark basis** — recompute baseline policies on our **mid** paths (same basis as the engine); the stored trade-price `realized_*` columns become a labeled reference only.

---

## Phase A1.5 — Greek/IV feature enrichment (re-run A1)

**Goal:** carry per-trade greeks/IV/underlying through reconstruction and derive the spec's intended features, then rebuild the dataset.

The full tape has (verified): `implied_volatility`, `delta`, `gamma`, `theta`, `vega`, `rho`, `underlying_price`, `strike`, `option_type`, `expiry`.

**Reconstruction** (`path_reconstruction.build_minute_path`): aggregate per-minute **last** value of `implied_volatility`, `delta`, `gamma`, `underlying_price` alongside mid/spread (same `groupby('minute').last()`). Coerce decimal→float (same fix as nbbo — old months store Decimal). Carry `strike` + `option_type` (constant per chain) onto the path for OTM distance. Keep the `mid > 0` filter.

**New causal features** (`features.py`) — all strictly past+current only; extend the append-future-row leak-guard test to cover every new column:
- `iv_level` — per-minute IV.
- `iv_change_5m`, `iv_change_10m` — trailing IV slope.
- `delta`, `gamma` — per-minute last.
- `otm_distance_pct` — signed moneyness: call = `(underlying − strike) / underlying`, put = `(strike − underlying) / underlying` (positive = ITM, negative = OTM). **Verify `option_type` encoding** in the full tape (`C`/`P` vs `call`/`put`) before wiring — the Bot-Eod tape uses `call`/`put`; the full tape may differ.
- `underlying_ret_from_entry` — `(underlying − underlying_entry) / underlying_entry` per minute.

**Driver** (`run_a1_build_dataset.py`): `TRADE_COLS += [implied_volatility, delta, gamma, underlying_price, strike, option_type]`. Re-run A1 — **robust pattern is in place** (caffeinate -i, incremental ParquetWriter, per-date progress, stream-assemble). Expect ~4 h.

**`model._NON_FEATURE` unchanged** — the new greek columns ARE features (only `strike`/`option_type`/`underlying_price` raw helpers used to derive features should be excluded if they leak onto rows; derive features in `features.py` and do NOT emit raw `strike`/`underlying_price` as model columns, OR add them to `_NON_FEATURE`).

**Open question:** greek set — default `{IV, delta, gamma, underlying}` + derived (`otm_distance_pct`, `iv_change`, `underlying_ret`). `theta`/`vega`/`rho` deferred (less direct for exit timing; trivial to add later).

**Files:** `path_reconstruction.py`, `features.py`, `dataset.py` (`build_fire_rows` threads greeks; ensure non-feature raws excluded), `run_a1_build_dataset.py`, tests for each (incl. Decimal greeks + leak-guard on new features). Then re-run A1.

---

## Phase A2 — Vectorized rule baseline at scale

**The scale problem:** 686K fires × 64 knob combos × walk-forward folds in pure-Python `decide_exit_index` loops = days. **Vectorization is mandatory.**

- **Vectorize the exit simulation** — `decide_exit_index` as numpy array ops per fire: `running_peak = np.maximum.accumulate(ret)`; `giveback = running_peak − ret`; activation mask; hard-stop via `minutes_since_entry` boundary; `np.argmax` of the first trigger. Precompute a per-`(fire, knob)` exit-index matrix once; each fold's best-knob pick is then an `argmax` over a slice.
- **On-path baselines (same basis):** recompute `trail-30/10`, `hard-30m`, `tier-50`, `hold-EOD` on the **mid** paths (reuse the vectorized sim), cost-netted via `apply_costs`. These are the primary benchmark. Keep the stored trade-price `realized_*` columns as a clearly-labeled "(stored, trade-price basis)" reference row only.
- **Walk-forward** by date (`cfg.N_TRAIN_DAYS`/`TEST_BLOCK_DAYS`). Best knobs chosen on train folds, applied OOS.
- **Evaluate realized R on ALL fires** (full eval — equal-weight per trade).
- **Output:** benchmark table (engine-rule vs on-path baselines, primary; stored, reference) + the OOS rule mean.

---

## Phase A3 — Model at scale

- **Training subsample (Decision B):** stratified sample of fires by `date × mode` (target ~50–100K fires; tune so XGBoost trains in minutes and fits memory). **Score/evaluate on ALL 686K fires.** Record the sample size + strata in the results doc; verify the sampled-train model's OOS matches a larger-sample spot check (no undertraining).
- **Vectorize** per-minute scoring + `greedy_stop_index` over arrays (no per-fire Python loop for the full-eval pass — `predict_proba` batched, stop computed vectorized per fire).
- **θ / exit-threshold sweep** on train; walk-forward OOS; **SHAP** on a train-only sample; **leakage stratification** (must not be uniform across modes).
- Now uses the **richer greek feature set** from A1.5.
- **A3b carry model** unchanged structurally; benefits from greek features (IV/gamma at the close are natural carry signals).

## Phase A4 — λ giveback frontier

Unchanged design, run on the richer dataset; giveback measured from the peak **mark** (already fixed).

---

## Scale / compute guardrails (lessons from the A1 build)

- **Instrument + bound first:** every long pass logs per-unit progress (`flush=True`), streams/chunks output (no accumulate-then-write), and is smoke-tested on a small *and old-data* slice before the full run.
- **Run long jobs under `caffeinate -i`.**
- **No pure-Python per-fire loops** over 686K fires anywhere on a hot path — vectorize or chunk.
- Full-eval passes over 220M rows process **chunked** (by fold / row-group) to bound memory.

## Success criteria (unchanged from parent spec, now at full scale)

Engine (model or rule) beats on-path `trail-30/10` and `hard-30m` on OOS equal-weight realized R; median giveback no worse; peak-ceiling gap closed on the high-upside tail; leakage stratification non-uniform; mode-B carry reported.

## Out of scope (still)

Project B (live signal + push), Project C (Schwab execution), Silent Boom universe, RL stopping. `theta`/`vega`/`rho` features deferred.
