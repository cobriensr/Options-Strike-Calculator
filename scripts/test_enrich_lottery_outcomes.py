"""Parity tests for the Python port of lottery exit policies.

Mirrors api/__tests__/lottery-exit-policies.test.ts and
api/__tests__/flow-inversion.test.ts so the local enrichment cannot
drift from the Vercel cron's logic without breaking this suite. Run:

    ml/.venv/bin/pytest scripts/test_enrich_lottery_outcomes.py -q
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from enrich_lottery_outcomes import (  # noqa: E402
    eod_ct_for_trigger,
    find_prominent_peaks,
    minutes_to_peak,
    peak_ceiling,
    realized_hard_stop_30m,
    realized_tier50_hold_eod,
    realized_trail_act30_trail10,
    simulate_flow_inversion,
)

ENTRY = 1.0


def minutes(n: int, step: float = 1.0) -> list[float]:
    return [i * step for i in range(n)]


def isclose(a: float, b: float) -> bool:
    return math.isclose(a, b, abs_tol=1e-6)


# ============================================================
# realized_trail_act30_trail10
# ============================================================


def test_trail_empty():
    assert realized_trail_act30_trail10([], 1) == 0


def test_trail_zero_entry():
    assert realized_trail_act30_trail10([1, 2, 3], 0) == 0
    assert realized_trail_act30_trail10([1, 2, 3], -1) == 0


def test_trail_never_activates():
    # Peak +25%, never activates → realized = last (+10%)
    r = realized_trail_act30_trail10([1.0, 1.25, 1.1], ENTRY)
    assert isclose(r, 10)


def test_trail_exits_on_10pp_drop():
    # Peak=50, drop threshold = 40, so 1.40 (≤ 40) is the exit.
    r = realized_trail_act30_trail10([1.0, 1.5, 1.4, 1.2], ENTRY)
    assert isclose(r, 40)


def test_trail_updates_running_peak():
    # +30 → +50 → +60 → +50 (peak-10 = 50, equal triggers exit) → 50
    r = realized_trail_act30_trail10(
        [1.0, 1.3, 1.5, 1.6, 1.5, 1.2], ENTRY
    )
    assert isclose(r, 50)


def test_trail_rides_to_last():
    # Activate at +30, climb to +60, end +55 (only -5pp drawdown).
    r = realized_trail_act30_trail10([1.0, 1.3, 1.6, 1.55], ENTRY)
    assert isclose(r, 55)


# ============================================================
# realized_hard_stop_30m
# ============================================================


def test_hard30_empty():
    assert realized_hard_stop_30m([], 1, []) == 0


def test_hard30_no_tick_in_window():
    # First offset is 31 min — outside the 30m stop.
    assert realized_hard_stop_30m([1.5, 1.6], 1, [31, 32]) == 0


def test_hard30_returns_last_in_window():
    # Window = 0..30; last_in = idx 2 (price 1.6).
    r = realized_hard_stop_30m(
        [1.0, 1.4, 1.6, 2.0], ENTRY, [0, 15, 30, 45]
    )
    assert isclose(r, 60)


def test_hard30_custom_stopmin():
    r = realized_hard_stop_30m(
        [1.0, 1.4, 1.6, 2.0], ENTRY, [0, 15, 30, 45], stop_min=60
    )
    assert isclose(r, 100)


def test_hard30_zero_entry():
    assert realized_hard_stop_30m([1, 2], 0, [0, 15]) == 0


# ============================================================
# realized_tier50_hold_eod
# ============================================================


def test_tier50_empty():
    assert realized_tier50_hold_eod([], 1) == 0


def test_tier50_threshold_never_hit():
    r = realized_tier50_hold_eod([1.0, 1.3, 1.1], ENTRY)
    assert isclose(r, 10)


def test_tier50_takes_tier1_then_holds():
    # Tier1 at +50% (price 1.5), tier2 at last (+100%) → avg 75
    r = realized_tier50_hold_eod([1.0, 1.5, 1.8, 2.0], ENTRY)
    assert isclose(r, 75)


def test_tier50_first_touch_wins():
    # Brief +60% then long fade → tier1=+60, tier2=-50 → avg 5
    r = realized_tier50_hold_eod([1.0, 1.6, 1.0, 0.5], ENTRY)
    assert isclose(r, 5)


def test_tier50_zero_entry():
    assert realized_tier50_hold_eod([1, 2], 0) == 0


# ============================================================
# peak_ceiling + minutes_to_peak
# ============================================================


def test_peak_empty():
    assert peak_ceiling([], 1) == 0


def test_peak_returns_max():
    assert isclose(peak_ceiling([1, 1.5, 1.2, 2.0, 1.5], ENTRY), 100)


def test_peak_zero_entry():
    assert peak_ceiling([1, 2], 0) == 0


def test_peak_sndk_archetype():
    # SNDK 5/1 fire #4: $0.05 → $0.55 = +1000%
    assert isclose(peak_ceiling([0.05, 0.1, 0.55, 0.4], 0.05), 1000)


def test_minutes_to_peak_first_max():
    assert minutes_to_peak([1, 1.5, 1.2, 2.0, 1.5], minutes(5)) == 3


def test_minutes_to_peak_empty():
    assert minutes_to_peak([], []) == 0


# ============================================================
# find_prominent_peaks — parity with TS findProminentPeaks
# ============================================================


def test_peaks_unimodal():
    # 0,1,3,7,9,7,5,3,1 — peak at index 4, prominence = 9 - 1 = 8.
    peaks = find_prominent_peaks([0, 1, 3, 7, 9, 7, 5, 3, 1], 0)
    assert len(peaks) == 1
    assert peaks[0][0] == 4
    assert peaks[0][1] == 8


def test_peaks_below_floor():
    peaks = find_prominent_peaks([1, 2, 1, 1, 1, 1, 1, 2, 1], 5)
    assert len(peaks) == 0


def test_peaks_multiple():
    peaks = find_prominent_peaks([0, 5, 0, 4, 0], 1)
    assert len(peaks) == 2
    assert [p[0] for p in peaks] == [1, 3]


def test_peaks_ignores_edges():
    peaks = find_prominent_peaks([10, 5, 0, 5, 10], 0)
    assert len(peaks) == 0


# ============================================================
# eod_ct_for_trigger — DST handling
# ============================================================


def test_eod_cdt():
    # 10:00 CT on 2026-05-02 (CDT) → 20:00 UTC same day.
    trigger = datetime(2026, 5, 2, 15, 0, 0, tzinfo=timezone.utc)
    eod = eod_ct_for_trigger(trigger)
    assert eod.isoformat() == '2026-05-02T20:00:00+00:00'


def test_eod_cst():
    # 09:00 CT on 2026-01-15 (CST) → 21:00 UTC same day.
    trigger = datetime(2026, 1, 15, 15, 0, 0, tzinfo=timezone.utc)
    eod = eod_ct_for_trigger(trigger)
    assert eod.isoformat() == '2026-01-15T21:00:00+00:00'


# ============================================================
# simulate_flow_inversion — parity with TS simulateFlowInversion
# ============================================================


TRIGGER = datetime(2026, 5, 2, 15, 0, 0, tzinfo=timezone.utc)
POST_START = datetime(2026, 5, 2, 15, 1, 0, tzinfo=timezone.utc)


def _build_minutes(start, count, fn):
    return [(start + timedelta(minutes=i), fn(i)) for i in range(count)]


def test_flow_inversion_inversion_status():
    # Mids climb to 1.5 around min 30, fall to 1.2 by 60.
    minutes = _build_minutes(
        POST_START, 90,
        lambda i: 1.0 + 0.5 * (i / 30) if i <= 30 else 1.5 - 0.3 * ((i - 30) / 60),
    )
    # Flow positive 100 then -100 — slope inverts persistently after peak.
    flow = _build_minutes(POST_START, 90, lambda i: 100 if i <= 30 else -100)
    exit_pct, exit_ts, status = simulate_flow_inversion(
        minutes, flow, 1.0, TRIGGER
    )
    assert status == 'inversion'
    assert exit_pct is not None
    assert exit_ts is not None


def test_flow_inversion_no_post_trigger():
    pre = _build_minutes(
        TRIGGER - timedelta(minutes=60), 30, lambda i: 1.0
    )
    flow = _build_minutes(POST_START, 60, lambda i: 100)
    exit_pct, _, status = simulate_flow_inversion(pre, flow, 1.0, TRIGGER)
    assert status == 'no_post_trigger_prices'
    assert exit_pct is None


def test_flow_inversion_insufficient_flow():
    minutes = _build_minutes(POST_START, 30, lambda i: 1.1)
    flow = _build_minutes(POST_START, 4, lambda i: 100)
    _, _, status = simulate_flow_inversion(minutes, flow, 1.0, TRIGGER)
    assert status == 'insufficient_flow_data'


def test_flow_inversion_no_peak():
    # Monotonic flow → cumsum is convex, no prominent peak.
    minutes = _build_minutes(POST_START, 300, lambda i: 1.0 + 0.001 * i)
    flow = _build_minutes(POST_START, 300, lambda i: 50)
    _, _, status = simulate_flow_inversion(minutes, flow, 1.0, TRIGGER)
    assert status == 'no_flow_peak_detected'


def test_flow_inversion_late_peak_fallback():
    minutes = _build_minutes(
        POST_START, 300,
        lambda i: 1.0 + 0.001 * i if i < 250 else 1.25,
    )

    def flow_fn(i):
        if i < 100:
            return 100
        if i < 110:
            return -50
        return 0

    flow = _build_minutes(POST_START, 300, flow_fn)
    _, _, status = simulate_flow_inversion(minutes, flow, 1.0, TRIGGER)
    assert status in {
        'inversion',
        'eod_no_inversion_window',
        'eod_no_inversion_found',
    }


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-q']))
