"""Tests for weights_store: the nightly service's read/write layer for lottery weights versions.

No test touches a database: a fake cursor replays queued rows and records each statement and
its parameters. What a fake cannot show (how Postgres runs the SQL) is held down two ways: the
statements' guards are asserted on their text, and the statements were run once against pglite
with the real migration #208 tables (see the task report).
"""

from __future__ import annotations

import ast
import copy
import json
import math
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

import lottery_weights
import psycopg2
import pytest
from lottery_weights import WeightsInvalid
from psycopg2.extras import Json

import weights_store
from weights_store import (
    StoredVersion,
    decide,
    insert_candidate,
    load_active,
    load_shadow,
    record_session_eval,
    version_exists,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads(
    (REPO_ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity.json").read_text(
        encoding="utf-8"
    )
)
VERSION = "refit-2026-11-02"
TRAINED_THROUGH = date(2026, 11, 2)


def _weights() -> dict[str, Any]:
    """A weights object `validate_weights` accepts; a fresh copy each call."""
    return copy.deepcopy(FIXTURE["weights"])


class FakeCursor:
    """Replays one queued row (or None) per statement and records what ran.

    Running more statements than were queued is an IndexError, so a test pins the statement
    count by queueing exactly what the code should run.
    """

    def __init__(self, rows: list[Any]) -> None:
        self.executed: list[tuple[str, Any]] = []
        self._rows = list(rows)
        self._current: Any = None

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    def execute(self, sql: str, params: Any = None) -> None:
        self.executed.append((" ".join(sql.split()), params))
        self._current = self._rows.pop(0)

    def fetchone(self) -> Any:
        return self._current


class FakeConn:
    def __init__(self, rows: list[Any] | None = None) -> None:
        self.cursor_ = FakeCursor(rows or [])

    def cursor(self) -> FakeCursor:
        return self.cursor_

    @property
    def executed(self) -> list[tuple[str, Any]]:
        return self.cursor_.executed


def _stored_row(
    *,
    version: str = VERSION,
    weights: Any = None,
    status: str = "shadow",
    trained_through: date | None = TRAINED_THROUGH,
    gate_report: dict[str, Any] | None = None,
) -> tuple[Any, ...]:
    return (
        version,
        _weights() if weights is None else weights,
        status,
        trained_through,
        {} if gate_report is None else gate_report,
    )


# ── the loads ───────────────────────────────────────────────────────────────


def test_load_active_reads_the_version_the_active_pointer_names() -> None:
    conn = FakeConn([_stored_row(version="seed-2026-06-17", status="seed", gate_report={"a": 1})])

    stored = load_active(conn)

    assert stored == StoredVersion(
        version="seed-2026-06-17",
        weights=_weights(),
        status="seed",
        trained_through=TRAINED_THROUGH,
        gate_report={"a": 1},
    )
    (sql, _), *rest = conn.executed
    assert rest == []
    assert (
        "FROM lottery_score_pointers p JOIN lottery_score_versions v ON v.version = p.version"
        in sql
    )
    assert "WHERE p.name = 'active'" in sql


def test_load_active_without_a_pointer_row_is_a_lookup_error() -> None:
    # The store was never migrated: a loud error, not a default set of weights.
    with pytest.raises(LookupError, match="active"):
        load_active(FakeConn([None]))


def test_load_shadow_none() -> None:
    conn = FakeConn([None])

    assert load_shadow(conn) is None
    assert len(conn.executed) == 1
    assert "FROM lottery_score_versions WHERE status = 'shadow'" in conn.executed[0][0]


def test_load_shadow_returns_the_stored_version() -> None:
    report = {"creation": {"verdict": "ok"}, "sessions": {"2026-11-03": {"rho": 0.4}}}
    conn = FakeConn([_stored_row(trained_through=None, gate_report=report)])

    stored = load_shadow(conn)

    assert stored is not None
    assert (stored.version, stored.status, stored.trained_through) == (VERSION, "shadow", None)
    assert stored.gate_report == report
    assert stored.weights == _weights()


@pytest.mark.parametrize("load", [load_active, load_shadow])
def test_load_validates_weights(load: Any) -> None:
    broken = _weights()
    broken["cutoffs"]["t1"] = broken["cutoffs"]["t2"]  # t1 must exceed t2
    conn = FakeConn([_stored_row(weights=broken)])

    with pytest.raises(WeightsInvalid) as raised:
        load(conn)

    assert (raised.value.path, raised.value.rule) == ("cutoffs", "order")


@pytest.mark.parametrize("load", [load_active, load_shadow])
def test_load_refuses_weights_that_are_not_an_object(load: Any) -> None:
    # A jsonb column can hold any JSON: a row whose weights is a string is refused, not returned.
    with pytest.raises(WeightsInvalid) as raised:
        load(FakeConn([_stored_row(weights="not weights")]))

    assert (raised.value.path, raised.value.rule) == ("$", "type")
    assert "not weights" not in str(raised.value)


def test_version_exists() -> None:
    conn = FakeConn([(True,), (False,)])

    assert version_exists(conn, VERSION) is True
    assert version_exists(conn, "refit-2026-01-01") is False
    assert [params for _, params in conn.executed] == [(VERSION,), ("refit-2026-01-01",)]
    assert "FROM lottery_score_versions WHERE version = %s" in conn.executed[0][0]


# ── insert_candidate ────────────────────────────────────────────────────────


def test_insert_candidate_is_idempotent() -> None:
    # The first insert returns its row; the second finds the version taken, so
    # ON CONFLICT DO NOTHING returns no row.
    conn = FakeConn([(VERSION,), None])
    report = {"creation": {"verdict": "ok", "train_window": ["2026-08-04", "2026-11-02"]}}

    first = insert_candidate(
        conn, VERSION, _weights(), status="shadow", trained_through=TRAINED_THROUGH, report=report
    )
    second = insert_candidate(
        conn, VERSION, _weights(), status="shadow", trained_through=TRAINED_THROUGH, report=report
    )

    assert (first, second) == (True, False)
    sql, params = conn.executed[0]
    assert sql.startswith("INSERT INTO lottery_score_versions ")
    assert sql.endswith("ON CONFLICT (version) DO NOTHING RETURNING version")
    version, weights_json, status, trained_through, report_json = params
    assert (version, status, trained_through) == (VERSION, "shadow", TRAINED_THROUGH)
    assert isinstance(weights_json, Json) and weights_json.adapted == _weights()
    assert isinstance(report_json, Json) and report_json.adapted == report
    # The second call sent the same statement and the same values.
    second_sql, second_params = conn.executed[1]
    assert second_sql == sql
    assert [p.adapted if isinstance(p, Json) else p for p in second_params] == [
        p.adapted if isinstance(p, Json) else p for p in params
    ]


def test_insert_candidate_stores_a_rejected_candidate() -> None:
    conn = FakeConn([(VERSION,)])

    stored = insert_candidate(
        conn,
        VERSION,
        _weights(),
        status="rejected",
        trained_through=TRAINED_THROUGH,
        report={"creation": {"verdict": "rejected", "reasons": ["too_few_train_rows"]}},
    )

    assert stored is True
    assert conn.executed[0][1][2] == "rejected"


@pytest.mark.parametrize("status", ["seed", "passed", "promoted", "SHADOW", ""])
def test_insert_candidate_refuses_a_status_a_candidate_cannot_have(status: str) -> None:
    # `promoted` belongs to the promotion transaction, `seed` to the migration.
    conn = FakeConn([(VERSION,)])

    with pytest.raises(ValueError, match="status"):
        insert_candidate(
            conn,
            VERSION,
            _weights(),
            status=status,  # type: ignore[arg-type]
            trained_through=TRAINED_THROUGH,
            report={},
        )

    assert conn.executed == []


def test_insert_candidate_validates_a_shadow_but_not_a_rejected_one() -> None:
    # A shadow that failed validation would make every later `load_shadow` raise; a
    # rejected candidate is stored as it was trained, because `invalid_weights` is one of
    # the reasons a candidate is rejected.
    broken = _weights()
    broken["features"]["dte_weights"].pop("0")
    conn = FakeConn([(VERSION,)])

    with pytest.raises(WeightsInvalid):
        insert_candidate(
            conn, VERSION, broken, status="shadow", trained_through=TRAINED_THROUGH, report={}
        )
    assert conn.executed == []

    assert insert_candidate(
        conn, VERSION, broken, status="rejected", trained_through=TRAINED_THROUGH, report={}
    )
    assert len(conn.executed) == 1


def test_json_columns_never_carry_a_non_finite_number() -> None:
    # jsonb has no NaN or Infinity: the default encoder writes them as bare tokens and
    # Postgres refuses the statement. A thin training window gives NaN boundaries and an
    # evaluation can give an infinite ratio (x / 0), so each becomes null.
    weights = _weights()
    weights["features"]["gamma_quintile_boundaries"] = [math.nan, 1.0, math.inf, -math.inf]
    report = {"creation": {"insample_rho": math.nan, "ratios": [math.inf, 1.5], "n": 3}}
    conn = FakeConn([(VERSION,), (VERSION,), (VERSION,)])

    insert_candidate(
        conn, VERSION, weights, status="rejected", trained_through=TRAINED_THROUGH, report=report
    )
    record_session_eval(conn, VERSION, date(2026, 11, 3), {"tier1_ratio": math.inf})
    decide(conn, VERSION, "rejected", {"rho_candidate": math.nan})

    def strict(text: str) -> Any:
        def refuse(constant: str) -> None:
            raise AssertionError(f"{constant} reached the database")

        return json.loads(text, parse_constant=refuse)

    inserted = conn.executed[0][1]
    assert strict(inserted[1].dumps(inserted[1].adapted))["features"][
        "gamma_quintile_boundaries"
    ] == [
        None,
        1.0,
        None,
        None,
    ]
    assert strict(inserted[4].dumps(inserted[4].adapted)) == {
        "creation": {"insample_rho": None, "ratios": [None, 1.5], "n": 3}
    }
    recorded = conn.executed[1][1][1]
    assert strict(recorded.dumps(recorded.adapted)) == {"tier1_ratio": None}
    decided = conn.executed[2][1][1]
    assert strict(decided.dumps(decided.adapted)) == {"verdict": {"rho_candidate": None}}
    # The caller's objects are left alone.
    assert math.isnan(weights["features"]["gamma_quintile_boundaries"][0])
    assert math.isnan(report["creation"]["insample_rho"])


# ── record_session_eval ─────────────────────────────────────────────────────


def test_record_session_eval_is_keyed_by_session() -> None:
    conn = FakeConn([(VERSION,), (VERSION,), (VERSION,)])
    entry = {"rho_candidate": 0.41, "eval_rows": 180}

    first = record_session_eval(conn, VERSION, date(2026, 11, 10), entry)
    other = record_session_eval(conn, VERSION, date(2026, 11, 11), {"rho_candidate": 0.2})
    again = record_session_eval(conn, VERSION, date(2026, 11, 10), entry)

    assert (first, other, again) == (True, True, True)
    keys = [params[0] for _, params in conn.executed]
    # One key per session, the ISO date; the same session again addresses the same key.
    assert keys == ["2026-11-10", "2026-11-11", "2026-11-10"]
    sql, params = conn.executed[0]
    assert "ARRAY['sessions', %s]" in sql
    assert isinstance(params[1], Json) and params[1].adapted == entry
    assert params[2] == VERSION


def test_record_session_eval_creates_the_sessions_object_first() -> None:
    # jsonb_set only creates the LAST path element: on a report with no `sessions` key
    # (a fresh candidate holds only `creation`), a bare jsonb_set(..., '{sessions,<d>}')
    # returns the report unchanged and RETURNING still reports a row.
    conn = FakeConn([(VERSION,)])

    record_session_eval(conn, VERSION, date(2026, 11, 10), {})

    sql = conn.executed[0][0]
    make_sessions = (
        "jsonb_set(gate_report, ARRAY['sessions'], COALESCE(gate_report->'sessions', '{}'::jsonb))"
    )
    assert make_sessions in sql
    # ... and it is the inner call: the entry is set into what it returns.
    assert sql.index(make_sessions) < sql.index("ARRAY['sessions', %s]")


def test_record_session_eval_is_conditional_on_shadow() -> None:
    conn = FakeConn([None])

    recorded = record_session_eval(conn, VERSION, date(2026, 11, 10), {})

    assert recorded is False  # not a shadow (or no such version): nothing was written
    sql = conn.executed[0][0]
    assert sql.startswith("UPDATE lottery_score_versions SET ")
    assert sql.endswith("WHERE version = %s AND status = 'shadow' RETURNING version")


def test_record_session_eval_refuses_a_datetime_session() -> None:
    # `datetime` is a `date`; its isoformat has a time part and would open a second key.
    conn = FakeConn([(VERSION,)])

    with pytest.raises(TypeError, match="date"):
        record_session_eval(conn, VERSION, datetime(2026, 11, 10, 9, 30), {})

    assert conn.executed == []


# ── decide ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", ["passed", "rejected"])
def test_decide_is_conditional_on_shadow(status: str) -> None:
    conn = FakeConn([(VERSION,), None])
    verdict = {"decision": "pass", "reasons": [], "sessions": ["2026-11-03"]}

    decided = decide(conn, VERSION, status, verdict)  # type: ignore[arg-type]
    decided_again = decide(conn, VERSION, status, verdict)  # type: ignore[arg-type]

    assert (decided, decided_again) == (True, False)
    sql, params = conn.executed[0]
    assert sql.startswith("UPDATE lottery_score_versions SET status = %s, decided_at = now(), ")
    assert "gate_report = gate_report || %s::jsonb" in sql
    assert sql.endswith("WHERE version = %s AND status = 'shadow' RETURNING version")
    assert params[0] == status
    assert isinstance(params[1], Json) and params[1].adapted == {"verdict": verdict}
    assert params[2] == VERSION


@pytest.mark.parametrize("status", ["promoted", "shadow", "seed", "PASSED", ""])
def test_decide_refuses_a_status_that_is_not_a_decision(status: str) -> None:
    # `promoted` is written only by the promotion transaction, which moves the pointer too.
    conn = FakeConn([(VERSION,)])

    with pytest.raises(ValueError, match="status"):
        decide(conn, VERSION, status, {})  # type: ignore[arg-type]

    assert conn.executed == []


# ── the module's reach ──────────────────────────────────────────────────────


def _is_write(sql: str) -> bool:
    return re.search(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|ALTER|DROP)\b", sql, re.I) is not None


def _sql_strings() -> list[str]:
    """Every string literal in the module that is not a docstring, whitespace-normalized."""
    tree = ast.parse(Path(weights_store.__file__).read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.FunctionDef | ast.ClassDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    return [
        " ".join(node.value.split())
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_module_never_writes_pointers() -> None:
    # Only the promotion transaction (`rescore_all`) moves a pointer.
    # Statically: no string in the module that names the pointer table holds a write
    # keyword, and the one statement that reads it is a SELECT.
    naming_pointers = [s for s in _sql_strings() if "lottery_score_pointers" in s]
    assert any(s.startswith("SELECT ") for s in naming_pointers), (
        "the scan found no pointer SELECT: load_active reads one"
    )
    for sql in naming_pointers:
        assert not _is_write(sql), sql

    # Dynamically: run every public function and look at what reached the cursor.
    conn = FakeConn([_stored_row(), None, (True,), (VERSION,), (VERSION,), (VERSION,)])
    load_active(conn)
    load_shadow(conn)
    version_exists(conn, VERSION)
    insert_candidate(
        conn, VERSION, _weights(), status="shadow", trained_through=TRAINED_THROUGH, report={}
    )
    record_session_eval(conn, VERSION, date(2026, 11, 10), {})
    decide(conn, VERSION, "passed", {})
    assert len(conn.executed) == 6
    for sql, _ in conn.executed:
        assert not ("lottery_score_pointers" in sql and _is_write(sql)), sql


# ── failures surface ────────────────────────────────────────────────────────


def _calls() -> list[tuple[str, Any]]:
    return [
        ("load_active", lambda c: load_active(c)),
        ("load_shadow", lambda c: load_shadow(c)),
        ("version_exists", lambda c: version_exists(c, VERSION)),
        (
            "insert_candidate",
            lambda c: insert_candidate(
                c, VERSION, _weights(), status="shadow", trained_through=TRAINED_THROUGH, report={}
            ),
        ),
        (
            "record_session_eval",
            lambda c: record_session_eval(c, VERSION, date(2026, 11, 10), {}),
        ),
        ("decide", lambda c: decide(c, VERSION, "rejected", {})),
    ]


@pytest.mark.parametrize(("name", "call"), _calls(), ids=[name for name, _ in _calls()])
def test_a_database_error_propagates_whole(name: str, call: Any) -> None:
    # A rejected statement is not "no row": a write that failed must not read as False, and
    # a read that failed must not read as "no shadow".
    class Failing(FakeCursor):
        def execute(self, sql: str, params: Any = None) -> None:
            raise psycopg2.OperationalError("connection lost")

    conn = FakeConn()
    conn.cursor_ = Failing([])

    with pytest.raises(psycopg2.OperationalError, match="connection lost"):
        call(conn)


# ── the import path ─────────────────────────────────────────────────────────


def test_lottery_weights_comes_from_ml_src() -> None:
    # conftest puts ml/src on the path; without it this module's import fails in a run
    # that did not import a scripts/ module first.
    assert (
        Path(lottery_weights.__file__).resolve() == REPO_ROOT / "ml" / "src" / "lottery_weights.py"
    )
