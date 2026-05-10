"""R2-aware parquet read helper for the UW Full Tape archive.

Lets ML pipeline code be source-agnostic:

    >>> from utils.r2 import read_fulltape
    >>> df = read_fulltape("2026-03-15")           # local cache → falls back to R2
    >>> df = read_fulltape("2026-03-15", force_r2=True)   # always pull from R2

Two read backends are exposed because they have different sweet spots:
  - `read_fulltape(date)` returns a pandas DataFrame for ad-hoc analysis.
  - `query_fulltape(sql, dates)` runs a DuckDB query directly against R2
    parquets — no full-file download, only the column ranges DuckDB
    needs travel over the wire. Use this for any SELECT / GROUP-BY work
    where you don't need every column.

Auth: same env vars as scripts/upload-fulltape-to-r2.py
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT_URL, R2_BUCKET_FULLTAPE
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import pandas as pd

KEY_PREFIX = "fulltape/"
DEFAULT_LOCAL_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"


def _must_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(
            f"Missing env var {name!r}. Set in .env.local. "
            f"See docs/superpowers/specs/r2-archive-2026-05-10.md"
        )
    return val


def _local_path(date: str) -> Path:
    """Local cache path for a date, regardless of whether the file exists."""
    base = Path(os.environ.get("INPUT_DIR", str(DEFAULT_LOCAL_DIR)))
    return base / f"{date}-fulltape.parquet"


@lru_cache(maxsize=1)
def _r2_storage_options() -> dict:
    """Build the storage_options dict for pandas/pyarrow's S3 reader.

    pyarrow uses fsspec under the hood for s3:// paths, which respects
    `endpoint_url` + `key`/`secret`. Cached because env-loading is the
    same on every call.
    """
    return {
        "key": _must_env("R2_ACCESS_KEY_ID"),
        "secret": _must_env("R2_SECRET_ACCESS_KEY"),
        "client_kwargs": {"endpoint_url": _must_env("R2_ENDPOINT_URL")},
    }


def r2_url(date: str) -> str:
    """Construct the s3:// URL for a date's parquet in R2."""
    bucket = _must_env("R2_BUCKET_FULLTAPE")
    return f"s3://{bucket}/{KEY_PREFIX}{date}-fulltape.parquet"


def read_fulltape(
    date: str,
    *,
    force_r2: bool = False,
    columns: list[str] | None = None,
) -> pd.DataFrame:
    """Read one day's UW Full Tape into a pandas DataFrame.

    Tries local cache first (instant); falls back to R2 on miss. Pass
    `force_r2=True` to always read from R2 — useful for verifying that
    a recent upload actually made it.

    `columns=[...]` is forwarded to pyarrow so only those columns are
    read off disk / downloaded — meaningful saving on the wire when
    pulling from R2.
    """
    local = _local_path(date)
    if not force_r2 and local.exists():
        return pd.read_parquet(local, columns=columns)
    return pd.read_parquet(
        r2_url(date),
        columns=columns,
        storage_options=_r2_storage_options(),
    )


def query_fulltape(sql: str, dates: list[str]) -> pd.DataFrame:
    """Run a DuckDB SQL query against the R2 parquets for the given dates.

    Use this when you only need aggregates / a column subset — DuckDB
    will only download the column ranges it needs (parquet row-group
    metadata + range requests), not the whole file.

    `sql` must reference the parquet via the literal string `__TAPE__`,
    which this function substitutes with the appropriate
    `read_parquet(...)` invocation under the hood. Example:

        query_fulltape(
            '''
            SELECT ticker, SUM(size) AS total_size
            FROM __TAPE__
            WHERE strike BETWEEN 7350 AND 7450
            GROUP BY ticker
            ORDER BY total_size DESC
            ''',
            dates=["2026-03-15", "2026-03-16"],
        )
    """
    import duckdb  # local import — keeps cold-start light when caller only needs read_fulltape

    if not dates:
        raise ValueError("query_fulltape: dates list is empty")

    urls = [r2_url(d) for d in dates]
    # DuckDB's read_parquet can take a list literal — single scan covers
    # all days. Embeds the URLs as a SQL list to keep the query stable.
    url_list = "[" + ", ".join(f"'{u}'" for u in urls) + "]"
    expanded = sql.replace("__TAPE__", f"read_parquet({url_list})")

    con = duckdb.connect()
    # Configure the httpfs extension to talk to R2.
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"SET s3_endpoint='{_must_env('R2_ENDPOINT_URL').replace('https://', '')}';")
    con.execute(f"SET s3_access_key_id='{_must_env('R2_ACCESS_KEY_ID')}';")
    con.execute(f"SET s3_secret_access_key='{_must_env('R2_SECRET_ACCESS_KEY')}';")
    con.execute("SET s3_url_style='path';")
    con.execute("SET s3_region='auto';")
    return con.execute(expanded).df()
