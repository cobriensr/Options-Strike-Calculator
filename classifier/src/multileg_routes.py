"""Multileg pattern matcher route handler.

Wraps ``_vendored_ml/multileg_assembler.classify_trades`` behind a
``handle_classify_payload`` pure function: bytes in → ``(status, body)``
out. The HTTP plumbing in ``server.py`` is responsible for socket I/O;
this module owns parsing, validation, dispatch, and error mapping.

Ported from ``sidecar/src/multileg_routes.py`` as part of the dedicated
classifier service split — see
``docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md``.
The sidecar version dispatched from a multi-purpose HealthHandler co-resident
with Databento and Theta Terminal probes; this version lives on its own
HTTP server (``server.ClassifierHandler``) so a polars crash can't take
down the futures relay.

The dynamic ``_ensure_ml_src_on_path`` shim that the sidecar carried is
gone here — the classifier image's ``PYTHONPATH=/app/src:/app/_vendored_ml``
(set in the Dockerfile) and the matching ``pythonpath`` entries in
``pyproject.toml`` make ``from multileg_assembler import classify_trades``
resolve directly. No sys.path manipulation needed.

Endpoint contract (HTTP shape lives in ``server.py``):
    POST /multileg-classify
    Body: JSON matching ``MultilegClassifyRequest``
    → 200: {"classifications": [MultilegClassification, ...]}
    → 400: empty or missing trades, malformed JSON, or non-standard JSON
           constants (bareword ``NaN`` / ``Infinity`` / ``-Infinity``
           are rejected at parse time before Pydantic ever sees them).
    → 422: schema validation error (Pydantic). Notable triggers:
           ``executed_at`` must be tz-aware ISO 8601 (naive datetime
           is rejected because the polars cast would relabel it as UTC
           without conversion); NaN / ±Infinity in any numeric field
           is rejected here as a defense-in-depth backstop to the 400
           parse-time gate (covers non-JSON future code paths);
           ``window_seconds`` must be in [1, 600], ``strike_tolerance``
           in [0.0, 0.5], ``size_tolerance`` in [0.0, 1.0]; strict-mode
           rejects ``bool`` → ``float`` and ``str`` → number coercion.
    → 500: matcher raised unexpectedly (reported to Sentry).

The matcher's required-fields contract is encoded in
``MultilegTradeInput``: id, underlying_symbol, executed_at, strike,
expiry, option_type, size, price, nbbo_bid, nbbo_ask, premium, plus
``option_chain_id`` for downstream attribution. ``delta`` is optional —
the matcher tolerates absence.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Annotated, Literal, NoReturn

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
)
from pydantic.types import Strict

logger = logging.getLogger(__name__)


# ── Pydantic models ────────────────────────────────────────────────────────
#
# All numeric fields use ``allow_inf_nan=False`` (Finding 1.2) so a bareword
# ``NaN`` / ``Infinity`` that survives the JSON layer (or a float NaN passed
# in via some non-JSON future code path) still gets rejected at validation.
# Each model also opts into ``strict=True`` (Finding 3.5) which:
#   • blocks ``True`` / ``False`` coercing to 1.0 / 0.0 for float fields, and
#   • blocks string → number coercion (``"450"`` → 450.0).
# Because strict mode also blocks the default ISO-string-to-datetime/date
# coercion, ``executed_at`` and ``expiry`` are wrapped in ``Strict(False)``
# so the wire contract (``"2026-05-15T15:30:00Z"``, ``"2026-05-15"``)
# continues to deserialize.


# Float field whose validation rejects NaN / +inf / -inf.
_StrictFloat = Annotated[float, Field(allow_inf_nan=False)]


class MultilegTradeInput(BaseModel):
    """One trade in the classify request.

    Fields mirror the matcher's ``_REQUIRED_FIELDS`` plus the optional
    columns it tolerates (delta). Schema validation here (Pydantic v2)
    converts the 422 path off the matcher's ValueError.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1)
    underlying_symbol: str = Field(min_length=1)
    # ``Strict(False)`` re-enables ISO 8601 string coercion that the
    # model-wide ``strict=True`` would otherwise block. We still enforce
    # tz-awareness via the field validator below (Finding 1.3).
    executed_at: Annotated[datetime, Strict(False)]
    option_chain_id: str = Field(min_length=1)
    strike: _StrictFloat
    expiry: Annotated[date, Strict(False)]
    option_type: Literal["call", "put", "CALL", "PUT", "Call", "Put"]
    size: _StrictFloat
    price: _StrictFloat
    nbbo_bid: _StrictFloat
    nbbo_ask: _StrictFloat
    premium: _StrictFloat
    delta: _StrictFloat | None = None

    @field_validator("executed_at")
    @classmethod
    def _require_tz(cls, v: datetime) -> datetime:
        """Reject naive ``executed_at`` (Finding 1.3).

        The matcher casts the ``executed_at`` column to
        ``Datetime(time_unit='us', time_zone='UTC')`` (see ``_classify_with_polars``
        below) which *relabels* a naive datetime as UTC without converting
        it. A trade stamped ``"2026-05-15T10:30:00"`` (intended ET → 14:30
        UTC) would silently bucket at 10:30 UTC. Reject up front.
        """
        if v.tzinfo is None:
            raise ValueError(
                "executed_at must include timezone (use 'Z' or '+00:00')"
            )
        return v


class MultilegClassifyRequest(BaseModel):
    """POST /multileg-classify body."""

    model_config = ConfigDict(extra="forbid", strict=True)

    trades: list[MultilegTradeInput] = Field(min_length=1)
    # Matcher defaults — kept in sync with classify_trades() signature.
    # Upper bounds (Finding 1.8) cap inputs that would otherwise feed the
    # matcher's near-quadratic cross-join into an OOM. ``window_seconds``
    # production caller uses 90; 600 (10 min) is the absolute ceiling.
    # ``strike_tolerance`` and ``size_tolerance`` are bounded to 0.5 (50%)
    # and 1.0 (100%) respectively — past those, the join is matching noise.
    window_seconds: int = Field(default=90, ge=1, le=600)
    strike_tolerance: Annotated[
        float, Field(default=0.05, ge=0.0, le=0.5, allow_inf_nan=False)
    ]
    size_tolerance: Annotated[
        float, Field(default=0.1, ge=0.0, le=1.0, allow_inf_nan=False)
    ]


class MultilegClassification(BaseModel):
    """One row in the classify response — keyed by input ``id``.

    Fields beyond ``id`` must be present in every row but may carry a
    ``null`` value (Finding 1.1 server side). This is "key required,
    value nullable" — NOT "key may be omitted". The matcher's
    ``_MAX_CELL_ROWS_PER_CLASSIFY`` overload-skip path emits a row with
    every classification column set to ``null`` when a ticker is
    skipped, and the TS Zod client (Task 5) needs to accept that shape
    to stop reporting legitimate skip events as opaque
    ``schema_mismatch`` failures.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    id: str
    inferred_structure: str | None
    is_isolated_leg: bool | None
    match_confidence: _StrictFloat | None
    pattern_group_id: str | None


class MultilegClassifyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    classifications: list[MultilegClassification]


# ── Matcher invocation ─────────────────────────────────────────────────────


def _classify_with_polars(request: MultilegClassifyRequest) -> list[dict]:
    """Convert Pydantic input → polars DataFrame, call classify_trades(),
    project to the response dict shape.

    Imports polars + multileg_assembler lazily so the module import is
    cheap when the endpoint isn't being hit (matters: polars binary is
    ~46 MB and only this route needs it).
    """
    import polars as pl
    from multileg_assembler import classify_trades

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


# ── Public entry point (called by server.ClassifierHandler) ────────────────


def handle_classify_payload(body_bytes: bytes) -> tuple[int, dict]:
    """Parse + dispatch a POST /multileg-classify body.

    Returns ``(http_status, json_body)``. The HTTP handler caller is
    responsible for writing the response headers + body; we just emit the
    status code and the JSON payload.

    Error mapping:
        - JSON decode error  → 400
        - empty/missing trades or invalid types → 422 (Pydantic)
        - unexpected matcher exception → 500 (reported to Sentry)
    """
    import json

    # CPython's ``json.loads`` accepts bareword ``NaN`` / ``Infinity`` /
    # ``-Infinity`` (non-strict spec). ``parse_constant`` is invoked for
    # each one; raising rejects the payload at parse time, so a
    # ``{"strike": NaN}`` body returns 400 here rather than slipping
    # through to Pydantic with ``strike=float('nan')`` and downstream
    # silent isolated_leg classifications (Finding 1.2).
    def _reject_constant(c: str) -> NoReturn:
        raise ValueError(f"non-standard JSON constant: {c}")

    try:
        payload = json.loads(body_bytes, parse_constant=_reject_constant)
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
    except Exception as exc:
        logger.exception("multileg classify failed: unexpected")
        # Sentry capture is best-effort — sentry_setup is a no-op when
        # SENTRY_DSN is unset. Tagged ``component=classifier`` so the
        # dedicated-service events are filterable from the old sidecar
        # ones still in the Sentry history.
        try:
            from sentry_setup import capture_exception

            capture_exception(
                exc, tags={"component": "classifier", "route": "classify"}
            )
        except Exception:
            pass
        return 500, {"error": str(exc)}

    return 200, {"classifications": results}
