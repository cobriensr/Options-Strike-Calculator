"""Tests for symbol_manager — contract roll logic and ES options strikes."""

from datetime import date

import pytest

from symbol_manager import (
    DATASET_CME,
    DATASET_IFUS,
    DATASET_XCBF,
    ES_RECENTER_THRESHOLD,
    ES_STRIKE_SPACING,
    ES_STRIKES_EACH_SIDE,
    OptionsStrikeSet,
    build_es_option_symbols,
    compute_atm_strikes,
    get_all_futures_subscriptions,
    get_nearest_es_expiry,
    third_friday,
)


# ---------------------------------------------------------------------------
# compute_atm_strikes
# ---------------------------------------------------------------------------


class TestComputeAtmStrikes:
    def test_returns_21_strikes(self):
        strikes = compute_atm_strikes(5850.0)
        assert len(strikes) == 2 * ES_STRIKES_EACH_SIDE + 1  # 21

    def test_spacing_is_5(self):
        strikes = compute_atm_strikes(5850.0)
        for i in range(1, len(strikes)):
            assert strikes[i] - strikes[i - 1] == ES_STRIKE_SPACING

    def test_sorted_ascending(self):
        strikes = compute_atm_strikes(5850.0)
        assert strikes == sorted(strikes)

    def test_exact_multiple_of_5(self):
        """Price already on a 5-point boundary centers correctly."""
        strikes = compute_atm_strikes(5850.0)
        mid = strikes[ES_STRIKES_EACH_SIDE]
        assert mid == pytest.approx(5850.0)

    def test_rounds_down_to_nearest_5(self):
        """5847.3 rounds to 5845."""
        strikes = compute_atm_strikes(5847.3)
        mid = strikes[ES_STRIKES_EACH_SIDE]
        assert mid == pytest.approx(5845.0)

    def test_rounds_up_to_nearest_5(self):
        """5852.6 rounds to 5855."""
        strikes = compute_atm_strikes(5852.6)
        mid = strikes[ES_STRIKES_EACH_SIDE]
        assert mid == pytest.approx(5855.0)

    def test_midpoint_rounds_up(self):
        """5852.5 is equidistant; Python rounds to even, so 5852.5/5=1170.5 -> 1170 -> 5850."""
        strikes = compute_atm_strikes(5852.5)
        mid = strikes[ES_STRIKES_EACH_SIDE]
        assert mid == pytest.approx(5850.0)

    def test_lowest_and_highest_strikes(self):
        strikes = compute_atm_strikes(5850.0)
        assert strikes[0] == pytest.approx(5850.0 - ES_STRIKES_EACH_SIDE * ES_STRIKE_SPACING)
        assert strikes[-1] == pytest.approx(5850.0 + ES_STRIKES_EACH_SIDE * ES_STRIKE_SPACING)

    def test_all_values_are_multiples_of_5(self):
        strikes = compute_atm_strikes(5847.3)
        for s in strikes:
            assert s % ES_STRIKE_SPACING == 0


# ---------------------------------------------------------------------------
# OptionsStrikeSet
# ---------------------------------------------------------------------------


class TestOptionsStrikeSet:
    def test_all_symbols_combines_calls_and_puts(self):
        oss = OptionsStrikeSet(
            call_symbols=["ESM5 C5850", "ESM5 C5855"],
            put_symbols=["ESM5 P5850", "ESM5 P5855"],
        )
        assert oss.all_symbols == [
            "ESM5 C5850",
            "ESM5 C5855",
            "ESM5 P5850",
            "ESM5 P5855",
        ]

    def test_all_symbols_empty_when_no_symbols(self):
        oss = OptionsStrikeSet()
        assert oss.all_symbols == []

    def test_needs_recenter_true_when_center_is_zero(self):
        """Default center_price is 0.0 -- always needs recentering."""
        oss = OptionsStrikeSet()
        assert oss.needs_recenter(5850.0) is True

    def test_needs_recenter_false_within_threshold(self):
        oss = OptionsStrikeSet(center_price=5850.0)
        assert oss.needs_recenter(5850.0) is False
        assert oss.needs_recenter(5849.0) is False
        assert oss.needs_recenter(5899.0) is False  # 49 pts away
        assert oss.needs_recenter(5801.0) is False  # 49 pts away

    def test_needs_recenter_true_at_threshold(self):
        """Exactly ES_RECENTER_THRESHOLD (50 pts) triggers recenter."""
        oss = OptionsStrikeSet(center_price=5850.0)
        assert oss.needs_recenter(5850.0 + ES_RECENTER_THRESHOLD) is True
        assert oss.needs_recenter(5850.0 - ES_RECENTER_THRESHOLD) is True

    def test_needs_recenter_true_beyond_threshold(self):
        oss = OptionsStrikeSet(center_price=5850.0)
        assert oss.needs_recenter(5920.0) is True
        assert oss.needs_recenter(5780.0) is True

    def test_defaults(self):
        oss = OptionsStrikeSet()
        assert oss.center_price == pytest.approx(0.0)
        assert oss.strikes == []
        assert oss.call_symbols == []
        assert oss.put_symbols == []
        assert oss.nearest_expiry is None


# ---------------------------------------------------------------------------
# build_es_option_symbols
# ---------------------------------------------------------------------------


class TestBuildEsOptionSymbols:
    def test_june_2025_prefix(self):
        """June 2025 -> month code M, year digit 5 -> ESM5."""
        strikes = [5850.0, 5855.0]
        calls, puts = build_es_option_symbols(strikes, date(2025, 6, 20))
        assert calls == ["ESM5 C5850", "ESM5 C5855"]
        assert puts == ["ESM5 P5850", "ESM5 P5855"]

    def test_march_2026_prefix(self):
        """March 2026 -> month code H, year digit 6 -> ESH6."""
        strikes = [5900.0]
        calls, puts = build_es_option_symbols(strikes, date(2026, 3, 20))
        assert calls == ["ESH6 C5900"]
        assert puts == ["ESH6 P5900"]

    def test_december_2025_prefix(self):
        """December 2025 -> month code Z, year digit 5 -> ESZ5."""
        strikes = [6000.0, 6005.0, 6010.0]
        calls, puts = build_es_option_symbols(strikes, date(2025, 12, 19))
        assert all(c.startswith("ESZ5 C") for c in calls)
        assert all(p.startswith("ESZ5 P") for p in puts)

    def test_september_2030_year_digit_wraps(self):
        """Year 2030 -> year digit 0 -> ESU0."""
        calls, puts = build_es_option_symbols([5500.0], date(2030, 9, 20))
        assert calls == ["ESU0 C5500"]
        assert puts == ["ESU0 P5500"]

    def test_returns_same_length(self):
        strikes = compute_atm_strikes(5850.0)
        calls, puts = build_es_option_symbols(strikes, date(2025, 6, 20))
        assert len(calls) == len(strikes)
        assert len(puts) == len(strikes)

    def test_empty_strikes(self):
        calls, puts = build_es_option_symbols([], date(2025, 6, 20))
        assert calls == []
        assert puts == []


# ---------------------------------------------------------------------------
# third_friday
# ---------------------------------------------------------------------------


class TestThirdFriday:
    @pytest.mark.parametrize(
        "year, month, expected",
        [
            (2025, 3, date(2025, 3, 21)),
            (2025, 6, date(2025, 6, 20)),
            (2025, 9, date(2025, 9, 19)),
            (2025, 12, date(2025, 12, 19)),
            (2026, 3, date(2026, 3, 20)),
            (2026, 6, date(2026, 6, 19)),
        ],
    )
    def test_known_dates(self, year, month, expected):
        assert third_friday(year, month) == expected

    def test_always_a_friday(self):
        """Third Friday must always be weekday 4 (Friday)."""
        for year in (2025, 2026, 2027):
            for month in range(1, 13):
                result = third_friday(year, month)
                assert result.weekday() == 4, (
                    f"{result} is not a Friday (weekday={result.weekday()})"
                )

    def test_always_between_15th_and_21st(self):
        """Third Friday of any month must fall between the 15th and 21st."""
        for year in (2025, 2026, 2027):
            for month in range(1, 13):
                result = third_friday(year, month)
                assert 15 <= result.day <= 21, (
                    f"{result} day {result.day} not in [15, 21]"
                )


# ---------------------------------------------------------------------------
# get_nearest_es_expiry
# ---------------------------------------------------------------------------


class TestGetNearestEsExpiry:
    def test_before_march_returns_march(self):
        result = get_nearest_es_expiry(date(2025, 1, 10))
        assert result == third_friday(2025, 3)

    def test_on_expiry_day_returns_that_day(self):
        """On expiry day itself, it's still >= now, so return it."""
        mar_exp = third_friday(2025, 3)
        result = get_nearest_es_expiry(mar_exp)
        assert result == mar_exp

    def test_day_after_march_expiry_returns_june(self):
        mar_exp = third_friday(2025, 3)
        next_day = date(mar_exp.year, mar_exp.month, mar_exp.day + 1)
        result = get_nearest_es_expiry(next_day)
        assert result == third_friday(2025, 6)

    def test_between_june_and_september(self):
        result = get_nearest_es_expiry(date(2025, 7, 1))
        assert result == third_friday(2025, 9)

    def test_after_december_returns_next_year_march(self):
        """November 2025 -> past Sep expiry, before Dec expiry -> Dec 2025."""
        dec_exp = third_friday(2025, 12)
        # Use a date after Dec expiry to force year boundary
        result = get_nearest_es_expiry(
            date(dec_exp.year, dec_exp.month, dec_exp.day + 1)
        )
        assert result == third_friday(2026, 3)

    def test_november_before_dec_expiry(self):
        """November 2025 is between Sep and Dec expiries -> returns Dec."""
        result = get_nearest_es_expiry(date(2025, 11, 1))
        assert result == third_friday(2025, 12)

    def test_returns_quarterly_only(self):
        """Result month must be in QUARTERLY_MONTHS."""
        for month in range(1, 13):
            result = get_nearest_es_expiry(date(2025, month, 1))
            assert result.month in (3, 6, 9, 12)


# ---------------------------------------------------------------------------
# get_all_futures_subscriptions
# ---------------------------------------------------------------------------


class TestGetAllFuturesSubscriptions:
    def test_returns_exactly_9_symbols(self):
        subs = get_all_futures_subscriptions()
        assert len(subs) == 9

    def test_expected_keys(self):
        subs = get_all_futures_subscriptions()
        expected = {"ES", "NQ", "ZN", "RTY", "CL", "GC", "VX1", "VX2", "DX"}
        assert set(subs.keys()) == expected

    def test_each_entry_has_required_fields(self):
        subs = get_all_futures_subscriptions()
        for sym, config in subs.items():
            assert "parent_symbol" in config, f"{sym} missing parent_symbol"
            assert "dataset" in config, f"{sym} missing dataset"
            assert "db_symbol" in config, f"{sym} missing db_symbol"

    def test_cme_symbols_use_glbx_dataset(self):
        subs = get_all_futures_subscriptions()
        cme_syms = ["ES", "NQ", "ZN", "RTY", "CL", "GC"]
        for sym in cme_syms:
            assert subs[sym]["dataset"] == DATASET_CME

    def test_vx_symbols_use_xcbf_dataset(self):
        subs = get_all_futures_subscriptions()
        assert subs["VX1"]["dataset"] == DATASET_XCBF
        assert subs["VX2"]["dataset"] == DATASET_XCBF

    def test_dx_uses_ifus_dataset(self):
        subs = get_all_futures_subscriptions()
        assert subs["DX"]["dataset"] == DATASET_IFUS

    def test_parent_symbols_follow_convention(self):
        subs = get_all_futures_subscriptions()
        # CME products end in .FUT
        for sym in ("ES", "NQ", "ZN", "RTY", "CL", "GC"):
            assert subs[sym]["parent_symbol"].endswith(".FUT")
        # VX second month uses .FUT.1
        assert subs["VX1"]["parent_symbol"] == "VX.FUT"
        assert subs["VX2"]["parent_symbol"] == "VX.FUT.1"
        assert subs["DX"]["parent_symbol"] == "DX.FUT"

    def test_db_symbols_match_keys(self):
        subs = get_all_futures_subscriptions()
        for sym, config in subs.items():
            assert config["db_symbol"] == sym
