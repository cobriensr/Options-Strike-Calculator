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
    prices = [5000.0, 5002.0, 5005.0] + [5004.0] * 14 + [4998.0]
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
    prices = [5000.0, 5003.0, 5005.0] + [5006.0] * 14 + [5010.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "broken"
    assert ev["success"] == 0
    assert ev["breached_eod"] is True


def test_wall_event_stalled_ceiling():
    prices = [5000.0, 5003.0, 5005.0] + [5004.0] * 14 + [5001.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "stalled"
    assert ev["success"] == 0


def test_wall_event_held_floor():
    prices = [5000.0, 4998.0, 4995.0] + [4997.0] * 14 + [5003.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=4995.0, wall_type="floor",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "held"
    assert ev["success"] == 1


def test_wall_event_censored_when_window_extends_past_bars():
    prices = [5000.0, 5003.0, 5005.0]
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True
    assert ev["classification"] == "censored"
    assert ev["success"] == 0


def test_wall_event_touch_tolerance_at_boundary():
    prices = [5004.0] + [5004.0] * 16
    bars = _bars_from_prices(prices)
    ev = compute_wall_event(bars, wall_strike=5005.0, wall_type="ceiling",
                            spot_at_read=5000.0)
    assert ev["touched"] is True


from periscope_gamma_wall_lib import compute_magnet_event


def test_magnet_event_excluded_when_too_close_to_spot():
    assert compute_magnet_event(spx_close=5000.0, magnet=5001.0,
                                spot_at_read=5000.0) is None


def test_magnet_event_beats_naive():
    ev = compute_magnet_event(spx_close=5008.0, magnet=5010.0,
                              spot_at_read=5000.0)
    assert ev is not None
    assert ev["err_magnet"] == pytest.approx(4.0)
    assert ev["err_naive"] == pytest.approx(64.0)
    assert ev["delta"] == pytest.approx(-60.0)
    assert ev["magnet_won"] is True


def test_magnet_event_loses_to_naive():
    ev = compute_magnet_event(spx_close=5001.0, magnet=5010.0,
                              spot_at_read=5000.0)
    assert ev is not None
    assert ev["delta"] > 0
    assert ev["magnet_won"] is False
