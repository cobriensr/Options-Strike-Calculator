"""Read helpers for the EOD options flow Parquet archive on Vercel Blob.

Pattern: lazy local cache. First read of a date downloads the Parquet from
Blob to ~/.flow-archive-cache/year=YYYY/month=MM/day=DD/data.parquet, every
subsequent query is local-disk-fast. Cache is intentionally separate from
the transient ~/.flow-archive/ directory used by the ingest script.

Usage:
    from flow_archive import load_flow

    # Single date
    df = load_flow("2026-04-22").collect()

    # Date range with filters and projection (pushed down to Parquet)
    df = (
        load_flow(
            ("2026-04-15", "2026-04-28"),
            tickers=["SPY", "QQQ", "SPX", "SPXW"],
            columns=["executed_at", "underlying_symbol", "strike", "premium", "side"],
        )
        .filter(pl.col("premium") >= 1_000_000)
        .collect()
    )

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md (Phase 3)
"""

from __future__ import annotations

import os
import re
from datetime import date as dt_date
from pathlib import Path

import polars as pl
import requests

# --- Config (mirrors scripts/ingest-flow.py) -----------------------

BLOB_API_BASE = "https://vercel.com/api/blob"
BLOB_API_VERSION = "12"
BLOB_DOWNLOAD_TIMEOUT_S = 600

CACHE_ROOT = Path.home() / ".flow-archive-cache"

# Pattern to extract date from a Blob pathname like "flow/year=2026/month=04/day=24/data.parquet"
_PATHNAME_DATE_RE = re.compile(
    r"^flow/year=(\d{4})/month=(\d{2})/day=(\d{2})/data\.parquet$"
)


# --- Public API ----------------------------------------------------


def list_archive_dates(token: str | None = None) -> list[dt_date]:
    """Return sorted list of dates available in the Vercel Blob archive.

    Calls the Blob list API with `prefix=flow/`, paginates if needed, parses
    the pathnames into `date` objects.
    """
    token = _require_token(token)
    dates: list[dt_date] = []
    cursor: str | None = None
    while True:
        params: dict[str, str] = {"prefix": "flow/", "limit": "1000"}
        if cursor:
            params["cursor"] = cursor
        # NB: no trailing slash before query string — the SDK uses
        # `${baseUrl}?...` not `${baseUrl}/?...`. Vercel's router treats
        # them differently and a trailing slash makes prefix filtering ignored.
        resp = requests.get(
            BLOB_API_BASE,
            headers={
                "authorization": f"Bearer {token}",
                "x-api-version": BLOB_API_VERSION,
            },
            params=params,
            timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(
                f"Blob list failed ({resp.status_code}): {resp.text[:500]}"
            )
        body = resp.json()
        for blob in body.get("blobs", []):
            pathname = blob.get("pathname", "")
            if (m := _PATHNAME_DATE_RE.match(pathname)) is not None:
                dates.append(dt_date(int(m[1]), int(m[2]), int(m[3])))
        if not body.get("hasMore"):
            break
        cursor = body.get("cursor")
        if cursor is None:
            break
    return sorted(set(dates))


def cache_path_for(date: str | dt_date) -> Path:
    """Return the local cache Path for a given date — does NOT download."""
    d = _coerce_date(date)
    return (
        CACHE_ROOT
        / f"year={d.year:04d}"
        / f"month={d.month:02d}"
        / f"day={d.day:02d}"
        / "data.parquet"
    )


def ensure_local(date: str | dt_date, *, token: str | None = None) -> Path:
    """Download the Parquet for `date` if not already cached. Returns the local Path.

    Idempotent — if the file exists, no network call is made.
    """
    local = cache_path_for(date)
    if local.is_file():
        return local
    token = _require_token(token)
    local.parent.mkdir(parents=True, exist_ok=True)
    pathname = _blob_pathname_for(date)
    _download_blob(pathname, local, token)
    return local


def load_flow(
    date_or_range: str | dt_date | tuple | list,
    *,
    tickers: list[str] | None = None,
    columns: list[str] | None = None,
    token: str | None = None,
) -> pl.LazyFrame:
    """Return a Polars LazyFrame over one or more archive dates.

    `date_or_range` accepts:
      - a single `str` ('YYYY-MM-DD') or `date`
      - a `(start, end)` tuple — inclusive range, archive intersection
      - a list of dates / strings

    `tickers` and `columns` are pushed down lazily — Parquet's row-group
    statistics + Polars' projection pushdown means the on-disk read is
    minimized for ticker filters AND column projections.

    Files are downloaded to the local cache as needed.
    """
    dates = _resolve_dates(date_or_range, token=token)
    if not dates:
        raise ValueError(f"No archive dates resolved from {date_or_range!r}")
    paths = [ensure_local(d, token=token) for d in dates]
    lf = pl.scan_parquet(paths)
    if tickers:
        lf = lf.filter(pl.col("underlying_symbol").is_in(tickers))
    if columns:
        # Always include underlying_symbol for filter pushdown to work cleanly,
        # even when the caller forgot to ask for it.
        cols = list(columns)
        if tickers and "underlying_symbol" not in cols:
            cols.append("underlying_symbol")
        lf = lf.select(cols)
    return lf


def clear_cache(*, before: dt_date | None = None) -> int:
    """Remove cached Parquet files. If `before` is set, only remove files for
    dates strictly before it. Returns the number of files removed.
    """
    if not CACHE_ROOT.is_dir():
        return 0
    removed = 0
    for parquet in CACHE_ROOT.rglob("data.parquet"):
        if before is not None:
            file_date = _date_from_cache_path(parquet)
            if file_date is None or file_date >= before:
                continue
        parquet.unlink()
        removed += 1
        # Best-effort empty-dir cleanup walking up
        for ancestor in (parquet.parent, parquet.parent.parent, parquet.parent.parent.parent):
            try:
                ancestor.rmdir()
            except OSError:
                break
    return removed


# --- Internal helpers ---------------------------------------------


def _require_token(token: str | None) -> str:
    """Resolve token from arg or env. Raises if neither set."""
    if token:
        return token
    env_token = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
    if not env_token:
        raise RuntimeError(
            "BLOB_READ_WRITE_TOKEN not set. Run `set -a; source .env.local; set +a` first."
        )
    return env_token


def _coerce_date(date: str | dt_date) -> dt_date:
    if isinstance(date, dt_date):
        return date
    if isinstance(date, str):
        return dt_date.fromisoformat(date)
    raise TypeError(f"Cannot coerce {type(date).__name__} to date")


def _blob_pathname_for(date: str | dt_date) -> str:
    d = _coerce_date(date)
    return f"flow/year={d.year:04d}/month={d.month:02d}/day={d.day:02d}/data.parquet"


def _date_from_cache_path(path: Path) -> dt_date | None:
    """Extract `date` from a cache path like
    `~/.flow-archive-cache/year=2026/month=04/day=24/data.parquet`."""
    try:
        parts = path.parts
        y = int(next(p for p in parts if p.startswith("year="))[5:])
        m = int(next(p for p in parts if p.startswith("month="))[6:])
        d = int(next(p for p in parts if p.startswith("day="))[4:])
        return dt_date(y, m, d)
    except (StopIteration, ValueError):
        return None


def _resolve_dates(
    date_or_range: str | dt_date | tuple | list,
    *,
    token: str | None = None,
) -> list[dt_date]:
    """Resolve any of the accepted input shapes into a sorted, deduped list of
    dates that intersect the archive contents."""
    if isinstance(date_or_range, (str, dt_date)):
        return [_coerce_date(date_or_range)]
    if isinstance(date_or_range, list):
        return sorted({_coerce_date(d) for d in date_or_range})
    if isinstance(date_or_range, tuple) and len(date_or_range) == 2:
        start, end = _coerce_date(date_or_range[0]), _coerce_date(date_or_range[1])
        if start > end:
            raise ValueError(f"Range start {start} after end {end}")
        # Intersect with what's actually in the archive — avoids download attempts
        # for dates that don't exist (weekends, days you haven't ingested yet).
        available = list_archive_dates(token=token)
        return [d for d in available if start <= d <= end]
    raise TypeError(
        f"Unsupported date_or_range type: {type(date_or_range).__name__}"
    )


def _store_id_from_token(token: str) -> str:
    """Extract storeId from BLOB_READ_WRITE_TOKEN.

    Token format is `vercel_blob_rw_<storeId>_<secret>`; the SDK uses index 3
    of `token.split('_')`. See `getStoreIdFromToken` in
    node_modules/@vercel/blob/dist/index.js:91.
    """
    parts = token.split("_")
    if len(parts) < 4 or not parts[3]:
        raise RuntimeError("Cannot parse storeId from BLOB_READ_WRITE_TOKEN")
    return parts[3]


def _blob_direct_url(pathname: str, token: str, *, access: str = "private") -> str:
    """Construct the direct Blob URL, mirroring SDK `constructBlobUrl`."""
    return f"https://{_store_id_from_token(token)}.{access}.blob.vercel-storage.com/{pathname}"


def _download_blob(pathname: str, local_path: Path, token: str) -> None:
    """Stream-download a Blob to local disk by constructing the direct URL
    from the token's storeId (the SDK's `get()` pattern). Auth via Bearer
    token in the Authorization header — required since access=private.
    """
    url = _blob_direct_url(pathname, token)
    resp = requests.get(
        url,
        headers={"authorization": f"Bearer {token}"},
        stream=True,
        timeout=BLOB_DOWNLOAD_TIMEOUT_S,
    )
    if not resp.ok:
        raise RuntimeError(
            f"Blob download failed ({resp.status_code}) for {pathname}: {resp.text[:500]}"
        )
    with local_path.open("wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            if chunk:
                f.write(chunk)
