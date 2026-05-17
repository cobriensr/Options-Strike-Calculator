"""Tests for multileg_assembler — pattern matcher for UW Full Tape trades.

These are PURE-COMPUTATION tests with synthetic polars DataFrames built
inline. No parquet, no database, no I/O.

The matcher classifies trade groups (within a rolling time window per
underlying) as one of:
    vertical | strangle | risk_reversal | butterfly | isolated_leg

See docs/tmp/fulltape-tag-stratification-and-multileg-2026-05-07.md for
the motivating analysis (76% of $1M+ "whales" are spread legs).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import polars as pl

from multileg_assembler import classify_trades

# ── Fixture helpers ─────────────────────────────────────────────────────────

BASE_TIME = datetime(2026, 5, 16, 14, 30, 0, tzinfo=UTC)
EXP_NEAR = date(2026, 5, 23)
EXP_FAR = date(2026, 6, 20)


def _trade(
    *,
    trade_id: str,
    ticker: str = "SPY",
    offset_s: float = 0.0,
    chain_id: str | None = None,
    strike: float = 200.0,
    expiry: date = EXP_NEAR,
    option_type: str = "call",
    size: int = 10,
    price: float = 1.50,
    nbbo_bid: float = 1.45,
    nbbo_ask: float = 1.55,
    delta: float | None = None,
) -> dict[str, object]:
    """Build a single trade row dict for inline DataFrame construction."""
    if chain_id is None:
        # Default: chain_id encodes (ticker, expiry, strike, type) — same
        # contract collapses to same id.
        chain_id = f"{ticker}-{expiry.isoformat()}-{strike}-{option_type}"
    if delta is None:
        delta = 0.5 if option_type == "call" else -0.5
    executed_at = BASE_TIME + timedelta(seconds=offset_s)
    return {
        "id": trade_id,
        "underlying_symbol": ticker,
        "executed_at": executed_at,
        "option_chain_id": chain_id,
        "strike": float(strike),
        "expiry": expiry,
        "option_type": option_type,
        "size": int(size),
        "price": float(price),
        "nbbo_bid": float(nbbo_bid),
        "nbbo_ask": float(nbbo_ask),
        "premium": float(price) * float(size) * 100.0,
        "delta": float(delta),
    }


def _df(rows: list[dict[str, object]]) -> pl.DataFrame:
    return pl.DataFrame(rows)


# ── Vertical spread ─────────────────────────────────────────────────────────


def test_vertical_matches() -> None:
    """2 calls, same expiry, $190C buy + $200C sell within 60s → vertical."""
    rows = [
        _trade(
            trade_id="t1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            size=10,
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,  # price >= ask → buy
        ),
        _trade(
            trade_id="t2",
            offset_s=30.0,
            strike=200.0,
            option_type="call",
            size=10,
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,  # price <= bid → sell
        ),
    ]
    out = classify_trades(_df(rows))

    structures = set(out["inferred_structure"].to_list())
    assert structures == {"vertical"}, f"expected only vertical, got {structures}"
    assert all(c > 0.7 for c in out["match_confidence"].to_list())
    assert all(not iso for iso in out["is_isolated_leg"].to_list())
    # Both rows share a pattern_group_id
    gids = out["pattern_group_id"].to_list()
    assert gids[0] == gids[1]


# ── Strangle ───────────────────────────────────────────────────────────────


def test_strangle_matches() -> None:
    """OTM call + OTM put, same expiry, both buys → strangle."""
    rows = [
        _trade(
            trade_id="s1",
            offset_s=0.0,
            strike=210.0,
            option_type="call",
            size=20,
            price=0.80,
            nbbo_bid=0.70,
            nbbo_ask=0.80,  # buy
        ),
        _trade(
            trade_id="s2",
            offset_s=15.0,
            strike=190.0,
            option_type="put",
            size=20,
            price=0.75,
            nbbo_bid=0.65,
            nbbo_ask=0.75,  # buy
        ),
    ]
    out = classify_trades(_df(rows))

    structures = set(out["inferred_structure"].to_list())
    assert structures == {"strangle"}, f"got {structures}"
    assert all(c > 0.5 for c in out["match_confidence"].to_list())


# ── Risk reversal ──────────────────────────────────────────────────────────


def test_risk_reversal_matches() -> None:
    """OTM put buy + OTM call sell, same expiry → risk_reversal."""
    rows = [
        _trade(
            trade_id="r1",
            offset_s=0.0,
            strike=190.0,
            option_type="put",
            size=15,
            price=0.90,
            nbbo_bid=0.80,
            nbbo_ask=0.90,  # buy
        ),
        _trade(
            trade_id="r2",
            offset_s=10.0,
            strike=210.0,
            option_type="call",
            size=15,
            price=0.85,
            nbbo_bid=0.85,
            nbbo_ask=0.95,  # sell
        ),
    ]
    out = classify_trades(_df(rows))

    structures = set(out["inferred_structure"].to_list())
    assert structures == {"risk_reversal"}, f"got {structures}"


# ── Butterfly ──────────────────────────────────────────────────────────────


def test_butterfly_matches() -> None:
    """3 calls $190/$200/$210, sizes 10/20/10, body opposite wings."""
    rows = [
        _trade(
            trade_id="b1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            size=10,
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,  # buy wing
        ),
        _trade(
            trade_id="b2",
            offset_s=5.0,
            strike=200.0,
            option_type="call",
            size=20,
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,  # sell body
        ),
        _trade(
            trade_id="b3",
            offset_s=10.0,
            strike=210.0,
            option_type="call",
            size=10,
            price=1.50,
            nbbo_bid=1.40,
            nbbo_ask=1.50,  # buy wing
        ),
    ]
    out = classify_trades(_df(rows))

    structures = set(out["inferred_structure"].to_list())
    assert structures == {"butterfly"}, f"got {structures}"
    assert all(c > 0.7 for c in out["match_confidence"].to_list())
    # All three share a group id
    gids = out["pattern_group_id"].to_list()
    assert gids[0] == gids[1] == gids[2]


# ── Isolated trades ────────────────────────────────────────────────────────


def test_isolated_call_no_match() -> None:
    """Single call trade → isolated_leg, confidence = 0."""
    rows = [
        _trade(trade_id="iso1", strike=200.0, option_type="call"),
    ]
    out = classify_trades(_df(rows))

    assert out["inferred_structure"].to_list() == ["isolated_leg"]
    assert out["match_confidence"].to_list() == [0.0]
    assert out["is_isolated_leg"].to_list() == [True]


def test_two_unrelated_trades_no_match() -> None:
    """$190C buy + $250C buy 30 days apart (different expiries) → isolated."""
    rows = [
        _trade(
            trade_id="u1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            expiry=EXP_NEAR,
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="u2",
            offset_s=20.0,
            strike=250.0,
            option_type="call",
            expiry=EXP_FAR,
            price=0.20,
            nbbo_bid=0.10,
            nbbo_ask=0.20,
        ),
    ]
    out = classify_trades(_df(rows))

    assert all(s == "isolated_leg" for s in out["inferred_structure"].to_list())
    assert all(iso for iso in out["is_isolated_leg"].to_list())


# ── Window boundary ───────────────────────────────────────────────────────


def test_window_boundary_89s_matches() -> None:
    """Two trades 89s apart (within 90s default window) → match."""
    rows = [
        _trade(
            trade_id="w1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,  # buy
        ),
        _trade(
            trade_id="w2",
            offset_s=89.0,
            strike=200.0,
            option_type="call",
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,  # sell
        ),
    ]
    out = classify_trades(_df(rows), window_seconds=90)

    assert set(out["inferred_structure"].to_list()) == {"vertical"}


def test_window_boundary_91s_no_match() -> None:
    """Two trades 91s apart (outside 90s window) → isolated."""
    rows = [
        _trade(
            trade_id="w1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="w2",
            offset_s=91.0,
            strike=200.0,
            option_type="call",
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,
        ),
    ]
    out = classify_trades(_df(rows), window_seconds=90)

    assert all(s == "isolated_leg" for s in out["inferred_structure"].to_list())


# ── Mid trades ────────────────────────────────────────────────────────────


def test_mid_trade_compatible() -> None:
    """Vertical where one leg traded at mid → still matches (mid is ambiguous)."""
    rows = [
        _trade(
            trade_id="m1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            price=10.95,  # mid
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="m2",
            offset_s=20.0,
            strike=200.0,
            option_type="call",
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,  # sell
        ),
    ]
    out = classify_trades(_df(rows))

    structures = set(out["inferred_structure"].to_list())
    assert "vertical" in structures, f"expected vertical, got {structures}"


# ── Butterfly tolerances ──────────────────────────────────────────────────


def test_butterfly_size_tolerance() -> None:
    """Body=20, wings=10/11 → still butterfly (within size_tolerance=0.1)."""
    rows = [
        _trade(
            trade_id="bt1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            size=10,
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="bt2",
            offset_s=5.0,
            strike=200.0,
            option_type="call",
            size=20,
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,
        ),
        _trade(
            trade_id="bt3",
            offset_s=10.0,
            strike=210.0,
            option_type="call",
            size=11,
            price=1.50,
            nbbo_bid=1.40,
            nbbo_ask=1.50,
        ),
    ]
    out = classify_trades(_df(rows), size_tolerance=0.1)

    assert set(out["inferred_structure"].to_list()) == {"butterfly"}


def test_butterfly_unequal_strikes_no_match() -> None:
    """Strikes 190/195/210 (not equidistant) → no butterfly."""
    rows = [
        _trade(
            trade_id="u1",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            size=10,
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="u2",
            offset_s=5.0,
            strike=195.0,
            option_type="call",
            size=20,
            price=7.00,
            nbbo_bid=7.00,
            nbbo_ask=7.10,
        ),
        _trade(
            trade_id="u3",
            offset_s=10.0,
            strike=210.0,
            option_type="call",
            size=10,
            price=1.50,
            nbbo_bid=1.40,
            nbbo_ask=1.50,
        ),
    ]
    out = classify_trades(_df(rows))

    structures = set(out["inferred_structure"].to_list())
    assert "butterfly" not in structures


# ── Edge cases ────────────────────────────────────────────────────────────


def test_empty_dataframe_returns_empty_with_columns() -> None:
    """Empty input → empty output with the new columns present."""
    empty = pl.DataFrame(
        {
            "id": [],
            "underlying_symbol": [],
            "executed_at": [],
            "option_chain_id": [],
            "strike": [],
            "expiry": [],
            "option_type": [],
            "size": [],
            "price": [],
            "nbbo_bid": [],
            "nbbo_ask": [],
        },
        schema={
            "id": pl.Utf8,
            "underlying_symbol": pl.Utf8,
            "executed_at": pl.Datetime(time_zone="UTC"),
            "option_chain_id": pl.Utf8,
            "strike": pl.Float64,
            "expiry": pl.Date,
            "option_type": pl.Utf8,
            "size": pl.Int64,
            "price": pl.Float64,
            "nbbo_bid": pl.Float64,
            "nbbo_ask": pl.Float64,
        },
    )
    out = classify_trades(empty)

    assert out.height == 0
    assert "inferred_structure" in out.columns
    assert "match_confidence" in out.columns
    assert "is_isolated_leg" in out.columns
    assert "pattern_group_id" in out.columns


def test_pattern_group_id_unique_per_group() -> None:
    """Two independent verticals on different tickers → different group ids."""
    rows = [
        # Vertical on SPY
        _trade(
            trade_id="a1",
            ticker="SPY",
            offset_s=0.0,
            strike=190.0,
            option_type="call",
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="a2",
            ticker="SPY",
            offset_s=10.0,
            strike=200.0,
            option_type="call",
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,
        ),
        # Vertical on QQQ
        _trade(
            trade_id="b1",
            ticker="QQQ",
            offset_s=0.0,
            strike=380.0,
            option_type="call",
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,
        ),
        _trade(
            trade_id="b2",
            ticker="QQQ",
            offset_s=10.0,
            strike=390.0,
            option_type="call",
            price=5.00,
            nbbo_bid=5.00,
            nbbo_ask=5.10,
        ),
    ]
    out = classify_trades(_df(rows))

    # All four should match as verticals
    assert set(out["inferred_structure"].to_list()) == {"vertical"}

    # Group SPY rows vs QQQ rows by ticker
    spy_gids = (
        out.filter(pl.col("underlying_symbol") == "SPY")["pattern_group_id"].to_list()
    )
    qqq_gids = (
        out.filter(pl.col("underlying_symbol") == "QQQ")["pattern_group_id"].to_list()
    )
    assert spy_gids[0] == spy_gids[1]
    assert qqq_gids[0] == qqq_gids[1]
    assert spy_gids[0] != qqq_gids[0]


def test_vertical_near_duplicate_strikes_no_match() -> None:
    """Two calls at $190.00 and $190.005 are effectively the same strike —
    must NOT match as a vertical (otherwise floating-point noise produces
    spurious spreads). Honors ``strike_tolerance``."""
    rows = [
        _trade(
            trade_id="nd1",
            offset_s=0.0,
            strike=190.000,
            option_type="call",
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,  # buy
        ),
        _trade(
            trade_id="nd2",
            offset_s=10.0,
            strike=190.005,
            option_type="call",
            price=11.00,
            nbbo_bid=11.00,
            nbbo_ask=11.10,  # sell
        ),
    ]
    out = classify_trades(_df(rows), strike_tolerance=0.05)

    structures = set(out["inferred_structure"].to_list())
    assert "vertical" not in structures, f"got {structures}"
    assert all(s == "isolated_leg" for s in out["inferred_structure"].to_list())


def test_dense_window_skips_three_leg_but_keeps_two_leg() -> None:
    """50 trades inside the rolling window — 3-leg enumeration must be
    skipped (would be C(50,3)=19,600 triples per anchor), but 2-leg
    matching must still find a planted vertical inside the burst."""
    rows = []
    # 48 noise trades at the same call strike, same direction (no pattern
    # match — they fail vertical's strike-differ and butterfly's equidistant
    # constraints). Spread 1.5s apart so all 50 fit inside the 90s window.
    for i in range(48):
        rows.append(
            _trade(
                trade_id=f"noise{i}",
                offset_s=float(i) * 1.5,
                strike=200.0,
                option_type="call",
                size=5,
                price=4.95,  # mid
                nbbo_bid=4.90,
                nbbo_ask=5.00,
            )
        )
    # Planted vertical at the end of the burst (within window of trade 0).
    rows.append(
        _trade(
            trade_id="vert_a",
            offset_s=72.0,
            strike=190.0,
            option_type="call",
            size=10,
            price=11.00,
            nbbo_bid=10.90,
            nbbo_ask=11.00,  # buy
        )
    )
    rows.append(
        _trade(
            trade_id="vert_b",
            offset_s=73.0,
            strike=210.0,
            option_type="call",
            size=10,
            price=1.50,
            nbbo_bid=1.50,
            nbbo_ask=1.60,  # sell
        )
    )

    out = classify_trades(_df(rows), window_seconds=90)

    # 2-leg vertical was still discovered despite the dense window.
    structures = out["inferred_structure"].to_list()
    ids = out["id"].to_list()
    by_id = dict(zip(ids, structures))
    assert by_id["vert_a"] == "vertical"
    assert by_id["vert_b"] == "vertical"


def test_isolated_legs_get_unique_group_ids() -> None:
    """Two isolated legs → each gets its own pattern_group_id."""
    rows = [
        _trade(trade_id="i1", ticker="SPY", strike=200.0, option_type="call"),
        _trade(
            trade_id="i2",
            ticker="QQQ",
            offset_s=300.0,
            strike=380.0,
            option_type="put",
        ),
    ]
    out = classify_trades(_df(rows))

    gids = out["pattern_group_id"].to_list()
    assert len(set(gids)) == 2
