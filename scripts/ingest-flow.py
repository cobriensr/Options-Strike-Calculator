#!/usr/bin/env python3
"""Ingest a UW EOD options flow CSV: validate, filter, write Parquet, upload to Blob.

Usage:
    ml/.venv/bin/python scripts/ingest-flow.py <YYYY-MM-DD>
    ml/.venv/bin/python scripts/ingest-flow.py 2026-04-24 --keep-csv
    ml/.venv/bin/python scripts/ingest-flow.py 2026-04-24 --dry-run

Spec: docs/superpowers/specs/options-flow-archive-2026-04-28.md

Pre-flight: source .env.local so BLOB_READ_WRITE_TOKEN is exported.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import urllib.parse
from datetime import UTC, date as dt_date, datetime, time
from pathlib import Path

import polars as pl
import requests

# --- Schema (frozen — pinned to docs/superpowers/specs/options-flow-archive-2026-04-28.md) ---

FLOW_SCHEMA: dict[str, pl.DataType] = {
    "executed_at": pl.Datetime("us", "UTC"),
    "underlying_symbol": pl.Utf8,
    "option_chain_id": pl.Utf8,
    "side": pl.Utf8,
    "strike": pl.Float64,
    "option_type": pl.Utf8,
    "expiry": pl.Date,
    "underlying_price": pl.Float64,
    "nbbo_bid": pl.Float64,
    "nbbo_ask": pl.Float64,
    "ewma_nbbo_bid": pl.Float64,
    "ewma_nbbo_ask": pl.Float64,
    "price": pl.Float64,
    "size": pl.Int32,
    "premium": pl.Float64,
    "volume": pl.Int32,
    "open_interest": pl.Int32,
    "implied_volatility": pl.Float64,
    "delta": pl.Float64,
    "theta": pl.Float64,
    "gamma": pl.Float64,
    "vega": pl.Float64,
    "rho": pl.Float64,
    "theo": pl.Float64,
    "sector": pl.Utf8,
    "exchange": pl.Utf8,
    "report_flags": pl.Utf8,
    # UW emits `f`/`t` literals here, not bools. Cast in transform().
    "canceled": pl.Utf8,
    "upstream_condition_detail": pl.Utf8,
    "equity_type": pl.Utf8,
}

VALID_SIDE = {"ask", "bid", "mid", "no_side"}
VALID_OPTION_TYPE = {"put", "call"}
VALID_EQUITY_TYPE = {"ADR", "Common Stock", "ETF", "Index", "Other", "Unit"}

# Cash session in UTC: 13:30 inclusive → 20:00 exclusive (08:30–15:00 CT)
CASH_SESSION_START_UTC = time(13, 30)
CASH_SESSION_END_UTC = time(20, 0)
SANITY_FLOOR_ROWS = 1_000_000

# Vercel Blob REST API — verified against @vercel/blob 2.3.3 SDK source
# (node_modules/@vercel/blob/dist/chunk-WLMB4XQD.js).
BLOB_API_BASE = "https://vercel.com/api/blob"
BLOB_API_VERSION = "12"
BLOB_UPLOAD_TIMEOUT_S = 600  # 10 min ceiling per request

# Vercel Blob single-shot PUT 413's somewhere ~500 MB (observed: 493 MB worked,
# 538 MB failed). Anything past this threshold goes through the /mpu multipart
# protocol, which mirrors what the Node SDK does when `multipart: true`.
MULTIPART_THRESHOLD = 100 * 1024 * 1024  # 100 MB
MULTIPART_PART_SIZE = 50 * 1024 * 1024  # 50 MB per part — 11 parts for 550 MB

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT_DIR = Path.home() / "Downloads" / "EOD-OptionFlow"
LOCAL_PARQUET_ROOT = Path.home() / ".flow-archive"


def expected_csv_path(date: str, input_dir: Path) -> Path:
    return input_dir / f"bot-eod-report-{date}.csv"


def parquet_local_path(date: str) -> Path:
    y, m, d = date.split("-")
    return LOCAL_PARQUET_ROOT / f"year={y}" / f"month={m}" / f"day={d}" / "data.parquet"


def blob_pathname(date: str) -> str:
    y, m, d = date.split("-")
    return f"flow/year={y}/month={m}/day={d}/data.parquet"


def validate_header(csv_path: Path) -> None:
    """Hard-fail if header doesn't match the 30 expected columns in order."""
    expected = list(FLOW_SCHEMA.keys())
    with csv_path.open("r") as f:
        header = f.readline().strip().split(",")
    if header != expected:
        missing = sorted(set(expected) - set(header))
        extra = sorted(set(header) - set(expected))
        raise ValueError(
            f"CSV header mismatch in {csv_path.name}.\n"
            f"  Missing: {missing or 'none'}\n"
            f"  Extra:   {extra or 'none'}\n"
            f"  Got first 5: {header[:5]} ({len(header)} cols)\n"
            f"  Want first 5: {expected[:5]} ({len(expected)} cols)"
        )


def transform(lf: pl.LazyFrame, date: str) -> pl.LazyFrame:
    """Filter to cash session, drop ETH-flagged, sort, add date+ingested_at,
    and cast `canceled` from UW's `f`/`t` literals to bool."""
    date_obj = dt_date.fromisoformat(date)
    ingested_at = datetime.now(UTC)
    return (
        lf.filter(
            (pl.col("executed_at").dt.time() >= CASH_SESSION_START_UTC)
            & (pl.col("executed_at").dt.time() < CASH_SESSION_END_UTC)
        )
        # `.fill_null(True)` keeps rows where report_flags is null — `~str.contains`
        # returns null on null input, which would silently drop those rows otherwise.
        .filter(
            pl.col("report_flags")
            .str.contains("extended_hours_trade")
            .not_()
            .fill_null(True)
        )
        .sort(["underlying_symbol", "executed_at"])
        .with_columns(
            (pl.col("canceled") == "t").alias("canceled"),
            pl.lit(date_obj).alias("date"),
            pl.lit(ingested_at).alias("ingested_at"),
        )
    )


def validate_categoricals(df: pl.DataFrame) -> None:
    """Hard-fail if closed-enum columns contain unknown values."""
    for col, allowed in (
        ("side", VALID_SIDE),
        ("option_type", VALID_OPTION_TYPE),
        ("equity_type", VALID_EQUITY_TYPE),
    ):
        present = {v for v in df[col].unique().to_list() if v is not None}
        unknown = present - allowed
        if unknown:
            raise ValueError(
                f"Column '{col}' has unknown values: {sorted(unknown)}. "
                f"If UW added a category, update the enum in scripts/ingest-flow.py."
            )


def _put_option_headers(token: str) -> dict[str, str]:
    """Headers that map to put() options: auth, version, access, overwrite, type."""
    return {
        "authorization": f"Bearer {token}",
        "x-api-version": BLOB_API_VERSION,
        "x-content-type": "application/vnd.apache.parquet",
        "x-vercel-blob-access": "private",
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "1",
    }


def _upload_singleshot(parquet_path: Path, pathname: str, token: str) -> dict:
    """Single-shot PUT for files under MULTIPART_THRESHOLD."""
    size = parquet_path.stat().st_size
    qs = urllib.parse.urlencode({"pathname": pathname})
    headers = {
        **_put_option_headers(token),
        "x-content-length": str(size),
        "content-length": str(size),
        "content-type": "application/vnd.apache.parquet",
    }
    with parquet_path.open("rb") as f:
        resp = requests.put(
            f"{BLOB_API_BASE}/?{qs}",
            headers=headers,
            data=f,
            timeout=BLOB_UPLOAD_TIMEOUT_S,
        )
    if not resp.ok:
        raise RuntimeError(
            f"Blob upload failed ({resp.status_code}): {resp.text[:500]}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise RuntimeError(
            f"Blob upload returned 2xx but body wasn't JSON "
            f"(content-type={resp.headers.get('content-type')!r}, "
            f"body_preview={resp.text[:200]!r})"
        ) from exc


def _mpu_create(pathname: str, token: str) -> dict:
    """Initiate multipart upload — returns {key, uploadId}."""
    qs = urllib.parse.urlencode({"pathname": pathname})
    headers = {**_put_option_headers(token), "x-mpu-action": "create"}
    resp = requests.post(
        f"{BLOB_API_BASE}/mpu?{qs}", headers=headers, timeout=60
    )
    if not resp.ok:
        raise RuntimeError(
            f"mpu create failed ({resp.status_code}): {resp.text[:500]}"
        )
    return resp.json()


def _mpu_upload_part(
    pathname: str,
    key: str,
    upload_id: str,
    part_number: int,
    body: bytes,
    token: str,
) -> dict:
    """Upload one part — returns {etag, partNumber}."""
    qs = urllib.parse.urlencode({"pathname": pathname})
    headers = {
        **_put_option_headers(token),
        "x-mpu-action": "upload",
        "x-mpu-key": urllib.parse.quote(key, safe=""),
        "x-mpu-upload-id": upload_id,
        "x-mpu-part-number": str(part_number),
        "content-length": str(len(body)),
    }
    resp = requests.post(
        f"{BLOB_API_BASE}/mpu?{qs}",
        headers=headers,
        data=body,
        timeout=BLOB_UPLOAD_TIMEOUT_S,
    )
    if not resp.ok:
        raise RuntimeError(
            f"mpu part {part_number} failed ({resp.status_code}): {resp.text[:500]}"
        )
    return resp.json()


def _mpu_complete(
    pathname: str,
    key: str,
    upload_id: str,
    parts: list[dict],
    token: str,
) -> dict:
    """Finalize multipart — returns final blob result {url, pathname, etag, ...}."""
    qs = urllib.parse.urlencode({"pathname": pathname})
    headers = {
        **_put_option_headers(token),
        "x-mpu-action": "complete",
        "x-mpu-key": urllib.parse.quote(key, safe=""),
        "x-mpu-upload-id": upload_id,
        "content-type": "application/json",
    }
    resp = requests.post(
        f"{BLOB_API_BASE}/mpu?{qs}", headers=headers, json=parts, timeout=60
    )
    if not resp.ok:
        raise RuntimeError(
            f"mpu complete failed ({resp.status_code}): {resp.text[:500]}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise RuntimeError(
            f"mpu complete returned 2xx but body wasn't JSON "
            f"(content-type={resp.headers.get('content-type')!r})"
        ) from exc


def _upload_multipart(parquet_path: Path, pathname: str, token: str) -> dict:
    """Multipart upload via /mpu — required for files past the single-shot 413
    cliff. Three-phase protocol (create → upload-parts → complete) mirroring
    @vercel/blob put() with multipart=true.

    Caveat: a failure between create and complete leaves an orphaned upload
    session on Vercel's side. The SDK and its type definitions expose NO
    server-side abort method — only a client-side AbortSignal for cancelling
    in-flight fetches. Verified by greping `node_modules/@vercel/blob/dist/`.
    Vercel will GC stale multipart sessions server-side (standard pattern;
    S3 lifecycle equivalent). Reruns are safe because allowOverwrite=1.
    """
    size = parquet_path.stat().st_size
    expected_parts = (size + MULTIPART_PART_SIZE - 1) // MULTIPART_PART_SIZE
    print(
        f"  multipart: {size / 1024**2:.1f} MB in ~{expected_parts} part(s) "
        f"of {MULTIPART_PART_SIZE / 1024**2:.0f} MB"
    )
    create = _mpu_create(pathname, token)
    key, upload_id = create["key"], create["uploadId"]

    parts: list[dict] = []
    part_number = 1
    with parquet_path.open("rb") as f:
        while True:
            chunk = f.read(MULTIPART_PART_SIZE)
            if not chunk:
                break
            print(
                f"  part {part_number}/{expected_parts} ({len(chunk) / 1024**2:.1f} MB)"
            )
            result = _mpu_upload_part(
                pathname, key, upload_id, part_number, chunk, token
            )
            parts.append({"partNumber": part_number, "etag": result["etag"]})
            part_number += 1

    return _mpu_complete(pathname, key, upload_id, parts, token)


def upload_to_blob(parquet_path: Path, pathname: str, token: str) -> dict:
    """Upload to Vercel Blob, dispatching single-shot vs multipart by size.

    Returns the parsed JSON response: {url, downloadUrl, pathname, etag, ...}.
    Raises RuntimeError on any failure — caller deletes source CSV only on
    a clean return.
    """
    size = parquet_path.stat().st_size
    if size >= MULTIPART_THRESHOLD:
        return _upload_multipart(parquet_path, pathname, token)
    return _upload_singleshot(parquet_path, pathname, token)


def cleanup_empty_parents(path: Path, stop_at: Path) -> None:
    """Remove empty parent dirs up to (but not including) stop_at."""
    parent = path.parent
    while parent != stop_at and parent.is_dir():
        try:
            parent.rmdir()
        except OSError:
            return
        parent = parent.parent


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("date", help="Trading date in YYYY-MM-DD format")
    p.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    p.add_argument("--keep-csv", action="store_true", help="Don't delete source CSV")
    p.add_argument("--dry-run", action="store_true", help="Skip upload + cleanup")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        print(f"ERROR: date must be YYYY-MM-DD, got {args.date!r}", file=sys.stderr)
        return 2

    csv_path = expected_csv_path(args.date, args.input_dir)
    if not csv_path.is_file():
        print(f"ERROR: CSV not found: {csv_path}", file=sys.stderr)
        return 2

    token: str = ""
    if not args.dry_run:
        token = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
        if not token:
            print(
                "ERROR: BLOB_READ_WRITE_TOKEN not set. Run `source .env.local` first.",
                file=sys.stderr,
            )
            return 2

    print(f"→ Validating header: {csv_path.name}")
    validate_header(csv_path)

    print("→ Counting raw rows (streaming)")
    lf = pl.scan_csv(csv_path, schema=FLOW_SCHEMA, infer_schema_length=0)
    raw_count = lf.select(pl.len()).collect(engine="streaming").item()
    print(f"  raw rows: {raw_count:,}")

    if raw_count == 0:
        print("ERROR: empty CSV", file=sys.stderr)
        return 2
    if raw_count < SANITY_FLOOR_ROWS:
        print(
            f"WARN: row count below sanity floor ({SANITY_FLOOR_ROWS:,}); continuing"
        )

    print("→ Filtering + sorting")
    df = transform(lf, args.date).collect(engine="streaming")
    print(f"  kept rows: {df.height:,} ({df.height / raw_count * 100:.1f}%)")

    print("→ Validating closed enums")
    validate_categoricals(df)

    parquet_path = parquet_local_path(args.date)
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"→ Writing Parquet: {parquet_path}")
    df.write_parquet(
        parquet_path,
        compression="zstd",
        compression_level=3,
        row_group_size=1_048_576,
        statistics=True,
    )

    csv_size = csv_path.stat().st_size
    parquet_size = parquet_path.stat().st_size
    print(f"  CSV     {csv_size / 1024**3:.2f} GB")
    print(f"  Parquet {parquet_size / 1024**2:.1f} MB")
    print(f"  Ratio   {csv_size / parquet_size:.1f}×")

    if args.dry_run:
        print("DRY RUN — keeping local files, skipping upload")
        return 0

    pathname = blob_pathname(args.date)
    print(f"→ Uploading to Blob: {pathname}")
    upload_result = upload_to_blob(parquet_path, pathname, token)
    print(f"  url:      {upload_result.get('url')}")
    print(f"  pathname: {upload_result.get('pathname')}")

    if upload_result.get("pathname") != pathname:
        raise RuntimeError(
            f"Pathname mismatch — sent={pathname!r} got={upload_result.get('pathname')!r}"
        )

    if not args.keep_csv:
        print(f"→ Deleting source CSV: {csv_path}")
        csv_path.unlink()

    print(f"→ Deleting local Parquet: {parquet_path}")
    parquet_path.unlink()
    cleanup_empty_parents(parquet_path, LOCAL_PARQUET_ROOT)

    tops = (
        df.group_by("underlying_symbol")
        .len()
        .sort("len", descending=True)
        .head(10)
    )
    print("\nTop 10 underlyings:")
    for sym, n in tops.iter_rows():
        print(f"  {sym:<10} {n:>10,}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
