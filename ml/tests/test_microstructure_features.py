"""Tests for features.microstructure — the Phase 4c feature engineering module.

Unlike the mocked-DBN tests in ``test_tbbo_convert.py``, these tests run
**real DuckDB queries against real Parquet fixtures on disk**. That's the
whole point of the Phase 4a verification pattern: the SQL is where the
subtle bugs live (column-name typos, ``side`` value drift, join cast
failures), and only end-to-end execution catches them.

Each test builds a tiny synthetic TBBO Parquet file via pyarrow, plus a
matching symbology file, then points the module under test at those paths.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from features import microstructure as ms

# ---------------------------------------------------------------------------
# Fixture helpers — build realistic TBBO rows matching the verified schema
# ---------------------------------------------------------------------------


def _make_trade_row(
    *,
    ts_recv: datetime,
    instrument_id: int,
    symbol: str,
    side: str,
    size: int,
    bid_px: float = 5300.00,
    ask_px: float = 5300.25,
    bid_sz: int = 10,
    ask_sz: int = 10,
    price: float = 5300.25,
) -> dict[str, object]:
    """Build one TBBO row matching the archive's schema."""
    return {
        "ts_recv": ts_recv,
        "ts_event": ts_recv,
        "rtype": 1,
        "publisher_id": 1,
        "instrument_id": instrument_id,
        "action": "T",
        "side": side,
        "depth": 0,
        "price": price,
        "size": size,
        "flags": 0,
        "ts_in_delta": 100,
        "sequence": 1,
        "bid_px_00": bid_px,
        "ask_px_00": ask_px,
        "bid_sz_00": bid_sz,
        "ask_sz_00": ask_sz,
        "bid_ct_00": 1,
        "ask_ct_00": 1,
        "symbol": symbol,
    }


def _write_tbbo_parquet(rows: list[dict[str, object]], path: Path) -> None:
    """Write rows to a TBBO-shaped Parquet file, partitioned by year=YYYY."""
    if not rows:
        # Create a dataframe with correct dtypes but 0 rows.
        df = pd.DataFrame(
            columns=[
                "ts_recv",
                "ts_event",
                "rtype",
                "publisher_id",
                "instrument_id",
                "action",
                "side",
                "depth",
                "price",
                "size",
                "flags",
                "ts_in_delta",
                "sequence",
                "bid_px_00",
                "ask_px_00",
                "bid_sz_00",
                "ask_sz_00",
                "bid_ct_00",
                "ask_ct_00",
                "symbol",
            ]
        )
    else:
        df = pd.DataFrame(rows)
        df["ts_recv"] = pd.to_datetime(df["ts_recv"], utc=True)
        df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)

    # Partition by year of ts_recv so the glob 'year=*/part.parquet' resolves.
    # For single-year fixtures this just writes one file.
    path.parent.mkdir(parents=True, exist_ok=True)
    if df.empty:
        # Still need a file the glob can resolve; write an empty year=1970 partition.
        year_dir = path / "year=1970"
        year_dir.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pandas(df, preserve_index=False),
                       year_dir / "part.parquet")
        return

    for year, grp in df.groupby(df["ts_recv"].dt.year, sort=False):
        year_dir = path / f"year={int(year)}"
        year_dir.mkdir(parents=True, exist_ok=True)
        pq.write_table(
            pa.Table.from_pandas(grp.reset_index(drop=True), preserve_index=False),
            year_dir / "part.parquet",
        )


def _write_symbology(
    mappings: list[tuple[int, str]],
    path: Path,
    *,
    first_seen: datetime | None = None,
    last_seen: datetime | None = None,
) -> None:
    """Write a symbology.parquet mapping instrument_id → symbol.

    Timestamps don't matter for the Phase 4c queries — they join on instrument_id
    alone. We populate them for schema parity with the real file.
    """
    fs = first_seen or datetime(2025, 1, 1, tzinfo=UTC)
    ls = last_seen or datetime(2027, 1, 1, tzinfo=UTC)
    df = pd.DataFrame(
        [
            {
                "instrument_id": iid,
                "symbol": sym,
                "first_seen": pd.Timestamp(fs),
                "last_seen": pd.Timestamp(ls),
            }
            for iid, sym in mappings
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), path)


@pytest.fixture
def tbbo_root(tmp_path: Path) -> Path:
    """Blank archive root tests populate per-scenario."""
    root = tmp_path / "archive"
    root.mkdir()
    return root


def _tbbo_glob_of(root: Path) -> str:
    return str(root / "tbbo" / "year=*" / "part.parquet")


def _symbology_of(root: Path) -> str:
    return str(root / "symbology.parquet")


def _populate(
    tbbo_root: Path,
    rows: list[dict[str, object]],
    mappings: list[tuple[int, str]],
) -> None:
    """Write both the TBBO parquet and symbology.parquet for a test."""
    _write_tbbo_parquet(rows, tbbo_root / "tbbo")
    _write_symbology(mappings, tbbo_root / "symbology.parquet")


# ---------------------------------------------------------------------------
# 1. OFI — balanced flow
# ---------------------------------------------------------------------------


def test_ofi_balanced_flow_mean_near_zero(tbbo_root: Path) -> None:
    """Evenly split buy/sell volume over a dense minute -> OFI ~ 0."""
    # Build 10 full minutes of activity. Each minute gets 20 buy + 20 sell
    # trades so every rolling window easily clears the 20-trade threshold
    # and stays balanced.
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    for m in range(10):
        minute_ts = base + timedelta(minutes=m)
        for i in range(20):
            rows.append(
                _make_trade_row(
                    ts_recv=minute_ts + timedelta(seconds=i),
                    instrument_id=101,
                    symbol="ESH6",
                    side="B",
                    size=10,
                )
            )
        for i in range(20):
            rows.append(
                _make_trade_row(
                    ts_recv=minute_ts + timedelta(seconds=30 + i),
                    instrument_id=101,
                    symbol="ESH6",
                    side="A",
                    size=10,
                )
            )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_ofi_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    # Balanced flow: mean OFI ~ 0, std ~ 0, no extremes.
    assert abs(stats["ofi_5m_mean"]) < 1e-9
    assert stats["ofi_5m_std"] < 1e-9
    assert stats["ofi_5m_pct_extreme"] == 0.0


# ---------------------------------------------------------------------------
# 2. OFI — aggressive buyers
# ---------------------------------------------------------------------------


def test_ofi_aggressive_buyers_highly_positive(tbbo_root: Path) -> None:
    """Buy-dominated flow -> OFI skewed strongly positive."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    # Dense 10-minute block: 200 buy-aggressor size vs 20 sell per minute.
    # Per minute: (200 - 20) / (200 + 20) = 180/220 ~= 0.818
    for m in range(10):
        minute_ts = base + timedelta(minutes=m)
        for i in range(20):
            rows.append(
                _make_trade_row(
                    ts_recv=minute_ts + timedelta(seconds=i),
                    instrument_id=101,
                    symbol="ESH6",
                    side="B",
                    size=10,
                )
            )
        for i in range(2):
            rows.append(
                _make_trade_row(
                    ts_recv=minute_ts + timedelta(seconds=40 + i),
                    instrument_id=101,
                    symbol="ESH6",
                    side="A",
                    size=10,
                )
            )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_ofi_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    # 5-minute rolling OFI should converge to ~0.818 once the window is full.
    assert stats["ofi_5m_mean"] == pytest.approx(0.8181818, abs=1e-4)
    # All valid windows are extreme (> 0.3).
    assert stats["ofi_5m_pct_extreme"] == 1.0


# ---------------------------------------------------------------------------
# 3. OFI — sparse minute skipped by volume threshold
# ---------------------------------------------------------------------------


def test_ofi_sparse_minute_skipped(tbbo_root: Path) -> None:
    """A 5-minute window with only 5 trades fails the min-trades threshold."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    # 5 minutes with ONE trade each — total in any 5m window = 5 size
    # (well below the 20-trade floor). With only 5 minutes of data, the
    # only ready 5-minute window is at minute index 5, and it'll fail the
    # threshold.
    for m in range(5):
        rows.append(
            _make_trade_row(
                ts_recv=base + timedelta(minutes=m),
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=1,
            )
        )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_ofi_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    # No valid window -> NaN aggregates.
    assert np.isnan(stats["ofi_5m_mean"])
    assert np.isnan(stats["ofi_5m_std"])


# ---------------------------------------------------------------------------
# 4. Spread widening — flat spreads
# ---------------------------------------------------------------------------


def test_spread_widening_flat_spreads(tbbo_root: Path) -> None:
    """Constant $0.25 spread -> zero-std baseline -> zscore guarded to 0."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    for m in range(60):  # 60 minutes of flat quotes
        minute_ts = base + timedelta(minutes=m)
        rows.append(
            _make_trade_row(
                ts_recv=minute_ts,
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=1,
                bid_px=5300.00,
                ask_px=5300.25,
            )
        )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_spread_widening_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    assert stats["spread_widening_count_2sigma"] == 0
    assert stats["spread_widening_count_3sigma"] == 0
    # Max z is 0 under the zero-std guard (no baseline deviation observed).
    assert stats["spread_widening_max_zscore"] == 0.0
    assert stats["spread_widening_max_run_minutes"] == 0


# ---------------------------------------------------------------------------
# 5. Spread widening — one wide event
# ---------------------------------------------------------------------------


def test_spread_widening_detects_one_wide_event(tbbo_root: Path) -> None:
    """30m of tight + 1m of wide -> z-score exceedance registered."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    # 30 tight minutes. Use small random perturbations so baseline std > 0,
    # which lets the z-score actually fire.
    rng = np.random.default_rng(seed=7)
    for m in range(30):
        minute_ts = base + timedelta(minutes=m)
        noise = float(rng.uniform(-0.01, 0.01))
        rows.append(
            _make_trade_row(
                ts_recv=minute_ts,
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=1,
                bid_px=5300.00,
                ask_px=5300.25 + noise,
            )
        )
    # 1 wide minute — 10x the normal spread.
    wide_ts = base + timedelta(minutes=30)
    rows.append(
        _make_trade_row(
            ts_recv=wide_ts,
            instrument_id=101,
            symbol="ESH6",
            side="B",
            size=1,
            bid_px=5300.00,
            ask_px=5302.50,
        )
    )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_spread_widening_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    assert stats["spread_widening_count_2sigma"] >= 1
    assert stats["spread_widening_max_zscore"] > 2.0


# ---------------------------------------------------------------------------
# 6. TOB — sustained buy pressure
# ---------------------------------------------------------------------------


def test_tob_sustained_buy_pressure_gives_long_run(tbbo_root: Path) -> None:
    """10 consecutive minutes of bid_sz/ask_sz = 2.0 -> max_run_buy_pressure == 10."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    for m in range(10):
        minute_ts = base + timedelta(minutes=m)
        rows.append(
            _make_trade_row(
                ts_recv=minute_ts,
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=1,
                bid_sz=20,
                ask_sz=10,  # ratio = 2.0 > 1.5
            )
        )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_tob_persistence_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    assert stats["tob_max_run_buy_pressure"] == 10
    assert stats["tob_max_run_sell_pressure"] == 0
    assert stats["tob_extreme_minute_count"] == 10
    # log(2.0) ~= 0.693 — mean abs log ratio should be ~0.693.
    assert stats["tob_mean_abs_log_ratio"] == pytest.approx(np.log(2.0), abs=1e-9)


# ---------------------------------------------------------------------------
# 7. TOB — balanced
# ---------------------------------------------------------------------------


def test_tob_balanced_has_zero_extreme_minutes(tbbo_root: Path) -> None:
    """All minutes with ratio in [0.67, 1.5] -> tob_extreme_minute_count == 0."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    for m in range(10):
        minute_ts = base + timedelta(minutes=m)
        rows.append(
            _make_trade_row(
                ts_recv=minute_ts,
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=1,
                bid_sz=10,
                ask_sz=10,  # ratio = 1.0 — perfectly balanced
            )
        )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_tob_persistence_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    assert stats["tob_extreme_minute_count"] == 0
    assert stats["tob_max_run_buy_pressure"] == 0
    assert stats["tob_max_run_sell_pressure"] == 0


# ---------------------------------------------------------------------------
# 8. Tick velocity — uniform activity
# ---------------------------------------------------------------------------


def test_tick_velocity_uniform_60_per_minute(tbbo_root: Path) -> None:
    """60 trades per minute for 60 minutes -> mean == p95 == max == 60."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    for m in range(60):
        minute_ts = base + timedelta(minutes=m)
        for i in range(60):
            rows.append(
                _make_trade_row(
                    ts_recv=minute_ts + timedelta(seconds=i),
                    instrument_id=101,
                    symbol="ESH6",
                    side="B",
                    size=1,
                )
            )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    conn = duckdb.connect()
    stats = ms._compute_tick_velocity_stats(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ESH6",
    )
    conn.close()

    assert stats["tick_velocity_mean"] == pytest.approx(60.0)
    assert stats["tick_velocity_p95"] == pytest.approx(60.0)
    assert stats["tick_velocity_max_minute"] == 60


# ---------------------------------------------------------------------------
# 9. compute_daily_features — no trades -> None
# ---------------------------------------------------------------------------


def test_compute_daily_features_no_trades_returns_none(tbbo_root: Path) -> None:
    """Date with no trades for the requested symbol -> None."""
    # Write a single ES trade on 2026-03-10; query for NQ on same date.
    rows = [
        _make_trade_row(
            ts_recv=datetime(2026, 3, 10, 14, 0, tzinfo=UTC),
            instrument_id=101,
            symbol="ESH6",
            side="B",
            size=1,
        )
    ]
    _populate(tbbo_root, rows, [(101, "ESH6")])

    result = ms.compute_daily_features(
        _tbbo_glob_of(tbbo_root),
        _symbology_of(tbbo_root),
        "2026-03-10",
        "NQ",
    )
    assert result is None


# ---------------------------------------------------------------------------
# 10. compute_daily_features — happy path
# ---------------------------------------------------------------------------


def test_compute_daily_features_happy_path_full_schema(tbbo_root: Path) -> None:
    """End-to-end: returns dict with every OUTPUT_COLUMNS key."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    # Modest 45-minute session so the spread z-score path (30m baseline +
    # min 10 periods) has enough data to produce non-NaN results.
    for m in range(45):
        minute_ts = base + timedelta(minutes=m)
        for i in range(25):
            rows.append(
                _make_trade_row(
                    ts_recv=minute_ts + timedelta(seconds=i),
                    instrument_id=101,
                    symbol="ESH6",
                    side="B" if i % 2 == 0 else "A",
                    size=5,
                )
            )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    result = ms.compute_daily_features(
        _tbbo_glob_of(tbbo_root),
        _symbology_of(tbbo_root),
        "2026-03-10",
        "ES",
    )
    assert result is not None
    # Every documented column must be present.
    assert set(result.keys()) == set(ms.OUTPUT_COLUMNS)
    assert result["symbol"] == "ES"
    assert result["front_month_contract"] == "ESH6"
    assert result["trade_count"] == 45 * 25
    assert result["is_degraded"] is False
    # Tick velocity obviously non-NaN.
    assert result["tick_velocity_mean"] > 0


# ---------------------------------------------------------------------------
# 11. _pick_front_month — higher-volume contract wins
# ---------------------------------------------------------------------------


def test_pick_front_month_picks_higher_volume(tbbo_root: Path) -> None:
    """Two ES contracts on the same date -> higher-volume one wins."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    # ESM6: 10 trades of size 1
    for i in range(10):
        rows.append(
            _make_trade_row(
                ts_recv=base + timedelta(seconds=i),
                instrument_id=102,
                symbol="ESM6",
                side="B",
                size=1,
            )
        )
    # ESH6: 5 trades of size 100 = 500 total size (wins)
    for i in range(5):
        rows.append(
            _make_trade_row(
                ts_recv=base + timedelta(seconds=100 + i),
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=100,
            )
        )
    _populate(tbbo_root, rows, [(101, "ESH6"), (102, "ESM6")])

    conn = duckdb.connect()
    contract = ms._pick_front_month(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ES",
    )
    conn.close()
    assert contract == "ESH6"


def test_pick_front_month_excludes_spreads_and_options(tbbo_root: Path) -> None:
    """Spread (hyphen) and option (space) symbols must never win."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    # Spread with dominant volume — must be filtered out.
    for i in range(100):
        rows.append(
            _make_trade_row(
                ts_recv=base + timedelta(seconds=i),
                instrument_id=999,
                symbol="ESH6-ESM6",
                side="B",
                size=100,
            )
        )
    # Small outright ESH6 — should win by default.
    rows.append(
        _make_trade_row(
            ts_recv=base,
            instrument_id=101,
            symbol="ESH6",
            side="B",
            size=1,
        )
    )
    _populate(tbbo_root, rows, [(101, "ESH6"), (999, "ESH6-ESM6")])

    conn = duckdb.connect()
    contract = ms._pick_front_month(
        conn, _tbbo_glob_of(tbbo_root), _symbology_of(tbbo_root),
        "2026-03-10", "ES",
    )
    conn.close()
    assert contract == "ESH6"


# ---------------------------------------------------------------------------
# 12. is_degraded flag
# ---------------------------------------------------------------------------


def test_is_degraded_flag_reads_condition_file(tbbo_root: Path) -> None:
    """Dates in condition.json with 'degraded' status flip is_degraded=True."""
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    rows = [
        _make_trade_row(
            ts_recv=base,
            instrument_id=101,
            symbol="ESH6",
            side="B",
            size=1,
        )
    ]
    _populate(tbbo_root, rows, [(101, "ESH6")])

    condition_path = tbbo_root / "tbbo_condition.json"
    condition_path.write_text(
        json.dumps(
            [
                {"date": "2026-03-10", "condition": "degraded"},
                {"date": "2026-03-11", "condition": "available"},
                {"date": "2026-03-12", "condition": "degraded"},
            ]
        )
    )

    result = ms.compute_daily_features(
        _tbbo_glob_of(tbbo_root),
        _symbology_of(tbbo_root),
        "2026-03-10",
        "ES",
        condition_path=condition_path,
    )
    assert result is not None
    assert result["is_degraded"] is True

    # Same code path, non-degraded date -> False. Seed a trade on that date.
    rows2 = rows + [
        _make_trade_row(
            ts_recv=datetime(2026, 3, 11, 14, 0, tzinfo=UTC),
            instrument_id=101,
            symbol="ESH6",
            side="B",
            size=1,
        )
    ]
    # Rewrite with both dates.
    import shutil
    shutil.rmtree(tbbo_root / "tbbo")
    _write_tbbo_parquet(rows2, tbbo_root / "tbbo")

    result2 = ms.compute_daily_features(
        _tbbo_glob_of(tbbo_root),
        _symbology_of(tbbo_root),
        "2026-03-11",
        "ES",
        condition_path=condition_path,
    )
    assert result2 is not None
    assert result2["is_degraded"] is False


# ---------------------------------------------------------------------------
# 13. backfill_daily_features — happy path
# ---------------------------------------------------------------------------


def test_backfill_happy_path_multi_date_multi_symbol(tbbo_root: Path) -> None:
    """3 dates × 2 symbols -> 6-row DataFrame sorted by (date, symbol)."""
    rows: list[dict[str, object]] = []
    dates = [
        datetime(2026, 3, 10, 14, 0, tzinfo=UTC),
        datetime(2026, 3, 11, 14, 0, tzinfo=UTC),
        datetime(2026, 3, 12, 14, 0, tzinfo=UTC),
    ]
    for d in dates:
        # Dense 5-minute fixture for ES and NQ so OFI + velocity have data.
        for m in range(5):
            minute_ts = d + timedelta(minutes=m)
            for i in range(10):
                rows.append(
                    _make_trade_row(
                        ts_recv=minute_ts + timedelta(seconds=i),
                        instrument_id=101,
                        symbol="ESH6",
                        side="B" if i % 2 == 0 else "A",
                        size=5,
                    )
                )
                rows.append(
                    _make_trade_row(
                        ts_recv=minute_ts + timedelta(seconds=30 + i),
                        instrument_id=201,
                        symbol="NQH6",
                        side="B" if i % 2 == 0 else "A",
                        size=3,
                    )
                )
    _populate(tbbo_root, rows, [(101, "ESH6"), (201, "NQH6")])

    out_path = tbbo_root.parent / "out" / "features.parquet"
    df = ms.backfill_daily_features(
        tbbo_root,
        out_path=out_path,
        start_date="2026-03-10",
        end_date="2026-03-12",
        symbols=("ES", "NQ"),
    )

    assert len(df) == 6
    assert list(df.columns) == list(ms.OUTPUT_COLUMNS)
    # Sort order: (date asc, symbol asc).
    pairs = list(zip(df["date"].astype(str), df["symbol"], strict=False))
    assert pairs == sorted(pairs)
    # Parquet on disk should round-trip.
    assert out_path.exists()
    round_trip = pq.read_table(out_path).to_pandas()
    assert len(round_trip) == 6
    assert list(round_trip.columns) == list(ms.OUTPUT_COLUMNS)


# ---------------------------------------------------------------------------
# 14. backfill_daily_features — dates with missing data are omitted
# ---------------------------------------------------------------------------


def test_backfill_skips_dates_with_no_trades(tbbo_root: Path) -> None:
    """A date that has no ES trades produces no row (not an empty row)."""
    rows: list[dict[str, object]] = []
    # Only 2026-03-10 has ES trades.
    base = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    for i in range(10):
        rows.append(
            _make_trade_row(
                ts_recv=base + timedelta(seconds=i),
                instrument_id=101,
                symbol="ESH6",
                side="B",
                size=1,
            )
        )
    _populate(tbbo_root, rows, [(101, "ESH6")])

    out_path = tbbo_root.parent / "out" / "features.parquet"
    df = ms.backfill_daily_features(
        tbbo_root,
        out_path=out_path,
        start_date="2026-03-10",
        end_date="2026-03-12",
        symbols=("ES",),  # no NQ data either — test it's skipped too
    )

    # Only 1 row: 2026-03-10 ES. 2026-03-11, 2026-03-12 are silently skipped
    # (no trades for any symbol on those dates).
    assert len(df) == 1
    assert df.iloc[0]["symbol"] == "ES"
    assert str(df.iloc[0]["date"]) == "2026-03-10"
