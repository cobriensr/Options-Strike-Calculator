"""Cloudflare R2 storage for the Full Tape: one Parquet object per trading day.

Single-threaded by design: one boto3 client, `use_threads=False` on transfers. A client
shared across threads once sent half its R2 calls without TLS verification on the
Windows workstation, so `verify=True` is set explicitly and nothing runs concurrently.

Every listing is scoped to the `fulltape/` prefix; the bucket also holds `gexbot-eod/`,
which this module never touches. Nothing here logs or embeds credentials or tape data.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

from config import Settings

_PREFIX = "fulltape/"
_UNAVAILABLE_PREFIX = "fulltape/_unavailable/"
_SUPERSEDED_PREFIX = "fulltape/_superseded/"
_TAPE_RE = re.compile(r"^fulltape/(\d{4}-\d{2}-\d{2})-fulltape\.parquet$")
_MARKER_RE = re.compile(r"^fulltape/_unavailable/(\d{4}-\d{2}-\d{2})\.json$")
_MULTIPART_THRESHOLD = 64 * 2**20


class R2VerifyError(Exception):
    """An uploaded object's size on R2 differs from the local file."""


def tape_key(day: date) -> str:
    """R2 key of a day's tape Parquet."""
    return f"{_PREFIX}{day.isoformat()}-fulltape.parquet"


class R2Store:
    """Reads and writes tape days in the Full Tape bucket."""

    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.r2_bucket_fulltape
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint_url,
            aws_access_key_id=settings.r2_access_key_id.get_secret_value(),
            aws_secret_access_key=settings.r2_secret_access_key.get_secret_value(),
            region_name="auto",
            verify=True,
            config=Config(
                signature_version="s3v4",
                retries={"mode": "standard", "max_attempts": 5},
            ),
        )
        self._transfer = TransferConfig(multipart_threshold=_MULTIPART_THRESHOLD, use_threads=False)

    def _keys(self, prefix: str) -> list[str]:
        """Every key directly under `prefix` (no subfolders), across all pages."""
        paginator = self._client.get_paginator("list_objects_v2")
        keys: list[str] = []
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix, Delimiter="/"):
            keys.extend(obj["Key"] for obj in page.get("Contents", []))
        return keys

    def landed(self) -> dict[date, dict[str, str]]:
        """Landed days mapped to their user metadata (`{}` for legacy objects).

        Costs ceil(N/1000) list requests plus one `head_object` per day: list results
        carry no user metadata. Any request error propagates, so a day is never
        silently reported landed or unlanded.
        """
        out: dict[date, dict[str, str]] = {}
        for key in self._keys(_PREFIX):
            match = _TAPE_RE.match(key)
            if match is None:
                continue
            head = self._client.head_object(Bucket=self._bucket, Key=key)
            out[date.fromisoformat(match.group(1))] = dict(head.get("Metadata", {}))
        return out

    def unavailable(self) -> set[date]:
        """Days marked as not posted by UW."""
        days: set[date] = set()
        for key in self._keys(_UNAVAILABLE_PREFIX):
            match = _MARKER_RE.match(key)
            if match is not None:
                days.add(date.fromisoformat(match.group(1)))
        return days

    def put_tape(self, path: Path, day: date, metadata: dict[str, str]) -> None:
        """Upload a day's Parquet with metadata, then check R2 holds the same byte count."""
        key = tape_key(day)
        self._client.upload_file(
            str(path),
            self._bucket,
            key,
            ExtraArgs={"Metadata": metadata},
            Config=self._transfer,
        )
        remote = self._client.head_object(Bucket=self._bucket, Key=key)["ContentLength"]
        local = path.stat().st_size
        if remote != local:
            raise R2VerifyError(f"{key}: uploaded {local} bytes but R2 reports {remote}")

    def supersede(self, day: date, source_etag: str) -> str:
        """Copy the current object aside before a re-land; returns the copy's key."""
        key = f"{_SUPERSEDED_PREFIX}{day.isoformat()}-{source_etag.strip(chr(34))}.parquet"
        self._client.copy_object(
            Bucket=self._bucket,
            Key=key,
            CopySource={"Bucket": self._bucket, "Key": tape_key(day)},
            MetadataDirective="COPY",
        )
        return key

    def mark_unavailable(self, day: date, reason: str) -> None:
        """Record that UW has not posted this day."""
        body = json.dumps(
            {"date": day.isoformat(), "reason": reason, "marked_at": datetime.now(UTC).isoformat()}
        )
        self._client.put_object(
            Bucket=self._bucket,
            Key=f"{_UNAVAILABLE_PREFIX}{day.isoformat()}.json",
            Body=body.encode(),
            ContentType="application/json",
        )
