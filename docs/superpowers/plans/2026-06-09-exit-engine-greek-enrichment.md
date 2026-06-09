# Exit-Engine Greek/IV Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry per-trade IV/greeks/underlying through path reconstruction and derive the spec's intended causal features (IV level/change, delta, gamma, OTM distance, underlying return), then re-run A1 to rebuild the decision dataset with the richer feature set.

**Architecture:** Additive, backward-compatible changes to `path_reconstruction.build_minute_path` (aggregate greeks per minute *when present*) and `features.build_features` (compute greek features *when the path carries them*), plus the A1 driver reading the new columns. `dataset.build_fire_rows` and `model._NON_FEATURE` need NO change — the new greek *features* flow through `build_features`, while raw helper columns (`strike`/`option_type`/`underlying_price`) stay on the path and are never emitted as model columns.

**Tech Stack:** Python 3.14 in `ml/.venv`, pandas 3.0.2, numpy, pyarrow; pytest. Worktree `feature/exit-timing-engine`.

**Spec:** `docs/superpowers/specs/exit-engine-greeks-and-scale-2026-06-09.md`

## Resolved facts (verified against the full tape 2026-06-09)
- `option_type` values are **`call`/`put`** (lowercase) in all months.
- Greek/underlying/strike columns are **`Decimal`** in Jan–Apr files, `float64` recently → coerce to float (same as nbbo).
- Full-tape greek columns: `implied_volatility`, `delta`, `gamma`, `underlying_price`, `strike`, `option_type` (all present every day).

## Conventions
- Run tests: `ml/.venv/bin/python -m pytest <path> -v`. Subagents: **do NOT run git** (controller commits) and **do NOT run the A1 driver** (Task 4 is operational, run by the controller).
- Strictly-causal features only (value at row t uses mid/iv/underlying `[:t+1]`). Greek aggregation is conditional on column presence so existing minimal-frame tests keep passing.

## File structure
- `ml/src/exit_engine/path_reconstruction.py` — add greek/underlying/strike/option_type per-minute aggregation (conditional).
- `ml/src/exit_engine/features.py` — add greek-derived causal features (conditional).
- `ml/experiments/exit-timing-engine/run_a1_build_dataset.py` — add greek columns to `TRADE_COLS`.
- Tests: `ml/tests/test_exit_path_reconstruction.py`, `ml/tests/test_exit_features.py`.

---

### Task 1: Carry greeks through path reconstruction

**Files:**
- Modify: `ml/src/exit_engine/path_reconstruction.py` (`build_minute_path`)
- Test: `ml/tests/test_exit_path_reconstruction.py`

- [ ] **Step 1: Write the failing test** (append to the test file; it already imports `pandas as pd`, `pytest`, `exit_engine.path_reconstruction as pr`)

```python
def test_build_minute_path_carries_greeks_and_coerces_decimal():
    from decimal import Decimal
    t = pd.DataFrame(
        [
            ("2026-01-02T14:30:10Z", "X", Decimal("1.0"), Decimal("1.2"), Decimal("1.1"), False,
             Decimal("0.45"), Decimal("0.30"), Decimal("0.02"), Decimal("500.0"), Decimal("495.0"), "call"),
        ],
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled",
                 "implied_volatility", "delta", "gamma", "underlying_price", "strike", "option_type"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-01-02T14:30:00Z"), entry_price=1.0)
    assert path["implied_volatility"].iloc[0] == pytest.approx(0.45)
    assert path["delta"].iloc[0] == pytest.approx(0.30)
    assert path["gamma"].iloc[0] == pytest.approx(0.02)
    assert path["underlying_price"].iloc[0] == pytest.approx(500.0)
    assert path["strike"].iloc[0] == pytest.approx(495.0)
    assert path["option_type"].iloc[0] == "call"
    assert path["implied_volatility"].dtype == "float64"


def test_build_minute_path_without_greeks_still_works():
    # minimal frame (no greek columns) must still reconstruct mid/spread
    t = pd.DataFrame(
        [("2026-04-13T14:30:10Z", "X", 1.0, 1.2, 1.1, False)],
        columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"],
    ).astype({"executed_at": "datetime64[ns, UTC]"})
    path = pr.build_minute_path(t, entry_ts=pd.Timestamp("2026-04-13T14:30:00Z"), entry_price=1.0)
    assert path["mid"].iloc[0] == pytest.approx(1.1)
    assert "implied_volatility" not in path.columns
```

- [ ] **Step 2: Run to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_path_reconstruction.py -v`
Expected: `test_build_minute_path_carries_greeks_and_coerces_decimal` FAILS (KeyError 'implied_volatility'); the no-greeks test passes already.

- [ ] **Step 3: Implement** — in `build_minute_path`, after the existing nbbo coercion + `df["minute"]`/`df["mid"]`/`df["spread"]` lines and BEFORE the `grouped = (...)` aggregation, insert greek handling and extend the agg. Replace the aggregation block with:

```python
    _GREEK_NUM = ["implied_volatility", "delta", "gamma", "underlying_price", "strike"]
    has_greeks = all(c in df.columns for c in ["implied_volatility", "delta", "gamma", "underlying_price"])
    for c in _GREEK_NUM:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    agg = dict(
        mid=("mid", "last"), spread=("spread", "last"),
        bid=("nbbo_bid", "last"), ask=("nbbo_ask", "last"),
    )
    if has_greeks:
        agg["implied_volatility"] = ("implied_volatility", "last")
        agg["delta"] = ("delta", "last")
        agg["gamma"] = ("gamma", "last")
        agg["underlying_price"] = ("underlying_price", "last")
    if "strike" in df.columns:
        agg["strike"] = ("strike", "first")
    if "option_type" in df.columns:
        agg["option_type"] = ("option_type", "first")
    grouped = df.groupby("minute", observed=True).agg(**agg).reset_index()
```

(Everything after — the `mid > 0` filter, entry filter, `minutes_since_entry` — stays unchanged. The greek/strike/option_type columns ride along through those row filters automatically.)

- [ ] **Step 4: Run to verify pass**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_path_reconstruction.py -v`
Expected: all pass (incl. both new tests).

- [ ] **Step 5: Report DONE** with the pytest count and the file diff. (Controller commits.)

---

### Task 2: Derive greek/IV causal features

**Files:**
- Modify: `ml/src/exit_engine/features.py` (`build_features`)
- Test: `ml/tests/test_exit_features.py`

- [ ] **Step 1: Write the failing test** (append; file imports `pandas as pd`, `exit_engine.features as feat`; add `import pytest` if missing)

```python
def _greek_path(mids, ivs, deltas, gammas, unders, strike, opt):
    return pd.DataFrame({
        "mid": mids, "spread": [0.1] * len(mids),
        "minutes_since_entry": [float(i) for i in range(len(mids))],
        "implied_volatility": ivs, "delta": deltas, "gamma": gammas,
        "underlying_price": unders, "strike": [strike] * len(mids),
        "option_type": [opt] * len(mids),
    })


def test_greek_features_present_and_correct():
    path = _greek_path([1.0, 2.0], [0.40, 0.50], [0.3, 0.4], [0.02, 0.03],
                       [500.0, 510.0], strike=495.0, opt="call")
    f = feat.build_features(path, entry_price=1.0, minutes_to_close=[390, 389])
    assert f["iv_level"].iloc[1] == pytest.approx(0.50)
    assert f["delta"].iloc[1] == pytest.approx(0.4)
    assert f["gamma"].iloc[1] == pytest.approx(0.03)
    # call OTM distance at idx1: (510-495)/510*100
    assert f["otm_distance_pct"].iloc[1] == pytest.approx((510.0 - 495.0) / 510.0 * 100.0)
    # underlying return from entry at idx1: (510-500)/500*100
    assert f["underlying_ret_from_entry"].iloc[1] == pytest.approx((510.0 - 500.0) / 500.0 * 100.0)


def test_put_otm_distance_sign():
    path = _greek_path([1.0, 1.0], [0.4, 0.4], [-0.3, -0.3], [0.02, 0.02],
                       [490.0, 490.0], strike=495.0, opt="put")
    f = feat.build_features(path, entry_price=1.0, minutes_to_close=[390, 389])
    # put OTM distance: (495-490)/490*100  (ITM-positive convention)
    assert f["otm_distance_pct"].iloc[0] == pytest.approx((495.0 - 490.0) / 490.0 * 100.0)


def test_price_only_path_has_no_greek_columns():
    path = pd.DataFrame({"mid": [1.0, 2.0], "spread": [0.1, 0.1],
                         "minutes_since_entry": [0.0, 1.0]})
    f = feat.build_features(path, entry_price=1.0, minutes_to_close=[390, 389])
    assert "iv_level" not in f.columns and "otm_distance_pct" not in f.columns


def test_greek_features_are_causal():
    short = feat.build_features(_greek_path([1.0, 2.0], [0.4, 0.5], [0.3, 0.4], [0.02, 0.03],
                                            [500.0, 510.0], 495.0, "call"),
                                entry_price=1.0, minutes_to_close=[390, 389])
    long = feat.build_features(_greek_path([1.0, 2.0, 9.0], [0.4, 0.5, 0.9], [0.3, 0.4, 0.8],
                                           [0.02, 0.03, 0.09], [500.0, 510.0, 600.0], 495.0, "call"),
                               entry_price=1.0, minutes_to_close=[390, 389, 388])
    cols = ["iv_level", "iv_change_5m", "delta", "gamma", "otm_distance_pct", "underlying_ret_from_entry"]
    pd.testing.assert_frame_equal(short[cols], long[cols].iloc[:2].reset_index(drop=True))
```

- [ ] **Step 2: Run to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_features.py -v`
Expected: the greek tests FAIL (KeyError 'iv_level'); existing price tests + `test_price_only_path_has_no_greek_columns` pass.

- [ ] **Step 3: Implement** — in `build_features`, before `return out`, append a conditional greek block (reuses the existing `_trailing_slope` helper for IV change):

```python
    if "implied_volatility" in path.columns:
        iv = path["implied_volatility"].to_numpy(dtype="float64")
        out["iv_level"] = iv
        out["iv_change_5m"] = _trailing_slope(iv, 5)
        out["iv_change_10m"] = _trailing_slope(iv, 10)
        out["delta"] = path["delta"].to_numpy(dtype="float64")
        out["gamma"] = path["gamma"].to_numpy(dtype="float64")
        under = path["underlying_price"].to_numpy(dtype="float64")
        strike = float(path["strike"].iloc[0])
        is_call = str(path["option_type"].iloc[0]).lower().startswith("c")
        if is_call:
            otm = np.where(under > 0, (under - strike) / under * 100.0, 0.0)
        else:
            otm = np.where(under > 0, (strike - under) / under * 100.0, 0.0)
        out["otm_distance_pct"] = otm
        u0 = under[0]
        out["underlying_ret_from_entry"] = (
            np.where(under > 0, (under - u0) / u0 * 100.0, 0.0) if u0 > 0 else np.zeros_like(under)
        )
```

- [ ] **Step 4: Run to verify pass**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_features.py -v`
Expected: all pass (incl. causality + put-sign).

- [ ] **Step 5: Report DONE** with pytest count + diff. (Controller commits.)

---

### Task 3: A1 driver reads the greek columns

**Files:**
- Modify: `ml/experiments/exit-timing-engine/run_a1_build_dataset.py` (`TRADE_COLS`)

- [ ] **Step 1: Implement** — change the `TRADE_COLS` constant to:

```python
TRADE_COLS = [
    "executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled",
    "implied_volatility", "delta", "gamma", "underlying_price", "strike", "option_type",
]
```

(No other driver change — `build_minute_path` now aggregates these, `build_features` derives the features, `build_fire_rows` emits the feature columns. The predicate-pushdown read already requests `columns=TRADE_COLS`.)

- [ ] **Step 2: Compile + import check**

Run: `ml/.venv/bin/python -m py_compile ml/experiments/exit-timing-engine/run_a1_build_dataset.py`
Run: `cd <worktree> && ml/.venv/bin/python -c "import sys; sys.path.insert(0,'ml/src'); sys.path.insert(0,'ml/experiments/exit-timing-engine'); import run_a1_build_dataset as r; print('TRADE_COLS', len(r.TRADE_COLS))"`
Expected: compiles; prints `TRADE_COLS 12`.

- [ ] **Step 3: Full engine suite green**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_exit_*.py -q`
Expected: all pass (30 prior + the new Task 1 & 2 tests).

- [ ] **Step 4: Report DONE.** (Controller commits Tasks 1–3 together or sequentially.)

---

### Task 4: Re-run A1 to rebuild the enriched dataset (CONTROLLER-RUN, operational)

This is NOT a subagent task — the controller runs it (needs live `DATABASE_URL` + the ~4 hr full-tape pass).

- [ ] **Step 1: Launch under caffeinate** (overwrites `decision_dataset.parquet`)

```bash
cd <worktree>
DBURL="$(grep -E '^DATABASE_URL=' /Users/charlesobrien/Documents/Workspace/strike-calculator/.env.local | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')"
caffeinate -i env DATABASE_URL="$DBURL" ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a1_build_dataset.py
```
(Run in background; ~4 hr; progress logs every 5 sessions.)

- [ ] **Step 2: Validate the rebuilt dataset** has the greek feature columns and the same fire count (~686K):

```bash
cd <worktree> && ml/.venv/bin/python -c "
import pyarrow.parquet as pq
s = pq.read_schema('ml/experiments/exit-timing-engine/decision_dataset.parquet')
need = ['iv_level','iv_change_5m','delta','gamma','otm_distance_pct','underlying_ret_from_entry']
print('greek features present:', all(c in s.names for c in need))
print('columns:', s.names)
print('rows:', f'{pq.read_metadata(\"ml/experiments/exit-timing-engine/decision_dataset.parquet\").num_rows:,}')
"
```
Expected: `greek features present: True`, fire/row counts close to the prior build (686K fires, ~220M rows).

- [ ] **Step 3:** Record the rebuilt counts; the enriched dataset gates the (separate) A2/A3 plan.

---

## Self-review

- **Spec coverage:** A1.5 greek-enrichment requirements all mapped — reconstruction carries IV/delta/gamma/underlying/strike/option_type (Task 1, with Decimal coercion), features derive iv_level/iv_change/delta/gamma/otm_distance/underlying_ret (Task 2, causal + put-sign), driver reads them (Task 3), re-run rebuilds (Task 4). `option_type=call/put` and Decimal dtypes resolved.
- **No-change confirmations:** `dataset.build_fire_rows` and `model._NON_FEATURE` need no edit — raw `strike`/`option_type`/`underlying_price` stay on the path and are never copied onto emitted rows; only derived greek *features* (via `build_features`) become columns.
- **Type consistency:** new feature names (`iv_level`, `iv_change_5m`, `iv_change_10m`, `delta`, `gamma`, `otm_distance_pct`, `underlying_ret_from_entry`) are used identically in tests and implementation; `_trailing_slope` reused for IV change.
- **No placeholders.**

## Out of scope (separate plan after the rebuild)
A2 vectorized rule baseline + on-path (mid-basis) benchmark; A3 sample-train/full-eval model at 686K-fire scale; A4 frontier. These are detailed into their own plan once Task 4's enriched dataset exists and its shape is confirmed.
