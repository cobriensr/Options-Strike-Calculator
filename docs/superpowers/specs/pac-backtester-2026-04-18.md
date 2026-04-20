# PAC Backtester & Manual-Live Validation → Automation Pipeline

**Date:** 2026-04-18
**Owner:** @cobriensr
**Status:** scoping → ready to execute Epic 1
**Target outcome:** PAC/SMC structure-based strategy on MNQ + MES using CHoCH, CHoCH+, and BOS as entry triggers (both reversal and continuation variants), statistically validated across ~16 years of dual-market data, validated in manual live trading on a small real account, and only then promoted to a fully automated TV-webhook → Tradovate pipeline.

**Amendment history:**

- 2026-04-18 (v1): NQ-only, 1m+L1, paid Databento pull. Included Tradovate automation as Phase 4b.
- 2026-04-18 (v2): Discovered Databento CME Globex MDP 3.0 history covered by plan at $0. Added ES as parallel market, Phase 1.5 options features, cross-market consistency gate.
- 2026-04-18 (v3): **Restructured into two epics.** Epic 1 delivers the research + a manual-trade journal UI in strike-calculator, ending in a human-in-the-loop manual-live trading period. Epic 2 (aws-trade-automation) is deferred and conditional on Epic 1's manual-live confirming edge. Retracted the "credential rotation" item after git-history verification showed `.env` was never committed; standard secrets-hygiene upgrade moves to Epic 2 as a non-urgent code-quality task.
- 2026-04-18 (v4): **Minimized manual input in E1.6 journal UI.** Redesigned to a 2-tap flow per trade (direction at entry, confirm at exit). Everything else auto-derived from Databento live bars, PAC engine streaming mode, winning-config strategy rules, and L1 tick data. Added `_source` columns to `manual_trades` schema to track auto-derived vs user-override values. Added streaming-mode requirement to E1.1 so the PAC engine can produce current-bar state in <50ms for live auto-tagging.
- 2026-04-19 (v5): **Broadened entry-trigger set from "CHoCH+ reversal only" to "CHoCH / CHoCH+ / BOS with both reversal and continuation variants."** The sweep now tests reversal entries (CHoCH family) AND continuation entries (BOS family) through the same CPCV framework. Stop-placement and exit-trigger param spaces expanded to cover continuation semantics. The strategy is no longer pre-committed to being a reversal system — the sweep decides which structure-event family has edge. Options features and cross-market gate unchanged. Single-strategy scope preserved (not multi-strategy; the "opening balance breakout / microstructure OFI / session-boundary fade" candidates explored in scoping are deferred).
- 2026-04-19 (v6): **Data infrastructure already in place — E1.1 scope reduces accordingly.** Databento pull is _done_: `ml/data/archive/` has 16 years of OHLCV-1m (456 MB, year-partitioned parquet) + ~1 year of TBBO/L1 tick (3.9 GB) + symbology (19 MB) + condition dictionaries. Same data mirrored in Vercel Blob for production and on a Railway mounted volume via sidecar DuckDB. DuckDB read pattern exists in [sidecar/src/archive_query.py](sidecar/src/archive_query.py) with year-partitioned globs, thread-safe singleton connection, parameterized queries, front-month-by-volume contract selection. PAC engine will reuse this pattern, not rebuild it. `joshyattridge/smart-money-concepts` is already cloned at `/Users/charlesobrien/Documents/Workspace/smart-money-concepts/` — pip-installable as editable local dep. Net effect: E1.1 scope shrinks from "pull data + build PAC engine" to "build PAC engine against existing archive"; 1–2 days instead of 2–3.

---

## Goal

**Epic 1 — Strategy Research & Manual Live Validation (strike-calculator only).** Build a Python backtest harness for a LuxAlgo-PAC-style price-action strategy on NQ + ES futures using CHoCH, CHoCH+, and BOS as entry triggers (both reversal and continuation variants — not pre-committed to one direction). Validate via CPCV / PBO / Deflated-Sharpe on ~16 years of Databento 1m + options data, port the winning config to PineScript as a _charting indicator_ (no webhook emission yet), and run a manual live trading period on a small real account with results captured in an owner-gated journal UI.

**Epic 2 — Automation Pipeline (aws-trade-automation + integration). Conditional on Epic 1 success.** Harden the existing AWS webhook bridge with a risk framework, add `alertcondition()` emission to the Pine indicator, wire Aurora → Neon sync, run 90 days of paper-live with the automated pipeline, then cut over to real automated trading with progressive sizing.

## Context

- Manual journaling of a single day (2026-04-17) on MNQ produced 13 trades, 47% WR, net −$43.70. Analysis surfaced: over-trading in chop pockets, directional asymmetry on trend days, poor exit efficiency (mean 40% of MFE captured), and chasing far from OBs on losses. Pattern detection motivates rigorous backtesting rather than feel-based iteration.
- Strategy framework is LuxAlgo Price Action Concepts® — specifically **CHoCH+** (supported change-of-character) reversal setups with **Volumetric Order Block** and **FVG / PD-zone confluence**.
- **Data is free.** Databento CME Globex MDP 3.0 OHLCV-1m covering 2010-06-06 → 2026-04-18 (5,795 days, ~2 GB) is fully covered by the existing plan. Includes all CME futures (NQ, ES, MNQ, MES) and ES/SPX-adjacent options chains.
- **Dual-market testing** (NQ + ES) is the single biggest overfitting gate. A config must pass PBO / DSR / drawdown / profit-factor thresholds on BOTH markets independently.
- **Options-derived features** leverage infrastructure already in strike-calculator (max-pain calc, straddle cone, IV regime) — pointing those at ES options gives the reversal strategy regime filters without net-new math.
- **Sequencing rationale.** A manual live account at $1-per-tick MNQ with real P&L swings is a higher-fidelity validation than automated paper. Real fills, real slippage, real emotion. If the strategy fails manual live, Epic 2 engineering is saved entirely.
- **Credential hygiene note.** Verified via `git log --all -- .env` that `aws-trade-automation/.env` has never been committed — earlier concern was incorrect. Secrets Manager migration moves from Phase 0 (was urgent) to Epic 2 (non-urgent).

## Repos Touched

| Epic   | Repo                            | Role                                                                                                       |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Epic 1 | `strike-calculator` (this repo) | Data pull, PAC engine, options features, backtest, sweep, Pine charting indicator, manual-trade journal UI |
| Epic 2 | `aws-trade-automation`          | Webhook bridge hardening, risk framework, idempotency, observability                                       |
| Epic 2 | `strike-calculator` (additive)  | Aurora → Neon sync, automated paper-trades panel                                                           |

## Cross-Repo Architecture

```text
╔═══════════════════════════════════════════════════════╗
║  EPIC 1 (strike-calculator only)                      ║
║                                                       ║
║  Databento → parquet → PAC engine (NQ + ES)           ║
║    → options features → numba backtest → CPCV         ║
║    → cross-market gate → winning config               ║
║    → Pine charting indicator (no alerts yet)          ║
║    → deployed on user's TradingView                   ║
║                                                       ║
║         ↓                                             ║
║                                                       ║
║  Manual live trading: user reads Pine signals,        ║
║  hand-places orders on small live Tradovate account,  ║
║  logs trades via owner-gated journal UI               ║
║    → Neon paper_trades_manual table                   ║
║    → journal panel shows cumulative P&L vs            ║
║      backtest expectation, per-market + combined      ║
║                                                       ║
║         ↓                                             ║
║                                                       ║
║  ═════ DECISION GATE ═════                            ║
║  Does manual-live P&L within threshold of backtest?   ║
║   YES → Epic 2        NO → stop, pivot, or redesign   ║
╚═══════════════════════════════════════════════════════╝
                          ↓
╔═══════════════════════════════════════════════════════╗
║  EPIC 2 (aws-trade-automation + strike-calculator)    ║
║                                                       ║
║  Bridge TLC: risk framework, idempotency, Sentry,     ║
║    Databento cache, circuit breaker, unit tests,      ║
║    Secrets Manager migration                          ║
║                                                       ║
║         ↓                                             ║
║                                                       ║
║  Pine indicator v2: adds alertcondition() emitting    ║
║    webhook payloads with idempotency key              ║
║                                                       ║
║         ↓                                             ║
║                                                       ║
║  TradingView → webhook → AWS API Gateway →            ║
║    Lambda (risk guard + idempotency) →                ║
║    Tradovate demo → Aurora → nightly sync to Neon     ║
║    → automated paper_trades panel                     ║
║                                                       ║
║         ↓                                             ║
║                                                       ║
║  90-day paper-live → live cutover (progressive        ║
║    position sizing, monitoring, runbook)              ║
╚═══════════════════════════════════════════════════════╝
```

---

## EPIC 1 — Strategy Research & Manual Live Validation

Everything in `strike-calculator` only. Zero touches to `aws-trade-automation`.

### E1.1 — PAC engine over existing archive (1–2 days)

**Scope note:** Data pull is _already done_. `ml/data/archive/` has 16 years of OHLCV-1m (456 MB, `year=*/part.parquet`) + 1 year of TBBO/L1 tick (3.9 GB, same partitioning) + symbology + condition dictionaries. Mirrored to Vercel Blob for production and to a Railway mounted volume via sidecar DuckDB. **This phase is PAC engine only — no data-pull work.**

**Scope:**

- Install `joshyattridge/smart-money-concepts` (already cloned at `/Users/charlesobrien/Documents/Workspace/smart-money-concepts/`) as editable local dep via `pip install -e`. Fork minimally — we _extend_ upstream by importing and adding new functions, not by copying the whole package. Keeps us pulling upstream bug fixes.
- Create `ml/src/pac/` as the extension wrapper with:
  - **CHoCH+** detection: CHoCH is promoted to CHoCH+ when a prior failed HH (uptrend) or failed LL (downtrend) occurred within N bars
  - **Volumetric Order Blocks**: per-OB volume, `OB_volume`, `OB_pct_share`, `OB_z_top`/`OB_z_bot`/`OB_z_mid` (z-score vs session VWAP ± 1σ)
  - Orchestrator `engine.py` that runs both upstream primitives and our extensions over a bar DataFrame
- **Data access via DuckDB.** PAC engine's data loader calls the same `_connection()` / `read_parquet` pattern used in [sidecar/src/archive_query.py](sidecar/src/archive_query.py) — year-partitioned globs, parameterized queries, front-month-by-volume contract selection. No parallel data pipeline. `ARCHIVE_ROOT` env var defaults to `ml/data/archive` locally.
- Match `ta.pivothigh(L, R)` / `ta.pivotlow(L, R)` semantics — pivot confirms R bars later, no lookahead
- PAC engine must be symbol-agnostic — same code runs over NQ or ES
- Snapshot fixtures: ~10 LuxAlgo TradingView screenshots covering trend, chop, gap, event days

**Files (strike-calculator):**

- `ml/src/pac/__init__.py`, `swings.py`, `structure.py` (BOS / CHoCH / CHoCH+ state machine), `order_blocks.py` (Volumetric OB extension), `engine.py` (orchestrator)
- `ml/src/pac/archive_loader.py` — thin wrapper around DuckDB archive queries, returns pandas DataFrame of bars for a given `(symbol, start, end)` window
- `ml/tests/test_pac_*.py`
- `ml/requirements.txt` or `ml/pyproject.toml` — add `-e /Users/charlesobrien/Documents/Workspace/smart-money-concepts` and `duckdb` as deps
- _(Not needed: data-pull script — archive is in place)_

**Verification:**

- `python -m ml.src.pac.engine --symbol=NQ --date=2026-04-17` produces DataFrame matching journal CSV columns
- Same for `--symbol=ES`
- 2026-04-17 NQ CHoCH+ event timestamps within ±1 bar of user's manual journal entries
- `pytest ml/tests/test_pac_*.py` all green
- ≥10 snapshot fixtures pass
- **Streaming-mode callable**: `engine.current_state(bars_up_to_T)` returns active structure / OBs / FVGs / PD zone at timestamp T in < 50ms. Required for live auto-tagging in E1.6.

### E1.2 — Options features overlay (1 day)

**Scope:** Per-bar options-derived feature layer joined onto PAC feature data, indexed by `(underlying, ts)`. Features are underlying-agnostic (ES/SPX options serve as index-wide regime proxy for both NQ and ES backtests).

**v1 features:**

- `atm_iv` — ATM 0DTE straddle IV at 9:30 CT open, carried through session
- `iv_tercile` — `{low, mid, high}` vs 20-day median
- `vx_ratio` — VIX / VIX9D (reuse existing cross-asset-regime logic)
- `max_pain_distance_atr` — signed (price − daily_max_pain) / ATR(14); Python port of `api/_lib/max-pain.ts`
- `straddle_cone_pct` — (price − session_open) / 0DTE_ATM_straddle_at_open
- `opex_flag`, `fomc_flag`, `is_event_day` (derived from static calendar)

**Deferred (v1.5+ if needed):** GEX per bar, dealer-flow anomalies.

**Files:**

- `ml/src/options_features/__init__.py`, `iv.py`, `max_pain.py`, `straddle.py`, `calendar.py`, `overlay.py`
- `ml/tests/test_options_features_*.py`
- `scripts/build_options_features.py`

**Verification:**

- `python -m ml.src.options_features.overlay --underlying=ES --start=2011-01-01 --end=2024-12-31` produces parquet with all columns populated
- `max_pain_distance_atr` for 2026-04-17 matches strike-calculator's live SPX calc (regression test)
- ≥99% of RTH 1m bars have all columns non-null
- `pytest ml/tests/test_options_features_*.py` all green

### E1.3 — Numba backtest harness (2–3 days)

**Scope:**

- Custom event-driven backtest loop in `@njit`-compiled numba
- Fill model: bar-close with next-bar-open fill ± 0.5 tick slippage; optional L1 tick refinement per ticker when available
- Track per-trade: entry/exit price + ts, exit reason, P&L, $ P&L, MAE, MFE, duration, options-feature snapshot at entry
- Strategy params plug via dict:
  - PAC entry triggers (sweep tests all families, not pre-committed to reversal):
    - _Reversal family (CHoCH):_ `choch_reversal`, `choch_plus_reversal`, `choch_at_ob`, `choch_at_fvg_fill`
    - _Continuation family (BOS):_ `bos_breakout`, `bos_retest`, `bos_at_ob_retest`, `bos_with_volume`
  - PAC exit triggers: `opposite_choch`, `opposite_bos`, `ob_mitigation`, `atr_target`, `trailing_swing`, `session_end`
  - PAC stop placement: `ob_boundary`, `n_atr`, `swing_extreme`, `broken_swing` (for BOS continuations)
  - PAC confluence filters: `pd_filter`, `liq_sweep_filter`, `session_filter`, `min_ob_volume_pct`, `fvg_alignment_required`
  - Options filters: `iv_filter`, `max_pain_filter`, `straddle_cone_filter`, `event_day_filter`
- Metrics: P&L, WR, avg win/loss, expectancy, profit factor, max DD, Sharpe, Sortino, exposure %, trade count, duration
- **Deflated Sharpe Ratio** with effective-trial estimation via param-space clustering
- Per-market single runs — E1.4 orchestrates cross-market

**Files:**

- `ml/src/pac_backtest/__init__.py`, `fills.py`, `loop.py`, `trades.py`, `metrics.py`, `params.py`
- `ml/tests/test_backtest_*.py`

**Verification:**

- Replay 2026-04-17 NQ with user's journal params → trades within ±$5 of his journaled net per trade
- Replay on ES for same date produces structurally similar trade list (different P&L due to tick economics)
- `pytest ml/tests/test_backtest_*.py` all green

### E1.4 — CPCV walk-forward + Optuna sweep + cross-market gate (2–3 days)

**Scope:**

- **CPCV** N=6 groups, k=2 test → 15 paths, **independently per market**
- Embargo: 2–3× max trade duration
- Purge any training bar whose trade overlaps a test bar
- **Optuna-inside-fold**: 30 studies (15 NQ + 15 ES)
- **Cross-market consistency gate**: winning config must pass ALL thresholds on NQ AND ES independently
- **Pre-commit thresholds YAML** git-committed before first sweep
- **Stationary bootstrap** for CIs

**Files:**

- `ml/src/pac_backtest/cpcv.py`, `sweep.py`, `pbo.py`, `bootstrap.py`, `cross_market.py`, `acceptance.yml`, `run_sweep.py`
- `ml/experiments/sweeps/` — JSON results (pattern of `phase2_early`)

**Pre-commit thresholds:**

```yaml
# ml/src/pac_backtest/acceptance.yml
version: 3
committed_ts: 2026-04-18T18:30:00-05:00
commit_hash_when_locked: <to be filled at lock time>

markets:
  - symbol: NQ
    apply_thresholds: true
  - symbol: ES
    apply_thresholds: true

cross_market_gate:
  require_pass_on_all_markets: true

thresholds:
  pbo_max: 0.3
  dsr_min_95ci: 0.0
  oos_vs_is_sharpe_min: 0.7
  min_trades_per_fold: 200
  max_drawdown_pct: 0.20
  profit_factor_min: 1.4
  param_stability_max_drop: 0.30

effective_trial_estimation:
  method: 'param_cluster'
  correlation_threshold: 0.7

fill_model:
  spread_cross: true
  extra_slippage_ticks: 0.5
  commission_per_rt:
    MNQ: 1.90
    NQ: 4.00
    MES: 1.90
    ES: 4.00
```

**Verification:**

- Sweep completes on both markets and applies cross-market gate
- Report separates: `cross_market_pass`, `nq_only`, `es_only`, `non_promoted`
- ≥3 configs pass cross-market gate; if zero, strategy is rejected — no override without re-committing thresholds

### E1.5 — PineScript charting indicator (1–2 days)

**Scope — charting only, no webhooks:**

- Select highest-DSR config that passes cross-market gate
- Port to PineScript v5/v6 using `ta.pivothigh/pivotlow`
- Render BOS, CHoCH, CHoCH+, Volumetric OBs (colored by volume), FVGs, PD zones, active liquidity levels on the chart
- Options filters shown as info-table (IV regime, max-pain distance, straddle-cone position) rather than rule-gates (rule-gates come in E2.2)
- No `alertcondition()` yet — this version is visual only
- Deploy to user's TradingView account; visual verification vs LuxAlgo free SMC indicator ±1 bar

**Files:**

- `pine/pac_reversal_v1_chart.pine` (tracked in strike-calculator)

**Verification:**

- Indicator loads on TradingView NQ 1m and ES 1m charts without errors
- Visual events match LuxAlgo SMC ±1 bar on 5 sampled days (2026-04-17 + 4 historical days)
- Info-table shows live values for the options filters

### E1.6 — Manual-trade journal UI (1–2 days)

**Scope:** Owner-gated trade-entry UI in strike-calculator frontend for logging hand-placed trades during E1.7. Designed to minimize manual typing — the user inputs _only_ what the system cannot derive from Databento live bars, the PAC engine, the winning-config strategy rules, or L1 tick data. All read/write endpoints owner-gated via existing `isOwner(req)` function at `api/_lib/api-helpers.ts:101` (same pattern as the analyze endpoint).

**UX — 2-tap flow per trade:**

_Entry (when placing an order):_

- Pre-selected symbol from session context (set once per trading session, default `MNQ`)
- User taps **[Long]** or **[Short]** — the only genuinely manual input
- System auto-derives and displays for confirmation:
  - `entry_price` — latest Databento 1m bar close at click moment
  - `entry_ts` — `now()`
  - `setup_tag` — PAC engine `current_state(bars_up_to_now)` runs the detector; if a CHoCH+ / BOS / FVG reclaim is active, tagged automatically; if none active, user picks from dropdown
  - `stop_price`, `target_price`, `dollar_risk` — computed from winning-config strategy rules (OB boundary / N×ATR / swing extreme)
  - `pac_snapshot`, `options_snapshot` — full feature capture via `/api/journal/pac-snapshot?symbol=MNQ&at=<now>`
- User taps **[Confirm]** → pending trade row written to `manual_trades`
- Optional: paste notes, override `entry_price` if user's actual Tradovate fill differed (expand "override fill" link)

_Exit (when closing):_

- Pending-trade card displays current unrealized P&L, time-in-trade, distance-to-stop
- User taps **[Log exit]** — only input needed
- System auto-derives:
  - `exit_price` — latest 1m bar close
  - `exit_ts` — `now()`
  - `exit_reason` — inferred: `|exit − stop| < 1 tick` → `stop_hit`; `|exit − target| < 1 tick` → `target_hit`; else `manual_flatten`
  - `mae_price`, `mfe_price` — queried from L1 tick data between entry_ts and exit_ts
  - `pnl_points`, `pnl_net`, `r_multiple`, `trade_efficiency` — computed
- User taps **[Confirm]** → trade row closed
- Override link on `exit_reason` if user disagrees with inference

**Entry-price approximation (intentional simplification):**

- Auto-captured `entry_price` = bar close at click moment. Actual Tradovate fill may differ by 0.25–0.75 ticks on MNQ market orders — usually negligible.
- Entry form has an "override fill" expand link for the ~3% of trades where it matters.
- Full Tradovate API integration to pull actual fills is intentionally deferred to Epic 2 (not worth polluting Epic 1 scope).

**Views:**

- Pending-trades panel: live P&L on all open positions
- Closed-trades list: filterable by market, setup tag, date range
- Cumulative-P&L chart with backtest-expectation overlay (from E1.4 sweep results), per-market + combined
- Per-setup-tag breakdown (WR, avg R, expectancy)
- Today's session rollup (P&L at each hour, trades-today counter)
- Week-over-week WR trend

**Data model (Neon, new migration):**

- `manual_trades` table — one row per trade lifecycle (entry → exit), with `status ∈ {open, closed, cancelled}`
- Columns grouped by derivation source:
  - _User-entered_: `direction`, `notes`
  - _Auto-captured_: `entry_price`, `entry_ts`, `exit_price`, `exit_ts`
  - _Auto-derived from strategy rules_: `stop_price`, `target_price`, `dollar_risk`
  - _Auto-detected_: `setup_tag`, `exit_reason`
  - _Auto-computed from tick data_: `mae_price`, `mfe_price`
  - _Auto-computed from lifecycle_: `pnl_points`, `pnl_net`, `r_multiple`, `trade_efficiency`
  - _JSONB snapshots_: `pac_snapshot` (full PAC state at entry), `options_snapshot` (full options overlay at entry)
  - _Metadata_: `market`, `symbol`, `status`, `created_at`, `closed_at`
- **`_source` columns** for every auto-derived field: `entry_price_source`, `setup_tag_source`, `exit_reason_source`, etc. ∈ `{auto, user_override}`. Distinguishes system-derived values from user corrections for audit and for re-running analytics if the auto-derivation logic changes.
- Migration added to `api/_lib/db-migrations.ts` with matching updates in `api/__tests__/db.test.ts`

**API endpoints (all owner-gated):**

- `POST /api/journal/manual-trade/entry` — creates a pending trade row
- `POST /api/journal/manual-trade/exit` — closes a pending trade, computes P&L
- `GET /api/journal/pac-snapshot` — on-demand PAC+options feature snapshot for a timestamp (used by the entry form's auto-populate)
- `GET /api/journal/manual-trades` — list trades for the cumulative panel
- `DELETE /api/journal/manual-trade/:id` — fat-finger recovery

**Files:**

- `api/journal/manual-trade/entry.ts` (new)
- `api/journal/manual-trade/exit.ts` (new)
- `api/journal/manual-trade/[id].ts` (new)
- `api/journal/pac-snapshot.ts` (new) — uses PAC engine from E1.1
- `api/journal/manual-trades.ts` (new) — list endpoint
- `api/_lib/db-migrations.ts` — new migration
- `api/__tests__/db.test.ts` — mock sequence update
- `src/components/ManualTradeForm.tsx` (new)
- `src/components/ManualTradesPanel.tsx` (new)
- `src/hooks/useManualTrades.ts` (new)
- `src/hooks/usePacSnapshot.ts` (new)

**Verification:**

- Non-owner (cookie-less browser) hits `POST /api/journal/manual-trade/entry` → 401
- Owner hits same endpoint → 200, row created in `manual_trades` with `status: 'open'`
- Exit endpoint closes the trade and computes net P&L
- `pac-snapshot` endpoint returns feature DataFrame row for `(symbol, ts)` with all PAC + options columns
- Frontend form renders, auto-populates features when entry timestamp is set
- Cumulative-P&L chart renders with backtest-expectation overlay (overlay pulled from E1.4 sweep results)

### E1.7 — Manual live trading period (user-defined, ~1–2 months)

**Scope — operational phase, no code changes:**

- User trades the strategy on a small live Tradovate account using the E1.5 Pine indicator as the signal source
- Every trade is logged via the E1.6 UI, with setup-tag field filled in
- Weekly review: per-market and combined WR vs backtest IS WR
- Monthly review: full stats refresh vs pre-commit thresholds

**Not a coding phase.**

**Verification (decision-gate criteria for Epic 2 promotion):**

- ≥60 manual-live trades logged across both markets (rough minimum for statistical comparison to IS bucket)
- Delta-DSR between manual-live window and backtest IS window computed per market
- If delta-DSR ≥ 0 on both markets (within stationary-bootstrap CI) → green light for Epic 2
- If delta-DSR < 0 on either market → do not promote; options are (a) abandon, (b) redesign and re-run E1.4, (c) accept that the manual-live phase _is_ the outcome and keep manual-trading without Epic 2

---

## DECISION GATE

After E1.7 completes, one of three outcomes:

1. **Green light → Epic 2.** Strategy validated on both markets. Proceed with automation.
2. **Red light → stop.** Strategy doesn't transfer to live. Epic 2 cancelled. Either pivot the strategy or return to backtest research.
3. **Yellow → keep manual.** Strategy works manually but user prefers staying hands-on. Epic 2 deferred indefinitely; E1.5 + E1.6 are the final deliverables.

---

## EPIC 2 — Automation Pipeline (conditional)

Triggered only if Epic 1's E1.7 gate is green. All work in `aws-trade-automation` unless noted.

### E2.1 — Bridge TLC (2–3 days)

**Scope:**

- **Risk framework** — pre-submit guard in `handle_futures_trade()` rejecting orders violating any of:
  - Symbol ∈ `{MNQ, NQ, MES, ES}` allowlist
  - Max 1 contract per order
  - Max 2 open positions (1 per market)
  - Daily loss limit (aggregate) — halt further orders if realized loss ≥ configurable $ threshold
  - Trading window 08:30–15:00 CT only
  - Kill switch DynamoDB flag `trading_enabled`
- **Idempotency**: dedup by hash of `(strategy, market, signal_ts, direction)`; DynamoDB 24h TTL
- **Databento symbol-lookup cache**: 1h TTL in DynamoDB
- **Sentry integration**: `@sentry/python`, same DSN convention as strike-calculator
- **Unit tests**: pytest covering `handle_futures_trade()`, risk guards, idempotency, token refresh, symbol mapping
- **Circuit breaker**: 30s halt after 3 consecutive Tradovate API failures, exponential backoff retries
- **Secrets Manager migration** (non-urgent code hygiene, rolled in here for convenience)

**Files:**

- `src/risk_guards.py`, `idempotency.py`, `symbol_cache.py`, `circuit_breaker.py`, `observability.py` (all new)
- `src/main.py` — wire guards into `handle_futures_trade()`
- `src/config.py` — Secrets Manager reads
- `terraform/dynamodb.tf`, `cloudwatch.tf`, `secrets.tf`, `iam.tf`
- `tests/test_risk_guards.py`, `test_idempotency.py`, `test_symbol_cache.py`, `test_integration.py`

**Verification:**

- Unit-test coverage > 80% on `handle_futures_trade()` + guards
- End-to-end demo TradingView → bridge → Tradovate demo order → fill → Aurora, within 3s on both NQ and ES
- Kill-switch flip stops submission within 1s
- Duplicate webhook rejected without reaching Tradovate
- Symbol allowlist rejects `BTCUSD` test payload with 400

### E2.2 — Pine alert wiring (0.5–1 day)

**Scope:**

- Copy E1.5 Pine indicator to `pac_reversal_v1_alerts.pine`
- Add `alertcondition()` on entry and exit signals
- Alert payload includes idempotency key: `{strategy: "pac_v1", market: "MNQ"|"MES", signal_ts: bar_time, direction: "long"|"short", price: close}`
- Deploy to TradingView and set up alerts pointed at aws-trade-automation staging endpoint

**Files:**

- `pine/pac_reversal_v1_alerts.pine`

**Verification:**

- Alert fires at bar close of a CHoCH+ test signal
- Webhook hits staging AWS endpoint with correct payload shape
- Idempotency key causes second firing of same signal to be rejected by E2.1's dedup

### E2.3 — Aurora → Neon sync + automated paper-trades panel (1 day)

**Scope:**

- Nightly sync reads new rows from Aurora `trades` table → upserts to Neon `paper_trades_auto` table
- Frontend automated-trades panel reads `paper_trades_auto`, alongside the manual `manual_trades` from E1.6
- Migration adds `paper_trades_auto` (distinct from `manual_trades` so the two audit trails stay separable)

**Files:**

- `aws-trade-automation/src/sync_to_neon.py`
- `strike-calculator/api/_lib/db-migrations.ts` — new migration
- `strike-calculator/api/__tests__/db.test.ts` — mock sequence update
- `strike-calculator/src/components/AutoTradesPanel.tsx` (new)
- `strike-calculator/src/hooks/useAutoTrades.ts` (new)

**Verification:**

- Tradovate paper fill → within 24h appears in frontend automated panel
- Manual and auto panels render side-by-side without interference

### E2.4 — 90-day paper-live (operational)

**Scope:**

- Run the fully automated pipeline on Tradovate demo for 90 calendar days
- Weekly + monthly review vs pre-commit thresholds
- **No parameter changes during the window** (pre-registration discipline)

**Verification (live-cutover gate):**

- ≥200 automated paper trades per market
- Delta-DSR between paper-live and manual-live ≈ 0 (within CI) — paper should not be wildly better or worse than manual
- If paper-live diverges dramatically from manual, assume automation has a bug (latency, slippage, fills) and root-cause before promoting

### E2.5 — Live cutover (1 week)

**Gate:** E2.4 passes on both markets.

**Scope:**

- Flip `TRADOVATE_ENV=live` env var (config switch, not code edit)
- Progressive position sizing: start 1 contract per market, scale up only if live P&L ≥ paper-live P&L at same trade count
- Optionally start live on stronger-performing market only, add second after 2 weeks clean
- Extra observability: per-trade Sentry breadcrumb, CloudWatch realized-loss-per-hour alarm
- `RUNBOOK.md` for manual intervention

**Files:**

- `aws-trade-automation/src/config.py` — env-driven endpoint selection
- `aws-trade-automation/RUNBOOK.md`
- `terraform/cloudwatch.tf`

**Verification:**

- First live trade placed, filled, logged
- Kill-switch tested live with 0-contract test order
- No auto-promotion — user manually flips env var after reviewing 90-day paper report

---

## Data Dependencies

| Dependency                                         | Source                                                                    | Cost        | Status                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| CME Globex MDP 3.0 OHLCV-1m, 16 years (~2010–2026) | Databento → `ml/data/archive/ohlcv_1m/` + Vercel Blob + sidecar DuckDB    | $0 (plan)   | **In place** (456 MB, year-partitioned parquet) |
| TBBO / L1 tick data, ~1 year                       | Databento → `ml/data/archive/tbbo/` + Vercel Blob + sidecar DuckDB        | $0 (plan)   | **In place** (3.9 GB, year-partitioned parquet) |
| Symbology + condition dictionaries                 | Databento → `ml/data/archive/symbology.parquet` + condition JSON          | $0 (plan)   | **In place** (19 MB)                            |
| ES options chain snapshots                         | Databento                                                                 | $0 (plan)   | Pending pull (Phase E1.2)                       |
| `joshyattridge/smart-money-concepts` baseline      | GitHub → `/Users/charlesobrien/Documents/Workspace/smart-money-concepts/` | $0          | **In place** (install via `pip install -e`)     |
| Small Tradovate live account (for E1.7)            | Tradovate                                                                 | User-funded | Exists                                          |
| Tradovate demo account (for E2.4)                  | Tradovate                                                                 | Free        | Exists                                          |
| AWS infra (Lambda, Aurora, DynamoDB, S3)           | AWS                                                                       | Existing    | Exists (for Epic 2)                             |
| Neon Postgres                                      | Neon                                                                      | Existing    | Exists                                          |
| Vercel Blob (alternate parquet storage)            | Vercel                                                                    | Existing    | Exists                                          |
| TradingView account with Pine                      | TradingView                                                               | Existing    | Exists                                          |

## New Tables / Migrations

**Neon (strike-calculator), added in E1.6:**

- `manual_trades` — one row per trade lifecycle. User-entered: `direction`, `notes`. Auto-captured: `entry_price`, `entry_ts`, `exit_price`, `exit_ts`. Auto-derived: `stop_price`, `target_price`, `dollar_risk`, `setup_tag`, `exit_reason`. Auto-computed: `mae_price`, `mfe_price`, `pnl_points`, `pnl_net`, `r_multiple`, `trade_efficiency`. JSONB: `pac_snapshot`, `options_snapshot`. Metadata: `market`, `symbol`, `status`, `created_at`, `closed_at`. Plus `*_source` columns on every auto-derived field ∈ `{auto, user_override}`.

**Neon (strike-calculator), added in E2.3:**

- `paper_trades_auto` — mirror of Aurora `trades`, synced nightly

**Aurora (aws-trade-automation), verified/added in E2.1:**

- `trades` — entry, exit, P&L, MAE, MFE, setup tag, `market`
- DynamoDB: `idempotency_keys`, `symbol_cache`, `kill_switch`

Migrations added to `api/_lib/db-migrations.ts` with matching `api/__tests__/db.test.ts` mock sequence updates per project convention.

## Environment Variables

Epic 1 only:

- `DATABENTO_API_KEY` (already exists in sidecar; reuse)
- `PARQUET_STORAGE ∈ {s3, vercel_blob}` — one-off at pull time
- `S3_BUCKET_CME_DATA` or `VERCEL_BLOB_CME_DATA_PREFIX`

Epic 2 (conditional):

- `TRADOVATE_ENV ∈ {demo, live}` in aws-trade-automation
- `SENTRY_DSN` in aws-trade-automation Lambdas
- `DAILY_LOSS_LIMIT_USD` — aggregate across markets
- `KILL_SWITCH_TABLE_NAME` — DynamoDB table name

## Open Questions

None remaining — all closed in 2026-04-18 scoping conversation. Reopen if any phase discovers a blocker.

## Risks & Mitigations

| Risk                                                                                                       | Likelihood | Mitigation                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python PAC engine diverges from LuxAlgo visual; strategy trades differently in Pine than in backtest       | High       | Snapshot fixtures vs LuxAlgo screenshots in E1.1; require visual review before E1.5                                                                                                            |
| Options-feature filter expansion inflates effective trial count, deflating DSR bar                         | Medium     | Cap filter additions at the 5 E1.2 v1 features; require hypothesis articulation before adding any filter beyond v1                                                                             |
| Strategy passes NQ but fails ES (or vice versa) → cross-market gate rejects every config                   | Medium     | This is a VALID NEGATIVE result — it means the strategy has no transferable edge. Document and pivot; do not relax the gate.                                                                   |
| Manual-live P&L diverges from backtest due to human execution variance (entry delays, hand-picked signals) | Medium     | Log exit reason + discrepancy between indicator signal timestamp and user's actual entry timestamp. If user is taking only a subset of signals, treat the sample as biased and flag in review. |
| User doesn't hit 60-trade manual-live threshold within 2 months                                            | Low-Medium | Relaxed to whatever sample size is available at end of window; use power analysis to honestly state what can/cannot be concluded                                                               |
| Overfitting survives CPCV (high-correlation params mask effective-trial count)                             | Medium     | PBO > 0.3 gate + param-stability perturbation + cross-market gate; reject family if any fail                                                                                                   |
| ES options data coverage gaps in early years (2010–2013)                                                   | Low-Medium | Use options features only from clean-coverage date; document cutoff in E1.2. PAC backbone runs on full history.                                                                                |
| Databento pull fails or rate-limits mid-way                                                                | Low        | Idempotent per-month parquet writes; resume-from-last-month on restart                                                                                                                         |
| Bayesian optimization overfits despite CPCV-fold isolation                                                 | Low        | DSR with effective trial count; pre-commit thresholds prevent promotion                                                                                                                        |
| Epic 2 bridge TLC introduces regressions in existing OANDA/Coinbase handlers                               | Low-Medium | Add unit tests for existing handlers as part of E2.1; run end-to-end smoke against demo endpoints before deploy                                                                                |

## Timeline

**Epic 1 (strike-calculator):**

| Phase                                   | Nominal               | User-compressed       | Sequential?                 |
| --------------------------------------- | --------------------- | --------------------- | --------------------------- |
| E1.1 — PAC engine over existing archive | 1–2 days              | 0.5–1 day             | Blocks E1.2, E1.3           |
| E1.2 — Options features                 | 1 day                 | 0.5 day               | Blocks E1.3 if filter-gated |
| E1.3 — Backtest harness                 | 2–3 days              | 1–2 days              | Blocks E1.4                 |
| E1.4 — CPCV + sweep + cross-market gate | 2–3 days              | 1–2 days              | Blocks E1.5                 |
| E1.5 — Pine charting indicator          | 1–2 days              | 1 day                 | Blocks E1.7                 |
| E1.6 — Manual-trade journal UI          | 1–2 days              | 1 day                 | Blocks E1.7                 |
| E1.7 — Manual live trading period       | 30–60 days wall-clock | 30–60 days wall-clock | Decision gate before Epic 2 |

Compressed Epic 1 engineering: **~7–10 working days** before manual live starts. Then 1–2 months manual live before Epic 2 decision.

**Epic 2 (aws-trade-automation + integration), conditional:**

| Phase                    | Nominal            | User-compressed    |
| ------------------------ | ------------------ | ------------------ |
| E2.1 — Bridge TLC        | 2–3 days           | 1–2 days           |
| E2.2 — Pine alert wiring | 0.5–1 day          | 0.5 day            |
| E2.3 — Sync + auto panel | 1 day              | 0.5 day            |
| E2.4 — 90-day paper-live | 90 days wall-clock | 90 days wall-clock |
| E2.5 — Live cutover      | 1 week             | 1 week             |

Compressed Epic 2 engineering: **~3–5 working days** before automated paper-live starts.

## Done When

**Epic 1 done when:**

- E1.1–E1.6 shipped
- E1.7 manual-live window complete with ≥60 trades logged
- Decision gate outcome recorded (green / red / yellow) as an amendment to this doc

**Epic 2 done when (conditional):**

- E2.1–E2.3 shipped
- E2.4 90-day paper-live complete
- E2.5 live cutover decision made and recorded as an amendment

---

_Plan written 2026-04-18. v2 added ES + options. v3 restructured into Epic 1 (research + manual-live in strike-calculator) and Epic 2 (automation in aws-trade-automation), introduced E1.6 manual-trade journal UI with owner-gating via `isOwner(req)` pattern, and retracted the Phase 0 credential-rotation item after git-history verification showed `.env` was never committed. v4 minimized manual input in E1.6 to a 2-tap-per-trade flow — everything else auto-derived from Databento live bars, PAC engine streaming mode, winning-config strategy rules, and L1 tick data; added `_source` audit columns to `manual_trades`; added streaming-mode requirement to E1.1. v5 (2026-04-19) broadened the entry-trigger scope from CHoCH+-reversal-only to the full CHoCH / CHoCH+ / BOS family with both reversal and continuation variants, expanded exit-trigger and stop-placement param spaces accordingly, and documented that "opening balance / microstructure OFI / session-boundary fade" alternate candidates explored in scoping are deferred to a future multi-strategy amendment once the PAC-only sweep has a baseline result. Research references: Tradovate API (live.tradovateapi.com/v1), Python backtesting frameworks (custom numba over vectorbt / nautilus_trader), open-source PAC/SMC (joshyattridge/smart-money-concepts fork baseline), walk-forward best practices (CPCV + PBO + DSR per Lopez de Prado, Wiecki, Harvey)._
