"""Tests for scripts/verify_index_candle_repair.py, the Full Tape check.

The tool compares repaired SPX 1-minute candles with the last SPXW
``underlying_price`` per UTC minute in the UW Full Tape. These tests touch no
database and no R2: the comparison maths and the gate are pure; the Postgres
read runs against a fake ``psycopg2.connect`` (a read-only session, SELECTs
only); the tape query runs against a local Parquet file through a local DuckDB
connection, in both Full Tape layouts.

Run:
    ml/.venv/Scripts/python -m pytest -q scripts/test_verify_index_candle_repair.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import duckdb
import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_index_candle_repair as vic  # noqa: E402

CREDENTIAL_NAMES = (
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
    "DATABASE_URL",
)


def minute_of(year, month, day, hour, minute) -> int:
    """The UTC epoch minute, from a clock time written out by hand."""
    stamp = datetime(year, month, day, hour, minute, tzinfo=UTC)
    return int(stamp.timestamp()) // 60


# ── minute_stats ─────────────────────────────────────────────────────────────


def test_minute_stats_gives_exact_figures_for_a_hand_built_pair():
    candles = {0: 100.0, 1: 102.0, 2: 97.0, 3: 100.5}
    tape = {0: 100.0, 1: 100.0, 2: 100.0, 3: 100.0}
    # d = candle - tape = 0, 2, -3, 0.5 -> |d| sorted 0, 0.5, 2, 3
    stats = vic.minute_stats(candles, tape)
    assert stats["minutes"] == 4
    assert stats["mean"] == pytest.approx(-0.125, abs=1e-12)  # signed
    assert stats["median_abs"] == pytest.approx(1.25, abs=1e-12)  # (0.5 + 2) / 2
    assert stats["p95_abs"] == pytest.approx(2.85, abs=1e-12)  # 2 + 0.85 * (3 - 2)
    assert stats["p99_abs"] == pytest.approx(2.97, abs=1e-12)  # 2 + 0.97 * (3 - 2)
    assert stats["max_abs"] == 3.0


def test_minute_stats_ignores_minutes_only_one_side_has():
    candles = {0: 100.0, 1: 101.0, 77: 9999.0}  # 77 has no tape minute
    tape = {0: 100.0, 1: 100.0, 88: 1.0}  # 88 has no candle
    stats = vic.minute_stats(candles, tape)
    assert stats["minutes"] == 2
    assert stats["max_abs"] == 1.0
    assert stats["median_abs"] == 0.5


def test_minute_stats_skips_a_non_finite_value_instead_of_poisoning_the_median():
    candles = {0: 100.0, 1: float("nan"), 2: 101.0}
    tape = {0: 100.0, 1: 100.0, 2: 100.0}
    stats = vic.minute_stats(candles, tape)
    assert stats["minutes"] == 2
    assert stats["median_abs"] == 0.5


def test_minute_stats_with_no_common_minute_reports_none_not_a_crash():
    stats = vic.minute_stats({0: 1.0}, {5: 1.0})
    assert stats["minutes"] == 0
    assert stats["median_abs"] is None
    assert stats["p99_abs"] is None
    assert stats["max_abs"] is None
    assert stats["mean"] is None
    assert vic.minute_stats({}, {})["minutes"] == 0


# ── gate ─────────────────────────────────────────────────────────────────────


def stats_of(median, p99, maximum=None, minutes=390):
    return {
        "minutes": minutes,
        "mean": 0.0,
        "median_abs": median,
        "p95_abs": p99,
        "p99_abs": p99,
        "max_abs": p99 if maximum is None else maximum,
    }


def test_gate_passes_the_aug_12_method_check():
    assert vic.gate(stats_of(0.95, 2.3)) == (True, [])


def test_gate_passes_nov_20_a_live_day_with_one_outlier_minute():
    # One minute at 25.3 against a median of 0.67: why the gate reads p99, not
    # max. The fixture takes p99 4.9 from the task brief, close under the limit;
    # the real 2026-11-20 run measured p99 2.85.
    assert vic.gate(stats_of(0.67, 4.9, maximum=25.3)) == (True, [])


def test_gate_fails_the_placeholder_with_a_reason_naming_the_median():
    ok, reasons = vic.gate(stats_of(25.1, 25.4))
    assert ok is False
    assert any("median" in reason for reason in reasons)


def test_gate_fails_on_p99_alone_and_names_p99_not_the_median():
    ok, reasons = vic.gate(stats_of(0.8, 5.01))
    assert ok is False
    assert len(reasons) == 1
    assert "p99" in reasons[0]
    assert "median" not in reasons[0]


def test_gate_limits_are_inclusive_at_2_and_5_and_fail_just_past_them():
    assert vic.gate(stats_of(2.0, 5.0)) == (True, [])
    assert vic.gate(stats_of(2.01, 5.0))[0] is False
    assert vic.gate(stats_of(2.0, 5.01))[0] is False


def test_gate_fails_no_overlap():
    ok, reasons = vic.gate(vic.minute_stats({0: 1.0}, {9: 1.0}))
    assert ok is False
    assert len(reasons) == 1
    assert "no overlap" in reasons[0]


# ── gate on a fitted day: p99 is a note, the median still gates ──────────────


def test_gate_fitted_passes_a_high_p99_with_a_note_not_a_reason():
    # A refit day (fitted medians 0.19-0.56) with a 18.2 pt tape-lag spike.
    ok, lines = vic.gate(stats_of(0.33, 18.2), fitted=True)
    assert ok is True
    assert len(lines) == 1
    assert lines[0].startswith("note:")
    assert "p99" in lines[0]
    assert "18.20" in lines[0]


def test_gate_fitted_still_fails_a_median_over_2():
    ok, lines = vic.gate(stats_of(2.5, 2.5), fitted=True)
    assert ok is False
    assert len(lines) == 1
    assert "median" in lines[0]
    assert not lines[0].startswith("note:")


def test_gate_fitted_with_a_bad_median_and_a_bad_p99_fails_and_keeps_the_note():
    ok, lines = vic.gate(stats_of(25.1, 25.4), fitted=True)
    assert ok is False
    assert any("median" in line and not line.startswith("note:") for line in lines)
    assert any(line.startswith("note:") and "p99" in line for line in lines)


def test_gate_fitted_with_a_p99_inside_5_has_no_note():
    assert vic.gate(stats_of(0.33, 5.0), fitted=True) == (True, [])


def test_gate_not_fitted_still_fails_a_p99_of_18():
    ok, reasons = vic.gate(stats_of(0.33, 18.2))
    assert ok is False
    assert len(reasons) == 1
    assert "p99" in reasons[0]
    assert not reasons[0].startswith("note:")
    assert vic.gate(stats_of(0.33, 18.2), fitted=False) == (ok, reasons)


def test_gate_fitted_still_fails_no_overlap():
    ok, reasons = vic.gate(vic.minute_stats({0: 1.0}, {9: 1.0}), fitted=True)
    assert ok is False
    assert "no overlap" in reasons[0]


# ── ratio_share ──────────────────────────────────────────────────────────────


def test_ratio_share_counts_the_minutes_within_1e_6():
    etf = {0: 700.0, 1: 700.0, 2: 700.0, 3: 700.0}
    ratio = 10.04
    index = {
        0: 700.0 * ratio,  # exact
        1: 700.0 * (ratio + 5e-7),  # inside the tolerance
        2: 700.0 * (ratio + 2e-6),  # outside
        3: 700.0 * (ratio - 5e-7),  # inside, below
    }
    assert vic.ratio_share(index, etf, ratio) == pytest.approx(0.75)


def test_ratio_share_honours_a_wider_tolerance():
    etf = {0: 700.0}
    index = {0: 700.0 * (10.04 + 2e-6)}
    assert vic.ratio_share(index, etf, 10.04) == 0.0
    assert vic.ratio_share(index, etf, 10.04, tol=1e-3) == 1.0


def test_ratio_share_ignores_minutes_only_one_side_has():
    etf = {0: 700.0, 5: 700.0}  # 5 has no index bar
    index = {0: 7028.0, 9: 1.0}  # 9 has no ETF bar
    assert vic.ratio_share(index, etf, 10.04) == 1.0


def test_ratio_share_is_zero_with_nothing_in_common():
    assert vic.ratio_share({0: 7028.0}, {1: 700.0}, 10.04) == 0.0
    assert vic.ratio_share({}, {}, 10.04) == 0.0


def test_ratio_share_counts_a_zero_etf_close_as_a_mismatch_not_a_division_error():
    etf = {0: 0.0, 1: 700.0}
    index = {0: 5.0, 1: 7028.0}
    assert vic.ratio_share(index, etf, 10.04) == 0.5


# ── evaluate: the gate, the coverage floor and the ratio check ───────────────


def test_evaluate_passes_without_a_ratio():
    assert vic.evaluate(stats_of(0.9, 2.0), None, 390) == (True, [])


def test_evaluate_fails_a_ratio_share_under_99_percent_and_names_the_ratio():
    ok, reasons = vic.evaluate(stats_of(0.9, 2.0), 0.98, 390)
    assert ok is False
    assert len(reasons) == 1
    assert "ratio" in reasons[0]


def test_evaluate_passes_a_ratio_share_of_exactly_99_percent():
    assert vic.evaluate(stats_of(0.9, 2.0), 0.99, 390) == (True, [])


def test_evaluate_keeps_the_gate_reason_next_to_the_ratio_reason():
    ok, reasons = vic.evaluate(stats_of(25.1, 25.4), 0.0, 390)
    assert ok is False
    assert any("median" in r for r in reasons)
    assert any("ratio" in r for r in reasons)


def test_evaluate_fails_a_tape_that_covers_under_99_percent_of_the_candle_minutes():
    # 99% of 390 is 386.1: 387 passes, 386 does not (the ratio gate's rule).
    assert vic.evaluate(stats_of(0.9, 2.0, minutes=387), None, 390) == (True, [])
    ok, reasons = vic.evaluate(stats_of(0.9, 2.0, minutes=386), None, 390)
    assert ok is False
    assert reasons == [
        "only 386 of 390 candle minutes have a tape spot (under 99%)",
    ]


def test_evaluate_coverage_floor_is_inclusive_at_exactly_99_percent():
    assert vic.evaluate(stats_of(0.9, 2.0, minutes=99), None, 100) == (True, [])
    assert vic.evaluate(stats_of(0.9, 2.0, minutes=98), None, 100)[0] is False


def test_evaluate_lists_the_coverage_reason_with_the_gates_other_reasons():
    ok, reasons = vic.evaluate(stats_of(25.1, 25.4, minutes=300), 0.5, 390)
    assert ok is False
    assert any("median" in r for r in reasons)
    assert any("p99" in r for r in reasons)
    assert any("only 300 of 390 candle minutes have a tape spot" in r for r in reasons)
    assert any("ratio" in r for r in reasons)


def test_evaluate_passes_fitted_through_to_the_gate():
    ok, lines = vic.evaluate(stats_of(0.33, 18.2), None, 390, fitted=True)
    assert ok is True
    assert len(lines) == 1
    assert lines[0].startswith("note:")
    assert vic.evaluate(stats_of(0.33, 18.2), None, 390)[0] is False


def test_evaluate_fitted_keeps_the_coverage_and_ratio_floors():
    ok, lines = vic.evaluate(stats_of(0.33, 18.2, minutes=300), 0.5, 390, fitted=True)
    assert ok is False
    assert any("only 300 of 390" in line for line in lines)
    assert any("ratio" in line for line in lines)


def test_evaluate_no_overlap_keeps_only_its_own_reason():
    # No common minute is "no overlap", not also "only 0 of N".
    ok, reasons = vic.evaluate(vic.minute_stats({0: 1.0}, {9: 1.0}), None, 1)
    assert ok is False
    assert len(reasons) == 1
    assert "no overlap" in reasons[0]


# ── arguments ────────────────────────────────────────────────────────────────


def test_args_parse_the_documented_command():
    args = vic.parse_args(
        [
            "--symbol",
            "SPX",
            "--date",
            "2026-04-10",
            "--before",
            "17:11Z",
            "--ratio",
            "10.040707",
        ]
    )
    assert args.symbol == "SPX"
    assert args.date == date(2026, 4, 10)
    assert args.before == "17:11Z"
    assert args.ratio == 10.040707


def test_args_default_to_no_cut_no_ratio_no_export_and_the_strict_gate():
    args = vic.parse_args(["--symbol", "SPX", "--date", "2026-03-26"])
    assert args.before is None
    assert args.ratio is None
    assert args.export_spots is None
    assert args.fitted is False


def test_args_parse_fitted():
    args = vic.parse_args(["--symbol", "SPX", "--date", "2026-03-26", "--fitted"])
    assert args.fitted is True


def test_args_refuse_ndx_because_the_tape_carries_no_ndx_price(capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(["--symbol", "NDX", "--date", "2026-03-26"])
    assert exit_info.value.code == 2
    assert "no NDX price" in capsys.readouterr().err


def test_args_refuse_ndx_with_a_fitted_gate_too(capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(["--symbol", "NDX", "--date", "2026-03-26", "--fitted"])
    assert exit_info.value.code == 2
    assert "no NDX price" in capsys.readouterr().err


def test_args_accept_ndx_with_export_spots(tmp_path):
    args = vic.parse_args(
        ["--symbol", "NDX", "--date", "2026-10-20", "--export-spots", str(tmp_path)]
    )
    assert args.symbol == "NDX"
    assert args.export_spots == tmp_path


def test_args_accept_spx_with_export_spots(tmp_path):
    args = vic.parse_args(
        ["--symbol", "spx", "--date", "2026-03-26", "--export-spots", str(tmp_path)]
    )
    assert args.symbol == "SPX"
    assert args.export_spots == tmp_path


@pytest.mark.parametrize(
    ("flag", "value"),
    [("--before", "17:11Z"), ("--ratio", "10.04"), ("--fitted", None)],
)
def test_args_refuse_a_candle_flag_next_to_export_spots(flag, value, tmp_path, capsys):
    # The export reads no candles; a flag that cannot apply must not be ignored
    # in silence (a --before that did not cut the file would look like it had).
    argv = ["--symbol", "SPX", "--date", "2026-04-10", "--export-spots", str(tmp_path)]
    argv += [flag] if value is None else [flag, value]
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(argv)
    assert exit_info.value.code == 2
    err = capsys.readouterr().err
    assert f"{flag} cannot be combined with --export-spots" in err


def test_args_refuse_any_other_symbol(capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(["--symbol", "QQQ", "--date", "2026-03-26"])
    assert exit_info.value.code == 2
    err = capsys.readouterr().err
    assert "SPX" in err
    assert "NDX" in err


@pytest.mark.parametrize(
    "bad",
    [
        ["--symbol", "SPX"],  # no date
        ["--date", "2026-03-26"],  # no symbol
        ["--symbol", "SPX", "--date", "2026-13-45"],
        ["--symbol", "SPX", "--date", "2026-3-26"],
        ["--symbol", "SPX", "--date", "20260326"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--before", "17:11"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--before", "25:00Z"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--before", "17:60Z"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "0"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "-10"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "nan"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "inf"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "ten"],
    ],
)
def test_args_refuse_malformed_input(bad, capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(bad)
    assert exit_info.value.code == 2
    capsys.readouterr()


# ── the 04-10 cut ────────────────────────────────────────────────────────────


def test_before_minute_is_the_utc_epoch_minute():
    # 1970-01-02 00:01Z is minute 1440 + 1.
    assert vic.before_minute(date(1970, 1, 2), "00:01Z") == 1441
    assert vic.before_minute(date(1970, 1, 1), "23:59Z") == 1439


def test_apply_cut_keeps_only_minutes_strictly_before_the_cut():
    kept = vic.apply_cut({9: 1.0, 10: 2.0, 11: 3.0}, 10)
    assert kept == {9: 1.0}


def test_apply_cut_without_a_cut_keeps_everything():
    assert vic.apply_cut({9: 1.0, 10: 2.0}, None) == {9: 1.0, 10: 2.0}


# ── parity_levels ────────────────────────────────────────────────────────────


def both_sides(minute, strike, call_mid, put_mid):
    """The (minute, strike, side, mid) quotes of one strike: its call and put."""
    return [(minute, strike, "c", call_mid), (minute, strike, "p", put_mid)]


def test_parity_levels_gives_the_level_of_three_strikes_that_agree():
    # strike + call - put: 24000 + 105 - 95, 24050 + 60 - 100, 24100 + 25 - 115.
    quotes = [
        *both_sides(7, 24000, 105.0, 95.0),
        *both_sides(7, 24050, 60.0, 100.0),
        *both_sides(7, 24100, 25.0, 115.0),
    ]
    assert vic.parity_levels(quotes) == {7: pytest.approx(24010.0, abs=1e-9)}


def test_parity_levels_takes_the_median_of_the_strikes_it_keeps():
    # Implied 24010, 24012, 24014: the level is 24012, the middle one.
    quotes = [
        *both_sides(7, 24000, 100.0, 90.0),  # 24010
        *both_sides(7, 24050, 60.0, 98.0),  # 24012
        *both_sides(7, 24100, 25.0, 111.0),  # 24014
    ]
    assert vic.parity_levels(quotes)[7] == pytest.approx(24012.0, abs=1e-9)


def test_parity_levels_leaves_out_a_strike_beyond_the_band():
    # Three strikes near 24012 and one at 24300 that implies 24500. Kept in, the
    # median of four would be 24013; left out, it is 24012.
    quotes = [
        *both_sides(7, 24000, 100.0, 90.0),  # 24010
        *both_sides(7, 24050, 60.0, 98.0),  # 24012
        *both_sides(7, 24100, 25.0, 111.0),  # 24014
        *both_sides(7, 24300, 700.0, 500.0),  # 24500, 288 pt from the rough level
    ]
    assert vic.parity_levels(quotes)[7] == pytest.approx(24012.0, abs=1e-9)


def test_parity_levels_gives_no_level_when_the_far_strike_was_the_second_strike():
    # Rough level 24011; 24300 is 289 pt away (band 120), so only one strike is
    # kept, under min_strikes. Were it kept, the minute would have a level.
    quotes = [
        *both_sides(7, 24000, 100.0, 90.0),  # 24010
        *both_sides(7, 24300, 100.0, 388.0),  # 24012
    ]
    assert vic.parity_levels(quotes) == {}


def test_parity_levels_keeps_a_strike_exactly_on_the_half_percent_bound():
    # Both strikes imply 20000, so the rough level is 20000 and the bound is
    # 0.005 * 20000 = 100 exactly: 19900 and 20100 sit on it.
    quotes = [
        *both_sides(7, 19900, 105.0, 5.0),  # 19900 + 100
        *both_sides(7, 20100, 5.0, 105.0),  # 20100 - 100
    ]
    assert vic.parity_levels(quotes) == {7: pytest.approx(20000.0, abs=1e-9)}


def test_parity_levels_drops_a_strike_just_past_the_bound():
    quotes = [
        *both_sides(7, 19899, 105.0, 5.0),  # 19899 + 100 = 19999, 101 pt below
        *both_sides(7, 20101, 5.0, 105.0),  # 20101 - 100 = 20001, 101 pt above
    ]
    # Rough level 20000; each strike is 101 pt away, over the 100 pt bound.
    assert vic.parity_levels(quotes) == {}


def test_parity_levels_with_one_strike_has_no_level():
    assert vic.parity_levels(both_sides(7, 24000, 105.0, 95.0)) == {}


def test_parity_levels_with_calls_only_has_no_level():
    quotes = [(7, 24000, "c", 105.0), (7, 24050, "c", 60.0), (7, 24100, "c", 25.0)]
    assert vic.parity_levels(quotes) == {}


def test_parity_levels_does_not_count_a_strike_that_has_only_one_side():
    quotes = [
        *both_sides(7, 24000, 105.0, 95.0),
        (7, 24050, "c", 60.0),  # no put at 24050
        (7, 24100, "p", 115.0),  # no call at 24100
    ]
    assert vic.parity_levels(quotes) == {}


def test_parity_levels_honours_min_strikes_and_band():
    quotes = [
        *both_sides(7, 24000, 105.0, 95.0),
        *both_sides(7, 24050, 60.0, 100.0),
    ]
    assert 7 in vic.parity_levels(quotes, min_strikes=2)
    assert vic.parity_levels(quotes, min_strikes=3) == {}
    # A band of 0 keeps the strikes only when they equal the rough level, which
    # a strike far from the index never does.
    assert vic.parity_levels(quotes, band=0.0) == {}


def test_parity_levels_works_minute_by_minute():
    quotes = [
        *both_sides(7, 24000, 105.0, 95.0),
        *both_sides(7, 24050, 60.0, 100.0),
        *both_sides(8, 24000, 110.0, 90.0),  # one strike: no level
        *both_sides(9, 24100, 25.0, 115.0),
        *both_sides(9, 24050, 60.0, 100.0),
    ]
    levels = vic.parity_levels(quotes)
    assert set(levels) == {7, 9}
    assert levels[7] == pytest.approx(24010.0, abs=1e-9)


def test_parity_levels_skips_a_non_finite_quote_instead_of_poisoning_the_minute():
    # The NaN call sits between good strikes: left in, it makes the rough level
    # NaN and the minute loses its level.
    quotes = [
        *both_sides(7, 24000, 100.0, 90.0),  # 24010
        *both_sides(7, 24150, float("nan"), 100.0),
        *both_sides(7, 24050, 60.0, 98.0),  # 24012
        *both_sides(7, 24100, 25.0, 111.0),  # 24014
    ]
    assert vic.parity_levels(quotes)[7] == pytest.approx(24012.0, abs=1e-9)


def test_parity_levels_of_nothing_is_empty():
    assert vic.parity_levels([]) == {}
    assert vic.parity_levels(iter([])) == {}


# ── the price file ───────────────────────────────────────────────────────────


def test_spots_document_has_string_minute_keys_in_minute_order():
    doc = vic.spots_document("SPX", date(2026, 3, 26), "tape", {20: 5801.5, 3: 5800.0})
    assert doc == {
        "symbol": "SPX",
        "date": "2026-03-26",
        "source": "tape",
        "minutes": {"3": 5800.0, "20": 5801.5},
    }
    assert list(doc["minutes"]) == ["3", "20"]


def test_write_spots_writes_the_named_file_and_returns_its_path(tmp_path):
    doc = vic.spots_document("NDX", date(2026, 10, 20), "parity", {5: 24010.25})
    path = vic.write_spots(tmp_path, doc)
    assert path == tmp_path / "NDX-2026-10-20-spots.json"
    assert json.loads(path.read_text(encoding="utf-8")) == doc
    assert list(json.loads(path.read_text(encoding="utf-8"))["minutes"]) == ["5"]


def test_write_spots_creates_the_output_directory(tmp_path):
    out_dir = tmp_path / "a" / "spots"
    path = vic.write_spots(
        out_dir, vic.spots_document("SPX", date(2026, 3, 26), "tape", {1: 1.0})
    )
    assert path.parent == out_dir
    assert path.is_file()


def test_write_spots_refuses_an_existing_file_and_leaves_it_unchanged(tmp_path):
    first = vic.spots_document("SPX", date(2026, 3, 26), "tape", {1: 5800.0})
    second = vic.spots_document("SPX", date(2026, 3, 26), "tape", {1: 9999.0})
    path = vic.write_spots(tmp_path, first)
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        vic.write_spots(tmp_path, second)
    assert path.read_bytes() == before


def test_write_spots_writes_no_file_for_a_price_that_is_not_a_number(tmp_path):
    # NaN is not JSON. The write must fail whole, not leave a file a later run
    # would "keep" and the fit would choke on.
    doc = vic.spots_document("SPX", date(2026, 3, 26), "tape", {1: float("nan")})
    with pytest.raises(ValueError, match="JSON"):
        vic.write_spots(tmp_path, doc)
    assert list(tmp_path.iterdir()) == []


def test_write_spots_removes_the_partial_file_when_the_write_fails(
    tmp_path, monkeypatch
):
    real_open = Path.open

    class DiskFull:
        """Takes a few bytes, then fails, as a full disk does."""

        def __init__(self, handle):
            self._handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            self._handle.close()
            return False

        def write(self, text):
            self._handle.write(text[:5])
            self._handle.flush()
            raise OSError("No space left on device")

    monkeypatch.setattr(
        Path, "open", lambda self, *a, **kw: DiskFull(real_open(self, *a, **kw))
    )
    doc = vic.spots_document("SPX", date(2026, 3, 26), "tape", {1: 5800.0})
    with pytest.raises(OSError, match="No space"):
        vic.write_spots(tmp_path, doc)
    # No half file is left for a re-run to "keep".
    assert list(tmp_path.iterdir()) == []


# ── credentials ──────────────────────────────────────────────────────────────


def test_read_allowed_env_returns_only_the_five_credential_names(tmp_path):
    env_file = tmp_path / ".env.local"
    env_file.write_text(
        "\n".join(
            [
                "# a comment",
                "R2_ACCESS_KEY_ID=key-id",
                'R2_SECRET_ACCESS_KEY="quoted-secret"',
                "R2_ENDPOINT_URL='https://r2.example'",
                "R2_BUCKET_FULLTAPE=bucket",
                "DATABASE_URL=postgres://u:p@h/d",
                "OWNER_SECRET=must-not-load",
                "ANTHROPIC_API_KEY=must-not-load",
                "R2_ACCOUNT_ID=not-needed",
                "export R2_CLOUDFLARE_TOKEN=not-needed",
            ]
        ),
        encoding="utf-8",
    )
    found = vic.read_allowed_env(env_file)
    assert found == {
        "R2_ACCESS_KEY_ID": "key-id",
        "R2_SECRET_ACCESS_KEY": "quoted-secret",
        "R2_ENDPOINT_URL": "https://r2.example",
        "R2_BUCKET_FULLTAPE": "bucket",
        "DATABASE_URL": "postgres://u:p@h/d",
    }


def test_read_allowed_env_keeps_the_first_assignment_of_a_repeated_name(tmp_path):
    # The same rule as scripts/_cli_paths.load_env_file (setdefault).
    env_file = tmp_path / ".env.local"
    env_file.write_text("DATABASE_URL=first\nDATABASE_URL=second\n", encoding="utf-8")
    assert vic.read_allowed_env(env_file) == {"DATABASE_URL": "first"}


def test_read_allowed_env_of_a_missing_file_is_empty(tmp_path):
    assert vic.read_allowed_env(tmp_path / "nope") == {}


def test_load_credentials_sets_only_the_allowed_names_and_keeps_a_shell_value(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env.local"
    env_file.write_text(
        "\n".join(
            [
                "R2_ACCESS_KEY_ID=from-file",
                "R2_SECRET_ACCESS_KEY=from-file",
                "R2_ENDPOINT_URL=https://r2.example",
                "R2_BUCKET_FULLTAPE=bucket",
                "DATABASE_URL=postgres://from-file",
                "OWNER_SECRET=must-not-load",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": "postgres://from-shell"})
    vic.load_credentials(env_file)
    assert os.environ["DATABASE_URL"] == "postgres://from-shell"
    assert os.environ["R2_ACCESS_KEY_ID"] == "from-file"
    assert "OWNER_SECRET" not in os.environ


def test_load_credentials_names_what_is_missing_and_never_a_value(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env.local"
    env_file.write_text(
        "R2_ACCESS_KEY_ID=value-that-must-not-print\n", encoding="utf-8"
    )
    monkeypatch.setattr(os, "environ", {})
    with pytest.raises(RuntimeError) as err:
        vic.load_credentials(env_file)
    message = str(err.value)
    assert "R2_SECRET_ACCESS_KEY" in message
    assert "DATABASE_URL" in message
    assert "R2_ACCESS_KEY_ID" not in message  # that one is set
    assert "value-that-must-not-print" not in message


def test_main_checkout_comes_from_the_git_common_dir():
    assert vic.main_checkout_from_common_dir("F:/dev/strike-calculator/.git\n") == Path(
        "F:/dev/strike-calculator"
    )
    assert vic.main_checkout_from_common_dir("/srv/repo/.git/") == Path("/srv/repo")


def test_main_checkout_refuses_a_path_that_is_not_a_dot_git():
    with pytest.raises(ValueError, match="not a .git"):
        vic.main_checkout_from_common_dir("/srv/repo/worktrees/x")


def test_redact_hides_every_secret_value_that_is_set(monkeypatch):
    monkeypatch.setattr(
        os,
        "environ",
        {
            "DATABASE_URL": "postgres://user:hunter2@host/db",
            "R2_SECRET_ACCESS_KEY": "s3cr3tkey",
            "R2_BUCKET_FULLTAPE": "",
        },
    )
    text = "failed on postgres://user:hunter2@host/db with s3cr3tkey"
    # The whole URL goes first: replacing the password alone first would leave
    # the user and host of the connection string in the message.
    assert vic.redact(text) == "failed on *** with ***"
    assert vic.redact("nothing secret here") == "nothing secret here"


def test_redact_hides_a_database_password_that_shows_up_alone(monkeypatch):
    monkeypatch.setattr(
        os, "environ", {"DATABASE_URL": "postgres://user:hunter2@host/db"}
    )
    assert vic.redact("auth failed, password hunter2 rejected") == (
        "auth failed, password *** rejected"
    )


NEON_HOST = "ep-fake-pooler.us-east-2.aws.neon.tech"
R2_HOST = "0123abcd.r2.cloudflarestorage.com"


def test_redact_hides_the_database_host_and_user_in_libpqs_own_message(monkeypatch):
    monkeypatch.setattr(
        os,
        "environ",
        {
            "DATABASE_URL": f"postgres://app_owner:hunter2@{NEON_HOST}/neondb",
            "R2_ENDPOINT_URL": f"https://{R2_HOST}",
        },
    )
    libpq = (
        f'connection to server at "{NEON_HOST}" (3.4.5.6), port 5432 failed: '
        'FATAL: password authentication failed for user "app_owner"'
    )
    redacted = vic.redact(libpq)
    assert "app_owner" not in redacted
    assert NEON_HOST not in redacted
    assert redacted == (
        'connection to server at "***" (3.4.5.6), port 5432 failed: '
        'FATAL: password authentication failed for user "***"'
    )


def test_redact_hides_the_r2_host_when_a_message_names_only_the_host(monkeypatch):
    monkeypatch.setattr(os, "environ", {"R2_ENDPOINT_URL": f"https://{R2_HOST}"})
    assert vic.redact(f"Could not resolve host {R2_HOST}") == (
        "Could not resolve host ***"
    )


def test_redact_matches_a_host_whatever_its_case(monkeypatch):
    # urlsplit lowercases the host; the driver prints it as the URL spelled it.
    monkeypatch.setattr(
        os,
        "environ",
        {"DATABASE_URL": "postgres://app_owner:hunter2@EP-Mixed.Neon.TECH/db"},
    )
    assert vic.redact('server at "EP-Mixed.Neon.TECH" refused') == (
        'server at "***" refused'
    )


def test_redact_survives_a_database_url_that_does_not_parse(monkeypatch):
    # urlsplit raises ValueError on this one. The error path must not crash
    # (an uncaught exception would exit 1, which reads as a FAIL verdict).
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": "postgres://[bad-host/db"})
    assert vic.redact("could not parse postgres://[bad-host/db") == (
        "could not parse ***"
    )


def test_redact_replaces_a_value_that_starts_another_value_whole(monkeypatch):
    monkeypatch.setattr(
        os,
        "environ",
        {"R2_ACCESS_KEY_ID": "AKIA", "R2_SECRET_ACCESS_KEY": "AKIAFULLSECRET"},
    )
    assert vic.redact("bad key AKIAFULLSECRET") == "bad key ***"


def test_redact_with_nothing_to_hide_changes_nothing(monkeypatch):
    # An empty pattern would match between every character.
    monkeypatch.setattr(os, "environ", {})
    assert vic.redact("nothing to hide") == "nothing to hide"


# ── the Postgres read ────────────────────────────────────────────────────────


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self._rows = []

    def execute(self, sql, params=None):
        self._conn.events.append(("execute", " ".join(sql.split()), params))
        if self._conn.fail_on_execute:
            raise psycopg2.OperationalError("connection reset by the fake")
        table = "index" if "index_candles_1m" in sql else "etf"
        self._rows = list(self._conn.tables[table])

    def fetchall(self):
        return self._rows

    def close(self):
        self._conn.events.append(("cursor_close",))


class FakeConnection:
    def __init__(self, tables, fail_on_execute=False):
        self.tables = tables
        self.fail_on_execute = fail_on_execute
        self.events: list[tuple] = [("connect",)]

    def set_session(self, **kwargs):
        self.events.append(("set_session", kwargs))

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.events.append(("close",))


def install_fake_postgres(monkeypatch, conn):
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": "postgres://fake/db"})
    monkeypatch.setattr(psycopg2, "connect", lambda *a, **k: conn)


def test_fetch_index_and_etf_opens_a_read_only_session_before_any_query(monkeypatch):
    conn = FakeConnection(
        {"index": [(100, 5800.5), (101, 5801.0)], "etf": [(100, 580.0), (101, 580.1)]}
    )
    install_fake_postgres(monkeypatch, conn)
    index, etf = vic.fetch_index_and_etf("SPX", date(2026, 3, 26))
    assert index == {100: 5800.5, 101: 5801.0}
    assert etf == {100: 580.0, 101: 580.1}
    kinds = [event[0] for event in conn.events]
    assert kinds[0] == "connect"
    assert conn.events[1] == ("set_session", {"readonly": True})
    assert kinds[-1] == "close"
    executed = [event for event in conn.events if event[0] == "execute"]
    assert len(executed) == 2
    assert all(event[1].upper().startswith("SELECT") for event in executed)


def test_fetch_index_and_etf_reads_regular_minutes_of_that_symbol_and_day(monkeypatch):
    conn = FakeConnection({"index": [], "etf": []})
    install_fake_postgres(monkeypatch, conn)
    vic.fetch_index_and_etf("SPX", date(2026, 3, 26))
    index_query, etf_query = [e for e in conn.events if e[0] == "execute"]
    assert "market_time = 'r'" in index_query[1]
    assert index_query[2] == ("SPX", date(2026, 3, 26))
    assert "ticker = 'SPY'" in etf_query[1]
    assert etf_query[2] == (date(2026, 3, 26), date(2026, 3, 26))


def test_fetch_index_and_etf_closes_the_connection_when_the_query_fails(monkeypatch):
    conn = FakeConnection({"index": [], "etf": []}, fail_on_execute=True)
    install_fake_postgres(monkeypatch, conn)
    with pytest.raises(psycopg2.OperationalError, match="connection reset"):
        vic.fetch_index_and_etf("SPX", date(2026, 3, 26))
    assert conn.events[-1] == ("close",)


# ── the tape query ───────────────────────────────────────────────────────────

# (executed_at column type, canceled column type, (not canceled, canceled), price type)
TAPE_LAYOUTS = {
    "tz_boolean": ("TIMESTAMPTZ", "BOOLEAN", ("false", "true"), "DOUBLE"),
    "naive_boolean": ("TIMESTAMP", "BOOLEAN", ("false", "true"), "DECIMAL(18,4)"),
    "naive_text_f_t": ("TIMESTAMP", "VARCHAR", ("'f'", "'t'"), "DECIMAL(18,4)"),
    "tz_text_words": ("TIMESTAMPTZ", "VARCHAR", ("'false'", "'true'"), "DOUBLE"),
}

# One SPXW print list: (id, chain, clock, price, canceled?)
TAPE_ROWS = [
    # 14:30: last by time wins; the later canceled print at 5900 is ignored.
    ("a1", "SPXW260326C05800000", "14:30:05", "5800.0", False),
    ("a2", "SPXW260326P05800000", "14:30:50", "5801.5", False),
    ("a3", "SPXW260326C05800000", "14:30:59", "5900.0", True),
    # 14:31: same instant twice; the later id wins the tie.
    ("b1", "SPXW260326C05800000", "14:31:10", "5802.0", False),
    ("b2", "SPXW260326C05805000", "14:31:10", "5803.0", False),
    # 14:32: the later print has no spot; the earlier one stands.
    ("c1", "SPXW260326C05800000", "14:32:10", "5804.0", False),
    ("c2", "SPXW260326C05800000", "14:32:30", None, False),
    # 14:33: only non-SPXW roots; no minute at all.
    ("d1", "SPX260327C05800000", "14:33:10", "5810.0", False),
    ("d2", "SPXS260326C00010000", "14:33:20", "9.0", False),
]


def write_tape(path: Path, layout: str) -> None:
    ts_type, canceled_type, (no, yes), price_type = TAPE_LAYOUTS[layout]
    con = duckdb.connect()
    try:
        con.execute(
            f"""CREATE TABLE tape (id VARCHAR, option_chain_id VARCHAR,
                executed_at {ts_type}, underlying_price {price_type},
                canceled {canceled_type})"""
        )
        offset = "+00" if ts_type == "TIMESTAMPTZ" else ""  # naive layout is UTC
        for row_id, chain, clock, price, canceled in TAPE_ROWS:
            stamp = f"'2026-03-26 {clock}{offset}'"
            value = "NULL" if price is None else price
            flag = yes if canceled else no
            con.execute(
                f"INSERT INTO tape VALUES ('{row_id}', '{chain}', "
                f"CAST({stamp} AS {ts_type}), {value}, {flag})"
            )
        con.execute(f"COPY tape TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()


@pytest.mark.parametrize("layout", sorted(TAPE_LAYOUTS))
def test_fetch_tape_spots_takes_the_last_spxw_spot_per_utc_minute(
    layout, tmp_path, monkeypatch
):
    tape_file = tmp_path / "2026-03-26-fulltape.parquet"
    write_tape(tape_file, layout)
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    asked = {}

    def local_connection(**kwargs):
        asked.update(kwargs)
        return duckdb.connect()

    monkeypatch.setattr(r2, "fulltape_connection", local_connection)
    monkeypatch.setattr(r2, "r2_url", lambda day: tape_file.as_posix())

    spots = vic.fetch_tape_spots(date(2026, 3, 26))

    assert spots == {
        minute_of(2026, 3, 26, 14, 30): 5801.5,
        minute_of(2026, 3, 26, 14, 31): 5803.0,
        minute_of(2026, 3, 26, 14, 32): 5804.0,
    }
    # The brief's budget for the shared box.
    assert asked == {"threads": 4, "memory_limit": "3000MiB"}


class FailingTapeConnection:
    """A DuckDB connection whose query fails, as a 404 on an absent day does."""

    def __init__(self):
        self.closed = False

    def execute(self, sql):
        raise duckdb.IOException("HTTP 404 Not Found reading the tape")

    def close(self):
        self.closed = True


def test_fetch_tape_spots_closes_the_connection_when_the_query_fails(monkeypatch):
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    conn = FailingTapeConnection()
    monkeypatch.setattr(r2, "fulltape_connection", lambda **kwargs: conn)
    monkeypatch.setattr(r2, "r2_url", lambda day: "s3://bucket/2026-03-28.parquet")
    with pytest.raises(duckdb.IOException, match="404"):
        vic.fetch_tape_spots(date(2026, 3, 28))
    assert conn.closed


def test_fetch_tape_spots_closes_the_connection_when_the_url_cannot_be_built(
    monkeypatch,
):
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    def no_bucket(day):
        raise RuntimeError("Missing env var 'R2_BUCKET_FULLTAPE'")

    conn = FailingTapeConnection()
    monkeypatch.setattr(r2, "fulltape_connection", lambda **kwargs: conn)
    monkeypatch.setattr(r2, "r2_url", no_bucket)
    with pytest.raises(RuntimeError, match="R2_BUCKET_FULLTAPE"):
        vic.fetch_tape_spots(date(2026, 3, 28))
    assert conn.closed


# ── the parity query ─────────────────────────────────────────────────────────

PARITY_DAY = date(2026, 3, 26)
M30 = minute_of(2026, 3, 26, 14, 30)
M31 = minute_of(2026, 3, 26, 14, 31)
M32 = minute_of(2026, 3, 26, 14, 32)


def tape_print(
    row_id,
    clock,
    kind,
    strike,
    bid,
    ask,
    *,
    root="NDXP",
    expiry="2026-03-26",
    canceled=False,
):
    """One print row: (id, chain, clock, expiry, strike, option_type, bid, ask, canceled)."""
    yymmdd = expiry[2:4] + expiry[5:7] + expiry[8:10]
    chain = f"{root}{yymmdd}{kind[0].upper()}{strike * 1000:08d}"
    return (row_id, chain, clock, expiry, strike, kind, bid, ask, canceled)


PARITY_ROWS = [
    # 14:30: the call at 24000 prints twice; the later print (mid 105) wins. Its
    # id sorts before the earlier print's, so time decides it, not the id.
    tape_print("n09", "14:30:05", "call", 24000, 99, 101),
    tape_print("n02", "14:30:40", "call", 24000, 104, 106),
    tape_print("n03", "14:30:10", "put", 24000, 94, 96),
    # The side is the lower-cased first letter of option_type, whatever its case.
    tape_print("n04", "14:30:10", "Call", 24050, 59, 61),
    tape_print("n05", "14:30:10", "PUT", 24050, 99, 101),
    # Two prints at one instant: the later id wins, whichever was written first.
    # The call's later id (n06b, mid 25) is written second, the put's (n08, mid
    # 115) first, so neither "first of the tie" nor "last of the tie" passes.
    tape_print("n06a", "14:30:10", "call", 24100, 29, 31),
    tape_print("n06b", "14:30:10", "call", 24100, 24, 26),
    tape_print("n08", "14:30:20", "put", 24100, 114, 116),
    tape_print("n07", "14:30:20", "put", 24100, 99, 101),
    # Left out, each printed after the print it would replace: a canceled print,
    # a zero bid, a crossed quote, another expiry, an SPXW root, an NDX root.
    tape_print("x01", "14:30:55", "call", 24000, 1, 3, canceled=True),
    tape_print("x02", "14:30:50", "put", 24050, 0, 50),
    tape_print("x03", "14:30:52", "call", 24100, 30, 30),
    tape_print("x04", "14:30:58", "call", 24050, 500, 502, expiry="2026-03-27"),
    tape_print("x05", "14:30:59", "call", 24000, 700, 702, root="SPXW"),
    tape_print("x06", "14:30:57", "call", 24000, 800, 802, root="NDX"),
    # 14:31: a call with no put gives a quote but no level.
    tape_print("m01", "14:31:10", "call", 24000, 110, 112),
    # 14:32: only prints that are left out, so the minute has no quote at all.
    tape_print("y01", "14:32:10", "put", 24000, 94, 96, canceled=True),
    tape_print("y02", "14:32:11", "call", 24000, 0, 9),
    tape_print("y03", "14:32:12", "put", 24000, 94, 96, expiry="2026-03-27"),
    tape_print("y04", "14:32:13", "put", 24000, 94, 96, root="SPXW"),
]

PARITY_QUOTES = [
    (M30, 24000.0, "c", 105.0),
    (M30, 24000.0, "p", 95.0),
    (M30, 24050.0, "c", 60.0),
    (M30, 24050.0, "p", 100.0),
    (M30, 24100.0, "c", 25.0),
    (M30, 24100.0, "p", 115.0),
    (M31, 24000.0, "c", 111.0),
]


def write_parity_tape(path: Path, layout: str) -> None:
    """A tape file with the columns PARITY_SQL reads, in one of the layouts.

    The layout's numeric type (DECIMAL(18,4) in the old one) holds the strike,
    the bid and the ask, as in the real files.
    """
    ts_type, canceled_type, (no, yes), number_type = TAPE_LAYOUTS[layout]
    con = duckdb.connect()
    try:
        con.execute(
            f"""CREATE TABLE tape (id VARCHAR, option_chain_id VARCHAR,
                executed_at {ts_type}, expiry DATE, strike {number_type},
                option_type VARCHAR, nbbo_bid {number_type},
                nbbo_ask {number_type}, canceled {canceled_type})"""
        )
        offset = "+00" if ts_type == "TIMESTAMPTZ" else ""
        for (
            row_id,
            chain,
            clock,
            expiry,
            strike,
            kind,
            bid,
            ask,
            canceled,
        ) in PARITY_ROWS:
            con.execute(
                f"INSERT INTO tape VALUES ('{row_id}', '{chain}', "
                f"CAST('2026-03-26 {clock}{offset}' AS {ts_type}), "
                f"DATE '{expiry}', {strike}, '{kind}', {bid}, {ask}, "
                f"{yes if canceled else no})"
            )
        con.execute(f"COPY tape TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()


def use_local_tape(monkeypatch, tape_file: Path) -> dict:
    """Point the tape reads at a local file; the dict collects the connection kwargs."""
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    asked: dict = {}

    def local_connection(**kwargs):
        asked.update(kwargs)
        return duckdb.connect()

    monkeypatch.setattr(r2, "fulltape_connection", local_connection)
    monkeypatch.setattr(r2, "r2_url", lambda day: tape_file.as_posix())
    return asked


@pytest.mark.parametrize("layout", sorted(TAPE_LAYOUTS))
def test_fetch_parity_quotes_takes_the_last_mid_per_minute_strike_and_side(
    layout, tmp_path, monkeypatch
):
    tape_file = tmp_path / "2026-03-26-fulltape.parquet"
    write_parity_tape(tape_file, layout)
    asked = use_local_tape(monkeypatch, tape_file)

    quotes = vic.fetch_parity_quotes(PARITY_DAY)

    assert sorted(quotes) == PARITY_QUOTES
    assert M32 not in {quote[0] for quote in quotes}  # only left-out prints
    # Plain floats and ints, never Decimal: the old layout stores DECIMAL(18,4),
    # and a Decimal times the float band raises in Python.
    for minute, strike, side, mid in quotes:
        assert type(minute) is int
        assert type(strike) is float
        assert type(mid) is float
        assert side in ("c", "p")
    assert asked == {"threads": 4, "memory_limit": "3000MiB"}


@pytest.mark.parametrize("layout", sorted(TAPE_LAYOUTS))
def test_fetch_parity_levels_gives_the_level_in_every_layout(
    layout, tmp_path, monkeypatch
):
    tape_file = tmp_path / "2026-03-26-fulltape.parquet"
    write_parity_tape(tape_file, layout)
    use_local_tape(monkeypatch, tape_file)
    # 24000 + 105 - 95 = 24050 + 60 - 100 = 24100 + 25 - 115. 14:31 has a call
    # and no put, 14:32 only left-out prints: neither has a level.
    assert vic.fetch_parity_levels(PARITY_DAY) == {M30: 24010.0}


def test_the_old_decimal_layout_gives_the_same_levels_as_the_new_one(
    tmp_path, monkeypatch
):
    levels = {}
    for layout in ("naive_boolean", "tz_boolean"):
        tape_file = tmp_path / f"{layout}.parquet"
        write_parity_tape(tape_file, layout)
        use_local_tape(monkeypatch, tape_file)
        levels[layout] = vic.fetch_parity_levels(PARITY_DAY)
    assert levels["naive_boolean"] == levels["tz_boolean"] == {M30: 24010.0}


def test_fetch_parity_quotes_asks_for_the_day_and_the_ndxp_root_only(monkeypatch):
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    seen = []

    class RecordingConnection:
        def execute(self, sql):
            seen.append(" ".join(sql.split()))
            return self

        def fetchall(self):
            return []

        def close(self):
            pass

    monkeypatch.setattr(
        r2, "fulltape_connection", lambda **kwargs: RecordingConnection()
    )
    monkeypatch.setattr(r2, "r2_url", lambda day: "s3://bucket/it's.parquet")
    assert vic.fetch_parity_quotes(date(2026, 4, 6)) == []
    (sql,) = seen
    assert "expiry = DATE '2026-04-06'" in sql
    assert "LIKE 'NDXP%'" in sql
    assert "read_parquet('s3://bucket/it''s.parquet')" in sql


def test_fetch_parity_quotes_closes_the_connection_when_the_query_fails(monkeypatch):
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    conn = FailingTapeConnection()
    monkeypatch.setattr(r2, "fulltape_connection", lambda **kwargs: conn)
    monkeypatch.setattr(r2, "r2_url", lambda day: "s3://bucket/2026-03-28.parquet")
    with pytest.raises(duckdb.IOException, match="404"):
        vic.fetch_parity_quotes(date(2026, 3, 28))
    assert conn.closed


# ── main ─────────────────────────────────────────────────────────────────────

M0 = 1_000_000  # an arbitrary UTC epoch minute


def install_main_fakes(monkeypatch, candles, etf, tape):
    monkeypatch.setattr(vic, "main_checkout_dir", lambda: Path("unused-checkout"))
    monkeypatch.setattr(vic, "load_credentials", lambda path: None)
    monkeypatch.setattr(vic, "fetch_index_and_etf", lambda symbol, day: (candles, etf))
    monkeypatch.setattr(vic, "fetch_tape_spots", lambda day: tape)


def run_main(argv):
    return vic.main(["--symbol", "SPX", "--date", "2026-03-26", *argv])


def test_main_passes_a_day_that_matches_the_tape(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 + i for i in range(10)}
    tape = {M0 + i: 5800.0 + i + (0.5 if i % 2 else -0.5) for i in range(10)}
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 0
    out = capsys.readouterr().out
    assert "PASS" in out
    assert "FAIL" not in out
    assert "median" in out


def test_main_fails_a_placeholder_day_and_says_why(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 for i in range(10)}
    tape = {M0 + i: 5825.1 for i in range(10)}  # 25.1 pt away: the placeholder
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "median" in out


def test_main_fails_no_overlap_instead_of_passing_or_crashing(monkeypatch, capsys):
    install_main_fakes(monkeypatch, {M0: 5800.0}, {}, {})
    assert run_main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "no overlap" in out


def test_main_with_a_ratio_fails_a_low_share_and_prints_the_share(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 + i for i in range(10)}
    tape = dict(candles)  # the tape gate passes on its own
    etf = {M0 + i: (5800.0 + i) / 10.0 for i in range(10)}
    install_main_fakes(monkeypatch, candles, etf, tape)
    assert run_main(["--ratio", "10.0"]) == 0  # every minute is index / etf = 10
    assert "100.0%" in capsys.readouterr().out
    etf_off = {m: close * 1.001 for m, close in etf.items()}  # index / etf = 9.99
    install_main_fakes(monkeypatch, candles, etf_off, tape)
    assert run_main(["--ratio", "10.0"]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "0.0%" in out
    assert "ratio" in out


def test_main_before_cuts_off_the_minutes_from_the_cut_on(monkeypatch, capsys):
    # 2026-03-26 17:11Z. Minute before it matches; from the cut on, wildly off.
    cut = minute_of(2026, 3, 26, 17, 11)
    candles = {cut - 1: 5800.0, cut: 5800.0, cut + 1: 5800.0}
    tape = {cut - 1: 5800.5, cut: 6800.0, cut + 1: 6800.0}
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main(["--before", "17:11Z"]) == 0
    assert "compared: 1 " in capsys.readouterr().out
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 1  # without the cut the bad minutes fail the day
    assert "compared: 3 " in capsys.readouterr().out


def test_main_fails_a_tape_that_covers_only_part_of_the_candle_minutes(
    monkeypatch, capsys
):
    candles = {M0 + i: 5800.0 for i in range(10)}
    tape = {M0 + i: 5800.5 for i in range(5)}  # every compared minute is close
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "only 5 of 10 candle minutes have a tape spot" in out
    assert "median" not in out.split("FAIL", 1)[1]  # the day's figures are fine


def spiky_day():
    """100 minutes at 0.3 pt off the tape, three of them tape-lag spikes at 20 pt."""
    tape = {M0 + i: 5800.0 for i in range(100)}
    candles = {m: 5800.3 + (19.7 if m - M0 in (10, 40, 70) else 0.0) for m in tape}
    return candles, tape


def test_main_fitted_passes_a_spiky_p99_and_prints_the_note(monkeypatch, capsys):
    candles, tape = spiky_day()
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main(["--fitted"]) == 0
    out = capsys.readouterr().out
    assert "PASS" in out
    assert "FAIL" not in out
    assert "note:" in out
    assert "p99" in out.split("PASS", 1)[1]


def test_main_without_fitted_fails_the_same_spiky_day_on_p99(monkeypatch, capsys):
    candles, tape = spiky_day()
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "p99" in out.split("FAIL", 1)[1]
    assert "note:" not in out


def test_main_fitted_still_fails_a_median_over_2(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 for i in range(10)}
    tape = {M0 + i: 5802.5 for i in range(10)}  # 2.5 pt off on every minute
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main(["--fitted"]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "median" in out


def test_main_exits_2_on_a_read_failure_and_prints_no_secret(monkeypatch, capsys):
    secret_url = "postgres://user:hunter2@host/db"
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": secret_url})
    monkeypatch.setattr(vic, "main_checkout_dir", lambda: Path("unused-checkout"))
    monkeypatch.setattr(vic, "load_credentials", lambda path: None)

    def boom(symbol, day):
        raise RuntimeError(f"could not connect to {secret_url}")

    monkeypatch.setattr(vic, "fetch_index_and_etf", boom)
    monkeypatch.setattr(vic, "fetch_tape_spots", lambda day: {})
    assert run_main([]) == 2
    captured = capsys.readouterr()
    shown = captured.out + captured.err
    assert "hunter2" not in shown
    assert secret_url not in shown
    assert "RuntimeError" in shown
    assert "PASS" not in shown


def test_main_exits_2_when_the_tape_read_fails_and_prints_no_bucket_name(
    monkeypatch, capsys
):
    # A day with no tape landed: DuckDB's 404 names the s3:// URL.
    monkeypatch.setattr(os, "environ", {"R2_BUCKET_FULLTAPE": "secret-bucket-xyz"})
    install_main_fakes(monkeypatch, {M0: 5800.0}, {}, {})

    def no_tape(day):
        raise RuntimeError(
            "HTTP 404 reading s3://secret-bucket-xyz/fulltape/2026-03-28-fulltape.parquet"
        )

    monkeypatch.setattr(vic, "fetch_tape_spots", no_tape)
    assert run_main([]) == 2
    captured = capsys.readouterr()
    shown = captured.out + captured.err
    assert "secret-bucket-xyz" not in shown
    assert "s3://***/fulltape/2026-03-28-fulltape.parquet" in shown
    assert "RuntimeError" in shown
    assert "PASS" not in shown
    assert "FAIL" not in shown


def test_main_loads_the_env_file_of_the_main_checkout(monkeypatch):
    install_main_fakes(monkeypatch, {M0: 5800.0}, {}, {M0: 5800.0})
    monkeypatch.setattr(vic, "main_checkout_dir", lambda: Path("the-main-checkout"))
    loaded = []
    monkeypatch.setattr(vic, "load_credentials", lambda path: loaded.append(path))
    assert run_main([]) == 0
    assert loaded == [Path("the-main-checkout") / ".env.local"]


def test_main_exits_2_when_the_main_checkout_cannot_be_found(monkeypatch, capsys):
    def no_git(*args, **kwargs):
        raise ValueError("not a .git directory: '/srv/repo/x'")

    monkeypatch.setattr(vic, "main_checkout_dir", no_git)
    assert run_main([]) == 2
    err = capsys.readouterr().err
    assert "ValueError" in err
    assert "not a .git directory" in err


def test_main_exits_2_when_credentials_are_missing_and_names_them(monkeypatch, capsys):
    def no_credentials(path):
        raise RuntimeError("missing credentials: DATABASE_URL, R2_ENDPOINT_URL")

    monkeypatch.setattr(vic, "main_checkout_dir", lambda: Path("unused-checkout"))
    monkeypatch.setattr(vic, "load_credentials", no_credentials)
    assert run_main([]) == 2
    err = capsys.readouterr().err
    assert "DATABASE_URL" in err


def test_main_refuses_ndx_before_reading_anything(monkeypatch, capsys):
    def must_not_run(*args, **kwargs):
        raise AssertionError("read something for a refused symbol")

    monkeypatch.setattr(vic, "main_checkout_dir", must_not_run)
    monkeypatch.setattr(vic, "load_credentials", must_not_run)
    monkeypatch.setattr(vic, "fetch_index_and_etf", must_not_run)
    monkeypatch.setattr(vic, "fetch_tape_spots", must_not_run)
    with pytest.raises(SystemExit) as exit_info:
        vic.main(["--symbol", "NDX", "--date", "2026-03-26"])
    assert exit_info.value.code == 2
    assert "no NDX price" in capsys.readouterr().err


# ── main: --export-spots ─────────────────────────────────────────────────────


def install_export_fakes(monkeypatch, tape=None, parity=None):
    """Fake every read; the returned list names the reads that ran, in order."""
    calls: list[str] = []

    def reading(name, result):
        def read(*args):
            calls.append(name)
            if isinstance(result, Exception):
                raise result
            return result

        return read

    monkeypatch.setattr(vic, "main_checkout_dir", lambda: Path("the-main-checkout"))
    monkeypatch.setattr(
        vic, "load_credentials", lambda path: calls.append(f"credentials {path.name}")
    )
    monkeypatch.setattr(vic, "fetch_index_and_etf", reading("candles", {}))
    monkeypatch.setattr(vic, "fetch_tape_spots", reading("tape", tape or {}))
    monkeypatch.setattr(vic, "fetch_parity_levels", reading("parity", parity or {}))
    return calls


def run_export(symbol, out_dir, day="2026-03-26"):
    return vic.main(["--symbol", symbol, "--date", day, "--export-spots", str(out_dir)])


def test_export_spx_writes_the_tape_minutes_and_reads_no_candles(
    tmp_path, monkeypatch, capsys
):
    calls = install_export_fakes(monkeypatch, tape={M0: 5800.5, M0 + 1: 5801.0})
    assert run_export("SPX", tmp_path) == 0
    path = tmp_path / "SPX-2026-03-26-spots.json"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "symbol": "SPX",
        "date": "2026-03-26",
        "source": "tape",
        "minutes": {str(M0): 5800.5, str(M0 + 1): 5801.0},
    }
    out = capsys.readouterr().out
    assert "2 minutes" in out
    assert str(path) in out
    assert calls == ["credentials .env.local", "tape"]  # no candles, no parity


def test_export_ndx_writes_the_parity_minutes_with_source_parity(
    tmp_path, monkeypatch, capsys
):
    calls = install_export_fakes(monkeypatch, parity={M0: 24010.25})
    assert run_export("NDX", tmp_path, day="2026-10-20") == 0
    path = tmp_path / "NDX-2026-10-20-spots.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["symbol"] == "NDX"
    assert doc["date"] == "2026-10-20"
    assert doc["source"] == "parity"
    assert doc["minutes"] == {str(M0): 24010.25}
    assert "1 minutes" in capsys.readouterr().out
    assert calls == ["credentials .env.local", "parity"]


@pytest.mark.parametrize("symbol", ["SPX", "NDX"])
def test_export_with_zero_minutes_exits_2_with_the_reason_and_writes_nothing(
    symbol, tmp_path, monkeypatch, capsys
):
    install_export_fakes(monkeypatch)  # both reads give no minute
    assert run_export(symbol, tmp_path) == 2
    captured = capsys.readouterr()
    assert symbol in captured.err
    assert "no minute" in captured.err
    assert "2026-03-26" in captured.err
    assert list(tmp_path.iterdir()) == []


def test_export_with_zero_minutes_creates_no_output_directory(
    tmp_path, monkeypatch, capsys
):
    install_export_fakes(monkeypatch)
    out_dir = tmp_path / "not-yet"
    assert run_export("SPX", out_dir) == 2
    capsys.readouterr()
    assert not out_dir.exists()


def test_export_keeps_an_existing_file_and_reads_nothing(tmp_path, monkeypatch, capsys):
    calls = install_export_fakes(monkeypatch, tape={M0: 9999.0})
    path = tmp_path / "SPX-2026-03-26-spots.json"
    path.write_text('{"kept": "as written"}', encoding="utf-8")
    assert run_export("SPX", tmp_path) == 0
    assert path.read_text(encoding="utf-8") == '{"kept": "as written"}'
    assert f"kept {path}" in capsys.readouterr().out
    assert calls == []  # no credentials, no R2 read, for a file already there


def test_export_a_second_run_keeps_the_first_runs_file(tmp_path, monkeypatch, capsys):
    install_export_fakes(monkeypatch, tape={M0: 5800.5})
    assert run_export("SPX", tmp_path) == 0
    path = tmp_path / "SPX-2026-03-26-spots.json"
    first = path.read_bytes()
    capsys.readouterr()
    install_export_fakes(monkeypatch, tape={M0: 1.0, M0 + 1: 2.0})
    assert run_export("SPX", tmp_path) == 0
    assert path.read_bytes() == first
    assert f"kept {path}" in capsys.readouterr().out


def test_export_read_failure_exits_2_prints_no_secret_and_writes_nothing(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(os, "environ", {"R2_BUCKET_FULLTAPE": "secret-bucket-xyz"})
    install_export_fakes(
        monkeypatch,
        parity=RuntimeError("HTTP 404 reading s3://secret-bucket-xyz/fulltape/x"),
    )
    assert run_export("NDX", tmp_path) == 2
    captured = capsys.readouterr()
    shown = captured.out + captured.err
    assert "secret-bucket-xyz" not in shown
    assert "s3://***/fulltape/x" in shown
    assert "RuntimeError" in shown
    assert list(tmp_path.iterdir()) == []


def test_export_missing_credentials_exits_2_and_writes_nothing(
    tmp_path, monkeypatch, capsys
):
    def no_credentials(path):
        raise RuntimeError("missing credentials: R2_ENDPOINT_URL")

    install_export_fakes(monkeypatch, tape={M0: 5800.5})
    monkeypatch.setattr(vic, "load_credentials", no_credentials)
    assert run_export("SPX", tmp_path) == 2
    assert "R2_ENDPOINT_URL" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == []


def test_export_to_a_path_that_is_a_file_exits_2_and_does_not_claim_kept(
    tmp_path, monkeypatch, capsys
):
    install_export_fakes(monkeypatch, tape={M0: 5800.5})
    not_a_dir = tmp_path / "a-file"
    not_a_dir.write_text("x", encoding="utf-8")
    assert run_export("SPX", not_a_dir) == 2
    captured = capsys.readouterr()
    assert "kept" not in captured.out
    assert "error:" in captured.err
    assert not_a_dir.read_text(encoding="utf-8") == "x"
