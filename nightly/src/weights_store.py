"""The nightly service's read/write layer for the lottery weights versions in Neon.

`lottery_score_versions` holds one row per set of weights (`seed-…` from the migration,
`refit-<trained_through>` from the nightly refit); `lottery_score_pointers` names which row
scores the feed (`active`) and which feeds Take-It (`takeit`). This module reads the active
and the shadow version and writes only the candidate's own row: it inserts a candidate,
records one evaluated session on it, and decides it. It never writes a pointer, and never
sets `promoted`: only `backfill_lottery_scores.rescore_all` does, in its promotion
transaction, which moves the pointer in the same commit. Every statement here is a single
atomic statement, so a connection in autocommit mode (what `resources.connect_db` gives) is
enough.

Every write is conditional or idempotent, so a re-run the same night changes nothing (R6):
- `insert_candidate` is `ON CONFLICT (version) DO NOTHING RETURNING`: the second insert of a
  version returns False. A different version while a shadow exists is not a conflict on the
  version, it is the one-shadow partial unique index refusing, and the psycopg2
  `UniqueViolation` propagates: the caller built a second shadow.
- `record_session_eval` and `decide` update only a row whose status is still `shadow`; a
  False return means the row is not (or no longer) a shadow, or does not exist.
  `record_session_eval` also writes each session once (D6: a session's record is never
  recomputed), so False is also what a session already recorded returns.

Every weights object that is loaded goes through `validate_weights`, so a caller never
scores or trains against a malformed version. A shadow is validated when it is inserted,
too, because a stored shadow that fails validation would make every later `load_shadow`
raise. A rejected candidate is stored as it was trained: `invalid_weights` is one of the
reasons for rejecting one.

JSON goes through `psycopg2.extras.Json` with every non-finite float replaced by null:
jsonb has no NaN or Infinity, and a thin training window gives NaN quintile boundaries
while an evaluation can give an infinite ratio. Logs and errors carry no row data: a
`WeightsInvalid` names the path and the rule, never the value.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import TYPE_CHECKING, Any, Literal, get_args

from lottery_weights import validate_weights
from psycopg2.extras import Json

if TYPE_CHECKING:
    from psycopg2.extensions import connection

CandidateStatus = Literal["shadow", "rejected"]
Decision = Literal["passed", "rejected"]

_CANDIDATE_STATUSES = get_args(CandidateStatus)
_DECISIONS = get_args(Decision)

# A version's columns, in the order `StoredVersion` takes them.
_COLUMNS = "version, weights, status, trained_through, gate_report"

# The pointer is only ever read: the join resolves `active` to its version.
_ACTIVE_SQL = (
    "SELECT v.version, v.weights, v.status, v.trained_through, v.gate_report "
    "FROM lottery_score_pointers p "
    "JOIN lottery_score_versions v ON v.version = p.version "
    "WHERE p.name = 'active'"
)

# The partial unique index allows at most one row here.
_SHADOW_SQL = f"SELECT {_COLUMNS} FROM lottery_score_versions WHERE status = 'shadow'"

_EXISTS_SQL = "SELECT EXISTS (SELECT 1 FROM lottery_score_versions WHERE version = %s)"

_INSERT_SQL = (
    f"INSERT INTO lottery_score_versions ({_COLUMNS}) "
    "VALUES (%s, %s, %s, %s, %s) "
    "ON CONFLICT (version) DO NOTHING RETURNING version"
)

# jsonb_set creates only the LAST element of its path: on a report with no `sessions` key
# (a fresh candidate holds only `creation`) a single jsonb_set to ARRAY['sessions', <date>]
# returns the report unchanged, and RETURNING still reports the row. The inner call makes
# `sessions` first, keeping what it already holds.
# A session's record is written once and never recomputed: a later enrich pass can fill a
# fire's inversion, so a recomputed entry would differ from the one the decision may rest
# on. The last `%s` is the same ISO date as the key; the COALESCE is required, because
# `NULL ? 'x'` is NULL, NOT NULL is NULL, and a report with no `sessions` key would match no
# row, so its first write would never land.
_RECORD_EVAL_SQL = (
    "UPDATE lottery_score_versions "
    "SET gate_report = jsonb_set("
    "jsonb_set(gate_report, ARRAY['sessions'], COALESCE(gate_report->'sessions', '{}'::jsonb)), "
    "ARRAY['sessions', %s], %s::jsonb) "
    "WHERE version = %s AND status = 'shadow' "
    "AND NOT (COALESCE(gate_report->'sessions', '{}'::jsonb) ? %s) "
    "RETURNING version"
)

_DECIDE_SQL = (
    "UPDATE lottery_score_versions "
    "SET status = %s, decided_at = now(), gate_report = gate_report || %s::jsonb "
    "WHERE version = %s AND status = 'shadow' RETURNING version"
)


@dataclass(frozen=True)
class StoredVersion:
    """One row of `lottery_score_versions`, its weights validated."""

    version: str
    weights: dict[str, Any]
    status: str
    trained_through: date | None
    gate_report: dict[str, Any]


def _finite(value: Any) -> Any:
    """A copy of `value` with every non-finite float replaced by None (jsonb has no NaN)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_finite(item) for item in value]
    return value


def _json(value: Any) -> Json:
    return Json(_finite(value))


def _stored(row: tuple[Any, ...]) -> StoredVersion:
    version, weights, status, trained_through, gate_report = row
    validate_weights(weights)
    return StoredVersion(version, weights, status, trained_through, gate_report)


def load_active(conn: connection) -> StoredVersion:
    """The version the `active` pointer names.

    Raises `LookupError` when the pointer has no row (the store was never migrated) and
    `WeightsInvalid` when its weights break a rule.
    """
    with conn.cursor() as cursor:
        cursor.execute(_ACTIVE_SQL)
        row = cursor.fetchone()
    if row is None:
        raise LookupError("lottery_score_pointers has no row named active")
    return _stored(row)


def load_shadow(conn: connection) -> StoredVersion | None:
    """The version under evaluation, or None when there is none.

    Raises `WeightsInvalid` when its weights break a rule.
    """
    with conn.cursor() as cursor:
        cursor.execute(_SHADOW_SQL)
        row = cursor.fetchone()
    return None if row is None else _stored(row)


def version_exists(conn: connection, version: str) -> bool:
    """Whether a row with this version id exists, in any status."""
    with conn.cursor() as cursor:
        cursor.execute(_EXISTS_SQL, (version,))
        (exists,) = cursor.fetchone()
    return bool(exists)


def insert_candidate(
    conn: connection,
    version: str,
    weights: Mapping[str, Any],
    *,
    status: CandidateStatus,
    trained_through: date,
    report: Mapping[str, Any],
) -> bool:
    """Store a candidate; True if this call inserted it, False if the version already existed.

    `status` is `shadow` or `rejected` (a ValueError otherwise: `seed` is the migration's
    and `promoted` the promotion transaction's). A shadow's weights are validated first
    (`WeightsInvalid`); a rejected candidate's are stored as they are. `report` becomes
    `gate_report`. Raises the `UniqueViolation` of the one-shadow index when another version
    is already a shadow.
    """
    if status not in _CANDIDATE_STATUSES:
        raise ValueError(f"a candidate's status must be one of {', '.join(_CANDIDATE_STATUSES)}")
    if status == "shadow":
        validate_weights(weights)
    with conn.cursor() as cursor:
        cursor.execute(
            _INSERT_SQL,
            (version, _json(weights), status, trained_through, _json(report)),
        )
        return cursor.fetchone() is not None


def record_session_eval(
    conn: connection, version: str, session: date, entry: Mapping[str, Any]
) -> bool:
    """Set `gate_report.sessions.<session>` of a shadow to `entry`; True if this call wrote it.

    Keyed by the session's ISO date and written once: a session already recorded keeps its
    first entry. False when the version is not a shadow, does not exist, or already holds
    this session; the caller cannot tell those apart from the return alone.
    """
    if isinstance(session, datetime) or not isinstance(session, date):
        raise TypeError("record_session_eval takes a datetime.date")
    day = session.isoformat()
    with conn.cursor() as cursor:
        cursor.execute(_RECORD_EVAL_SQL, (day, _json(entry), version, day))
        return cursor.fetchone() is not None


def decide(conn: connection, version: str, status: Decision, verdict: Mapping[str, Any]) -> bool:
    """Move a shadow to `passed` or `rejected`; True if this call decided it.

    Sets `decided_at` and adds `verdict` to the gate report under that key. False when the
    version is not (or no longer) a shadow, so a second decision changes nothing. A
    ValueError for any other status: `promoted` is written only with the pointer.
    """
    if status not in _DECISIONS:
        raise ValueError(f"a decision's status must be one of {', '.join(_DECISIONS)}")
    with conn.cursor() as cursor:
        cursor.execute(_DECIDE_SQL, (status, _json({"verdict": verdict}), version))
        return cursor.fetchone() is not None
