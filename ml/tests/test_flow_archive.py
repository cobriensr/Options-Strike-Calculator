"""Tests for ml/src/flow_archive.py — read helpers + lazy local cache."""

from __future__ import annotations

from datetime import date as dt_date
from pathlib import Path
from unittest.mock import MagicMock, patch

import polars as pl
import pytest

from flow_archive import (
    _blob_direct_url,
    _blob_pathname_for,
    _coerce_date,
    _date_from_cache_path,
    _resolve_dates,
    _store_id_from_token,
    cache_path_for,
    clear_cache,
    ensure_local,
    list_archive_dates,
    load_flow,
)

# Synthetic token shaped like the real Vercel Blob format (`vercel_blob_rw_<storeId>_<secret>`)
# so _store_id_from_token's parser doesn't reject it. Not a real credential — used in mocked
# requests only. SonarLint S6418 false-positives on the variable name "token" appearing in
# tests; centralizing the fake here makes that one place to inspect.
FAKE_TOKEN = "vercel_blob_rw_storeABC_secretXYZ"  # NOSONAR — test fixture


# --- Pure helpers (no I/O) ----------------------------------------


def test_coerce_date_accepts_str_and_date() -> None:
    assert _coerce_date("2026-04-22") == dt_date(2026, 4, 22)
    assert _coerce_date(dt_date(2026, 4, 22)) == dt_date(2026, 4, 22)


def test_coerce_date_rejects_other_types() -> None:
    with pytest.raises(TypeError):
        _coerce_date(20260422)  # type: ignore[arg-type]


def test_blob_pathname_format() -> None:
    assert (
        _blob_pathname_for("2026-04-22")
        == "flow/year=2026/month=04/day=22/data.parquet"
    )


def test_cache_path_for_zero_pads() -> None:
    p = cache_path_for("2026-04-01")
    assert p.parts[-4:] == ("year=2026", "month=04", "day=01", "data.parquet")


def test_date_from_cache_path_roundtrip() -> None:
    p = cache_path_for("2026-04-22")
    assert _date_from_cache_path(p) == dt_date(2026, 4, 22)


def test_date_from_cache_path_none_for_unrelated() -> None:
    assert _date_from_cache_path(Path("/tmp/random/file.parquet")) is None


def test_store_id_extracts_fourth_segment() -> None:
    # FAKE_TOKEN is `vercel_blob_rw_storeABC_secretXYZ` → storeId == "storeABC"
    assert _store_id_from_token(FAKE_TOKEN) == "storeABC"


def test_store_id_rejects_malformed_token() -> None:
    with pytest.raises(RuntimeError, match="storeId"):
        _store_id_from_token("notatoken")


def test_blob_direct_url_format() -> None:
    url = _blob_direct_url(
        "flow/year=2026/month=04/day=22/data.parquet",
        token=FAKE_TOKEN,
    )
    assert url == (
        "https://storeABC.private.blob.vercel-storage.com/"
        "flow/year=2026/month=04/day=22/data.parquet"
    )


# --- list_archive_dates -------------------------------------------


def _fake_list_response(blobs: list[str], has_more: bool = False, cursor: str | None = None) -> MagicMock:
    return MagicMock(
        ok=True,
        json=MagicMock(
            return_value={
                "blobs": [{"pathname": p} for p in blobs],
                "hasMore": has_more,
                "cursor": cursor,
            }
        ),
    )


def test_list_archive_dates_parses_and_sorts() -> None:
    pathnames = [
        "flow/year=2026/month=04/day=24/data.parquet",
        "flow/year=2026/month=04/day=15/data.parquet",
        "flow/year=2026/month=04/day=22/data.parquet",
        # Should be ignored — doesn't match flow/ pattern
        "archive/v1/manifest.json",
        # Should be ignored — wrong shape
        "flow/year=2026/data.parquet",
    ]
    with patch("flow_archive.requests.get", return_value=_fake_list_response(pathnames)):
        dates = list_archive_dates(token=FAKE_TOKEN)
    assert dates == [
        dt_date(2026, 4, 15),
        dt_date(2026, 4, 22),
        dt_date(2026, 4, 24),
    ]


def test_list_archive_dates_paginates() -> None:
    page1 = _fake_list_response(
        ["flow/year=2026/month=04/day=15/data.parquet"], has_more=True, cursor="c1"
    )
    page2 = _fake_list_response(
        ["flow/year=2026/month=04/day=22/data.parquet"], has_more=False
    )
    with patch("flow_archive.requests.get", side_effect=[page1, page2]) as g:
        dates = list_archive_dates(token=FAKE_TOKEN)
    assert g.call_count == 2
    # Second call should carry the cursor
    assert g.call_args_list[1].kwargs["params"].get("cursor") == "c1"
    assert dates == [dt_date(2026, 4, 15), dt_date(2026, 4, 22)]


def test_list_archive_dates_propagates_http_failure() -> None:
    bad = MagicMock(ok=False, status_code=403, text="forbidden")
    with patch("flow_archive.requests.get", return_value=bad):
        with pytest.raises(RuntimeError, match="403"):
            list_archive_dates(token=FAKE_TOKEN)


# --- _resolve_dates -----------------------------------------------


def test_resolve_dates_single() -> None:
    assert _resolve_dates("2026-04-22", token=FAKE_TOKEN) == [dt_date(2026, 4, 22)]


def test_resolve_dates_list() -> None:
    out = _resolve_dates(
        ["2026-04-22", dt_date(2026, 4, 15), "2026-04-22"], token=FAKE_TOKEN
    )
    # Sorted + deduped
    assert out == [dt_date(2026, 4, 15), dt_date(2026, 4, 22)]


def test_resolve_dates_tuple_intersects_archive() -> None:
    fake_archive = [
        dt_date(2026, 4, 15),
        dt_date(2026, 4, 22),
        dt_date(2026, 4, 28),
    ]
    with patch("flow_archive.list_archive_dates", return_value=fake_archive):
        out = _resolve_dates(("2026-04-20", "2026-04-25"), token=FAKE_TOKEN)
    # Only the dates within the range AND in the archive
    assert out == [dt_date(2026, 4, 22)]


def test_resolve_dates_rejects_inverted_range() -> None:
    with pytest.raises(ValueError, match="after end"):
        _resolve_dates(("2026-04-22", "2026-04-15"), token=FAKE_TOKEN)


# --- ensure_local + load_flow integration -------------------------


def test_ensure_local_skips_download_when_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    target = tmp_path / "year=2026" / "month=04" / "day=22" / "data.parquet"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"already-here")
    with patch("flow_archive.requests.get") as g:
        result = ensure_local("2026-04-22", token=FAKE_TOKEN)
    g.assert_not_called()
    assert result == target


def test_ensure_local_downloads_when_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    # Two-step download path: GET returns Parquet bytes directly (not JSON)
    fake_response = MagicMock(
        ok=True,
        headers={"content-type": "application/vnd.apache.parquet"},
        iter_content=MagicMock(return_value=[b"PARQUET-MAGIC-BYTES"]),
    )
    fake_response.close = MagicMock()
    with patch("flow_archive.requests.get", return_value=fake_response):
        path = ensure_local("2026-04-22", token=FAKE_TOKEN)
    assert path.is_file()
    assert path.read_bytes() == b"PARQUET-MAGIC-BYTES"


def test_load_flow_pushes_down_ticker_filter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Build a small synthetic Parquet at the cache path; verify load_flow
    composes the LazyFrame with our pushdown filter."""
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    target = tmp_path / "year=2026" / "month=04" / "day=22" / "data.parquet"
    target.parent.mkdir(parents=True)
    pl.DataFrame(
        {
            "executed_at": ["2026-04-22T13:30:00", "2026-04-22T13:31:00"],
            "underlying_symbol": ["SPY", "TSLA"],
            "premium": [1_500_000.0, 200_000.0],
        }
    ).write_parquet(target)

    lf = load_flow("2026-04-22", tickers=["SPY"], token=FAKE_TOKEN)
    df = lf.collect()
    # Ticker filter applied lazily
    assert df["underlying_symbol"].to_list() == ["SPY"]


def test_load_flow_projects_columns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    target = tmp_path / "year=2026" / "month=04" / "day=22" / "data.parquet"
    target.parent.mkdir(parents=True)
    pl.DataFrame(
        {
            "executed_at": ["2026-04-22T13:30:00"],
            "underlying_symbol": ["SPY"],
            "strike": [650.0],
            "premium": [1_500_000.0],
        }
    ).write_parquet(target)

    lf = load_flow(
        "2026-04-22",
        columns=["executed_at", "premium"],
        token=FAKE_TOKEN,
    )
    df = lf.collect()
    # Only requested columns surface
    assert sorted(df.columns) == ["executed_at", "premium"]


def test_load_flow_includes_underlying_when_ticker_filter_and_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If user asks for tickers + columns but forgets underlying_symbol in
    columns, load_flow should still include it so the filter works."""
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    target = tmp_path / "year=2026" / "month=04" / "day=22" / "data.parquet"
    target.parent.mkdir(parents=True)
    pl.DataFrame(
        {
            "executed_at": ["2026-04-22T13:30:00", "2026-04-22T13:31:00"],
            "underlying_symbol": ["SPY", "TSLA"],
            "premium": [1_500_000.0, 200_000.0],
        }
    ).write_parquet(target)

    lf = load_flow(
        "2026-04-22",
        tickers=["SPY"],
        columns=["premium"],  # forgot underlying_symbol
        token=FAKE_TOKEN,
    )
    df = lf.collect()
    assert df["premium"].to_list() == [1_500_000.0]


def test_load_flow_unions_multiple_dates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    for day in (15, 22):
        t = tmp_path / "year=2026" / "month=04" / f"day={day:02d}" / "data.parquet"
        t.parent.mkdir(parents=True)
        pl.DataFrame(
            {
                "executed_at": [f"2026-04-{day:02d}T13:30:00"],
                "underlying_symbol": ["SPY"],
                "premium": [1_000_000.0 + day],
            }
        ).write_parquet(t)

    lf = load_flow(
        ["2026-04-15", "2026-04-22"],
        token=FAKE_TOKEN,
    )
    df = lf.collect()
    assert df.height == 2
    assert sorted(df["premium"].to_list()) == [1_000_015.0, 1_000_022.0]


# --- clear_cache --------------------------------------------------


def test_clear_cache_removes_all_when_no_before(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    for day in (15, 22):
        t = tmp_path / "year=2026" / "month=04" / f"day={day:02d}" / "data.parquet"
        t.parent.mkdir(parents=True)
        t.write_bytes(b"x")
    removed = clear_cache()
    assert removed == 2
    assert not list(tmp_path.rglob("data.parquet"))


def test_clear_cache_respects_before_filter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path)
    for day in (15, 22):
        t = tmp_path / "year=2026" / "month=04" / f"day={day:02d}" / "data.parquet"
        t.parent.mkdir(parents=True)
        t.write_bytes(b"x")
    # Only remove dates strictly before 2026-04-20
    removed = clear_cache(before=dt_date(2026, 4, 20))
    assert removed == 1
    remaining = sorted(p.name for p in tmp_path.rglob("data.parquet"))
    assert remaining == ["data.parquet"]
    # The 22nd should still be present
    assert (tmp_path / "year=2026" / "month=04" / "day=22" / "data.parquet").exists()


def test_clear_cache_returns_zero_when_root_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("flow_archive.CACHE_ROOT", tmp_path / "nonexistent")
    assert clear_cache() == 0
