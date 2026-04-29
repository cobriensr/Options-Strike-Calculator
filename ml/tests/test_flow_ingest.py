"""Unit tests for scripts/ingest-flow.py — exercises transform + validation."""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

import polars as pl
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Load the script as a module (script filename has hyphens, not a valid identifier)
_spec = importlib.util.spec_from_file_location(
    "ingest_flow", REPO_ROOT / "scripts" / "ingest-flow.py"
)
assert _spec is not None and _spec.loader is not None
ingest_flow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ingest_flow)


def _make_lf() -> pl.LazyFrame:
    """Synthetic CSV-like LazyFrame matching the schema (subset of cols)."""
    return pl.LazyFrame(
        [
            # In-window 13:30 UTC (08:30 CT) — keep
            {
                "executed_at": datetime(2026, 4, 24, 13, 30, tzinfo=UTC),
                "underlying_symbol": "SPY",
                "report_flags": "{}",
                "canceled": "f",
            },
            # Pre-market 12:00 UTC (07:00 CT) — drop
            {
                "executed_at": datetime(2026, 4, 24, 12, 0, tzinfo=UTC),
                "underlying_symbol": "SPY",
                "report_flags": "{}",
                "canceled": "f",
            },
            # 19:59 UTC (14:59 CT) — keep
            {
                "executed_at": datetime(2026, 4, 24, 19, 59, tzinfo=UTC),
                "underlying_symbol": "QQQ",
                "report_flags": "{}",
                "canceled": "f",
            },
            # 20:00 UTC (15:00 CT) — drop (exclusive end)
            {
                "executed_at": datetime(2026, 4, 24, 20, 0, tzinfo=UTC),
                "underlying_symbol": "QQQ",
                "report_flags": "{}",
                "canceled": "f",
            },
            # In-window but ETH-flagged — drop
            {
                "executed_at": datetime(2026, 4, 24, 14, 0, tzinfo=UTC),
                "underlying_symbol": "AAPL",
                "report_flags": "{extended_hours_trade}",
                "canceled": "f",
            },
        ]
    )


def test_transform_filters_to_cash_session() -> None:
    df = ingest_flow.transform(_make_lf(), "2026-04-24").collect()
    # Should keep only the two in-window non-ETH rows: SPY 13:30 and QQQ 19:59
    assert df.height == 2
    symbols = sorted(df["underlying_symbol"].to_list())
    assert symbols == ["QQQ", "SPY"]


def test_transform_drops_extended_hours_trade() -> None:
    df = ingest_flow.transform(_make_lf(), "2026-04-24").collect()
    assert "AAPL" not in df["underlying_symbol"].to_list()


def test_transform_sort_is_stable_by_symbol() -> None:
    df = ingest_flow.transform(_make_lf(), "2026-04-24").collect()
    symbols = df["underlying_symbol"].to_list()
    assert symbols == sorted(symbols), f"Not sorted by symbol: {symbols}"


def test_transform_adds_date_and_ingested_at() -> None:
    df = ingest_flow.transform(_make_lf(), "2026-04-24").collect()
    assert "date" in df.columns
    assert "ingested_at" in df.columns
    assert df["date"][0].isoformat() == "2026-04-24"


def test_validate_categoricals_passes_on_known_values() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", "bid", "mid", "no_side"],
            "option_type": ["put", "call", "put", "call"],
            "equity_type": ["ETF", "Common Stock", "Index", "ADR"],
        }
    )
    ingest_flow.validate_categoricals(df)  # should not raise


def test_validate_categoricals_rejects_unknown_side() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", "lifted"],  # "lifted" not in enum
            "option_type": ["put", "call"],
            "equity_type": ["ETF", "ETF"],
        }
    )
    with pytest.raises(ValueError, match="lifted"):
        ingest_flow.validate_categoricals(df)


def test_validate_categoricals_rejects_unknown_equity_type() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", "bid"],
            "option_type": ["put", "call"],
            "equity_type": ["ETF", "Crypto"],  # "Crypto" not in enum
        }
    )
    with pytest.raises(ValueError, match="Crypto"):
        ingest_flow.validate_categoricals(df)


def test_validate_categoricals_allows_nulls() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", None],
            "option_type": ["put", None],
            "equity_type": ["ETF", None],
        }
    )
    ingest_flow.validate_categoricals(df)  # nulls should not trigger


def test_blob_pathname_format() -> None:
    assert (
        ingest_flow.blob_pathname("2026-04-24")
        == "flow/year=2026/month=04/day=24/data.parquet"
    )


def test_validate_header_passes_on_correct_header(tmp_path: Path) -> None:
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    csv.write_text(",".join(ingest_flow.FLOW_SCHEMA.keys()) + "\n")
    ingest_flow.validate_header(csv)  # should not raise


def test_validate_header_fails_on_extra_column(tmp_path: Path) -> None:
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    cols = list(ingest_flow.FLOW_SCHEMA.keys()) + ["new_uw_field"]
    csv.write_text(",".join(cols) + "\n")
    with pytest.raises(ValueError, match="new_uw_field"):
        ingest_flow.validate_header(csv)


def test_validate_header_fails_on_missing_column(tmp_path: Path) -> None:
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    cols = [c for c in ingest_flow.FLOW_SCHEMA.keys() if c != "rho"]
    csv.write_text(",".join(cols) + "\n")
    with pytest.raises(ValueError, match="rho"):
        ingest_flow.validate_header(csv)


def test_full_pipeline_through_real_csv_shape(tmp_path: Path) -> None:
    """End-to-end: write a CSV that matches UW's wire format (incl. `f`/`t`
    for `canceled` and `+00` UTC offset), scan with FLOW_SCHEMA, transform,
    collect. Catches schema/cast bugs the synthetic LazyFrame tests miss.
    """
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    header = ",".join(ingest_flow.FLOW_SCHEMA.keys())
    # Two in-window rows (one canceled, one not) and one ETH-flagged row that
    # should be dropped. Shape mirrors actual UW samples.
    rows = [
        # In-window, canceled=f, normal flags → kept, canceled=False
        "2026-04-24 14:00:00.000000+00,SPY,SPY260515P00650000,ask,650,put,2026-05-15,710.76,1.25,1.35,1.25,1.35,1.30,3,390,3,121751,0.25,-0.07,-0.14,0.003,0.225,-0.029,1.30,,XPHO,{},f,auto,ETF",
        # In-window, canceled=t, normal flags → kept, canceled=True
        "2026-04-24 14:00:01.000000+00,QQQ,QQQ260515C00500000,bid,500,call,2026-05-15,510.00,5.00,5.10,5.00,5.10,5.05,1,505,1,2426,0.20,0.50,-0.05,0.01,0.30,-0.10,5.05,,XCBO,{},t,auto,ETF",
        # In-window but extended_hours_trade flagged → dropped
        "2026-04-24 14:00:02.000000+00,AAPL,AAPL260515C00200000,ask,200,call,2026-05-15,205.00,1.00,1.10,1.00,1.10,1.05,1,105,1,500,0.30,0.40,-0.08,0.02,0.20,-0.15,1.05,Tech,XPHO,{extended_hours_trade},f,auto,Common Stock",
    ]
    csv.write_text(header + "\n" + "\n".join(rows) + "\n")

    lf = pl.scan_csv(csv, schema=ingest_flow.FLOW_SCHEMA, infer_schema_length=0)
    df = ingest_flow.transform(lf, "2026-04-24").collect()

    assert df.height == 2, f"Expected 2 rows after ETH filter, got {df.height}"
    assert df["canceled"].dtype == pl.Boolean
    assert sorted(df["canceled"].to_list()) == [False, True]
    assert df["executed_at"].dtype == pl.Datetime("us", "UTC")
    assert df["expiry"].dtype == pl.Date
    assert df["date"][0].isoformat() == "2026-04-24"
    assert "ingested_at" in df.columns
    # Sort assertion: QQQ before SPY alphabetically
    assert df["underlying_symbol"].to_list() == ["QQQ", "SPY"]
