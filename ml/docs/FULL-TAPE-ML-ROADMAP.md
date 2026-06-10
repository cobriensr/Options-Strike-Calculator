# Full-Tape ML Roadmap

> Created: 2026-06-09 · **Single self-contained build-ready document.**
> Data source: `~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet` (107 files, 2026-01-02 → 2026-06-08)
> Status: **planning complete, not yet built.** Every feasibility claim is verified against the tape (probe: `docs/tmp/full-tape-probe.py`) and every reused signature against real repo code. The intent: building is pure execution — no investigation-while-building.

---

## 0. Executive summary

Five ML projects (FT-1…FT-5) plus a shared data foundation (FT-0), all built on the full intraday options tape rather than the 5-minute Neon cron snapshots that the existing [ROADMAP.md](ROADMAP.md) uses. Separate, higher-resolution track with its own `FT-N` numbering.

| ID | Project | Resolution | Type | Depends | Build risk |
| -- | ------- | ---------- | ---- | ------- | ---------- |
| FT-0 | Shared data foundation | — | infra | — | Low (mostly reuse; charm is the only net-new primitive) |
| FT-1 | Dealer gamma **trajectory** | minute | reconstruction → predictive | FT-0 | Medium (sign-convention hard gate) |
| FT-2 | Intraday path / MAE-MFE exit | minute entry-state | conditional quantile regression | FT-0, FT-1 | Low-Med (reuse exit lib) |
| FT-3 | Last-hour charm/vanna drift | minute | sign + magnitude regression | FT-0 (charm) | Medium (derive charm) |
| FT-4 | **IV-regime directional-flow signal** | per-trade | supervised classification | FT-0 | **Caution — signal-confirm gate first (§2A)** |
| FT-5 | "Today is different" anomaly | per-morning | unsupervised (IF + autoencoder) | FT-0 | Low |

*FT-6 (gamma-flip timing) was dropped 2026-06-09 — see §2A.*

**Build order:** FT-0 → FT-1 → (FT-2, FT-3) ; FT-4 and FT-5 independent, any time. FT-1 is the highest-leverage single build (FT-2 consumes it).

**Gate status (2026-06-09, see §2A):** G1 (FT-1 dealer-sign reconciliation) — **PASSED, sign inverted to `+signed_dir`**. FT-6 (gamma-flip timing) — **dropped** (flow-only census failed; revisit only with OI-anchored ZG).

---

## 1. Why this is a separate track + the organizing thesis

The existing [ROADMAP.md](ROADMAP.md) is built on **5-minute Neon cron snapshots** (~78×/day aggregates). This track is built on the **full intraday tape**: every print with NBBO + per-trade greeks, ~11.2M rows/day, ~1.5M SPXW. Different resolution → separate `FT-N` numbering. Where they overlap (FT-2 ≈ existing Phase 5 survival), the FT version is the tape-native sibling and cross-references it.

**Organizing thesis — match model resolution to data abundance:**

| Resolution | Samples (107 days) | Verdict | FT projects |
| ---------- | ------------------ | ------- | ----------- |
| Per-trade | ~10⁹ | Abundant — ML can genuinely learn | FT-4 |
| Per-minute | ~41,000 | Plenty | FT-1, FT-2, FT-3 |
| Per-day | 107 | Tiny — overfit risk | FT-5 (unsupervised, sidesteps it) |

A 0DTE trader makes **intraday** decisions, so day-level "predict the day" models are both least tradeable here and most data-starved. This track concentrates at minute/trade level; the one day-level idea (FT-5) is unsupervised so it never needs 107 labels.

---

## 2. Verified data facts (probe 2026-06-09)

Measured, not assumed. Source: `docs/tmp/full-tape-probe.py`.

### 2.1 Schema drift — **build-breaker, handled in FT-0**
- Files **2026-01-02 → ~2026-05** have **39 columns**; **2026-06-01 onward** have **42** (added `date`, `ingested_at`, `alert_score`). Only ~6 newest files have `date`.
- **0DTE detection must derive trade-date from `executed_at`** (`.dt.tz_convert('America/Chicago').dt.date`), never `expiry == date`. Treat `date`/`ingested_at`/`alert_score` as optional; `alert_score` as a feature is June-only → unusable for historical training.
- Loader must intersect requested columns with each file's actual schema.

### 2.2 Aggressor signing — **tags-first, NBBO-second, ~99% coverage**

| | bid_side | ask_side | untagged | valid NBBO |
| --- | --- | --- | --- | --- |
| SPXW 06-08 | 43.5% | 36.5% | 20.0% | 98.8% |
| SPXW 05-15 | 43.6% | 35.8% | 20.6% | 98.4% |
| SPY 06-08 | 47.9% | 45.5% | 6.7% | 99.4% |
| QQQ 06-08 | 46.4% | 44.4% | 9.1% | 98.8% |

~80% of SPXW carry a side tag; ~20% untagged signed via price-vs-NBBO (98.8% have a usable quote) → ~99% total. **Never** sign from `ask_vol`/`bid_vol` (cumulative rollups, [memory: feedback_uw_fulltape_vols_cumulative]). `canceled` < 0.002% but must be filtered.

### 2.3 Volume & 0DTE share
SPXW ~1.5M trades/day, **83.8% 0DTE** (~1.25M). SPY 0DTE 69.7%, QQQ 65.8%. `underlying_price` dense (5k+ unique/day) for forward returns + repricing.

### 2.4 Session window
SPXW prints 08:30:02 → 15:59:59 CT; only **0.96%** outside 08:30–15:00 CT. Restrict to 08:30–15:00 CT (trader flat by 15:00).

### 2.5 FT-2 path feasibility — **split decision, quantified**
0DTE SPXW: every session minute has *some* print, but per-contract coverage is bimodal:
- **ATM band (±1% of spot): 58–60 contracts, median 382–383 of 390 minutes** → near-continuous → **actual prints**.
- **All strikes: median 26 minutes** → far-OTM sparse → **BS-reprice off `underlying_price`**.

### 2.6 Gamma-flip frequency (→ FT-6 dropped)
Crude signed-flow-cumulative proxy showed near-zero intraday flips (1 on 06-08, 0 on 05-15); the 18-day census (§2A) confirmed this on flow-only data → **FT-6 was dropped 2026-06-09.** Kept here as a data fact: intraday dealer-gamma sign rarely flips without an OI anchor.

### 2.7 Environment verified (`ml/.venv`, Python 3.14)
`sklearn 1.8.0`, `torch 2.11.0` (→ FT-5 uses a real autoencoder, not PCA fallback), `xgboost` (2.x), `lifelines`, `scipy`, `numpy`, `pandas 3.x` (`Categorical.astype(str)` NaN gotcha [memory: project_pandas3_categorical_nan]), `pyarrow`, `polars`, `duckdb`, `statsmodels`, `psycopg2`, `sqlalchemy`. `ml/src/full_tape/` does NOT exist yet (confirmed clean).

---

## 2A. Resolved findings (de-risking probes 2026-06-09)

Four load-bearing unknowns were resolved by running `docs/tmp/ft{1,6,2,4}_*probe.py`. **These override the original FT-section defaults wherever they conflict.**

**FT-1 — sign convention + gamma units (both hard-resolved). G1 gate PASSED.**
- Tape `gamma` is **raw BS per-point**, not per-1% (median tape/γ_bs_raw = 1.11; /γ_bs_pct = 0.0002). FT-1 must apply `× S²×1e-4`. The §5 GAMMA_NOTIONAL formula is correct as written.
- **Dealer sign is INVERTED vs the canonical assumption.** Reconciled vs Neon `spot_exposures.gamma_oi` on 2026-06-08: `-signed_dir` (canonical dealer-short) → **11.9%** sign agreement; **`+signed_dir` → 88.1%** (Spearman ρ = +0.512, p<1e-4). Use `+signed_dir`, align to the app's existing convention (`gamma_oi>0 ⇒ suppressive`), and use the Neon anchor directly (same perspective — no negation). Confirms & resolves [memory: project_range_model_phase1].
- Delta self-check: raise `DELTA_SELF_CHECK_TOL 0.05 → 0.10` (92.8% pass at 0.10; ATM is tighter only due to mid-quote-IV snapshot timing, not a BS-port bug).

**FT-6 — DROPPED 2026-06-09 (flow-only flip census failed).**
- 18-day sample. **Def-1** (inventory sign): 27.8% days ≥1 flip, median 0, flips cluster in the first 16 min (opening-auction noise) → **FAIL**. **Def-2** (spot crosses ZG): ~0 flips — flow-only ZG sits 50–220 pts *below* spot (put-dominated without an OI anchor), so `sign(spot−ZG)` is +1 all session → **FAIL**.
- Root cause is the missing OI anchor, not absence of the phenomenon — but rather than block it indefinitely, **FT-6 is dropped from the roadmap.** If ever revisited, the prerequisite is OI-anchored ZG (FT-1's anchored curve or Neon `zero_gamma_levels`, cols `ts`/`zero_gamma`, 2026-03-01+) and a fresh census; do not resurrect on flow-only data.

**FT-2 — OTM repricing: use per-minute tape IV (not constant-IV).**
- Tape `implied_volatility` is **mid-quote IV**, not transaction IV (numerical inversion: print-IV ~9.4% below tape IV). All BS OTM paths overprice transaction prices ~10–25% (structural, uncorrectable). Constant-IV is unacceptable (IV drift 7–13% in the first hour → 30–50%+ error).
- **`build_otm_path` uses per-minute tape IV in v1** (was deferred v2) — cuts forward error ~46%. Residual ~10–25% level overstatement biases MFE *conservatively upward* (acceptable); rank-order preserved. ATM ±1% threshold validated (ATM 342–384/390 min, OTM 13–35/390). Calibrate OTM-MFE level bias against ATM tape-native paths before trading on it.

**FT-4 — band broken; aggressor-side hypothesis fails; reframe around IV. Lean: CAUTION.**
- **Band formula is ~10–18× too wide:** `0.5×VIX1D/√390×√5` ≈ 90 bps at VIX 16 → 100% NOISE. Correct ≈ **5 bps** for SPY/QQQ (40–60% NOISE) or empirical `p70(|ret_fwd_5m|)` per day; SPXW ~10–15 bps. Drop/rescale the formula.
- **Per-trade aggressor signal fails:** side / paid_up / tags / size all AUC≈0.50, and "ask-side=informed" *inverts* (directional hit-rate 0.6–0.7× baseline) — replicates [memory: project_concentrated_flow_no_edge]. **IV is the only real separator (AUC 0.755).** **Actioned: FT-4 is reframed as an IV-regime signal (see its section) with a Phase-0 signal-confirmation gate (IV-AUC across VIX regimes, event-day control) that must pass before any corpus build.**

---

## 3. Reuse map (repo archaeology 2026-06-09)

Build `ml/src/full_tape/` new, but import/model these tested modules. The **only net-new primitive is Python charm/vanna** (no Python Black-Scholes exists anywhere — port `src/utils/black-scholes.ts`).

| Need | Reuse | Notes |
| ---- | ----- | ----- |
| Fulltape loader (pyarrow pushdown) | `scripts/refine_naive_gamma_charm.py:get_parquet_path`, `load_day_trades_indexed` | `read_table(filters=[('underlying_symbol','=',...),('expiry','=',date_obj)], columns=...)`. `expiry` filter needs a `date` object, not string. |
| Vectorized tape→MFE | `scripts/refine_naive_gamma_charm.py:compute_R_fast` | `np.searchsorted` entry + forward-max |
| Spot attach | `scripts/refine_naive_gamma_charm.py:load_spot`/`attach_spot` | Neon `index_candles_1m`, backward `merge_asof` |
| **Trade-side signing (tags)** | `scripts/backfill_silent_boom_from_fulltape.py:load_buckets_for_date_fulltape` | `tags.str.contains('ask_side'/'bid_side')`; FT-0 extends with NBBO fallback |
| **MAE/MFE & exit policies** | `ml/src/lottery_exit_policies.py` (`realized_*`, `peak_ceiling`, `minutes_to_peak`) | source-agnostic, tested; FT-2 imports directly |
| Full-tape MFE outcome | `scripts/enrich_silent_boom_outcomes_fulltape.py:compute_outcomes` | proven full-tape path |
| Forward-return labeling | `ml/src/eod_flow_forward_returns.py:_attach_forward_returns`, `_attach_direction_and_signed`, `_load_minute_spot` | multi-horizon `merge_asof`; FT-4 models on this |
| Gamma profile / pin | `ml/src/pin_analysis.py:compute_gamma_profile`, `gamma_concentration`, `gamma_spread`, `prox_centroid` | FT-1 curve features mirror these |
| Zero-gamma level | `api/_lib/zero-gamma.ts:computeZeroGammaLevel` (port to Python) + Neon `zero_gamma_levels` (reliable 2026-03-01+) via `setups_backtest/data_loaders.py:load_zero_gamma` | FT-1 zero-gamma curve feature; grid: 30 pts, ±3% |
| Dealer-sign authority | `api/_lib/market-mechanics.ts`; `spot_exposures.gamma_oi` ← UW `gamma_per_one_percent_move_oi` (`api/_lib/fetch-spot-gex.ts:44,114`); `takeit/build_training_set.py:363-371` (`gamma_oi>0 ⇒ dealer long ⇒ suppressive`) | FT-1 sign gate reference |
| Anomaly/baseline machinery | `ml/src/eod_flow_baselines.py`, `flow_outliers.py`, `clustering.py` | FT-5 morning-feature + scaling conventions |
| Calibration | `ml/src/calibration.py:compute_calibration_score`, `bucket_summary` | all probabilistic heads |
| Time-aware train conventions | `ml/src/takeit/train.py` + `config.py` (`WALK_FORWARD_FOLDS=5`, `ISOTONIC_HOLDOUT_FRAC=0.20`, XGB params) | FT-3/FT-4 |
| Shared infra | `ml/src/utils/__init__.py` (`get_connection` Neon-retry, `load_env`, `validate_dataframe`, `save_section_findings`) | importable as top-level `utils` (conftest path) |

**Venv/paths:** run with `ml/.venv/bin/python`. `ml/src/` on conftest path (`from full_tape import ...`, `from utils import ...`); `scripts/` self-insert. Keep `pd.to_numeric(errors='coerce')` on price/size/strike for old-file Decimal safety even though 42-col files store doubles.

---

## 4. Shared data caveats (every FT project)

1. Trade-date from `executed_at`, not `date` (§2.1).
2. Signing tags-first, NBBO-second; skip `nbbo_bid==nbbo_ask==0`; never `*_vol` (§2.2).
3. Filter `canceled==True` before aggregation.
4. Universe: index work (FT-1/2/3) → `SPXW`; informed-flow (FT-4) → `SPY`/`QQQ` first ([memory: feedback_hunt_flow_in_spy_qqq]).
5. Session 08:30–15:00 CT; drop extended/contingent ([memory: feedback_extended_hours], [feedback_contingent_trade_filter]).
6. EOD ≠ live — each spec states its live-reconstruction path (UW websocket `option_trades` + greeks).
7. Compute: ~150 GB/full pass. Push down filters; cache minute-bar intermediates; **every backfill resumable** ([memory: feedback_instrument_before_long_runs]).

---

## 5. Shared build conventions (apply to all FT specs)

**Package tree** (FT-0 creates the base; each project adds one or two modules):
```
ml/src/full_tape/
  __init__.py        loader.py      signing.py    greeks.py        (FT-0)
  aggregate.py       resample.py    cache.py                       (FT-0)
  ft1_dealer_gamma.py                                              (FT-1)
  ft2_path_model.py  ft2_runner.py                                 (FT-2)
  ft3_charm_drift.py                                               (FT-3)
  ft4_iv_regime.py                                                 (FT-4)
  ft5_anomaly.py     ft5_constants.py                              (FT-5)
ml/tests/test_full_tape_*.py , test_ftN_*.py
```

**Standardized paths** (reconciled across specs):
- Minute-bar / labeled-corpus caches → `ml/cache/full_tape/ftN/{date}.parquet` — **gitignored** (large binary, resumable part-files; atomic `.tmp`→rename).
- Experiment artifacts / run JSON → `ml/experiments/full-tape/ftN/`.
- Plots → `ml/plots/full-tape/ftN/` — **tracked in git** ([memory: feedback_keep_ml_plots_in_git]).
- Saved models → `ml/models/`.

**Standardized constants:**
- `RATE_R = 0.0` for all BS greeks/repricing (matches `black-scholes.ts`; required for the delta self-check; 0DTE rate impact on price ~0.1%, below noise).
- `GAMMA_NOTIONAL = per-1%-move` (matches `spot_exposures.gamma_oi`): `gamma_$ = gamma × S² × 0.0001 × size × 100`.
- Session `08:30–15:00 CT`, DST-aware via `zoneinfo.ZoneInfo('America/Chicago')` (tape spans CST and CDT — never a fixed offset).
- `CONTRACT_MULTIPLIER = 100`.

**Dealer-sign convention (RESOLVED 2026-06-09 — see §2A):** empirically reconciled against Neon `spot_exposures.gamma_oi`, the app-aligned sign uses **`+signed_dir`** (ask-side `signed_dir=+1`, bid-side `-1`, mid `0`): `dealer_greek = +signed_dir × greek × ... × size × 100`. This is the **inverse** of the textbook dealer-short convention (which scored only 11.9% sign agreement vs Neon; `+signed_dir` scored 88.1%, ρ=+0.512). Result aligns with the app's existing `gamma_oi>0 ⇒ suppressive` convention; the Neon OI anchor is used directly (same perspective, no negation). Mid/untagged excluded from signed sums (still counted in volume/premium). **G1 gate PASSED** — magnitudes are now trustworthy.

**Shared eval discipline (mandatory):** walk-forward only (never random-split time series); beat ≥3 baselines (majority/naive, persistence, relevant existing rule); leakage reflex — *uniform lift across stratified buckets = leakage* ([memory: feedback_uniform_lift_is_leakage]), and audit feature timestamps for look-ahead; score with realized R under a stop, not peak/EOD ([memory: feedback_path_matters_not_endpoint]); calibration via `calibration.py`. FT-1/2/3 have a dealer-hedging mechanism (why they should hold OOS); FT-4/5 are empirical — higher bar.

---

## FT-0 — Shared data foundation

**Goal:** reusable `ml/src/full_tape/` so FT-1/2/3/6 don't re-load 1.4 GB or re-derive primitives.

**Public API (signatures):**
```python
# loader.py
FULL_TAPE_DIR = Path.home()/"Desktop"/"Eod-Full-Tape-parquet"
def load_day(trade_date: date, *, symbols: list[str], columns: list[str],
             expiry: date | None = None, session_clip: bool = True) -> pd.DataFrame:
    """Pyarrow pushdown on underlying_symbol(+expiry); intersect requested cols
    with file schema (39 vs 42); derive trade_date from executed_at; tz-localize
    naive→UTC; pd.to_numeric(coerce); drop canceled; optional 08:30–15:00 CT clip.
    Empty df (correct dtypes) if file absent."""

# signing.py
def sign_trades(df) -> pd.DataFrame:
    """Add side∈{ask,bid,mid}, signed_dir∈{+1,-1,0}. tags-first
    (ask_side/bid_side); NBBO fallback price≥mid→ask, <mid→bid; skip
    nbbo_bid==nbbo_ask==0; never read *_vol."""

# greeks.py  (NEW — only net-new primitive)
def charm(S,K,T,r,sigma,is_call) -> float|np.ndarray:
    """∂Δ/∂t. r=0: charm_call = N'(d1)·d2/(2T); charm_put = -charm_call.
    General: -N'(d1)·[2rT - d2·σ√T]/(2T·σ√T). NaN if T<=0 or sigma<=0.
    Units delta/yr (÷252 day, ÷(252·6.5·60) minute)."""
def vanna(S,K,T,r,sigma) -> float|np.ndarray:
    """∂Δ/∂σ = -d2·N'(d1)/σ. Same for call/put. NaN if T<=0 or sigma<=0."""
def delta_self_check(df,*,r=0.0,tol=0.05,min_coverage=0.90) -> None:
    """Recompute BS delta (d1=[ln(S/K)+(r+σ²/2)T]/(σ√T); call N(d1), put N(d1)-1)
    vs tape `delta`. Probe: median err ~0.02, p90 ~0.045 (S/IV snapshot mismatch,
    not formula). Assert ≥90% within tol=0.05. Test fixture, not a row filter."""

# aggregate.py
def dealer_greek_minute(df, spot_col="underlying_price", gamma_notional_pct=0.01) -> pd.DataFrame:
    """Per-(minute_bar=floor('1min'), strike) sums of:
    dealer_gamma_raw = -signed_dir·gamma·size·100 ; dealer_gamma_notl = raw·S²·1e-4 ;
    dealer_delta_raw, dealer_vega_raw (and net_charm when charm present);
    trade_count, total_size, total_premium(size·price)."""

# resample.py
def resample_minute_bars(agg_df, *, spot_df=None) -> pd.DataFrame:
    """Collapse per-(minute,strike)→per-minute: net_dealer_gamma_notl/delta/vega,
    counts, premium, n_strikes_active; merge_asof spot if given. No forward-fill
    (callers decide)."""

# cache.py
class CacheStore:  # ml/cache/full_tape/{symbol}/{YYYY-MM-DD}.parquet ; atomic .tmp→rename
    def exists(d)->bool; def write(d,df)->None; def read(d)->pd.DataFrame
    def missing_dates(rng)->list[date]
```

**Schema-drift handling:** `available=set(pq.read_schema(path).names); load_cols=[c for c in cols if c in available]`. Always `trade_date = executed_at.dt.tz_convert('America/Chicago').dt.date`; `is_0dte = expiry == trade_date`. `date`/`ingested_at`/`alert_score` omitted silently when absent.

**Constants:** `RATE_R=0.0`; `GAMMA_NOTIONAL_PCT=0.01`; NBBO-zero skip strict; `DELTA_SELF_CHECK_TOL=0.05`, `MIN_COVERAGE=0.90`; session 08:30–15:00 CT; `T_EXPIRY_UTC_HOUR=21` (4pm ET); cache `ml/cache/full_tape/` (gitignore).

**Tests (`ml/tests/test_full_tape_*.py`):** 39-col & 42-col load without error; trade_date from executed_at; 0DTE detection; session-clip; canceled drop (bool+string); empty-file→empty-df; tag wins over NBBO (both sides); NBBO fallback (both sides); zero-NBBO→mid; coverage≥99%; signed_dir∈{-1,0,1}; charm vs analytic (call/put/r≠0); vanna vs analytic; charm NaN at T=0; delta self-check pass + raises-on-bug; dealer-gamma sign; ×100 scaling; notional scaling (S=5000→±250); mid excluded from signed sums; cache skip-completed + atomic.

**Phase checklist:**
- [ ] P0 package stub imports.
- [ ] P1 `load_day` (drift/trade_date/clip/cancel/cast) → loader tests green.
- [ ] P2 `sign_trades` → signing tests green; coverage ≥99% on real 2026-06-08 SPXW 0DTE.
- [ ] P3 `charm`/`vanna`/`delta_self_check` → greeks tests green; run self-check on real ATM slice (≥90% @ tol 0.05).
- [ ] P4 `dealer_greek_minute` → aggregate tests; spot-check ~23k rows/day (390 min × ~60 ATM strikes).
- [ ] P5 `resample_minute_bars` → 390 rows/session; net_dealer_gamma_notl O($1M–$100M).
- [ ] P6 `CacheStore` → cache tests; 2-day backfill skips on rerun.
- [ ] P7 full `pytest ml/tests/test_full_tape_*.py` green.
- [ ] P8 integration smoke on 2026-06-08 SPXW 0DTE: shape, nulls, gamma sign plausibility.

**Open Qs:** delta self-check needs caller-derived `T` (`(expiry_close_utc − executed_at)/yr`, expiry_close = `{date} 21:00 UTC`); gitignore `ml/cache/`; sign convention shipped consistent but reconciled in FT-1.

---

## FT-1 — Dealer gamma trajectory (foundation, build first)

**Goal:** reconstruct dealer net gamma *as it evolves intraday* from signed SPXW trades → live wall-location/strength curve vs static opening GEX. Foundation for FT-2.

**Reconstruction math (sign + units RESOLVED, §2A):** per-trade `Γ_dealer = +signed_dir × gamma × size × 100 × S²×1e-4`. Note the **`+signed_dir`** (app-aligned, verified — NOT the textbook dealer-short `-signed_dir`) and the `× S²×1e-4` to convert the tape's **raw per-point** `gamma` to per-1% notional. Opening anchor = first session `spot_exposures.gamma_oi` (SPX, earliest ts ≥ 13:30 UTC), used directly (same perspective); per-strike anchor = `gex_strike_0dte.(call_gamma_oi+put_gamma_oi)`. Minute accumulation: `Γ_net(t)=Γ_anchor + Σ_{open..t} Γ_flow`; per-strike matrix `(strike × minute)`. (Phase 4 reconciliation already run — see §2A; re-verify on a second day during build.)

**Public API:**
```python
def load_oi_anchor(trade_date, pg_conn) -> tuple[float, pd.DataFrame]  # (agg, per-strike)
def build_minute_accumulation(trades, anchor_agg, anchor_strikes) -> tuple[pd.Series, pd.DataFrame]
def compute_curve_features(gamma_strike_matrix, gamma_agg_series, spot_series) -> pd.DataFrame
def run_ft1_day(trade_date, pg_conn, parquet_dir=None, cache_dir=None) -> pd.DataFrame  # cached
def backfill_ft1(start, end, pg_conn, ...) -> pd.DataFrame  # resumable, flush logging
```

**Curve features (per minute):** `gamma_agg`, `gamma_agg_sign`, `zero_gamma_level` (interp sign-change strike) + `zero_gamma_dist_pct`, `nearest_pos_wall_above/below` (+ dist_pct + mag), `gamma_concentration` (top-3 |Γ| / total — matches `pin_analysis.gamma_concentration`), `gamma_spread`, `pos_gamma_above/below`, `gamma_asymmetry`∈[-1,1], `wall_erosion_rate` (5m), `wall_erosion_rate_30`, `pos_wall_erosion_above`, `wall_strike_changed`, `prox_centroid` (matches `pin_analysis.compute_gamma_profile`). (`charm_centroid` deferred to FT-3.)

**Sign-convention reconciliation (HARD GATE, Phase 4):** on 3 sample days (1 suppressive low-VIX, 1 procyclical high-VIX, 1 ambiguous) compare `sign(gamma_agg)` vs `sign(spot_exposures.gamma_oi)` on overlapping minutes; flow-only/OI magnitude ratio ∈ [0.001,0.50]; anchor-adjusted median rel err < 30%; cross-check summed `gex_strike_0dte` vs aggregate. **Pass:** sign agreement ≥80% AND ratio in band AND median err <30%. **Fail/inversion:** if agreement <50%, UW `gamma_oi` is likely customer-perspective → negate target, flip `FT1_SIGN_CONVENTION`, retest. Write `ml/plots/full-tape/ft1/sign_reconciliation.json` before any predictive code.

**Predictive layer:** target `intraday_range_pct=(high−low)/open` (verified: +γ compresses to 54–76% VIX-implied, −γ 107%, [memory: project_dealer_gamma_vol_compression]); secondary pin = `|settlement − prox_centroid(14:30 CT)|`; LassoCV walk-forward (60-day expanding, 47-day test). Baselines: unconditional mean, VIX1D, static-OI prox_centroid, prior-day persistence. **Success:** range MAE ≥7% better than VIX1D ([memory: project_range_model_phase1] block-CV +7.4%); sign balanced-acc ≥57% (p<0.05); pin ≥10% better than static OI; leakage audit — lift must concentrate ≥1.5× in the regime-correct gamma-sign bucket.

**Key constants:** session 08:30–15:00 CT; per-1% scaling; `ZERO_GAMMA_INTERP_STRIKES=5`; `PROX_CENTROID_MIN_DIST=1.0`; erosion windows 5/30; `SIGN_RECON_MIN_AGREEMENT=0.80`; `WF_INITIAL_TRAIN_DAYS=60`; cache `ml/cache/full_tape/ft1/`.

**Tests:** per-trade gamma sign (ask/bid), ×100 + notional scaling, mid→0, accumulation adds-to-anchor + cumulative, zero-gamma interp + no-crossover NaN, concentration/prox_centroid match `pin_analysis`, erosion direction, session clip, canceled excluded, recon pass/fail-on-inverted, backfill skip-cached, empty-day, **no-lookahead (spot lagged 1 min)**, asymmetry∈[-1,1], nearest-wall-none→NaN.

**Phases:** P0 FT-0 green → P1 `load_oi_anchor` → P2 `build_minute_accumulation` → P3 `compute_curve_features` → **P4 HARD GATE recon (sign_reconciliation.json="pass")** → P5 `run_ft1_day`+backfill smoke → P6 107-day backfill (flush logs, free per-day frame) → P7 descriptive range-vs-gamma plot (rho,p) → P8 pin prox_centroid Wilcoxon vs static OI → P9 walk-forward LassoCV (≥7% vs VIX1D) + leakage audit → P10 export FT-2 features (`gamma_agg_sign`, `zero_gamma_dist_pct`, wall dist pcts, `wall_erosion_rate`) keyed `(trade_date, minute_utc)`.

**Open Qs:** verify tape `gamma` units (per-1% vs raw BS) before P2 — recompute BS gamma from tape delta/S/K/IV/T and compare; `gex_strike_0dte` unit cross-check; dealer- vs customer-perspective `gamma_oi` (resolved by P4); untagged-trade fractional contribution (default 0, revisit if magnitude undershoots after P4).

**Live path:** websocket `option_trades:SPXW` + greeks → same signing/accumulation intraday.

---

## FT-2 — Intraday path / MAE-MFE exit model

**Goal:** conditioned on entry-minute state, model the distribution of MAE/MFE before expiry → stop placement + profit-taking.

**Two-mode path builder** (threshold `|strike/spot−1| ≤ 0.01`):
```python
ATM_MONEYNESS_THRESHOLD = 0.01
def build_atm_path(trades_dict, strike, entry_ts_ns, session_end_ns) -> (prices, minutes_elapsed)
    # np.searchsorted entry+end on sorted (ts_ns,px) arrays — port compute_R_fast
def build_otm_path(spot_minute_series, strike, option_type, iv_minute_series, t_entry_frac,
                   r, entry_ts, session_end) -> (prices, minutes_elapsed)
    # BS reprice each minute via FT-0 greeks.bs_price; t decrements; intrinsic at t<=0.
    # RESOLVED §2A: use PER-MINUTE tape IV (iv_minute_series), NOT constant entry IV
    # (constant-IV → 30-50%+ error; per-minute cuts forward error ~46%). Tape IV is
    # mid-quote IV → ~10-25% level overstatement (conservative MFE bias, acceptable).
def build_option_path(mode, **kw) -> (prices, minutes_elapsed)  # dispatch
```
Routing upstream: `mode = 'atm' if abs(strike/spot_at_entry-1) <= 0.01 else 'otm'`.

**Public API:**
```python
def build_entry_records(date,*,trades_dict,spot_minute,ft1_curve,r=0.0,
                        session_start="08:30",session_end="15:00",tz="US/Central") -> pd.DataFrame
def compute_path_metrics(prices, entry_price, minutes_elapsed) -> dict
    # mae_pct, mfe_pct(=peak_ceiling), minutes_to_peak, realized_trail_act30_trail10,
    # realized_hard_stop_30m, realized_tier50_hold_eod, realized_eod  (reuse lottery_exit_policies)
def fit_quantile_model(entries, target, quantiles=(.1,.25,.5,.75,.9), ...) -> dict[float,GBR]
def score_policy_grid(entries, stop_grid=(-.1,-.2,-.3,-.4,-.5), target_grid=(.3,.5,1,2,5)) -> pd.DataFrame
```

**Entry-state features (no look-ahead):** `minute_of_day`, `dealer_gamma_sign` (FT-1, NaN until sign gate passes), `dist_to_wall_pct` (FT-1), `wall_gamma_magnitude` (log1p), `realized_vol_so_far` (SPX 1-min log-ret std × √min, annualized; impute first 5 min), `iv_at_entry` (chain-median fallback), `distance_otm_pct`, `moneyness_mode`, `session_remaining_frac`, `option_type_call`.

**Target:** `mfe_pct = max(prices)/entry−1` (= `peak_ceiling`); `mae_pct = min(prices)/entry−1` (compute inline). Both right/left-skewed, non-Gaussian → **GradientBoostingRegressor(loss='quantile', alpha=q)** per quantile (n_estimators=300, max_depth=4, lr=0.05, subsample=0.8, min_samples_leaf=20, no internal val split). Walk-forward cutoff ~day 86, slide 5 days; metric = pinball loss vs unconditional-quantile baseline.

**Policy eval (realized R under a stop):** per (stop,target): if `mfe≥target`→R=target; elif `mae≤stop`→R=stop; else `realized_eod`. Baselines: hold-EOD, trail-30/10, hard-stop-30%, tier50, and constant rule (stop -30/target +100). Beat hold-EOD on mean-R OOS.

**Resumability:** per-day part-files `ml/cache/full_tape/ft2/{date}-entries.parquet` + `.done` sentinel; `--smoke` on 3 oldest days first; flush per-day progress; `del df; gc.collect()` between days. (Prior exit-engine died on infra — non-negotiable.)

**Constants:** `ATM_MONEYNESS_THRESHOLD=0.01`; `ATM_ENTRY_WINDOW_NS=5min`; `RATE_R=0.0`; quantiles {.1,.25,.5,.75,.9}; stop/target grids above; `MIN_PRICES_FOR_PATH=3`; `WALK_FORWARD_TRAIN_FRAC=0.80`.

**Tests:** ATM slice correctness + empty + session-clip; OTM length + intrinsic-at-t0; moneyness routing (atm/otm/boundary exact); entry-record schema; **no-lookahead (no feature == mfe/mae)**; FT-1-missing→NaN dealer features; realized_vol filled <5min; quantile model returns 5 estimators + monotone ordering; walk-forward no-future-in-train; policy grid shape + stop-breached-uses-stop + target-hit-uses-target + eod-fallback + beats-EOD-somewhere.

**Phases:** P0 FT-0 green → P1 FT-1 sign gate resolved → P2 `--smoke` path builder (3 days; mae≤0, mfe≥0, ATM≈58 dense / OTM sparse) → P3 107-day backfill (~41k rows/day) → P4 feature QA (iv null <5%) → P5 quantile fit (beat baseline ≥3/5 MFE quantiles) → P6 policy grid (beat hold-EOD) → P7 reliability on P50 MFE → P8 leakage/feature-importance audit → P9 commit + `ft2-baseline` tag.

**Open Qs:** FT-1 sign gate (build P2–5 with NaN, rerun after); constant-IV OTM bias (v2: per-minute tape IV); entry-sampling grain (downsample 1 ATM strike/minute to curb correlation); joint vs per-type model; quantile-crossing isotonic post-fix if >5%.

**Live path:** entry-state features reconstructable live from FT-1 + websocket; path/MFE offline for policy tuning.

---

## FT-3 — Last-hour charm/vanna drift forecast

**Goal:** predict sign + magnitude of the 14:00→15:00 CT drift (money zone) from aggregate dealer charm (FT-0-derived; charm is NOT a tape column).

**Charm aggregation:** per-trade `signed_charm = signed_dir(dealer) × charm(S,K,t,r=0,σ,is_call) × size × 100`; `net_charm_t = Σ minute`; `cum_charm_t` from 08:30. **Sanity check (diagnostic, not a gate):** Spearman of 5-min-resampled `cum_charm` vs Neon `spx_spot_charm_oi`; ρ<0 ⇒ sign convention inverted, resolve before features. (Delta self-check in FT-0 already validates the BS port within mean-abs-delta-err < 0.002.)

**Public API:**
```python
def build_charm_minute_bars(date,*,session_start_ct=time(8,30),feature_cutoff_ct=time(14,0),r=0.0)->pd.DataFrame
def build_features(date,*,charm_bars=None,ft1_gamma_sign=None,r=0.0)->dict
def build_target(date,*,spot_series=None)->dict   # ret_1400_1500, sign_target, abs_ret
def build_dataset(dates,*,r=0.0,cache_dir=None,ft1_signs=None)->pd.DataFrame
def train_models(df,*,min_train_days=40,sign_threshold=0.0)->list[dict]
def run(dates=None,*,cache_dir=None)->None
```

**Features (eval at 14:00 CT):** `cum_charm_at_1400`, `charm_slope_last30`/`last60` (OLS), `charm_accel`, `charm_sign_at_1400`, `charm_abs_at_1400` (log1p at fit), `ft1_dealer_gamma_sign` (NaN-fill 0 if FT-1 absent), `realized_am_range_bps`, `spot_vs_open_bps`, `charm_to_gamma_ratio`, `t_remaining_at_1400`. v2-gated: `vanna_slope_last30`, `realized_am_range_normalized` (VIX1D).

**Target:** `ret_1400_1500 = log(spot_1459 / spot_1400)` (minute-median underlying via resample, like `_load_minute_spot`). Two heads: sign classifier (deadband 5 bps → {−1,0(excluded),+1}) and magnitude regressor (`log1p(abs_ret×1e4)`).

**Models:** XGBClassifier (n_est=200, depth=3, lr=0.05, subsample/colsample=0.8, min_child_weight=3, eval=logloss) + isotonic calibration (prefit, last 20% dates); XGBRegressor (same, reg:squarederror) on log-bps; SHAP per fold. Median imputer (train-only); `ft1_*_sign` NaN→0.

**Eval:** walk-forward (min 40 days, slide 5). Baselines: majority, persistence (sign of `ret_1300_1400`), **charm-sign heuristic** (critical). Metrics: balanced acc, ROC-AUC, Brier (calibrated), ECE, magnitude MAE-ratio. **Success:** balanced acc >0.55 AND beats charm-sign heuristic by ≥2pp; Brier ≤0.24; MAE-ratio ≤0.90; no uniform-lift leakage.

**Constants:** CT/UTC window times (DST-aware); `RATE_R=0.0`; `SIGN_DEADBAND=0.0005`; slope windows 30/60; `MIN_TRAIN_DAYS=40`, `FOLD_STEP_DAYS=5`; `CALIBRATION_BINS=10`; `VANNA_INCLUDE=False`; cache `ml/cache/full_tape/ft3/`.

**Tests:** charm sign (ATM call neg), put=−call, divergence as t→0, delta recovery; minute-bar columns/UTC index; mid→0 charm; cutoff clip (no rows >14:00); feature keys present; ft1=None→0; target raises on missing 14:00 spot; sign correctness; deadband→0; dataset 3-day shape; walk-forward no-leak; charm-sign baseline; **DST boundary (CST + CDT both resolve 14:00 CT correctly)**.

**Phases:** P0 FT-0 greeks green (delta <0.002) → P1 `build_charm_minute_bars` (≥99% signing) → P2 spx_spot_charm_oi Spearman sign check (ρ<0 ⇒ stop) → P3 features+target face-validity → P4 `build_dataset` 107 days (resumable) → P5 EDA scatter `cum_charm_at_1400` vs `ret_1400_1500` + heuristic confusion (does signal exist at all?) → P6 walk-forward (v1 features) → P7 SHAP + leakage → P8 (cond.) plots/reliability if thresholds met → P9 (cond.) add vanna only if ≥1pp lift.

**Open Qs:** spx_spot_charm_oi sign (P2 gate); r=0 default; vanna defer; VIX1D coverage ≥90% else raw range; FT-1 dep optional (measure marginal lift); deadband recalibrate at P5 (target 5–20% days); if non-deadband n<80 report heuristic only.

**Live path:** charm derivable live from websocket greeks + spot.

---

## FT-4 — IV-regime directional-flow signal (REFRAMED — was per-trade informed-flow)

**Reframe rationale (§2A):** the original "aggressor-side identifies informed flow" hypothesis FAILED empirically — side/paid_up/tags/size are coin-flips (AUC≈0.50) and "ask-side=informed" *inverts* (replicates [memory: project_concentrated_flow_no_edge]). The **only** real separator was **IV** (trade IV vs the concurrent ATM surface → directional-move AUC 0.755). FT-4 is reframed around that: it is an *IV-regime* signal, not an aggressor classifier.

> **Status: CANDIDATE, signal-confirmation-gated.** The IV edge was measured once, at the wrong band, on one day. **A stratified OOS confirmation (Phase 0) must pass before any corpus build.** If the IV→direction edge doesn't hold across VIX regimes and survives the event-day control, FT-4 is shelved.

**Goal:** predict which index 0DTE trades/contracts precede a directional move, driven by IV regime. Universe SPY/QQQ first, then SPXW. Needs FT-0 signing only. Module: `ft4_iv_regime.py`.

**Label (forward outcome):** minute-median spot via DuckDB (`_load_minute_spot`); `base_spot`=merge_asof nearest (90s); `ret_fwd_5m`. `direction_sign=+1 call/−1 put`. **Band: ~5 bps SPY/QQQ (~10–15 bps SPXW) or empirical `p70(|ret_fwd_5m|)` per day** (the `0.5×vol` formula is broken — §2A). `y=+1` if `direction_sign×ret_fwd_5m>+band`; `−1` if `<−band`; else `0`. Drop trades with `ts+5min>session_end`.

**Features — IV family (primary):** `iv_vs_surface` = trade IV − concurrent **backward** 5-min ATM-median IV (the AUC-0.755 separator); `iv_level`; `iv_put_call_skew`; `iv_otm_atm_ratio`. Controls: `moneyness`, `log_dte`, `time_of_day_frac`. **Demoted to ablation-only (proven no edge, retained only to confirm they add nothing):** `side_ask`, `paid_up`, `tag_bullish/bearish`, `log_size`. Excluded: `*_vol`, `alert_score`.

**Model:** start SIMPLE — univariate `iv_vs_surface` threshold, then a small XGBClassifier `multi:softprob` (depth 3–4, n_est≤200, `tree_method='hist'`) on the **IV family only**. Add aggressor features only if ablation shows lift (it shouldn't). Walk-forward by date; isotonic-calibrate per class on last 20% dates.

**Phase 0 — SIGNAL-CONFIRMATION GATE (before any corpus build):** on a stratified ~15-day sample spanning low/mid/high VIX + event days, recompute the `iv_vs_surface`→direction AUC at the corrected band. **Pass:** AUC ≥0.60 in ≥2 of 3 VIX-regime strata AND ≥0.55 on non-event days (not just an event-day proxy). **Fail → shelve FT-4.** Write `ml/experiments/full-tape/ft4/signal_confirmation.json`.

**Eval (post-gate):** walk-forward unique-date splits (n=5, T=5d, K=20d). Baselines: majority, **`iv_vs_surface`-threshold** (the rule the model must beat), ask-side (expected to lose). Metrics: macro-AUC, precision@k (top 5%), Brier, calibration. Leakage audit: per-bucket precision@k CV<0.05 ⇒ halt; IV-surface/rolling features strictly backward. **Success:** macro-AUC ≥0.54; precision@k lift ≥+5pp vs the IV-threshold rule; reliability slope ≥0.70.

**Constants:** band per above; `LABEL_HORIZON_MIN=5`; `TOLERANCE_ASOF=90s`; `SIGNAL_CONFIRM_AUC=0.60`; `ISOTONIC_HOLDOUT_FRAC=0.20`; `WALK_FORWARD_FOLDS=5`; `MIN_TRAIN_DAYS=20`; `PRECISION_AT_K_PCT=0.05`; `UNIVERSE_V1=[SPY,QQQ]`; cache `ml/cache/full_tape/ft4/`.

**Tests:** label call-bullish/put-bearish/noise/drops-truncated/no-future-spot; **`iv_vs_surface` backward-only (no look-ahead)**; empirical-p70 band; signal-confirm gate verdict (pass/shelve); walk-forward no-leak; IV-threshold + ask-side baselines present (ask-side loses); 39-vs-42 schema; canceled filtered.

**Phases:** **P0 SIGNAL-CONFIRMATION GATE** (stratified IV-AUC across VIX regimes — pass or shelve) → P1 labeler (corrected band, NOISE 40–60%) → P2 IV-family features → P3 corpus SPY+QQQ (resumable; **only if P0 passed**) → P4 IV-threshold + ask-side baselines → P5 small GBM + ablation (confirm aggressor features add nothing) → P6 calibration → P7 SPXW extension → P8 live path → P9 plots/findings.

**Open Qs:** is the IV edge an event-day proxy (P0 stratifies); per-trade vs per-(strike,minute) grain; surface-IV backward-window length; live VIX/surface source.

**Live path:** per-trade `iv_vs_surface` scoring on websocket `option_trades` (rolling backward ATM-IV buffer).

---

## FT-5 — "Today is different" anomaly detector

**Goal:** flag mornings whose opening-flow *shape* is an outlier vs the 107-day baseline — "don't trust your normal playbook," not direction. Unsupervised; needs FT-0 loader only.

**Morning window** 08:30–09:30 CT, SPXW 0DTE, signed. **Scaling:** trailing-40-day z-score `(x − mean40)/max(std40, 1e-6)` — slow secular drift doesn't register; rows 1–40 = warm-up (not scored), scoring from day 41 (67 scored days).

**Public API:**
```python
def build_morning_features(date,*,window_start_ct="08:30",window_end_ct="09:30",symbol="SPXW")->dict  # 25 raw
def build_feature_matrix(dates)->pd.DataFrame
def z_score_trailing(feature_matrix,*,window=40)->pd.DataFrame
def fit_ensemble(X,*,contamination=0.05,ae_hidden_dim=12,ae_epochs=200,ae_lr=1e-3,random_state=42)->(IF,AE)
def score_ensemble(X, if_model, ae_model,*,if_weight=0.5,ae_weight=0.5)->np.ndarray  # [0,1]
def top_features(x_row, feature_names, ae_model,*,top_k=5)->list[(name,sq_recon_err)]
def run_ft5(dates=None,*,save_plots=True,alarm_percentile=0.90)->pd.DataFrame
```

**25 features:** premium shares (put/call/ask/bid, put-ask, call-ask); moneyness fracs (otm/deep-otm/atm); dte0/dte>0 frac; iv mean/std (size-wtd), put-call skew, otm/atm ratio; trade_count, total_premium, mean_trade_size, large_print_frac (rolling P95), sweep/bullish/bearish tag frac, net_tag_bias, prints_per_minute, prem_gini. Fallback `sweep_tag_frac=0` if tags absent.

**Model:** IsolationForest(n_est=200, max_samples=auto, contamination=0.05, random_state=42) + torch MLP autoencoder 25→16→**12**→16→25, ReLU, MSE, Adam(1e-3), 200 epochs full-batch (sub-sec CPU; **torch 2.11.0 confirmed**). Per-feature `(x−x̂)²` = attribution. Ensemble: min-max normalize each to [0,1], `composite = 0.5·IF + 0.5·AE`. AE frozen to `ml/models/ft5_ae_weights.pt` for live scoring.

**Output:** per scored day — `anomaly_score`, `is_alarm` (≥p90), `if_score_norm`, `ae_score_norm`, `top_feature_1..5` + contribs. → `ml/experiments/full-tape/ft5/` + `ml/findings.json` `ft5_latest`.

**Eval (no labels — face validity):** known regime days must score top-decile: **2026-06-05** (−2.27%, put-dominated, [memory: project_0dte_put_share_downday_signal]), FOMC days (iv/count spike), >2% gap days (gini/atm shift); quiet low-VIX days must score LOW. `regime_hit_rate ≥0.80`; false-alarm ≤10% (by construction); inspect top-5 attribution per alarm; heatmap drift review. No automated pass/fail gate (advisory tool).

**Constants:** window 08:30–09:30; SPXW; `TRAILING_Z_WINDOW=40`; `MIN_MORNING_PRINTS=100`; IF 200/0.05; AE dim12/200ep/1e-3; ensemble 0.5/0.5; `ALARM_PERCENTILE=0.90`; `WARMUP_DAYS=40`; `ATM=0.003`, `DEEP_OTM=0.010` (match `eod_flow_bursts.py`).

**Tests:** features smoke (25 keys) + session-clip + canceled-filter + insufficient-prints raises; z-score warmup NaN + no-lookahead + zero-variance→0; ensemble shape∈[0,1]; top_features k + sorted; run schema; **regime day 2026-06-05 top-decile** (integration); alarm-rate ≈1−percentile.

**Phases:** P1 constants → P2 `build_morning_features` real day (put_prem_share∈[.3,.7]) → P3 matrix+z-score 107d (clamp ±5 if wild) → P4 IF+AE fit (score not flat) → P5 attribution sanity → P6 `run_ft5` + 3 plots → P7 face-validity (06-05 + FOMC top-decile) → P8 13 tests green → P9 save AE weights + live `load_ft5_model`.

**Open Qs:** FT-0 loader/signing must exist; **verify `implied_volatility` notna ≥85%** before P2 (else IV→spread proxies); verify `tags` carries sweep/bullish/bearish substrings; AE overfit at n~67 (add weight_decay 1e-4 / fewer epochs if IQR of ae_score <0.05); live staleness retrain when z-dist mean drifts >1.5σ; add NDXP put_share as 26th feature if face-validity fails.

**Live path:** computable by ~10:00 CT from live stream → morning alarm.

---

## 6. Dependency graph

```
FT-0 (loader · signing · greeks/charm · aggregate · resample · cache)
 ├── FT-1 (dealer gamma trajectory) ── FT-2 (path / MAE-MFE exit)
 │   [sign gate PASSED — §2A]
 ├── FT-3 (charm drift)     [needs FT-0 charm]
 ├── FT-4 (IV-regime flow)  [needs FT-0 signing; signal-confirm gate first] ── independent
 └── FT-5 (anomaly)         [needs FT-0 loader]                              ── independent
```
Order: FT-0 → FT-1 → (FT-2, FT-3); FT-4/FT-5 any time. *(FT-6 dropped — §2A.)*

## 7. Consolidated gates & open questions

| # | Item | Default / resolution | Blocks |
| - | ---- | -------------------- | ------ |
| G1 | **FT-1 dealer-sign reconciliation** | ✅ **RESOLVED** — `+signed_dir` (88.1% agreement); sign inverted vs textbook | — |
| — | **FT-6 — DROPPED** | ❌ flow-only flip census failed (§2A); revisit only with OI-anchored ZG | — |
| Q1 | Tape `gamma` units | ✅ **RESOLVED** — raw BS per-point; apply `×S²×1e-4` | — |
| Q2 | `implied_volatility` notna ≥85% | probe before FT-5 P2 | FT-5 features |
| Q3 | BS rate | `r=0.0` everywhere | FT-0/2/3 |
| Q4 | FT-4 band | ✅ **RESOLVED** — `0.5×vol` formula broken (~90bps); use ~5 bps / empirical p70 | FT-4 |
| Q5 | FT-3 deadband recalibrate | 5 bps; adjust at P5 | FT-3 |
| Q6 | FT-2 OTM IV | ✅ **RESOLVED** — per-minute tape IV (not constant); mid-quote → conservative MFE bias | FT-2 |
| Q7 | FT-4 viability | ⚠ **REFRAMED to IV-regime (§2A)**; Phase-0 signal-confirmation gate (IV-AUC across VIX regimes) before any corpus | FT-4 build |

## 8. Probe artifact
`docs/tmp/full-tape-probe.py` — re-runnable feasibility battery (`ml/.venv/bin/python docs/tmp/full-tape-probe.py <dates...>`). Regenerate if the tape schema changes again.
```
