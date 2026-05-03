"""Unit tests for the ticker → issue_type lookup."""

from __future__ import annotations

import pytest

from utils.ticker_classify import classify


class TestIndices:
    @pytest.mark.parametrize("ticker", ["SPX", "SPXW", "NDX", "RUT", "VIX"])
    def test_known_indices(self, ticker):
        assert classify(ticker) == "Index"


class TestEtfs:
    @pytest.mark.parametrize("ticker", ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT"])
    def test_known_etfs(self, ticker):
        assert classify(ticker) == "ETF"

    def test_leveraged_etf(self):
        assert classify("TQQQ") == "ETF"

    def test_thematic_etf(self):
        assert classify("ARKK") == "ETF"


class TestCommonStock:
    @pytest.mark.parametrize("ticker", ["AAPL", "MSFT", "TSLA", "NVDA", "WMT"])
    def test_single_names(self, ticker):
        assert classify(ticker) == "Common Stock"

    def test_unknown_ticker_falls_through(self):
        assert classify("ZZZZ") == "Common Stock"


class TestEdgeCases:
    def test_empty_string(self):
        assert classify("") == "Common Stock"

    def test_whitespace_trimmed(self):
        assert classify("  SPY  ") == "ETF"

    def test_lowercase_normalized(self):
        assert classify("spy") == "ETF"
        assert classify("spxw") == "Index"

    def test_mixed_case(self):
        assert classify("Spy") == "ETF"
