"""Unit tests for OCC option-symbol parsing."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from utils.occ_parser import parse


class TestParseValid:
    def test_spxw_call(self):
        r = parse("SPXW260502C05900000")
        assert r.root == "SPXW"
        assert r.expiry == date(2026, 5, 2)
        assert r.option_type == "C"
        assert r.strike == Decimal("5900.000")

    def test_dia_call(self):
        r = parse("DIA241018C00415000")
        assert r.root == "DIA"
        assert r.expiry == date(2024, 10, 18)
        assert r.option_type == "C"
        assert r.strike == Decimal("415.000")

    def test_spy_put(self):
        r = parse("SPY261019P00415000")
        assert r.root == "SPY"
        assert r.expiry == date(2026, 10, 19)
        assert r.option_type == "P"
        assert r.strike == Decimal("415.000")

    def test_wmt_put_short_root(self):
        r = parse("WMT260501P00126000")
        assert r.root == "WMT"
        assert r.expiry == date(2026, 5, 1)
        assert r.option_type == "P"
        assert r.strike == Decimal("126.000")

    def test_strike_with_decimal_thousandths(self):
        # 12.500 strike → "00012500" (5 dollar digits, 3 thousandths)
        r = parse("ABC260101C00012500")
        assert r.strike == Decimal("12.500")

    def test_six_char_root(self):
        # SPXW + 1 = max 6-char roots; UW lists some.
        r = parse("ABCDEF260101C05900000")
        assert r.root == "ABCDEF"


class TestParseInvalid:
    def test_too_short(self):
        with pytest.raises(ValueError, match="too short"):
            parse("SPY")

    def test_empty(self):
        with pytest.raises(ValueError, match="too short"):
            parse("")

    def test_non_string(self):
        with pytest.raises(ValueError, match="must be a string"):
            parse(12345)  # type: ignore[arg-type]

    def test_bad_option_type(self):
        # 'X' instead of C/P
        with pytest.raises(ValueError, match="option_type"):
            parse("SPY261019X00415000")

    def test_non_digit_date(self):
        with pytest.raises(ValueError, match="not all digits"):
            parse("SPYAA1019C00415000")

    def test_non_digit_strike(self):
        with pytest.raises(ValueError, match="not all digits"):
            parse("SPY261019C0041500X")

    def test_invalid_calendar_date(self):
        # Month 13 doesn't exist
        with pytest.raises(ValueError, match="OCC date invalid"):
            parse("SPY261301C00415000")

    def test_empty_root(self):
        # 15 chars (no root) is below the 16-char minimum for any valid
        # OCC symbol, so it gets caught by the length check.
        with pytest.raises(ValueError, match="too short"):
            parse("261019C00415000")
