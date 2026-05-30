#!/usr/bin/env python3
"""Upload local UW Full Tape parquets to Cloudflare R2.

Idempotent: lists what's already in the bucket and skips matching keys.
Used as a one-shot to seed R2 with the existing local archive, then
called repeatedly as new daily parquets land in the local dir.

Naming convention in R2 mirrors the local convention:
    fulltape/{YYYY-MM-DD}-fulltape.parquet

Auth — required env vars (set in .env.local):
    R2_ACCOUNT_ID
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_ENDPOINT_URL          # https://<account-id>.r2.cloudflarestorage.com
    R2_BUCKET_FULLTAPE       # e.g. theta-options-fulltape

Usage:
    # One-shot upload everything missing in R2:
    ml/.venv/bin/python scripts/upload-fulltape-to-r2.py

    # Custom local dir:
    INPUT_DIR=~/Desktop/Eod-Full-Tape-parquet \\
      ml/.venv/bin/python scripts/upload-fulltape-to-r2.py

    # Dry-run (list what would upload, do nothing):
    ml/.venv/bin/python scripts/upload-fulltape-to-r2.py --dry-run

    # Force re-upload of specific date (overwrites in R2):
    ml/.venv/bin/python scripts/upload-fulltape-to-r2.py --force 2026-03-15
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError


KEY_PREFIX = "fulltape/"
DEFAULT_LOCAL_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"


def load_env_local() -> None:
    """Load .env.local from repo root if present. Pure-Python, no deps."""
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        # Strip trailing inline comment, e.g. "VALUE  # comment".
        # Done by find rather than split so '#' inside a quoted value
        # — like a Slack webhook with a fragment — survives the parse.
        comment_idx = val.find(" #")
        if comment_idx >= 0:
            val = val[:comment_idx].rstrip()
        if key and key not in os.environ:
            os.environ[key] = val


def must_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        sys.stderr.write(f"❌ Missing env var: {name}\n")
        sys.stderr.write("   Set it in .env.local (see docs/superpowers/specs/r2-archive-2026-05-10.md)\n")
        sys.exit(2)
    return val


def make_client():
    return boto3.client(
        "s3",
        endpoint_url=must_env("R2_ENDPOINT_URL"),
        aws_access_key_id=must_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=must_env("R2_SECRET_ACCESS_KEY"),
        # R2 uses a unified region label; "auto" works for all regions.
        region_name="auto",
        # Force path-style addressing for non-AWS S3-compatible stores.
        # The boto default would try virtual-hosted-style which R2's
        # endpoint doesn't support cleanly when the bucket name has dots.
        #
        # Adaptive retries (5 attempts) cover BOTH list_objects_v2 and
        # upload_file at the botocore layer — transient R2 throttling (429)
        # and 5xx are retried with client-side rate limiting before any
        # exception surfaces to our handler below.
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 5, "mode": "adaptive"},
        ),
    )


def list_remote_keys(client, bucket: str) -> set[str]:
    """Return set of keys already present under KEY_PREFIX in the bucket."""
    keys: set[str] = set()
    token: str | None = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": KEY_PREFIX}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            keys.add(obj["Key"])
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return keys


def local_to_key(path: Path) -> str:
    """Map a local *-fulltape.parquet path to its R2 key."""
    return f"{KEY_PREFIX}{path.name}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload UW Full Tape parquets to R2")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would upload, but do nothing",
    )
    parser.add_argument(
        "--force",
        nargs="*",
        metavar="DATE",
        default=[],
        help="Force re-upload of these YYYY-MM-DD dates even if present in R2",
    )
    args = parser.parse_args()

    load_env_local()
    bucket = must_env("R2_BUCKET_FULLTAPE")

    input_dir = Path(os.environ.get("INPUT_DIR", str(DEFAULT_LOCAL_DIR)))
    if not input_dir.is_dir():
        sys.stderr.write(f"❌ Local dir not found: {input_dir}\n")
        return 2

    local_files = sorted(input_dir.glob("*-fulltape.parquet"))
    if not local_files:
        sys.stderr.write(f"⚠️  No *-fulltape.parquet files in {input_dir}\n")
        return 0

    print(f"→ Local source: {input_dir} ({len(local_files)} files)")
    client = make_client()

    print(f"→ Listing remote bucket {bucket} under prefix {KEY_PREFIX!r}...")
    remote_keys = list_remote_keys(client, bucket)
    print(f"  found {len(remote_keys)} existing R2 keys")

    force_dates = set(args.force)
    to_upload: list[Path] = []
    for f in local_files:
        key = local_to_key(f)
        date_str = f.stem.replace("-fulltape", "")
        if key in remote_keys and date_str not in force_dates:
            continue
        to_upload.append(f)

    if not to_upload:
        print("✅ Nothing to upload — R2 already has every local file.")
        return 0

    total_bytes = sum(f.stat().st_size for f in to_upload)
    print(
        f"→ Will upload {len(to_upload)} files "
        f"({total_bytes / 1024 / 1024 / 1024:.1f} GiB)"
    )
    if args.dry_run:
        for f in to_upload[:10]:
            print(f"   would upload: {f.name} ({f.stat().st_size / 1024 / 1024:.1f} MiB)")
        if len(to_upload) > 10:
            print(f"   ... ({len(to_upload) - 10} more)")
        print("(dry-run — no files transferred)")
        return 0

    uploaded_bytes = 0
    started = time.monotonic()
    failed: list[tuple[str, str]] = []
    for i, f in enumerate(to_upload, start=1):
        key = local_to_key(f)
        size = f.stat().st_size
        t0 = time.monotonic()
        try:
            # boto3's upload_file uses multipart automatically for files
            # > 8 MB by default. R2 supports multipart and signs each part
            # via SigV4 — works out of the box with the s3 client above.
            client.upload_file(
                Filename=str(f),
                Bucket=bucket,
                Key=key,
                ExtraArgs={"ContentType": "application/x-parquet"},
            )
        except (ClientError, BotoCoreError) as e:
            # Catch BotoCoreError too — transient transport failures
            # (EndpointConnectionError, ReadTimeoutError, ConnectTimeoutError)
            # are NOT ClientError subclasses and would otherwise crash the
            # whole batch after botocore exhausts its own retries.
            # Don't abandon the batch — every upload is idempotent (skip-if-
            # present), so we record the failure and keep going. Operator gets
            # a full list at the end and can re-run to retry just the failures.
            sys.stderr.write(f"❌ [{i}/{len(to_upload)}] {f.name}: {e}\n")
            failed.append((f.name, str(e)))
            continue
        elapsed = time.monotonic() - t0
        mibps = size / 1024 / 1024 / max(elapsed, 0.001)
        uploaded_bytes += size
        gib_done = uploaded_bytes / 1024 / 1024 / 1024
        gib_total = total_bytes / 1024 / 1024 / 1024
        print(
            f"  [{i}/{len(to_upload)}] {f.name} "
            f"({size / 1024 / 1024:.1f} MiB in {elapsed:.1f}s, {mibps:.1f} MiB/s) "
            f"— total {gib_done:.1f}/{gib_total:.1f} GiB"
        )

    total_elapsed = time.monotonic() - started
    succeeded = len(to_upload) - len(failed)
    print(
        f"{'⚠️ ' if failed else '✅'} Upload complete: "
        f"{succeeded}/{len(to_upload)} files, "
        f"{uploaded_bytes / 1024 / 1024 / 1024:.1f} GiB in {total_elapsed:.0f}s"
    )
    if failed:
        sys.stderr.write(f"❌ {len(failed)} upload(s) failed:\n")
        for name, err in failed:
            sys.stderr.write(f"  {name}: {err}\n")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
