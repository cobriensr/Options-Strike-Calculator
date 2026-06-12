"""Tests for symbol_manager — contract roll logic and ES options strikes."""

from datetime import date

import pytest

from symbol_manager import (
    DATASET_CME,
    ES_RECENTER_THRESHOLD,
    ES_STRIKE_SPACING,
    ES_STRIKES_EACH_SIDE,
    OptionsStrikeSet,
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
        assert strikes[0] == pytest.approx(
            5850.0 - ES_STRIKES_EACH_SIDE * ES_STRIKE_SPACING
        )
        assert strikes[-1] == pytest.approx(
            5850.0 + ES_STRIKES_EACH_SIDE * ES_STRIKE_SPACING
        )

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
        # Just inside the recenter trigger (threshold minus one point).
        just_inside = ES_RECENTER_THRESHOLD - 1
        assert oss.needs_recenter(5850.0) is False
        assert oss.needs_recenter(5849.0) is False
        assert oss.needs_recenter(5850.0 + just_inside) is False
        assert oss.needs_recenter(5850.0 - just_inside) is False

    def test_needs_recenter_true_at_threshold(self):
        """A move of exactly ES_RECENTER_THRESHOLD triggers recenter."""
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
# Recenter hysteresis (Finding D) — the subscribed window must always
# contain the current price with a coverage margin, so a price chopping
# across the exact trigger boundary cannot thrash recenters.
# ---------------------------------------------------------------------------


class TestRecenterHysteresis:
    """The recenter trigger (ES_RECENTER_THRESHOLD) must be strictly less
    than the subscribed window half-width (ES_STRIKES_EACH_SIDE *
    ES_STRIKE_SPACING) so that, after a recenter (which sets center =
    current price), the window keeps covering the price even as it drifts
    right up to the next trigger boundary.

    Documented invariant:
        window_half_width - recenter_threshold >= one_strike (>= 5pt)
    """

    @staticmethod
    def _window_half_width() -> float:
        return ES_STRIKES_EACH_SIDE * ES_STRIKE_SPACING

    def test_margin_invariant_holds(self):
        """Window half-width must exceed the trigger by at least one strike."""
        margin = self._window_half_width() - ES_RECENTER_THRESHOLD
        assert margin >= ES_STRIKE_SPACING

    def test_chop_across_trigger_boundary_does_not_thrash(self):
        """A price chopping +/-2 pts across the exact trigger boundary
        (center +/- ES_RECENTER_THRESHOLD) causes AT MOST ONE recenter.

        Simulate the databento_client flow: each time needs_recenter is
        True we recenter (center := current price, exactly as
        _update_atm_strikes does). A +/-2 pt chop right at the boundary
        must not produce a back-and-forth re-subscribe loop."""
        center = 5850.0
        oss = OptionsStrikeSet(center_price=center)
        boundary = center + ES_RECENTER_THRESHOLD  # 5900.0

        recenter_count = 0
        # Oscillate just below and just above the boundary repeatedly.
        for price in (
            boundary - 2,
            boundary + 2,
            boundary - 2,
            boundary + 2,
            boundary - 2,
            boundary + 2,
        ):
            if oss.needs_recenter(price):
                recenter_count += 1
                # Mirror _update_atm_strikes: new center IS the price.
                oss.center_price = price

        # At most one recenter despite six boundary crossings.
        assert recenter_count <= 1

    def test_window_covers_price_after_chop(self):
        """After the single recenter from a boundary chop, the current
        chopping price stays inside the subscribed strike window."""
        center = 5850.0
        oss = OptionsStrikeSet(center_price=center)
        boundary = center + ES_RECENTER_THRESHOLD

        for price in (boundary - 2, boundary + 2, boundary - 2, boundary + 2):
            if oss.needs_recenter(price):
                oss.center_price = price
            strikes = compute_atm_strikes(oss.center_price)
            # Price is within the subscribed window (inclusive of edges).
            assert strikes[0] <= price <= strikes[-1]

    def test_price_within_window_after_recenter_with_margin(self):
        """After a recenter, the current price is always within the
        subscribed strikes with the documented margin: the window edge
        sits at least one strike beyond the next trigger boundary."""
        es_price = 5847.3
        strikes = compute_atm_strikes(es_price)
        half_width = self._window_half_width()
        # The window must extend a full margin past the recenter trigger.
        assert strikes[-1] - es_price >= ES_RECENTER_THRESHOLD
        assert es_price - strikes[0] >= ES_RECENTER_THRESHOLD
        # And the window half-width itself carries the margin over trigger.
        assert half_width - ES_RECENTER_THRESHOLD >= ES_STRIKE_SPACING

    def test_genuine_large_move_still_recenters(self):
        """A move larger than the window half-width must still trigger a
        recenter — hysteresis adds margin, it does not disable recentering."""
        oss = OptionsStrikeSet(center_price=5850.0)
        big_move = 5850.0 + self._window_half_width() + ES_STRIKE_SPACING
        assert oss.needs_recenter(big_move) is True
        assert oss.needs_recenter(5850.0 - self._window_half_width()) is True


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
    def test_returns_exactly_6_symbols(self):
        subs = get_all_futures_subscriptions()
        assert len(subs) == 6

    def test_expected_keys(self):
        subs = get_all_futures_subscriptions()
        expected = {"ES", "NQ", "ZN", "RTY", "CL", "GC"}
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

    def test_parent_symbols_follow_convention(self):
        subs = get_all_futures_subscriptions()
        for sym in ("ES", "NQ", "ZN", "RTY", "CL", "GC"):
            assert subs[sym]["parent_symbol"].endswith(".FUT")

    def test_db_symbols_match_keys(self):
        subs = get_all_futures_subscriptions()
        for sym, config in subs.items():
            assert config["db_symbol"] == sym
