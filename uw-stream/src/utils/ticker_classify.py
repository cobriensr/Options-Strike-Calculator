"""Static ticker → issue_type lookup.

UW's REST flow-alerts endpoint accepts an `issue_types[]` filter and
echoes the type back on each row. The websocket `flow-alerts` channel
does NOT include `issue_type` in the payload, so we recover it here
via a hardcoded lookup.

The classification matches what UW's REST API would return for these
tickers — confirmed against the existing cron at
`api/cron/fetch-flow-alerts.ts` which filters `issue_types[]=Index`
for SPXW.

Anything not in the known sets falls through to "Common Stock". This
is the right default for the long tail of single-name tickers — UW's
own REST API uses the same default.
"""

from __future__ import annotations

# Cash-settled equity indices. SPX/SPXW/NDX/RUT cover what we trade;
# the others (DJX, XSP, XEO, OEX, NDXP, VIX, VIXW) are listed for
# completeness so the daemon doesn't misclassify them if UW fires for
# any of them in the future.
_INDEX_TICKERS: frozenset[str] = frozenset(
    {
        "SPX",
        "SPXW",
        "NDX",
        "NDXP",
        "RUT",
        "RUTW",
        "DJX",
        "XSP",
        "XEO",
        "OEX",
        "VIX",
        "VIXW",
    }
)


# Major listed ETFs. List is intentionally conservative — broad-market,
# sector SPDRs, popular leveraged products, and flow-heavy thematic
# funds. Single-name and small-cap ETFs fall through to "Common Stock"
# which is harmless.
_ETF_TICKERS: frozenset[str] = frozenset(
    {
        # Broad market
        "SPY",
        "QQQ",
        "IWM",
        "DIA",
        "VTI",
        "VOO",
        "VEA",
        "VWO",
        "EEM",
        "EFA",
        "EWJ",
        "EWZ",
        "FXI",
        "MCHI",
        # SPDR sectors
        "XLB",
        "XLC",
        "XLE",
        "XLF",
        "XLI",
        "XLK",
        "XLP",
        "XLRE",
        "XLU",
        "XLV",
        "XLY",
        # Real estate / financials sub
        "IYR",
        "KBE",
        "KRE",
        # Commodities
        "GLD",
        "SLV",
        "USO",
        "UNG",
        "DBA",
        "DBC",
        "PDBC",
        # Bonds
        "TLT",
        "IEF",
        "SHY",
        "AGG",
        "BND",
        "LQD",
        "HYG",
        "JNK",
        "TIP",
        # Vol / hedging
        "UVXY",
        "VXX",
        "VIXY",
        "SVXY",
        # Leveraged equity
        "TQQQ",
        "SQQQ",
        "SPXL",
        "SPXS",
        "SPXU",
        "TZA",
        "TNA",
        "UPRO",
        "SOXL",
        "SOXS",
        "TMF",
        "TMV",
        # Thematic / popular
        "ARKK",
        "ARKF",
        "ARKG",
        "ARKQ",
        "ARKW",
        "JETS",
        "XBI",
        "IBB",
        "SMH",
        "SOXX",
        "KWEB",
        "GDX",
        "GDXJ",
        "EWY",
        "EWT",
        "INDA",
        "ITB",
        "XHB",
        "XOP",
        "OIH",
        "BITO",
        "FXE",
        "UUP",
    }
)


def classify(ticker: str) -> str:
    """Return the UW-style issue_type for a ticker.

    Matches values UW's REST API would emit: "Index", "ETF", or
    "Common Stock". The check is case-insensitive on input but always
    returns the canonical capitalization.
    """
    if not ticker:
        return "Common Stock"
    upper = ticker.strip().upper()
    if upper in _INDEX_TICKERS:
        return "Index"
    if upper in _ETF_TICKERS:
        return "ETF"
    return "Common Stock"
