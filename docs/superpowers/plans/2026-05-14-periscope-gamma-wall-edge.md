# Periscope Gamma-Level Edge Experiment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Python experiment that tests three pre-registered claims (walls hold, magnet predicts close, charm-zero crosses) against `periscope_analyses.key_levels` data joined with SPX 1-minute bars, and writes results to `ml/findings.json` plus four plots.

**Architecture:** One pure-function library (`ml/src/periscope_gamma_wall_lib.py`) with unit tests using synthetic bars. One runner script (`ml/src/periscope_eda/05_gamma_wall_reversal.py`) that fetches data from Neon via psycopg2, applies the library functions, runs Bonferroni-corrected statistical tests, emits plots + CSV, and appends to findings.json. Mirrors the pattern of the existing `ml/src/periscope_eda/01–04` scripts.

**Tech Stack:** Python 3 (ml/.venv), psycopg2, pandas, numpy, scipy.stats, matplotlib. Database: Neon Postgres (read-only). No new tables.

**Spec:** [docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md](../specs/periscope-gamma-wall-edge-2026-05-14.md)

---

## File Structure

| Path | Purpose |
|---|---|
| `ml/src/periscope_gamma_wall_lib.py` | Pure functions: bucket, wall measurement, magnet metric, charm-zero cross, sham mirror. Importable by tests and runner. |
| `ml/tests/test_periscope_gamma_wall_lib.py` | Pytest unit tests with synthetic 1-min bar DataFrames. No DB. |
| `ml/src/periscope_eda/05_gamma_wall_reversal.py` | Runner: DB fetch, event assembly, statistical tests, plot generation, CSV export, findings.json append. |
| `ml/plots/periscope-eda/gamma_wall_reversal.png` | (Output) Bar chart, hold rate by distance bucket, real vs sham, with 95% bootstrap CIs. |
| `ml/plots/periscope-eda/gamma_wall_distance_dist.png` | (Output) Histogram of `distance_initial` by wall type. |
| `ml/plots/periscope-eda/magnet_predictor_quality.png` | (Output) Scatter `\|magnet − spot\|` vs `\|close − magnet\|` with naive overlay. |
| `ml/plots/periscope-eda/charm_zero_cross_rates.png` | (Output) Bar chart, cross rate real vs sham by distance bucket. |
| `ml/exports/gamma_wall_events.csv` | (Output) Per-event data export for ad-hoc slicing. |
| `ml/findings.json` | (Modified) Append three blocks: walls, magnet, charm-zero. |

**Note on plot directory:** Existing `01–04` scripts use `ml/plots/periscope-eda/` (hyphen). The spec said `periscope_eda` (underscore) — we match the existing on-disk convention (hyphen) and update the spec footnote at the end.

**Note on imports:** `ml/conftest.py` adds `ml/src/` to `sys.path`, so tests import the lib as `from periscope_gamma_wall_lib import ...`. The runner script also resides effectively under `ml/src/` and adds its own sys.path entry at the top (matching existing 01–04 scripts that import top-level `ml/src/` modules).

---

## Phase 0 — Pre-flight (must run before any code)

### Task 0: Confirm sample size

**Files:** None (one-shot psql query)

- [ ] **Step 1: Run the feasibility query against production Neon**

Pull `DATABASE_URL` from `.env.local` (do NOT print it). Run:

```bash
psql "$DATABASE_URL" <<'SQL'
SELECT
  COUNT(*) FILTER (WHERE mode IN ('pre_trade','intraday'))
                                                                                      AS reads_pretrade_intraday,
  COUNT(*) FILTER (WHERE mode IN ('pre_trade','intraday')
                   AND key_levels->>'gamma_ceiling' IS NOT NULL
                   AND key_levels->>'gamma_floor'   IS NOT NULL)
                                                                                      AS reads_with_both_walls,
  COUNT(*) FILTER (WHERE key_levels->>'magnet'     IS NOT NULL)                       AS reads_with_magnet,
  COUNT(*) FILTER (WHERE key_levels->>'charm_zero' IS NOT NULL)                       AS reads_with_charm_zero,
  COUNT(DISTINCT trading_date)                                                        AS distinct_days
FROM periscope_analyses;
SQL
```

- [ ] **Step 2: Decide go/no-go**

Per spec §"Pre-flight check":
- `reads_with_both_walls ≥ 60` → run primary tests as specified
- `30 ≤ reads_with_both_walls < 60` → run, flag wide CIs in findings.json
- `reads_with_both_walls < 30` → STOP. Report descriptively only; do not run primary tests. Add note to findings.json: `"power": "underpowered (N<30)"`.

Record the counts in the implementation log (we'll cite them in the final findings.json output).

- [ ] **Step 3: Verify SPX bar coverage**

Confirm `spx_candles_1m` (or underlying `index_candles_1m`) has bars on every `trading_date` present in `periscope_analyses`:

```bash
psql "$DATABASE_URL" <<'SQL'
SELECT
  pa.trading_date,
  COUNT(DISTINCT c.timestamp) FILTER (WHERE c.market_time = 'r') AS regular_bars
FROM (SELECT DISTINCT trading_date FROM periscope_analyses) pa
LEFT JOIN spx_candles_1m c ON c.date = pa.trading_date
GROUP BY pa.trading_date
HAVING COUNT(DISTINCT c.timestamp) FILTER (WHERE c.market_time = 'r') < 200
ORDER BY pa.trading_date DESC
LIMIT 20;
SQL
```

Any row that comes back (especially `regular_bars` near 0) indicates a coverage hole. If holes exist, the runner script will skip those reads with an `excluded_no_bar_coverage` counter.

---

## Phase 1 — Library functions (TDD)

### Task 1: Create lib file and constants

**Files:**
- Create: `ml/src/periscope_gamma_wall_lib.py`
- Create: `ml/tests/test_periscope_gamma_wall_lib.py`

- [ ] **Step 1: Create the lib file with constants only**

Write `ml/src/periscope_gamma_wall_lib.py`:

```python
"""Pure functions for the Periscope gamma-level edge experiment.

Imported by ml/src/periscope_eda/05_gamma_wall_reversal.py (runner)
and ml/tests/test_periscope_gamma_wall_lib.py (unit tests).

No DB I/O. No file I/O. No plotting. Pure data transforms.

Spec: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
"""

from __future__ import annotations

from datetime import timedelta
from typing import Literal

import pandas as pd

# Pre-registered knobs (FIXED per spec §"Pre-registered knobs").
# Do not tune post-hoc.
TOUCH_TOLERANCE_PTS = 1.0
REVERSAL_THRESHOLD_PTS = 2.0
REVERSAL_WINDOW_MIN = 15
DISTANCE_BUCKET_EDGES = [0.0, 3.0, 7.0, 15.0]  # buckets: 0-3, 3-7, 7-15, 15+
PRIMARY_BUCKETS = {"3-7", "7-15"}
MAGNET_MIN_DISTANCE_PTS = 3.0
CHARM_ZERO_MIN_DISTANCE_PTS = 1.0

WallType = Literal["ceiling", "floor"]
```

- [ ] **Step 2: Create the test file with module import smoke test**

Write `ml/tests/test_periscope_gamma_wall_lib.py`:

```python
"""Tests for ml/src/periscope_gamma_wall_lib.py."""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from periscope_gamma_wall_lib import (
    CHARM_ZERO_MIN_DISTANCE_PTS,
    DISTANCE_BUCKET_EDGES,
    MAGNET_MIN_DISTANCE_PTS,
    PRIMARY_BUCKETS,
    REVERSAL_THRESHOLD_PTS,
    REVERSAL_WINDOW_MIN,
    TOUCH_TOLERANCE_PTS,
)


def test_constants_match_spec():
    assert TOUCH_TOLERANCE_PTS == 1.0
    assert REVERSAL_THRESHOLD_PTS == 2.0
    assert REVERSAL_WINDOW_MIN == 15
    assert DISTANCE_BUCKET_EDGES == [0.0, 3.0, 7.0, 15.0]
    assert PRIMARY_BUCKETS == {"3-7", "7-15"}
    assert MAGNET_MIN_DISTANCE_PTS == 3.0
    assert CHARM_ZERO_MIN_DISTANCE_PTS == 1.0
```

- [ ] **Step 3: Run the test to verify imports work**

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: PASS for `test_constants_match_spec`.

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_gamma_wall_lib.py ml/tests/test_periscope_gamma_wall_lib.py
git commit -m "feat(periscope-edge): Scaffold gamma-wall lib + constants

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Distance bucket function

**Files:**
- Modify: `ml/src/periscope_gamma_wall_lib.py`
- Modify: `ml/tests/test_periscope_gamma_wall_lib.py`

- [ ] **Step 1: Write failing tests**

Append to `ml/tests/test_periscope_gamma_wall_lib.py`:

```python
from periscope_gamma_wall_lib import distance_bucket


@pytest.mark.parametrize(
    "distance,expected",
    [
        (0.0, "0-3"),
        (2.99, "0-3"),
        (3.0, "3-7"),
        (6.99, "3-7"),
        (7.0, "7-15"),
        (14.99, "7-15"),
        (15.0, "15+"),
        (100.0, "15+"),
    ],
)
def test_distance_bucket(distance, expected):
    assert distance_bucket(distance) == expected


def test_distance_bucket_negative_raises():
    with pytest.raises(ValueError):
        distance_bucket(-1.0)
```

- [ ] **Step 2: Run to verify it fails**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py::test_distance_bucket -v
```

Expected: FAIL with `ImportError: cannot import name 'distance_bucket'`.

- [ ] **Step 3: Implement**

Append to `ml/src/periscope_gamma_wall_lib.py`:

```python
def distance_bucket(distance: float) -> str:
    """Bucket a wall-to-spot distance into pre-registered ranges.

    Buckets: '0-3' (trivial), '3-7' (near), '7-15' (tactical), '15+' (far).
    Primary test pools 3-7 and 7-15 (see spec §"Primary tests").
    """
    if distance < 0:
        raise ValueError(f"distance must be non-negative, got {distance}")
    if distance < 3.0:
        return "0-3"
    if distance < 7.0:
        return "3-7"
    if distance < 15.0:
        return "7-15"
    return "15+"
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add ml/src/periscope_gamma_wall_lib.py ml/tests/test_periscope_gamma_wall_lib.py
git commit -m "feat(periscope-edge): Distance bucket function

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Wall event measurement function

**Files:**
- Modify: `ml/src/periscope_gamma_wall_lib.py`
- Modify: `ml/tests/test_periscope_gamma_wall_lib.py`

- [ ] **Step 1: Write failing tests**

Append to `ml/tests/test_periscope_gamma_wall_lib.py`:

```python
from periscope_gamma_wall_lib import compute_wall_event


def _bars_from_prices(prices: list[float], start_minute: int = 0) -> pd.DataFrame:
    """Build a 1-min bar DataFrame for the given close prices.

    All bars on 2026-05-14, market_time = 'r'. Starts at 14:30 UTC + start_minute.
    """
    base = datetime(2026, 5, 14, 14, 30, tzinfo=timezone.utc)
    return pd.DataFrame({
        "timestamp": [base + pd.Timedelta(minutes=start_minute + i)
                      for i in range(len(prices))],
        "close": prices,
    })


def test_wall_event_never_touched():
    # Spot 5000, ceiling at 5020, bars stay 4995-5005 → never touched.
    bars = _bars_from_prices([4995.0, 5000.0, 5005.0, 5002.0, 4998.0])
    ev = compute_wall_event(bars, wall_strike=5020.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is False
    assert ev["classification"] == "never_touched"
    assert ev["success"] == 0
    assert ev["distance_initial"] == 20.0
    assert ev["bucket"] == "15+"
    assert ev["breached_eod"] is False


def test_wall_event_held_ceiling():
    # Spot 5000, ceiling at 5005 (5pt away).
    # Bars: 5000, 5002, 5005 (touch), 5004, 5003, 4998 (15min later, reversed 7pts).
    prices = [5000.0, 5002.0, 5005.0] + [5004.0] * 12 + [4998.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "held"
    assert ev["success"] == 1
    assert ev["distance_initial"] == 5.0
    assert ev["bucket"] == "3-7"
    assert ev["reversal_signed"] >= REVERSAL_THRESHOLD_PTS


def test_wall_event_broken_ceiling():
    # Spot 5000, ceiling at 5005. Touch then continue up to 5010.
    prices = [5000.0, 5003.0, 5005.0] + [5006.0] * 12 + [5010.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "broken"
    assert ev["success"] == 0
    assert ev["breached_eod"] is True


def test_wall_event_stalled_ceiling():
    # Touch then drift within ±2pts of spot for the full window.
    prices = [5000.0, 5003.0, 5005.0] + [5004.0] * 12 + [5001.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "stalled"
    assert ev["success"] == 0


def test_wall_event_held_floor():
    # Spot 5000, floor at 4995. Touch from above then bounce.
    prices = [5000.0, 4998.0, 4995.0] + [4997.0] * 12 + [5003.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=4995.0, wall_type="floor",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "held"
    assert ev["success"] == 1


def test_wall_event_censored_when_window_extends_past_bars():
    # Touch on the last bar — no 15-min window available.
    prices = [5000.0, 5003.0, 5005.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "censored"
    assert ev["success"] == 0


def test_wall_event_touch_tolerance_at_boundary():
    # Bar at 5004.0, wall at 5005.0, tolerance 1.0 → exactly touches.
    prices = [5004.0] + [5004.0] * 16
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
```

- [ ] **Step 2: Run to verify it fails**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: 7 failures (all `compute_wall_event` tests) with `ImportError`.

- [ ] **Step 3: Implement**

Append to `ml/src/periscope_gamma_wall_lib.py`:

```python
def compute_wall_event(
    bars: pd.DataFrame,
    wall_strike: float,
    wall_type: WallType,
    spot_at_read: float,
) -> dict:
    """Measure how SPX behaves vs a single wall over the trading window.

    Args:
        bars: DataFrame with columns 'timestamp' (datetime64) and 'close' (float),
            sorted by timestamp ascending. Should already be filtered to bars
            between read_time and 15:00 CT, regular hours only.
        wall_strike: The gamma wall strike from periscope_analyses.key_levels.
        wall_type: 'ceiling' (above spot) or 'floor' (below spot).
        spot_at_read: SPX spot at read_time, anchor for distance and reversal.

    Returns dict with:
        distance_initial (float): |wall_strike - spot_at_read|.
        bucket (str): one of '0-3', '3-7', '7-15', '15+'.
        touched (bool): True if any bar.close came within ±TOUCH_TOLERANCE_PTS.
        t_touch_idx (int | None): index of the first touching bar in `bars`.
        post_touch_price (float | None): close at +REVERSAL_WINDOW_MIN after t_touch,
            or None if never touched / censored.
        reversal_signed (float | None): signed reversal (positive = moved away
            from wall toward spot). None if never touched / censored.
        classification (str): 'held' / 'broken' / 'stalled' / 'never_touched' / 'censored'.
        breached_eod (bool): for ceiling, spx_close > wall; for floor, spx_close < wall.
        success (int): 1 if touched AND classification == 'held', else 0.
    """
    distance_initial = abs(wall_strike - spot_at_read)
    bucket = distance_bucket(distance_initial)

    if len(bars) == 0:
        return {
            "distance_initial": distance_initial,
            "bucket": bucket,
            "touched": False,
            "t_touch_idx": None,
            "post_touch_price": None,
            "reversal_signed": None,
            "classification": "never_touched",
            "breached_eod": False,
            "success": 0,
        }

    spx_close = float(bars["close"].iloc[-1])
    breached_eod = (
        spx_close > wall_strike if wall_type == "ceiling"
        else spx_close < wall_strike
    )

    touch_mask = (bars["close"] - wall_strike).abs() <= TOUCH_TOLERANCE_PTS
    if not touch_mask.any():
        return {
            "distance_initial": distance_initial,
            "bucket": bucket,
            "touched": False,
            "t_touch_idx": None,
            "post_touch_price": None,
            "reversal_signed": None,
            "classification": "never_touched",
            "breached_eod": breached_eod,
            "success": 0,
        }

    t_touch_idx = int(touch_mask.idxmax())  # first True index
    t_touch = bars["timestamp"].iloc[t_touch_idx]
    window_end = t_touch + pd.Timedelta(minutes=REVERSAL_WINDOW_MIN)

    bars_in_window = bars[bars["timestamp"] <= window_end]
    if bars_in_window["timestamp"].iloc[-1] < window_end:
        # The full 15-min window does not fit in the available bars → censored.
        return {
            "distance_initial": distance_initial,
            "bucket": bucket,
            "touched": True,
            "t_touch_idx": t_touch_idx,
            "post_touch_price": None,
            "reversal_signed": None,
            "classification": "censored",
            "breached_eod": breached_eod,
            "success": 0,
        }

    post_touch_price = float(bars_in_window["close"].iloc[-1])
    if wall_type == "ceiling":
        reversal_signed = spot_at_read - post_touch_price
    else:  # floor
        reversal_signed = post_touch_price - spot_at_read

    if reversal_signed >= REVERSAL_THRESHOLD_PTS:
        classification = "held"
    elif reversal_signed <= -REVERSAL_THRESHOLD_PTS:
        classification = "broken"
    else:
        classification = "stalled"

    return {
        "distance_initial": distance_initial,
        "bucket": bucket,
        "touched": True,
        "t_touch_idx": t_touch_idx,
        "post_touch_price": post_touch_price,
        "reversal_signed": reversal_signed,
        "classification": classification,
        "breached_eod": breached_eod,
        "success": 1 if classification == "held" else 0,
    }
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ml/src/periscope_gamma_wall_lib.py ml/tests/test_periscope_gamma_wall_lib.py
git commit -m "feat(periscope-edge): Wall event measurement function

Computes touched/held/broken/stalled per wall+window with EOD breach flag.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Magnet event function

**Files:**
- Modify: `ml/src/periscope_gamma_wall_lib.py`
- Modify: `ml/tests/test_periscope_gamma_wall_lib.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
from periscope_gamma_wall_lib import compute_magnet_event


def test_magnet_event_excluded_when_too_close_to_spot():
    # |magnet - spot| < 3 → trivial, return None.
    assert compute_magnet_event(spx_close=5000.0, magnet=5001.0,
                                spot_at_read=5000.0) is None


def test_magnet_event_beats_naive():
    # spot=5000, magnet=5010, close=5008.
    # err_magnet = (5008 - 5010)^2 = 4
    # err_naive  = (5008 - 5000)^2 = 64
    # delta = err_magnet - err_naive = -60 (negative = magnet won)
    ev = compute_magnet_event(spx_close=5008.0, magnet=5010.0,
                              spot_at_read=5000.0)
    assert ev is not None
    assert ev["err_magnet"] == pytest.approx(4.0)
    assert ev["err_naive"] == pytest.approx(64.0)
    assert ev["delta"] == pytest.approx(-60.0)
    assert ev["magnet_won"] is True


def test_magnet_event_loses_to_naive():
    # spot=5000, magnet=5010, close=5001 (close to spot, far from magnet).
    ev = compute_magnet_event(spx_close=5001.0, magnet=5010.0,
                              spot_at_read=5000.0)
    assert ev is not None
    assert ev["delta"] > 0
    assert ev["magnet_won"] is False
```

- [ ] **Step 2: Run to verify fails**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: 3 new failures.

- [ ] **Step 3: Implement**

Append to lib:

```python
def compute_magnet_event(
    spx_close: float,
    magnet: float,
    spot_at_read: float,
) -> dict | None:
    """Compare 'magnet as close predictor' vs 'spot as close predictor'.

    Returns None when |magnet - spot_at_read| < MAGNET_MIN_DISTANCE_PTS to
    avoid trivial wins (a magnet sitting on top of spot would always
    'predict' close just by being near spot).

    Otherwise returns:
        err_magnet (float): (spx_close - magnet)^2
        err_naive (float):  (spx_close - spot_at_read)^2
        delta (float):      err_magnet - err_naive (negative = magnet beat naive)
        magnet_won (bool):  delta < 0
        distance (float):   |magnet - spot_at_read|
    """
    distance = abs(magnet - spot_at_read)
    if distance < MAGNET_MIN_DISTANCE_PTS:
        return None
    err_magnet = (spx_close - magnet) ** 2
    err_naive = (spx_close - spot_at_read) ** 2
    delta = err_magnet - err_naive
    return {
        "err_magnet": err_magnet,
        "err_naive": err_naive,
        "delta": delta,
        "magnet_won": delta < 0,
        "distance": distance,
    }
```

- [ ] **Step 4: Run to confirm pass**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ml/src/periscope_gamma_wall_lib.py ml/tests/test_periscope_gamma_wall_lib.py
git commit -m "feat(periscope-edge): Magnet event function with naive baseline

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Charm-zero cross + sham mirror

**Files:**
- Modify: `ml/src/periscope_gamma_wall_lib.py`
- Modify: `ml/tests/test_periscope_gamma_wall_lib.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
from periscope_gamma_wall_lib import compute_charm_zero_event, mirror_strike


def test_mirror_strike_reflects_across_spot():
    assert mirror_strike(spot=5000.0, real_strike=5010.0) == 4990.0
    assert mirror_strike(spot=5000.0, real_strike=4985.0) == 5015.0


def test_charm_zero_excluded_when_degenerate():
    bars = _bars_from_prices([5000.0, 5001.0, 5002.0])
    # |charm_zero - spot| < 1 → return None
    assert compute_charm_zero_event(bars, charm_zero=5000.5,
                                    spot_at_read=5000.0) is None


def test_charm_zero_crossed_real_not_sham():
    # spot=5000, charm_zero=5005 (5pts above), sham=4995 (5pts below mirror).
    # Bars: open 4998, then climb to 5008 → real crossed (5005), sham not (4995).
    bars = _bars_from_prices([4998.0, 5000.0, 5002.0, 5004.0, 5006.0, 5008.0])
    ev = compute_charm_zero_event(bars, charm_zero=5005.0, spot_at_read=5000.0)
    assert ev is not None
    assert ev["crossed_real"] is True
    assert ev["crossed_sham"] is False
    assert ev["sham_strike"] == 4995.0


def test_charm_zero_crossed_neither():
    # spot=5000, charm_zero=5050 (far). Bars stay near spot.
    bars = _bars_from_prices([4999.0, 5000.0, 5001.0])
    ev = compute_charm_zero_event(bars, charm_zero=5050.0, spot_at_read=5000.0)
    assert ev is not None
    assert ev["crossed_real"] is False
    assert ev["crossed_sham"] is False
```

- [ ] **Step 2: Run to verify fails**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: 4 new failures.

- [ ] **Step 3: Implement**

Append to lib:

```python
def mirror_strike(spot: float, real_strike: float) -> float:
    """Return the strike mirrored across spot.

    mirror = 2*spot - real_strike, which sits at the same absolute
    distance from spot on the opposite side. Used to construct sham
    baselines (real wall above spot → sham below at same distance).
    """
    return 2.0 * spot - real_strike


def compute_charm_zero_event(
    bars: pd.DataFrame,
    charm_zero: float,
    spot_at_read: float,
) -> dict | None:
    """Did SPX cross charm_zero (and its sham mirror) during the window?

    A 'cross' = the open-time and close-time sides of the strike differ
    in sign of (close - strike). Equivalent to: bars closed on different
    sides of the strike.

    Returns None if |charm_zero - spot| < CHARM_ZERO_MIN_DISTANCE_PTS
    (degenerate-pair filter — sham would collide with real).

    Otherwise:
        crossed_real (bool)
        crossed_sham (bool)
        sham_strike (float)
        distance (float)
    """
    distance = abs(charm_zero - spot_at_read)
    if distance < CHARM_ZERO_MIN_DISTANCE_PTS:
        return None
    if len(bars) < 2:
        return None

    first_close = float(bars["close"].iloc[0])
    last_close = float(bars["close"].iloc[-1])

    def _crossed(strike: float) -> bool:
        return (first_close - strike) * (last_close - strike) < 0

    sham = mirror_strike(spot_at_read, charm_zero)
    return {
        "crossed_real": _crossed(charm_zero),
        "crossed_sham": _crossed(sham),
        "sham_strike": sham,
        "distance": distance,
    }
```

- [ ] **Step 4: Run to confirm pass**

```bash
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ml/src/periscope_gamma_wall_lib.py ml/tests/test_periscope_gamma_wall_lib.py
git commit -m "feat(periscope-edge): Charm-zero cross + sham mirror

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 2 — Runner script: DB fetch + event assembly

### Task 6: Scaffold runner with CLI and DB fetch

**Files:**
- Create: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Write the runner scaffold**

Create `ml/src/periscope_eda/05_gamma_wall_reversal.py`:

```python
"""Periscope EDA 05 — Gamma-level edge experiment.

Tests three pre-registered claims against periscope_analyses.key_levels
joined to spx_candles_1m:

  1. Walls hold (touch-then-reverse vs sham at same distance)
  2. Magnet predicts SPX close better than naive spot
  3. Charm-zero crosses more (or less) frequently than sham

Outputs:
    ml/plots/periscope-eda/gamma_wall_reversal.png
    ml/plots/periscope-eda/gamma_wall_distance_dist.png
    ml/plots/periscope-eda/magnet_predictor_quality.png
    ml/plots/periscope-eda/charm_zero_cross_rates.png
    ml/exports/gamma_wall_events.csv
    ml/findings.json   (appends three blocks)

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py

Spec: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Make periscope_gamma_wall_lib (top-level under ml/src/) importable when
# running the script directly. ml/conftest.py does this for pytest;
# scripts have to do it themselves.
_HERE = Path(__file__).resolve().parent
_ML_SRC = _HERE.parent  # ml/src/
sys.path.insert(0, str(_ML_SRC))

import pandas as pd  # noqa: E402  (after sys.path mutation)
import psycopg2  # noqa: E402

from periscope_gamma_wall_lib import (  # noqa: E402
    PRIMARY_BUCKETS,
    compute_charm_zero_event,
    compute_magnet_event,
    compute_wall_event,
    distance_bucket,
    mirror_strike,
)

PLOT_DIR = Path("ml/plots/periscope-eda")
CSV_PATH = Path("ml/exports/gamma_wall_events.csv")
FINDINGS_PATH = Path("ml/findings.json")


def fetch_reads(database_url: str) -> pd.DataFrame:
    """Fetch periscope_analyses rows with key_levels, before 15:00 CT same day."""
    sql = """
        SELECT
          id                          AS read_id,
          trading_date,
          read_time                   AS read_time_utc,
          spot_at_read_time::float    AS spot_at_read,
          mode,
          calibration_quality,
          (key_levels->>'gamma_ceiling')::float AS wall_ceiling,
          (key_levels->>'gamma_floor')::float   AS wall_floor,
          (key_levels->>'magnet')::float        AS magnet,
          (key_levels->>'charm_zero')::float    AS charm_zero
        FROM periscope_analyses
        WHERE mode IN ('pre_trade', 'intraday')
          AND read_time < ((trading_date + INTERVAL '15 hours')
                           AT TIME ZONE 'America/Chicago')
          AND key_levels IS NOT NULL
        ORDER BY trading_date, read_time
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def fetch_bars_for_read(conn, trading_date, read_time_utc) -> pd.DataFrame:
    """Fetch regular-hours SPX 1-min bars from read_time to 15:00 CT same day.

    NOTE: queries index_candles_1m directly (the compat view spx_candles_1m
    does not exist in this DB). symbol='SPX' filter is required.
    """
    sql = """
        SELECT timestamp, close::float AS close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = %s
          AND timestamp >= %s
          AND timestamp <= ((%s::date + INTERVAL '15 hours')
                            AT TIME ZONE 'America/Chicago')
          AND market_time = 'r'
        ORDER BY timestamp
    """
    return pd.read_sql_query(
        sql, conn, params=(trading_date, read_time_utc, trading_date)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres URL (default: $DATABASE_URL)",
    )
    args = parser.parse_args()
    if not args.database_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 1

    print("Fetching periscope reads with key_levels…")
    reads = fetch_reads(args.database_url)
    print(f"  N reads = {len(reads)}")
    print(f"  with both walls = {reads.dropna(subset=['wall_ceiling','wall_floor']).shape[0]}")
    print(f"  with magnet     = {reads['magnet'].notna().sum()}")
    print(f"  with charm_zero = {reads['charm_zero'].notna().sum()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the scaffold (read-only sanity check)**

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
```

Expected output:
```
Fetching periscope reads with key_levels…
  N reads = <N>
  with both walls = <N>
  with magnet     = <N>
  with charm_zero = <N>
```

Counts should match the Phase 0 pre-flight numbers.

- [ ] **Step 3: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py
git commit -m "feat(periscope-edge): Runner scaffold with DB fetch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Build per-event DataFrame (walls + magnet + charm-zero)

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add event-builder function**

Insert below `fetch_bars_for_read()` and above `main()`:

```python
def build_events(reads: pd.DataFrame, database_url: str) -> dict[str, pd.DataFrame]:
    """For each read, compute all per-event rows for the three claims.

    Returns dict with keys 'walls', 'magnet', 'charm' — each a DataFrame.

    Walls DataFrame columns:
        read_id, trading_date, read_time_utc, mode, calibration_quality,
        spot_at_read, wall_type, wall_strike, real_or_sham, distance_initial,
        bucket, touched, classification, reversal_signed, breached_eod, success
    """
    wall_rows: list[dict] = []
    magnet_rows: list[dict] = []
    charm_rows: list[dict] = []
    excluded_no_bars = 0

    with psycopg2.connect(database_url) as conn:
        for _, r in reads.iterrows():
            bars = fetch_bars_for_read(conn, r.trading_date, r.read_time_utc)
            if bars.empty:
                excluded_no_bars += 1
                continue

            spx_close = float(bars["close"].iloc[-1])

            # --- Walls (both ceiling and floor, real and sham) ---
            for wall_type, real_strike in (("ceiling", r.wall_ceiling),
                                           ("floor", r.wall_floor)):
                if pd.isna(real_strike):
                    continue
                # Real wall
                ev_real = compute_wall_event(bars, float(real_strike),
                                             wall_type, float(r.spot_at_read))
                # Sham = mirror across spot. For ceiling that puts sham below,
                # so its wall_type for measurement is 'floor', and vice versa.
                sham_strike = mirror_strike(float(r.spot_at_read), float(real_strike))
                sham_type: str = "floor" if wall_type == "ceiling" else "ceiling"
                ev_sham = compute_wall_event(bars, sham_strike, sham_type,
                                             float(r.spot_at_read))
                for tag, ev, strike in (("real", ev_real, float(real_strike)),
                                        ("sham", ev_sham, sham_strike)):
                    wall_rows.append({
                        "read_id": int(r.read_id),
                        "trading_date": r.trading_date,
                        "read_time_utc": r.read_time_utc,
                        "mode": r.mode,
                        "calibration_quality": r.calibration_quality,
                        "spot_at_read": float(r.spot_at_read),
                        "wall_type": wall_type,
                        "wall_strike": strike,
                        "real_or_sham": tag,
                        **ev,
                    })

            # --- Magnet ---
            if pd.notna(r.magnet):
                ev = compute_magnet_event(spx_close, float(r.magnet),
                                          float(r.spot_at_read))
                if ev is not None:
                    magnet_rows.append({
                        "read_id": int(r.read_id),
                        "trading_date": r.trading_date,
                        "mode": r.mode,
                        "calibration_quality": r.calibration_quality,
                        "spot_at_read": float(r.spot_at_read),
                        "magnet": float(r.magnet),
                        "spx_close": spx_close,
                        **ev,
                    })

            # --- Charm-zero ---
            if pd.notna(r.charm_zero):
                ev = compute_charm_zero_event(bars, float(r.charm_zero),
                                              float(r.spot_at_read))
                if ev is not None:
                    charm_rows.append({
                        "read_id": int(r.read_id),
                        "trading_date": r.trading_date,
                        "mode": r.mode,
                        "calibration_quality": r.calibration_quality,
                        "spot_at_read": float(r.spot_at_read),
                        "charm_zero": float(r.charm_zero),
                        "bucket": distance_bucket(ev["distance"]),
                        **ev,
                    })

    print(f"  excluded_no_bar_coverage = {excluded_no_bars}")
    return {
        "walls": pd.DataFrame(wall_rows),
        "magnet": pd.DataFrame(magnet_rows),
        "charm": pd.DataFrame(charm_rows),
    }
```

- [ ] **Step 2: Wire into main()**

Replace the body of `main()` (after the arg-parse block) with:

```python
    print("Fetching periscope reads with key_levels…")
    reads = fetch_reads(args.database_url)
    print(f"  N reads = {len(reads)}")

    print("Building events…")
    events = build_events(reads, args.database_url)
    print(f"  walls events  (real+sham, ceiling+floor) = {len(events['walls'])}")
    print(f"  magnet events                            = {len(events['magnet'])}")
    print(f"  charm events                             = {len(events['charm'])}")

    # Save CSV for ad-hoc slicing
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    events["walls"].to_csv(CSV_PATH, index=False)
    print(f"  wrote {CSV_PATH}")

    return 0
```

- [ ] **Step 3: Run end-to-end**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
```

Expected: prints counts, writes `ml/exports/gamma_wall_events.csv`. Inspect first few rows:

```bash
head -5 ml/exports/gamma_wall_events.csv
```

You should see columns: `read_id, trading_date, …, wall_type, real_or_sham, distance_initial, bucket, touched, classification, success`.

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py ml/exports/gamma_wall_events.csv
git commit -m "feat(periscope-edge): Event assembly + CSV export

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 3 — Statistical tests

### Task 8: McNemar test (walls)

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add walls primary test function**

Insert before `main()`:

```python
from scipy.stats import wilcoxon  # noqa: E402
from statsmodels.stats.contingency_tables import mcnemar  # noqa: E402

BONFERRONI_ALPHA = 0.05 / 3
EFFECT_SIZE_THRESHOLD_PP = 0.10  # 10 percentage points
EFFECT_SIZE_THRESHOLD_MAGNET = 1.0  # 1 SPX point^2 in median squared-error delta


def test_walls(walls_df: pd.DataFrame) -> dict:
    """Run primary McNemar test on walls (real vs sham success, paired).

    Returns dict suitable for findings.json:
        claim, n_pairs, real_success_rate, sham_success_rate,
        effect_pp, p_value, passes_bonferroni, effect_size_meets_threshold,
        verdict, threats_to_validity, notes
    """
    if walls_df.empty:
        return {
            "claim": "walls_hold",
            "n_pairs": 0,
            "verdict": "no_data",
            "p_value": None,
        }

    # Restrict primary to PRIMARY_BUCKETS only.
    primary = walls_df[walls_df["bucket"].isin(PRIMARY_BUCKETS)]
    # Pair real ↔ sham on (read_id, wall_type).
    pivot = primary.pivot_table(
        index=["read_id", "wall_type"],
        columns="real_or_sham",
        values="success",
        aggfunc="first",
    ).dropna()

    if len(pivot) == 0:
        return {
            "claim": "walls_hold",
            "n_pairs": 0,
            "verdict": "no_data_in_primary_buckets",
            "p_value": None,
        }

    # Build 2x2 contingency table for McNemar:
    #            sham=0  sham=1
    # real=0      a       b
    # real=1      c       d
    real = pivot["real"].astype(int).values
    sham = pivot["sham"].astype(int).values
    a = int(((real == 0) & (sham == 0)).sum())
    b = int(((real == 0) & (sham == 1)).sum())
    c = int(((real == 1) & (sham == 0)).sum())
    d = int(((real == 1) & (sham == 1)).sum())
    table = [[a, b], [c, d]]

    result = mcnemar(table, exact=True)
    p_value = float(result.pvalue)
    real_rate = float(real.mean())
    sham_rate = float(sham.mean())
    effect_pp = real_rate - sham_rate

    passes_p = p_value < BONFERRONI_ALPHA
    passes_effect = effect_pp >= EFFECT_SIZE_THRESHOLD_PP

    return {
        "claim": "walls_hold",
        "n_pairs": int(len(pivot)),
        "real_success_rate": real_rate,
        "sham_success_rate": sham_rate,
        "effect_pp": effect_pp,
        "p_value": p_value,
        "bonferroni_alpha": BONFERRONI_ALPHA,
        "passes_bonferroni": passes_p,
        "effect_size_meets_threshold": passes_effect,
        "verdict": "pass" if (passes_p and passes_effect) else "fail",
        "contingency_table": {"a": a, "b": b, "c": c, "d": d},
        "threats_to_validity": [
            "SPX cash != tradeable (option premium not tested here)",
            "Multiple reads per day not strictly independent",
            "Selection effect on key_levels non-null",
        ],
    }
```

- [ ] **Step 2: Wire into main() and print result**

After the CSV-write line in `main()`, add:

```python
    print("\n=== Test 1: Walls hold (McNemar paired) ===")
    walls_result = test_walls(events["walls"])
    print(json.dumps(walls_result, indent=2, default=str))
```

- [ ] **Step 3: Run and verify output**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
```

Expected: prints a JSON block with `claim, n_pairs, real_success_rate, sham_success_rate, effect_pp, p_value, verdict`.

- [ ] **Step 4: Verify `statsmodels` is installed**

If `from statsmodels.stats.contingency_tables import mcnemar` raises `ModuleNotFoundError`:

```bash
ml/.venv/bin/pip install statsmodels
```

Then re-run Step 3. Note the install in the commit message so the requirements doc gets updated if there's a `ml/requirements.txt` or `pyproject.toml`.

- [ ] **Step 5: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py
git commit -m "feat(periscope-edge): McNemar primary test for walls

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Wilcoxon test (magnet)

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add magnet primary test function**

Insert below `test_walls()`:

```python
def test_magnet(magnet_df: pd.DataFrame) -> dict:
    """Wilcoxon signed-rank on delta = err_magnet - err_naive.

    H0: median delta == 0.
    Win: median(delta) < 0 (magnet has lower squared error) AND
         |median(delta)| >= EFFECT_SIZE_THRESHOLD_MAGNET (1 point^2).
    """
    if magnet_df.empty or len(magnet_df) < 6:
        return {
            "claim": "magnet_predicts_close",
            "n_reads": int(len(magnet_df)),
            "verdict": "no_data",
            "p_value": None,
        }

    delta = magnet_df["delta"].astype(float).values
    median_delta = float(pd.Series(delta).median())

    # Wilcoxon requires non-zero values; statsmodels handles ties via zero_method='wilcox'.
    # scipy uses 'wilcox' by default since 1.13.
    result = wilcoxon(delta, alternative="less")  # H1: median < 0
    p_value = float(result.pvalue)

    passes_p = p_value < BONFERRONI_ALPHA
    passes_effect = (median_delta < 0) and (abs(median_delta) >= EFFECT_SIZE_THRESHOLD_MAGNET)

    return {
        "claim": "magnet_predicts_close",
        "n_reads": int(len(magnet_df)),
        "median_delta": median_delta,
        "median_err_magnet": float(pd.Series(magnet_df["err_magnet"]).median()),
        "median_err_naive": float(pd.Series(magnet_df["err_naive"]).median()),
        "p_value": p_value,
        "bonferroni_alpha": BONFERRONI_ALPHA,
        "passes_bonferroni": passes_p,
        "effect_size_meets_threshold": passes_effect,
        "verdict": "pass" if (passes_p and passes_effect) else "fail",
        "threats_to_validity": [
            "Subset |magnet - spot| >= 3pt only — small or near-spot magnets excluded",
            "Squared-error metric penalizes large misses heavily",
        ],
    }
```

- [ ] **Step 2: Wire into main()**

After the walls print block:

```python
    print("\n=== Test 2: Magnet predicts close (Wilcoxon, one-sided less) ===")
    magnet_result = test_magnet(events["magnet"])
    print(json.dumps(magnet_result, indent=2, default=str))
```

- [ ] **Step 3: Run and verify**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
```

Expected: prints both walls and magnet result blocks.

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py
git commit -m "feat(periscope-edge): Wilcoxon primary test for magnet

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: McNemar test (charm-zero)

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add charm-zero primary test function**

Insert below `test_magnet()`:

```python
def test_charm_zero(charm_df: pd.DataFrame) -> dict:
    """McNemar paired on crossed_real vs crossed_sham.

    Two-sided (direction not pre-specified — either sign counts per spec).
    """
    if charm_df.empty:
        return {
            "claim": "charm_zero_cross",
            "n_pairs": 0,
            "verdict": "no_data",
            "p_value": None,
        }

    real = charm_df["crossed_real"].astype(int).values
    sham = charm_df["crossed_sham"].astype(int).values
    a = int(((real == 0) & (sham == 0)).sum())
    b = int(((real == 0) & (sham == 1)).sum())
    c = int(((real == 1) & (sham == 0)).sum())
    d = int(((real == 1) & (sham == 1)).sum())
    result = mcnemar([[a, b], [c, d]], exact=True)
    p_value = float(result.pvalue)
    real_rate = float(real.mean())
    sham_rate = float(sham.mean())
    effect_pp = abs(real_rate - sham_rate)  # two-sided: magnitude only

    passes_p = p_value < BONFERRONI_ALPHA
    passes_effect = effect_pp >= EFFECT_SIZE_THRESHOLD_PP

    return {
        "claim": "charm_zero_cross",
        "n_pairs": int(len(charm_df)),
        "real_cross_rate": real_rate,
        "sham_cross_rate": sham_rate,
        "effect_pp_abs": effect_pp,
        "direction": "real > sham" if real_rate > sham_rate else "real < sham",
        "p_value": p_value,
        "bonferroni_alpha": BONFERRONI_ALPHA,
        "passes_bonferroni": passes_p,
        "effect_size_meets_threshold": passes_effect,
        "verdict": "pass" if (passes_p and passes_effect) else "fail",
        "contingency_table": {"a": a, "b": b, "c": c, "d": d},
        "threats_to_validity": [
            "Two-sided test by design — direction is descriptive, not predictive",
            "Crossing defined by first vs last close only; ignores intraday excursions",
        ],
    }
```

- [ ] **Step 2: Wire into main()**

```python
    print("\n=== Test 3: Charm-zero crosses (McNemar paired, two-sided) ===")
    charm_result = test_charm_zero(events["charm"])
    print(json.dumps(charm_result, indent=2, default=str))
```

- [ ] **Step 3: Run and verify**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
```

Expected: prints all three test result blocks.

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py
git commit -m "feat(periscope-edge): McNemar primary test for charm-zero

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 4 — Plots and findings.json

### Task 11: Plot 1 — Wall reversal bars (real vs sham by bucket)

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add plot function**

Insert near the top imports:

```python
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
```

Insert above `main()`:

```python
def _bootstrap_ci(values: np.ndarray, n_boot: int = 1000,
                  alpha: float = 0.05, seed: int = 42) -> tuple[float, float]:
    """Percentile bootstrap CI for the mean of a binary array."""
    rng = np.random.default_rng(seed)
    if len(values) == 0:
        return (float("nan"), float("nan"))
    boots = rng.choice(values, size=(n_boot, len(values)), replace=True).mean(axis=1)
    lo = float(np.percentile(boots, 100 * alpha / 2))
    hi = float(np.percentile(boots, 100 * (1 - alpha / 2)))
    return (lo, hi)


def plot_wall_reversal(walls_df: pd.DataFrame, out_path: Path) -> None:
    """Bar chart: success rate by distance bucket, real vs sham, with 95% CIs."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buckets = ["0-3", "3-7", "7-15", "15+"]
    width = 0.35
    x = np.arange(len(buckets))

    fig, ax = plt.subplots(figsize=(9, 5))
    for offset, tag, color in ((-width / 2, "real", "#1f77b4"),
                               (+width / 2, "sham", "#cccccc")):
        rates = []
        los = []
        his = []
        ns = []
        for bucket in buckets:
            subset = walls_df[(walls_df["bucket"] == bucket) &
                              (walls_df["real_or_sham"] == tag)]
            success = subset["success"].astype(int).values
            ns.append(len(success))
            if len(success) == 0:
                rates.append(0.0); los.append(0.0); his.append(0.0)
                continue
            rate = float(success.mean())
            lo, hi = _bootstrap_ci(success)
            rates.append(rate); los.append(lo); his.append(hi)
        yerr = [
            [r - lo for r, lo in zip(rates, los, strict=False)],
            [hi - r for r, hi in zip(rates, his, strict=False)],
        ]
        ax.bar(x + offset, rates, width, yerr=yerr, capsize=4,
               color=color, edgecolor="black", label=tag)
        for i, (r, n) in enumerate(zip(rates, ns, strict=False)):
            ax.annotate(f"n={n}", xy=(x[i] + offset, r),
                        xytext=(0, 4), textcoords="offset points",
                        ha="center", fontsize=8)

    ax.set_xticks(x)
    ax.set_xticklabels(buckets)
    ax.set_xlabel("Distance bucket (SPX points from spot)")
    ax.set_ylabel("P(touched AND held) — success rate")
    ax.set_title("Periscope gamma-wall reversal rate, real vs sham\n"
                 "(success = touched ±1pt AND reversed ≥2pt within 15min)")
    ax.legend()
    ax.set_ylim(0, max(0.5, max(rates) * 1.5))
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
```

- [ ] **Step 2: Wire into main()** after charm test print:

```python
    print("\nWriting plots…")
    plot_wall_reversal(events["walls"], PLOT_DIR / "gamma_wall_reversal.png")
    print(f"  wrote {PLOT_DIR / 'gamma_wall_reversal.png'}")
```

- [ ] **Step 3: Run and inspect plot**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
open ml/plots/periscope-eda/gamma_wall_reversal.png
```

Plot should show 4 distance buckets, two bars each (real blue, sham grey) with error bars and n= annotations.

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py ml/plots/periscope-eda/gamma_wall_reversal.png
git commit -m "feat(periscope-edge): Wall reversal plot (real vs sham by bucket)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Plot 2 — Distance histogram

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add plot function**

Insert below `plot_wall_reversal()`:

```python
def plot_distance_distribution(walls_df: pd.DataFrame, out_path: Path) -> None:
    """Histogram of distance_initial for real walls only (sham is mirror)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    real = walls_df[walls_df["real_or_sham"] == "real"]
    fig, ax = plt.subplots(figsize=(8, 5))
    for wall_type, color in (("ceiling", "#d62728"), ("floor", "#2ca02c")):
        d = real.loc[real["wall_type"] == wall_type, "distance_initial"]
        ax.hist(d, bins=20, alpha=0.5, label=wall_type, color=color, edgecolor="black")
    for edge in (3.0, 7.0, 15.0):
        ax.axvline(edge, color="gray", linestyle="--", linewidth=1)
    ax.set_xlabel("Distance from spot at read time (SPX points)")
    ax.set_ylabel("Number of reads")
    ax.set_title("Distribution of gamma_ceiling / gamma_floor distance from spot\n"
                 "(dashed lines: 3 / 7 / 15 pt bucket edges)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
```

- [ ] **Step 2: Wire into main()**

```python
    plot_distance_distribution(events["walls"], PLOT_DIR / "gamma_wall_distance_dist.png")
    print(f"  wrote {PLOT_DIR / 'gamma_wall_distance_dist.png'}")
```

- [ ] **Step 3: Run and inspect**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
open ml/plots/periscope-eda/gamma_wall_distance_dist.png
```

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py ml/plots/periscope-eda/gamma_wall_distance_dist.png
git commit -m "feat(periscope-edge): Wall distance distribution histogram

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Plot 3 — Magnet predictor scatter

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add plot function**

Insert below `plot_distance_distribution()`:

```python
def plot_magnet_quality(magnet_df: pd.DataFrame, out_path: Path) -> None:
    """Scatter of |magnet - spot| vs |close - magnet|; overlay |close - spot|."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if magnet_df.empty:
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.text(0.5, 0.5, "No magnet events", ha="center", va="center")
        ax.set_axis_off()
        fig.savefig(out_path, dpi=120)
        plt.close(fig)
        return

    abs_dist = (magnet_df["magnet"] - magnet_df["spot_at_read"]).abs()
    abs_err_magnet = (magnet_df["spx_close"] - magnet_df["magnet"]).abs()
    abs_err_naive = (magnet_df["spx_close"] - magnet_df["spot_at_read"]).abs()

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.scatter(abs_dist, abs_err_magnet, alpha=0.6, s=30,
               c="#1f77b4", label="|close − magnet|")
    ax.scatter(abs_dist, abs_err_naive, alpha=0.4, s=30,
               c="#ff7f0e", label="|close − spot| (naive)", marker="x")
    ax.plot([0, abs_dist.max()], [0, abs_dist.max()],
            color="gray", linestyle="--", label="break-even")
    ax.set_xlabel("|magnet − spot at read| (SPX points)")
    ax.set_ylabel("Prediction error |close − target| (SPX points)")
    ax.set_title("Magnet predictor quality vs naive 'close ≈ spot'\n"
                 "Below the dashed line = magnet beats naive")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
```

- [ ] **Step 2: Wire into main()**

```python
    plot_magnet_quality(events["magnet"], PLOT_DIR / "magnet_predictor_quality.png")
    print(f"  wrote {PLOT_DIR / 'magnet_predictor_quality.png'}")
```

- [ ] **Step 3: Run and inspect**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
open ml/plots/periscope-eda/magnet_predictor_quality.png
```

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py ml/plots/periscope-eda/magnet_predictor_quality.png
git commit -m "feat(periscope-edge): Magnet predictor scatter plot

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: Plot 4 — Charm-zero cross rates

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`

- [ ] **Step 1: Add plot function**

Insert below `plot_magnet_quality()`:

```python
def plot_charm_zero(charm_df: pd.DataFrame, out_path: Path) -> None:
    """Bar chart: cross rate real vs sham, stratified by distance bucket."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if charm_df.empty:
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.text(0.5, 0.5, "No charm-zero events", ha="center", va="center")
        ax.set_axis_off()
        fig.savefig(out_path, dpi=120)
        plt.close(fig)
        return

    buckets = ["0-3", "3-7", "7-15", "15+"]
    width = 0.35
    x = np.arange(len(buckets))
    fig, ax = plt.subplots(figsize=(9, 5))

    real_rates = []
    sham_rates = []
    ns = []
    for bucket in buckets:
        subset = charm_df[charm_df["bucket"] == bucket]
        ns.append(len(subset))
        if subset.empty:
            real_rates.append(0.0); sham_rates.append(0.0)
            continue
        real_rates.append(float(subset["crossed_real"].astype(int).mean()))
        sham_rates.append(float(subset["crossed_sham"].astype(int).mean()))

    ax.bar(x - width / 2, real_rates, width, color="#1f77b4",
           edgecolor="black", label="real charm_zero")
    ax.bar(x + width / 2, sham_rates, width, color="#cccccc",
           edgecolor="black", label="sham (mirror)")
    for i, n in enumerate(ns):
        ax.annotate(f"n={n}", xy=(x[i], max(real_rates[i], sham_rates[i])),
                    xytext=(0, 4), textcoords="offset points",
                    ha="center", fontsize=8)
    ax.set_xticks(x)
    ax.set_xticklabels(buckets)
    ax.set_xlabel("Distance bucket (SPX points from spot)")
    ax.set_ylabel("P(crossed between read and 15:00 CT close)")
    ax.set_title("Charm-zero cross rate, real vs sham (mirror across spot)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
```

- [ ] **Step 2: Wire into main()**

```python
    plot_charm_zero(events["charm"], PLOT_DIR / "charm_zero_cross_rates.png")
    print(f"  wrote {PLOT_DIR / 'charm_zero_cross_rates.png'}")
```

- [ ] **Step 3: Run and inspect**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
open ml/plots/periscope-eda/charm_zero_cross_rates.png
```

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py ml/plots/periscope-eda/charm_zero_cross_rates.png
git commit -m "feat(periscope-edge): Charm-zero cross rate plot

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 15: Append to findings.json

**Files:**
- Modify: `ml/src/periscope_eda/05_gamma_wall_reversal.py`
- Modify: `ml/findings.json`

- [ ] **Step 1: Add findings-append function**

Insert near other helpers:

```python
def append_findings(
    findings_path: Path,
    blocks: list[dict],
    data_window: dict,
) -> None:
    """Append a list of result blocks to findings.json under a top-level key.

    Existing findings.json is preserved; we add (or overwrite) the
    'periscope_gamma_wall_edge' key with today's run summary, including
    a data_window block with the date range, distinct-day count, and a
    prominent caveat string when the window is narrow.
    """
    if findings_path.exists():
        existing = json.loads(findings_path.read_text())
    else:
        existing = {}
    existing["periscope_gamma_wall_edge"] = {
        "experiment": "periscope-gamma-wall-edge",
        "run_date_utc": datetime.now(timezone.utc).isoformat(),
        "data_window": data_window,
        "results": blocks,
    }
    findings_path.write_text(json.dumps(existing, indent=2, default=str) + "\n")


def build_data_window(reads: pd.DataFrame) -> dict:
    """Compute date-range stats + emit warnings when the window is narrow.

    Triggers a 'narrow_window_warning' when distinct_days < 20, since per
    the spec design the sensitivity check (one read per (date,mode)) needs
    ~30+ days to be informative.
    """
    distinct_days = int(reads["trading_date"].nunique())
    earliest = str(reads["trading_date"].min())
    latest = str(reads["trading_date"].max())
    warnings = []
    if distinct_days < 20:
        warnings.append(
            f"NARROW WINDOW ({distinct_days} distinct trading days only). "
            "Results reflect a single-regime snapshot. Within-day "
            "correlation across the auto-playbook's ~35 reads/day is "
            "high; the spec's first-read-per-(date,mode) sensitivity "
            "check is underpowered at this N. Re-run after several "
            "more weeks of data accumulate before trading on the result."
        )
    return {
        "distinct_days": distinct_days,
        "earliest": earliest,
        "latest": latest,
        "total_reads_in_window": int(len(reads)),
        "warnings": warnings,
    }
```

- [ ] **Step 2: Wire into main()** at the very end (before `return 0`):

```python
    data_window = build_data_window(reads)
    if data_window["warnings"]:
        print("\nDATA WINDOW WARNINGS:")
        for w in data_window["warnings"]:
            print(f"  ! {w}")
    append_findings(FINDINGS_PATH,
                    [walls_result, magnet_result, charm_result],
                    data_window)
    print(f"\nWrote findings to {FINDINGS_PATH}")

    return 0
```

- [ ] **Step 3: Run and verify findings.json updated**

```bash
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
python3 -c "import json; print(json.dumps(json.load(open('ml/findings.json'))['periscope_gamma_wall_edge'], indent=2))" | head -40
```

Expected: prints the three result blocks under the new key.

- [ ] **Step 4: Commit**

```bash
git add ml/src/periscope_eda/05_gamma_wall_reversal.py ml/findings.json
git commit -m "feat(periscope-edge): Append results to findings.json

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 5 — Wrap-up

### Task 16: Final end-to-end run + lint pass

**Files:** None new

- [ ] **Step 1: Clean re-run of everything**

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
rm -f ml/exports/gamma_wall_events.csv ml/plots/periscope-eda/gamma_wall_*.png ml/plots/periscope-eda/magnet_*.png ml/plots/periscope-eda/charm_*.png
ml/.venv/bin/python -m pytest ml/tests/test_periscope_gamma_wall_lib.py -v
ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py
```

Expected: pytest all pass; script writes 4 plots + 1 CSV + updates findings.json.

- [ ] **Step 2: Run ruff format/lint on the new files**

The repo uses ruff (see the most-recent commit `style(ml): Fix ruff lint errors + apply ruff format`):

```bash
ruff format ml/src/periscope_gamma_wall_lib.py \
            ml/src/periscope_eda/05_gamma_wall_reversal.py \
            ml/tests/test_periscope_gamma_wall_lib.py
ruff check  ml/src/periscope_gamma_wall_lib.py \
            ml/src/periscope_eda/05_gamma_wall_reversal.py \
            ml/tests/test_periscope_gamma_wall_lib.py
```

Fix any complaints. Then re-run tests + script.

- [ ] **Step 3: Read the actual verdicts from findings.json and write the run summary**

```bash
ml/.venv/bin/python -c "
import json
d = json.load(open('ml/findings.json'))['periscope_gamma_wall_edge']
for r in d['results']:
    print(f\"{r['claim']:30s}  verdict={r.get('verdict','?'):10s}  p={r.get('p_value','?')}  n={r.get('n_pairs', r.get('n_reads', '?'))}\")
"
```

Expected output (numbers will vary):
```
walls_hold                      verdict=fail        p=0.21    n=87
magnet_predicts_close           verdict=fail        p=0.65    n=42
charm_zero_cross                verdict=pass        p=0.009   n=58
```

- [ ] **Step 4: Final commit + push**

```bash
git status
# Confirm only intended files staged.
git add -A ml/  docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
git commit -m "chore(periscope-edge): Final ruff pass + end-to-end run

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
```

---

## Self-Review Checklist

- [x] **Spec §"Pre-flight check"** → Task 0
- [x] **Spec §"Data pipeline" / Source 1** → Task 6 (`fetch_reads`)
- [x] **Spec §"Data pipeline" / Source 2** → Task 6 (`fetch_bars_for_read`)
- [x] **Spec §"Per-event measurement (Claim 1: walls)"** → Tasks 3, 7
- [x] **Spec §"Pre-registered knobs"** → Task 1 (constants block, marked FIXED)
- [x] **Spec §"Per-event measurement (Claim 2: magnet)"** → Tasks 4, 7
- [x] **Spec §"Per-event measurement (Claim 3: charm-zero cross)"** → Tasks 5, 7
- [x] **Spec §"Primary tests"** → Tasks 8 (walls McNemar), 9 (magnet Wilcoxon), 10 (charm McNemar)
- [x] **Spec §"Outputs" / findings.json** → Task 15
- [x] **Spec §"Outputs" / 4 plots** → Tasks 11–14
- [x] **Spec §"Outputs" / CSV** → Task 7
- [x] **Spec §"Threats to validity"** → emitted in each test function's return dict

**Plot dir mismatch noted:** spec used `periscope_eda/` (underscore); existing repo uses `periscope-eda/` (hyphen). Plan matches existing repo convention. No code change to spec needed — the underscore version was internal-doc-only.

**Type consistency:** `compute_wall_event` returns `success: int (0|1)`; `test_walls` reads `success` from the events DataFrame and pivots on it; `plot_wall_reversal` reads `success` from the same DataFrame. Matches.

**No placeholders.** Every code block has runnable code, every command has expected output, every constant is named the same in lib and tests.

**Secondary metrics (per-mode, per-calibration-quality breakdowns) — descriptive only:** the spec marks these as "descriptive, NOT used for accept/reject." They're available via the CSV (`ml/exports/gamma_wall_events.csv`) for ad-hoc slicing in a notebook later. Not built into this experiment script to keep scope tight; can be added in a follow-up if a primary test passes.
