"""Multileg pattern matcher endpoint — handler co-resident on the sidecar.

Wraps ``ml/src/multileg_assembler.classify_trades`` behind a JSON HTTP
route the Vercel-side detect crons can call. Phase 4 of the
fulltape-multileg spec (docs/superpowers/specs/) — the matcher itself
is committed to ml/src; this module is the wire layer.

Architectural shape mirrors ``takeit_server``: pure handler functions
(``handle_classify_payload``) that the existing HealthHandler in
``health.py`` dispatches to. Co-resident on port 8080 — Railway only
forwards one public port, and a separate server would add zero value
since this endpoint is stateless and CPU-bound on the request thread.

Endpoint (wired in sidecar/src/health.py):
    POST /takeit/multileg-classify
    Body: JSON matching MultilegClassifyRequest
    → 200: {"classifications": [MultilegClassification, ...]}
    → 400: empty or missing trades
    → 422: schema validation error (Pydantic)
    → 500: matcher raised unexpectedly (reported to Sentry)

The matcher's required-fields contract is encoded in
``MultilegTradeInput``: id, underlying_symbol, executed_at, strike,
expiry, option_type, size, price, nbbo_bid, nbbo_ask, premium, plus
``option_chain_id`` for downstream attribution. ``delta`` is optional —
the matcher tolerates absence.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)


# ── Path setup ─────────────────────────────────────────────────────────────
#
# The matcher lives in ``ml/src/multileg_assembler.py``. The sidecar shares
# a Python venv with ml/ in CI / Railway (polars is the same install).
# Local dev: add ml/src/ to sys.path the same way ml's conftest.py does for
# its own tests, so the import resolves without restructuring either tree.
# Idempotent — re-running this module is a no-op.
def _ensure_ml_src_on_path() -> None:
    """Prepend ml/src/ to sys.path if not already present.

    Resolves relative to this file: sidecar/src/multileg_routes.py
    → ../../ml/src.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    ml_src = os.path.abspath(os.path.join(here, "..", "..", "ml", "src"))
    if ml_src not in sys.path and os.path.isdir(ml_src):
        sys.path.insert(0, ml_src)


_ensure_ml_src_on_path()


# ── Pydantic models ────────────────────────────────────────────────────────


class MultilegTradeInput(BaseModel):
    """One trade in the classify request.

    Fields mirror the matcher's ``_REQUIRED_FIELDS`` plus the optional
    columns it tolerates (delta). Schema validation here (Pydantic v2)
    converts the 422 path off the matcher's ValueError.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    underlying_symbol: str = Field(min_length=1)
    executed_at: datetime
    option_chain_id: str = Field(min_length=1)
    strike: float
    expiry: date
    option_type: Literal["call", "put", "CALL", "PUT", "Call", "Put"]
    size: float
    price: float
    nbbo_bid: float
    nbbo_ask: float
    premium: float
    delta: float | None = None


class MultilegClassifyRequest(BaseModel):
    """POST /takeit/multileg-classify body."""

    model_config = ConfigDict(extra="forbid")

    trades: list[MultilegTradeInput] = Field(min_length=1)
    # Matcher defaults — kept in sync with classify_trades() signature.
    window_seconds: int = Field(default=90, ge=1)
    strike_tolerance: float = Field(default=0.05, ge=0.0)
    size_tolerance: float = Field(default=0.1, ge=0.0)


class MultilegClassification(BaseModel):
    """One row in the classify response — keyed by input ``id``."""

    model_config = ConfigDict(extra="forbid")

    id: str
    inferred_structure: str
    is_isolated_leg: bool
    match_confidence: float
    pattern_group_id: str


class MultilegClassifyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    classifications: list[MultilegClassification]


# ── Matcher invocation ─────────────────────────────────────────────────────


def _classify_with_polars(request: MultilegClassifyRequest) -> list[dict]:
    """Convert Pydantic input → polars DataFrame, call classify_trades(),
    project to the response dict shape.

    Imports polars + multileg_assembler lazily so the module import is
    cheap when the endpoint isn't being hit (matters: polars binary is
    ~46 MB and only this route needs it).
    """
    import polars as pl  # noqa: PLC0415
    from multileg_assembler import classify_trades  # noqa: PLC0415

    # Build row dicts with normalized option_type. The matcher matches on
    # lower-case 'call' / 'put' (see _two_leg_cross_type_from_batch's
    # option_type[0] == "call" check).
    rows: list[dict] = []
    for t in request.trades:
        rows.append(
            {
                "id": t.id,
                "underlying_symbol": t.underlying_symbol,
                "executed_at": t.executed_at,
                "option_chain_id": t.option_chain_id,
                "strike": float(t.strike),
                "expiry": t.expiry,
                "option_type": t.option_type.lower(),
                "size": float(t.size),
                "price": float(t.price),
                "nbbo_bid": float(t.nbbo_bid),
                "nbbo_ask": float(t.nbbo_ask),
                "premium": float(t.premium),
                "delta": t.delta,
            }
        )

    df = pl.DataFrame(rows).with_columns(
        # The matcher does microsecond datetime arithmetic and partitions
        # on (expiry, option_type). Cast to the exact dtypes it expects.
        pl.col("executed_at").cast(pl.Datetime(time_unit="us", time_zone="UTC")),
        pl.col("expiry").cast(pl.Date),
    )

    classified = classify_trades(
        df,
        window_seconds=request.window_seconds,
        strike_tolerance=request.strike_tolerance,
        size_tolerance=request.size_tolerance,
    )

    # The matcher preserves input row order (it rebuilds output columns
    # via the ``_orig_idx`` row index). We project just the response cols
    # and convert to dicts. ``id`` is the matcher's input id column.
    out = classified.select(
        [
            "id",
            "inferred_structure",
            "is_isolated_leg",
            "match_confidence",
            "pattern_group_id",
        ]
    )
    return out.to_dicts()


# ── Public entry point (called by health.py) ──────────────────────────────


def handle_classify_payload(body_bytes: bytes) -> tuple[int, dict]:
    """Parse + dispatch a POST /takeit/multileg-classify body.

    Returns ``(http_status, json_body)``. The HealthHandler caller is
    responsible for writing the response headers + body; we just emit the
    status code and the JSON payload.

    Error mapping:
        - JSON decode error  → 400
        - empty/missing trades or invalid types → 422 (Pydantic)
        - unexpected matcher exception → 500 (reported to Sentry)
    """
    import json  # noqa: PLC0415

    try:
        payload = json.loads(body_bytes)
    except (ValueError, json.JSONDecodeError):
        return 400, {"error": "body must be valid JSON"}

    if not isinstance(payload, dict):
        return 400, {"error": "body must be a JSON object"}

    # Explicit "missing trades" → 400 (per spec), distinct from 422 schema
    # errors. Pydantic would also raise here, but with a less helpful
    # message and 422 status; we want callers to be able to tell the two
    # apart without parsing error strings.
    if "trades" not in payload:
        return 400, {"error": "trades is required"}
    if not isinstance(payload["trades"], list) or len(payload["trades"]) == 0:
        return 400, {"error": "trades must be a non-empty list"}

    try:
        request = MultilegClassifyRequest.model_validate(payload)
    except ValidationError as exc:
        return 422, {"error": "schema validation failed", "details": exc.errors()}

    try:
        results = _classify_with_polars(request)
    except Exception as exc:  # noqa: BLE001
        logger.exception("multileg classify failed: unexpected")
        # Sentry capture is best-effort — the sentry_setup module is
        # available in the sidecar and a no-op when SENTRY_DSN is unset.
        try:
            from sentry_setup import capture_exception  # noqa: PLC0415

            capture_exception(
                exc, tags={"component": "multileg_routes", "route": "classify"}
            )
        except Exception:  # noqa: BLE001 — never let logging break the response
            pass
        return 500, {"error": str(exc)}

    return 200, {"classifications": results}
