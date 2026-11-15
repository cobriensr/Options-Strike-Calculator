"""Tests for scripts/backfill_lottery_scores.py, the one rescore path.

``rescore_all`` rescores every stored lottery fire with one weights version in
one transaction. It snapshots each score it replaces first and, for a
promotion, moves the version's status and the ``active`` pointer in that same
transaction. Review Focus 1 of the plan: a promotion that fails or races
halfway through leaves everything new or nothing new
(docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md, Task 15).

No database. ``FakeDb`` is a psycopg2 connection over an in-memory store with
transactions: statements work on a copy of the committed state, commit keeps
it and rollback drops it. It refuses what Postgres and psycopg2 would refuse:
an autocommit change inside a transaction, a write in a READ ONLY transaction,
a value psycopg2 cannot adapt, and the snapshot table's CHECKs (migration
#208). The real ``execute_values`` runs against it.

Run:
    ml/.venv/Scripts/python -m pytest -q scripts/test_backfill_lottery_scores.py
"""

from __future__ import annotations

import copy
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import numpy as np
import psycopg2
import psycopg2.errors
import pytest
from psycopg2.extensions import adapt
from psycopg2.extras import Json

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _cli_paths  # noqa: E402
import _pipeline_retry  # noqa: E402
import backfill_lottery_scores as bls  # noqa: E402
from lottery_weights import SCORE_COLUMNS, WeightsInvalid  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = json.loads(
    (ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity.json").read_text(
        encoding="utf-8"
    )
)
SEED = FIXTURE["version"]
SEED_WEIGHTS = FIXTURE["weights"]
CANDIDATE = "refit-2026-11-13"
OTHER = "refit-2026-10-01"


def _candidate_weights() -> dict[str, Any]:
    """The seed with AMZN worth 3 instead of 1."""
    w = copy.deepcopy(SEED_WEIGHTS)
    w["model_version"] = CANDIDATE
    w["trained_through"] = "2026-11-13"
    w["features"]["ticker_weights"]["AMZN"] = 3
    return w


CANDIDATE_WEIGHTS = _candidate_weights()

# The parity fixture's first case, an aligned AMZN call at a Wednesday open.
# The seed scores it 9: ticker 1, tod 4, DTE 1, vol/OI q2 +3, gamma q3 +3,
# ask q1 -1, call -2. The candidate gives AMZN 3, so 11.
SEED_SCORE = 9
CANDIDATE_SCORE = 11

DEADLINE = 50.0

# The decision a promotion rests on, as the nightly refit's verdict summary: plain JSON.
VERDICT = {
    "decision": "pass",
    "reasons": [],
    "sessions": ["2026-11-02", "2026-11-03"],
    "eval_rows": 6000,
    "rho_candidate": 0.06,
    "rho_active": 0.05,
    "tier1_ratio": 1.1,
    "tier12_ratio": 0.9,
    "tier1_share": 0.05,
}


def fire(fire_id: int, *, score: int | None, version: str | None = None, **columns):
    """A lottery_finder_fires row as psycopg2 returns it: NUMERIC as Decimal,
    DATE as a date."""
    assert set(columns) <= set(SCORE_COLUMNS), set(columns) - set(SCORE_COLUMNS)
    row = {
        "id": fire_id,
        "score": score,
        "score_version": version,
        "underlying_symbol": "AMZN",
        "option_type": "C",
        "tod": "AM_open",
        "dte": 1,
        "trigger_vol_to_oi_window": Decimal("0.12"),
        "gamma_at_trigger": Decimal("0.05"),
        "trigger_ask_pct": Decimal("0.55"),
        "cum_ncp_at_fire": Decimal("1200000"),
        "cum_npp_at_fire": Decimal("800000"),
        "date": date(2026, 3, 11),
    }
    row.update(columns)
    return row


def gated(fire_id: int, *, score: int | None = None, version: str | None = None):
    """A call whose net put premium leads: not aligned, so the scorer gates it."""
    return fire(
        fire_id, score=score, version=version, cum_ncp_at_fire=Decimal("100")
    )


# ── The fake database ───────────────────────────────────────────────────────

# (kind, a marker only that statement's text holds), checked in this order.
_KINDS = (
    ("read_only", "SET TRANSACTION READ ONLY"),
    ("lock_timeout", "SET LOCAL lock_timeout"),
    ("load_pointer", "JOIN lottery_score_versions"),
    ("load_version", "SELECT weights FROM lottery_score_versions"),
    ("status_read", "SELECT status FROM lottery_score_versions"),
    ("active", "SELECT version FROM lottery_score_pointers"),
    ("page", "FROM lottery_finder_fires WHERE id > %s"),
    ("snapshot", "INSERT INTO lottery_fire_value_snapshots"),
    ("update", "UPDATE lottery_finder_fires"),
    ("status", "UPDATE lottery_score_versions"),
    ("pointer", "UPDATE lottery_score_pointers"),
)
WRITES = frozenset({"snapshot", "update", "status", "pointer"})
_REASON = re.compile(r"[a-z][a-z0-9-]{1,40}")


def _check_adaptable(value: Any) -> None:
    """Raise as psycopg2 would on a value it cannot send (a numpy int, say)."""
    adapt(value).getquoted()


@dataclass
class Statement:
    kind: str
    text: str
    params: Any
    rows: list[tuple]
    autocommit: bool


@dataclass
class FakeDb:
    """A psycopg2 connection over an in-memory lottery store. See the module
    docstring."""

    fires: list[dict[str, Any]]
    active: str = SEED
    statuses: dict[str, str] = field(
        default_factory=lambda: {SEED: "seed", CANDIDATE: "shadow", OTHER: "promoted"}
    )
    # lottery_score_versions.gate_report per version: what a shadow holds when it is
    # promoted (its creation report and the sessions recorded on it).
    gate_reports: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {
            CANDIDATE: {
                "creation": {"verdict": {"ok": True}},
                "sessions": {"2026-11-12": {"eval_rows": 700}},
            }
        }
    )

    encoding = "UTF8"

    def __post_init__(self) -> None:
        self.committed: dict[str, Any] = {
            "fires": {f["id"]: dict(f) for f in self.fires},
            "pointers": {"active": self.active, "takeit": SEED},
            "statuses": dict(self.statuses),
            "gate_reports": copy.deepcopy(self.gate_reports),
            "snapshots": [],
        }
        self.weights = {SEED: SEED_WEIGHTS, CANDIDATE: CANDIDATE_WEIGHTS, OTHER: SEED_WEIGHTS}
        self.work: dict[str, Any] | None = None  # None outside a transaction
        self.read_only = False
        self._autocommit = False  # psycopg2's default
        self.closed = 0
        self.statements: list[Statement] = []
        # Statement kinds plus "commit" and "rollback", in order.
        self.events: list[str] = []
        self.returned: list[int] = []  # RETURNING row counts of the fire UPDATEs
        # kind -> callable(db), run once just before the first such statement.
        self.hooks: dict[str, Callable[[FakeDb], None]] = {}
        # kind -> (n, exception): the n-th such statement raises it.
        self.failures: dict[str, tuple[int, BaseException]] = {}

    def _check_open(self) -> None:
        # psycopg2 sets closed = 2 when the server drops the connection.
        if self.closed:
            raise psycopg2.InterfaceError("connection already closed")

    # psycopg2 refuses to change autocommit inside a transaction.
    @property
    def autocommit(self) -> bool:
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value: bool) -> None:
        self._check_open()
        if self.work is not None:
            raise psycopg2.ProgrammingError(
                "set_session cannot be used inside a transaction"
            )
        self._autocommit = value

    def cursor(self) -> FakeCursor:
        self._check_open()
        return FakeCursor(self)

    def commit(self) -> None:
        self._check_open()
        if self.work is not None:
            self.committed = self.work
        self._end("commit")

    def rollback(self) -> None:
        self._check_open()
        self._end("rollback")

    def _end(self, event: str) -> None:
        self.work = None
        self.read_only = False
        self.events.append(event)

    def close(self) -> None:
        self.closed = 1

    @property
    def commits(self) -> int:
        return self.events.count("commit")

    @property
    def rollbacks(self) -> int:
        return self.events.count("rollback")

    def of_kind(self, kind: str) -> list[Statement]:
        return [s for s in self.statements if s.kind == kind]

    def commit_elsewhere(self, change: Callable[[dict[str, Any]], None]) -> None:
        """Another session commits ``change``. Under READ COMMITTED this
        session's next statement sees it."""
        change(self.committed)
        if self.work is not None:
            change(self.work)

    def execute(self, text: str, params: Any, rows: list[tuple]) -> list[tuple] | None:
        text = " ".join(text.split())
        kind = next((k for k, marker in _KINDS if marker in text), None)
        assert kind is not None, f"unexpected statement: {text[:80]}"
        self.statements.append(Statement(kind, text, params, rows, self._autocommit))
        self.events.append(kind)
        hook = self.hooks.pop(kind, None)
        if hook is not None:
            hook(self)
        if kind in self.failures:
            nth, exc = self.failures[kind]
            if len(self.of_kind(kind)) == nth:
                raise exc
        if self.work is None:
            self.work = copy.deepcopy(self.committed)
        if kind in WRITES and self.read_only:
            raise psycopg2.errors.ReadOnlySqlTransaction(
                "cannot execute a write in a read-only transaction"
            )
        result = getattr(self, f"_{kind}")(self.work, text, params, rows)
        if self._autocommit:
            self.committed, self.work = self.work, None
        return result

    # One handler per statement kind: (state, text, params, rows) -> result.

    def _read_only(self, state, text, params, rows):
        assert not self._autocommit, "SET TRANSACTION outside a transaction does nothing"
        self.read_only = True

    def _lock_timeout(self, state, text, params, rows):
        # SET LOCAL outside a transaction does nothing (Postgres warns).
        assert not self._autocommit, "SET LOCAL outside a transaction does nothing"
        assert text == "SET LOCAL lock_timeout = '60s'"

    def _load_pointer(self, state, text, params, rows):
        version = state["pointers"][params[0]]
        return [(version, self.weights[version])]

    def _load_version(self, state, text, params, rows):
        version = params[0]
        return [(self.weights[version],)] if version in state["statuses"] else []

    def _status_read(self, state, text, params, rows):
        version = params[0]
        return [(state["statuses"][version],)] if version in state["statuses"] else []

    def _active(self, state, text, params, rows):
        assert "name = 'active'" in text
        if self.read_only and " FOR " in text:
            raise psycopg2.errors.ReadOnlySqlTransaction(
                "cannot lock rows in a read-only transaction"
            )
        return [(state["pointers"]["active"],)]

    def _page(self, state, text, params, rows):
        # The columns the statement names, in its order; an unknown one is a
        # KeyError, as Postgres would refuse it.
        columns = re.search(r"SELECT (.*?) FROM", text).group(1).split(", ")
        assert "ORDER BY id LIMIT %s" in text
        after, limit = params
        ids = sorted(i for i in state["fires"] if i > after)[:limit]
        return [tuple(state["fires"][i][c] for c in columns) for i in ids]

    def _snapshot(self, state, text, params, rows):
        reason, to_version, ids, old_values, old_tags = params
        # Migration #208: lists (a tuple would go out as a record), the reason
        # pattern, the to_version rule and FK, and 1-50,000 ids of equal length.
        if not all(isinstance(a, list) for a in (ids, old_values, old_tags)):
            raise psycopg2.errors.DatatypeMismatch("the snapshot arrays must be lists")
        if (
            not _REASON.fullmatch(reason)
            or "'score'" not in text
            or not 1 <= len(ids) <= 50_000
            or not len(ids) == len(old_values) == len(old_tags)
        ):
            raise psycopg2.errors.CheckViolation("lottery_fire_value_snapshots")
        if to_version not in state["statuses"]:
            raise psycopg2.errors.ForeignKeyViolation("to_version")
        assert all(v is None or type(v) is float for v in old_values), "float8"
        state["snapshots"].append(
            {
                "reason": reason,
                "to_version": to_version,
                "fire_ids": ids,
                "old_values": old_values,
                "old_tags": old_tags,
            }
        )

    def _update(self, state, text, params, rows):
        assert text.endswith("RETURNING f.id")
        # The VALUES columns the statement names, and the guards its WHERE
        # holds: a guard that is not in the text is not applied.
        names = re.search(r"AS v\((.*?)\)", text).group(1).split(", ")
        guards = [
            (column, alias)
            for column, alias in (("score", "old"), ("score_version", "old_ver"))
            if re.search(rf"\bf\.{column} IS NOT DISTINCT FROM v\.{alias}\b", text)
        ]
        returned = []
        for values in rows:
            v = dict(zip(names, values, strict=True))
            row = state["fires"].get(v["id"])
            if row is not None and all(row[c] == v[a] for c, a in guards):
                row["score"], row["score_version"] = v["score"], v["ver"]
                returned.append((v["id"],))
        self.returned.append(len(returned))
        return returned

    def _status(self, state, text, params, rows):
        assert "status IN ('shadow', 'passed')" in text
        # The patch psycopg2 sends as `%s::jsonb`: only a Json adapter can be sent (a bare
        # dict is refused by `_check_adaptable` before it gets here). Applied only if the
        # statement's text merges it, as for the guards in `_update`.
        patch, version = params
        assert isinstance(patch, Json), "the gate_report patch must be a Json"
        merges = "gate_report = gate_report || %s::jsonb" in text
        if state["statuses"].get(version) in ("shadow", "passed"):
            state["statuses"][version] = "promoted"
            if merges:
                # jsonb `||` on two objects: the right one's keys win, the rest stay.
                report = state["gate_reports"].setdefault(version, {})
                report.update(copy.deepcopy(patch.adapted))
            return [(version,)]
        return []

    def _pointer(self, state, text, params, rows):
        assert "WHERE name = 'active' AND version = %s" in text
        new, expected = params
        if state["pointers"]["active"] == expected:
            state["pointers"]["active"] = new
            return [("active",)]
        return []


class FakeCursor:
    def __init__(self, db: FakeDb) -> None:
        self.connection = db
        self._result: list[tuple] | None = None
        self._values: list[tuple] = []  # rows execute_values mogrified

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def mogrify(self, template: str | bytes, args: tuple) -> bytes:
        if isinstance(template, bytes):
            template = template.decode("utf-8")
        assert template.count("%s") == len(args)
        for value in args:
            _check_adaptable(value)
        self._values.append(tuple(args))
        return b"(row)"

    def execute(self, sql: str | bytes, params: tuple | None = None) -> None:
        if isinstance(sql, bytes):
            sql = sql.decode("utf-8")
        for value in params or ():
            _check_adaptable(value)
        rows, self._values = self._values, []
        self._result = self.connection.execute(sql, params, rows)

    def fetchall(self) -> list[tuple]:
        if self._result is None:
            raise psycopg2.ProgrammingError("no results to fetch")
        return list(self._result)

    def fetchone(self) -> tuple | None:
        rows = self.fetchall()
        return rows[0] if rows else None


# ── Helpers ─────────────────────────────────────────────────────────────────


def promote(db: FakeDb, **overrides: Any) -> bls.RescoreResult:
    """The nightly step's promotion of CANDIDATE over the seed."""
    kwargs: dict[str, Any] = {
        "to_version": CANDIDATE,
        "weights": CANDIDATE_WEIGHTS,
        "reason": "promotion",
        "expect_active": SEED,
        "dry_run": False,
    }
    kwargs.update(overrides)
    return bls.rescore_all(db, **kwargs)


def rescore(db: FakeDb, **overrides: Any) -> bls.RescoreResult:
    """The CLI's rescore with the seed: no pointer."""
    kwargs: dict[str, Any] = {
        "to_version": SEED,
        "weights": SEED_WEIGHTS,
        "reason": "manual",
        "expect_active": None,
        "dry_run": False,
    }
    kwargs.update(overrides)
    return bls.rescore_all(db, **kwargs)


def autocommit_db(fires: list[dict[str, Any]], **kwargs: Any) -> FakeDb:
    """A connection as the nightly's connect_db hands it out: autocommit on."""
    db = FakeDb(fires, **kwargs)
    db.autocommit = True
    return db


def clock_passes(monkeypatch, db: FakeDb, when: Callable[[FakeDb], bool]) -> None:
    """The script's monotonic clock reads 0 until ``when(db)``, then 100."""
    monkeypatch.setattr(
        bls,
        "time",
        SimpleNamespace(monotonic=lambda: 100.0 if when(db) else 0.0),
    )


def scores(db: FakeDb) -> dict[int, tuple[int | None, str | None]]:
    return {
        i: (f["score"], f["score_version"]) for i, f in db.committed["fires"].items()
    }


# ── Scoring ─────────────────────────────────────────────────────────────────


def test_boundary_value_now_lands_low():
    # 0.625 is the seed's third ask-pct boundary. Right-closed, it is quintile
    # 2 (weight 0). The old left-closed `<` put it in quintile 3 (weight -1)
    # and stored 9. Just above the boundary is quintile 3 either way.
    assert SEED_WEIGHTS["features"]["ask_pct_quintile_boundaries"][2] == 0.625
    db = autocommit_db(
        [
            fire(1, score=9, trigger_ask_pct=Decimal("0.625")),
            fire(2, score=9, trigger_ask_pct=Decimal("0.6251")),
        ]
    )

    result = rescore(db)

    assert scores(db) == {1: (10, SEED), 2: (9, SEED)}
    assert result.score_changed == 1


def test_a_page_whose_feature_column_is_all_null_scores():
    # Older fires have no gamma. A page where every gamma is NULL builds a
    # column of None, which must score as NULL does: it adds 0, so 9 - 3.
    db = autocommit_db(
        [fire(i, score=SEED_SCORE, gamma_at_trigger=None) for i in (1, 2)]
    )

    rescore(db)

    assert scores(db) == {1: (6, SEED), 2: (6, SEED)}


# ── Snapshot and writes ─────────────────────────────────────────────────────


def test_snapshot_precedes_each_update_and_holds_old_values(monkeypatch):
    monkeypatch.setattr(bls, "PAGE_ROWS", 2)
    monkeypatch.setattr(bls, "WRITE_ROWS", 1)
    db = autocommit_db(
        [
            fire(1, score=5),
            fire(2, score=None, version=OTHER),
            fire(3, score=SEED_SCORE),
        ]
    )

    rescore(db)

    assert db.events == [
        "lock_timeout", "active",
        "page", "snapshot", "update", "update",
        "page", "snapshot", "update",
        "commit",
    ]
    assert db.committed["snapshots"] == [
        {
            "reason": "manual",
            "to_version": SEED,
            "fire_ids": [1, 2],
            "old_values": [5.0, None],
            "old_tags": [None, OTHER],
        },
        {
            "reason": "manual",
            "to_version": SEED,
            "fire_ids": [3],
            "old_values": [9.0],
            "old_tags": [None],
        },
    ]
    # Every UPDATE writes only ids a snapshot before it already holds.
    snapshotted: set[int] = set()
    for statement in db.statements:
        if statement.kind == "snapshot":
            snapshotted.update(statement.params[2])
        elif statement.kind == "update":
            assert {row[0] for row in statement.rows} <= snapshotted
    assert scores(db) == {1: (9, SEED), 2: (9, SEED), 3: (9, SEED)}


def test_only_changed_rows_are_written_and_snapshotted():
    db = autocommit_db(
        [
            fire(1, score=SEED_SCORE, version=SEED),  # unchanged
            fire(2, score=7, version=SEED),  # a new score
            fire(3, score=SEED_SCORE, version=OTHER),  # a new tag
            gated(4, version=SEED),  # gated, unchanged
            gated(5, score=4, version=SEED),  # newly gated
        ]
    )

    result = rescore(db)

    [snapshot] = db.committed["snapshots"]
    assert snapshot["fire_ids"] == [2, 3, 5]
    assert snapshot["old_values"] == [7.0, 9.0, 4.0]
    assert snapshot["old_tags"] == [SEED, OTHER, SEED]
    [update] = db.of_kind("update")
    assert [row[0] for row in update.rows] == [2, 3, 5]
    assert scores(db) == {
        1: (9, SEED),
        2: (9, SEED),
        3: (9, SEED),
        4: (None, SEED),
        5: (None, SEED),
    }
    assert (result.scanned, result.changed, result.score_changed) == (5, 3, 2)
    assert result.snapshot_rows == 1


def test_rescore_counts_come_from_returning(monkeypatch):
    monkeypatch.setattr(bls, "PAGE_ROWS", 3)
    monkeypatch.setattr(bls, "WRITE_ROWS", 2)
    db = autocommit_db(
        [fire(1, score=SEED_SCORE, version=SEED)]
        + [fire(i, score=3) for i in range(2, 8)]
    )

    result = rescore(db)

    # Pages [1, 2, 3], [4, 5, 6], [7]; batches of at most 2 from each.
    assert db.returned == [2, 2, 1, 1]
    assert result == bls.RescoreResult(
        scanned=7, changed=6, snapshot_rows=3, pointer_moved=False, score_changed=6
    )


def test_updates_go_out_500_rows_per_statement():
    assert (bls.PAGE_ROWS, bls.WRITE_ROWS) == (50_000, 500)
    db = autocommit_db([fire(i, score=3) for i in range(1, 1_002)])

    result = rescore(db)

    assert [len(s.rows) for s in db.of_kind("update")] == [500, 500, 1]
    assert [len(s["fire_ids"]) for s in db.committed["snapshots"]] == [1_001]
    assert result.changed == 1_001


def test_pages_by_id(monkeypatch):
    monkeypatch.setattr(bls, "PAGE_ROWS", 2)
    db = autocommit_db([fire(i, score=3) for i in (3, 7, 8, 20, 21)])

    result = rescore(db)

    # A short page is the last one.
    assert [s.params for s in db.of_kind("page")] == [(0, 2), (7, 2), (20, 2)]
    assert result.scanned == 5
    assert all(f["score"] == SEED_SCORE for f in db.committed["fires"].values())


def test_first_promotion_rewrites_rows_whose_score_version_is_null():
    # Scored before the store existed: the tag is NULL, even where the score
    # already equals the candidate's.
    db = autocommit_db([fire(1, score=CANDIDATE_SCORE), gated(2)])

    result = promote(db)

    [snapshot] = db.committed["snapshots"]
    assert snapshot["fire_ids"] == [1, 2]
    assert snapshot["old_values"] == [11.0, None]
    assert snapshot["old_tags"] == [None, None]
    assert scores(db) == {1: (11, CANDIDATE), 2: (None, CANDIDATE)}
    assert (result.changed, result.score_changed) == (2, 0)


# ── Promotion: one transaction ──────────────────────────────────────────────


def test_promotion_moves_status_and_pointer_in_the_same_transaction():
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED), gated(2)])

    result = promote(db)

    assert db.events == [
        "lock_timeout",
        "active", "page", "snapshot", "update", "status", "pointer", "commit",
    ]
    assert db.of_kind("active")[0].text.endswith("FOR UPDATE")
    assert not any(s.autocommit for s in db.statements)
    assert db.autocommit is True  # restored
    assert db.committed["pointers"] == {"active": CANDIDATE, "takeit": SEED}
    assert db.committed["statuses"][CANDIDATE] == "promoted"
    assert scores(db) == {1: (11, CANDIDATE), 2: (None, CANDIDATE)}
    assert result.pointer_moved is True


def test_promotion_merges_the_verdict_into_the_gate_report_in_the_same_transaction():
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED)])
    verdict = copy.deepcopy(VERDICT)

    promote(db, verdict=verdict)

    # One status statement, as without a verdict: the merge rides in it, so it commits
    # with the status and the pointer.
    assert db.events == [
        "lock_timeout",
        "active", "page", "snapshot", "update", "status", "pointer", "commit",
    ]
    assert db.committed["statuses"][CANDIDATE] == "promoted"
    # `||` adds the verdict and the version the promotion replaced, both at the top level
    # (the verdict is the decision; `replaced` is no part of it), and keeps what the shadow
    # already held.
    assert db.committed["gate_reports"][CANDIDATE] == {
        "creation": {"verdict": {"ok": True}},
        "sessions": {"2026-11-12": {"eval_rows": 700}},
        "replaced": SEED,
        "verdict": VERDICT,
    }
    assert verdict == VERDICT  # the caller's mapping is not touched
    (status,) = db.of_kind("status")
    assert status.params[1] == CANDIDATE


def test_promotion_without_a_verdict_adds_only_replaced_to_the_gate_report():
    # `replaced` is recorded on every promotion, with or without a verdict.
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED)])
    before = copy.deepcopy(db.committed["gate_reports"])

    promote(db)

    assert db.committed["statuses"][CANDIDATE] == "promoted"
    assert db.committed["gate_reports"] == {
        CANDIDATE: {**before[CANDIDATE], "replaced": SEED}
    }
    assert db.of_kind("status")[0].params[0].adapted == {"replaced": SEED}


def test_replaced_is_the_version_the_first_promotion_took_over_from_the_seed():
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED)])

    promote(db)

    assert SEED == "seed-2026-06-17"
    assert db.committed["gate_reports"][CANDIDATE]["replaced"] == "seed-2026-06-17"


def test_replaced_is_the_version_active_named_whatever_the_old_tags_say():
    # The README's undo reads `replaced` to point `active` back. A hand-run `--version`
    # rescore re-tags fires to a version `active` does not name, so the snapshot's old
    # tags (SEED here) are not the version the promotion replaced (OTHER).
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED)], active=OTHER)

    promote(db, expect_active=OTHER)

    [snapshot] = db.committed["snapshots"]
    assert snapshot["old_tags"] == [SEED]
    assert db.committed["gate_reports"][CANDIDATE]["replaced"] == OTHER
    assert db.committed["pointers"]["active"] == CANDIDATE


def test_a_rolled_back_promotion_leaves_the_verdict_and_replaced_out():
    # The status UPDATE (verdict and replaced merged) runs, then the pointer UPDATE matches
    # nothing: the transaction rolls back and both go with it.
    db = autocommit_db([fire(1, score=SEED_SCORE)])
    before = copy.deepcopy(db.committed)
    db.hooks["pointer"] = lambda d: d.commit_elsewhere(
        lambda state: state["pointers"].update(active=OTHER)
    )

    with pytest.raises(bls.PointerMoved):
        promote(db, verdict=VERDICT)

    assert db.events[-3:] == ["status", "pointer", "rollback"]
    # They were sent.
    assert db.of_kind("status")[0].params[0].adapted == {"replaced": SEED, "verdict": VERDICT}
    assert "verdict" not in db.committed["gate_reports"][CANDIDATE]
    assert "replaced" not in db.committed["gate_reports"][CANDIDATE]
    assert db.committed["statuses"][CANDIDATE] == "shadow"
    before["pointers"]["active"] = OTHER  # the other session's change stands
    assert db.committed == before


def test_a_promotion_dry_run_with_a_verdict_writes_nothing():
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED)])
    before = copy.deepcopy(db.committed)

    promote(db, dry_run=True, verdict=VERDICT)

    assert db.of_kind("status") == []
    assert db.committed == before


@pytest.mark.parametrize("kwargs", [{}, {"pin_active": True, "to_version": SEED}])
def test_a_verdict_without_a_promotion_is_refused_before_any_statement(kwargs):
    # A verdict is the record of a promotion's decision; a manual or pinned rescore has none.
    db = autocommit_db([fire(1, score=SEED_SCORE)])

    with pytest.raises(ValueError, match="verdict"):
        rescore(db, verdict=VERDICT, **kwargs)

    assert db.statements == []
    assert db.events == []
    assert db.autocommit is True


@pytest.mark.parametrize(
    ("bad", "error", "message"),
    [
        pytest.param(float("nan"), ValueError, "not JSON compliant", id="nan"),
        pytest.param(float("inf"), ValueError, "not JSON compliant", id="infinity"),
        pytest.param(float("-inf"), ValueError, "not JSON compliant", id="negative-infinity"),
        pytest.param(np.int64(6000), TypeError, "not JSON serializable", id="numpy-integer"),
    ],
)
def test_a_verdict_jsonb_cannot_hold_is_refused_before_any_statement(bad, error, message):
    # jsonb has no NaN or Infinity (Postgres refuses `NaN`), and json.dumps raises on a numpy
    # value: the check is json.dumps(allow_nan=False), so nothing is half-written.
    db = autocommit_db([fire(1, score=SEED_SCORE, version=SEED)])

    with pytest.raises(error, match=message):
        promote(db, verdict={**VERDICT, "rho_candidate": bad})

    assert db.statements == []
    assert db.events == []
    assert db.committed["statuses"][CANDIDATE] == "shadow"


def test_promotion_rolls_back_when_an_update_fails(monkeypatch):
    monkeypatch.setattr(bls, "WRITE_ROWS", 1)
    db = autocommit_db([fire(i, score=SEED_SCORE, version=SEED) for i in (1, 2, 3)])
    before = copy.deepcopy(db.committed)
    db.failures["update"] = (
        2,
        psycopg2.errors.QueryCanceled("canceling statement due to statement timeout"),
    )

    with pytest.raises(psycopg2.errors.QueryCanceled, match="statement timeout"):
        promote(db)

    assert db.events == [
        "lock_timeout", "active", "page", "snapshot", "update", "update", "rollback",
    ]
    assert db.committed == before
    assert db.autocommit is True


def test_a_sigterm_mid_rescore_rolls_back(monkeypatch):
    # The nightly turns SIGTERM into SystemExit(143) (nightly/src/main.py), a
    # BaseException that an `except Exception` would let past the rollback.
    monkeypatch.setattr(bls, "WRITE_ROWS", 1)
    db = autocommit_db([fire(i, score=SEED_SCORE, version=SEED) for i in (1, 2, 3)])
    before = copy.deepcopy(db.committed)
    db.failures["update"] = (2, SystemExit(143))

    with pytest.raises(SystemExit) as exit_info:
        promote(db)

    assert exit_info.value.code == 143
    assert db.events[-1] == "rollback"
    assert db.commits == 0
    assert db.committed == before
    assert db.autocommit is True


def test_a_lock_timeout_rolls_back_the_rescore():
    # The pointer lock waited past lock_timeout: Postgres cancels the statement.
    db = autocommit_db([fire(1, score=SEED_SCORE)])
    before = copy.deepcopy(db.committed)
    db.failures["active"] = (
        1,
        psycopg2.errors.LockNotAvailable("canceling statement due to lock timeout"),
    )

    with pytest.raises(psycopg2.errors.LockNotAvailable):
        promote(db)

    # The timeout is set before the first statement that can wait for a lock.
    assert db.events == ["lock_timeout", "active", "rollback"]
    assert db.committed == before


def test_a_dropped_connection_surfaces_its_own_error(monkeypatch):
    # The server drops the connection mid-rescore: psycopg2 raises
    # OperationalError and marks the connection closed, and a rollback on it
    # would raise InterfaceError. Postgres aborts the open transaction itself.
    monkeypatch.setattr(bls, "WRITE_ROWS", 1)
    db = autocommit_db([fire(i, score=SEED_SCORE, version=SEED) for i in (1, 2)])
    before = copy.deepcopy(db.committed)
    db.hooks["update"] = lambda d: setattr(d, "closed", 2)
    db.failures["update"] = (1, psycopg2.OperationalError("server closed the connection"))

    with pytest.raises(psycopg2.OperationalError, match="server closed"):
        promote(db)

    assert db.rollbacks == db.commits == 0
    assert db.committed == before


def test_promotion_aborts_when_the_active_pointer_moved():
    db = autocommit_db([fire(1, score=SEED_SCORE)], active=OTHER)
    before = copy.deepcopy(db.committed)

    with pytest.raises(bls.PointerMoved, match=OTHER):
        promote(db)

    assert db.events == ["lock_timeout", "active", "rollback"]
    assert db.committed == before


def test_promotion_rolls_back_when_the_version_is_no_longer_a_candidate():
    statuses = {SEED: "seed", CANDIDATE: "rejected", OTHER: "promoted"}
    db = autocommit_db([fire(1, score=SEED_SCORE)], statuses=statuses)
    before = copy.deepcopy(db.committed)

    with pytest.raises(bls.PointerMoved, match=CANDIDATE):
        promote(db)

    assert db.events == ["lock_timeout", "active", "page", "snapshot", "update", "status", "rollback"]
    assert db.committed == before


def test_promotion_rolls_back_when_the_pointer_update_matches_nothing():
    # The FOR UPDATE lock should make this impossible; the guard holds anyway.
    db = autocommit_db([fire(1, score=SEED_SCORE)])
    before = copy.deepcopy(db.committed)
    db.hooks["pointer"] = lambda d: d.commit_elsewhere(
        lambda state: state["pointers"].update(active=OTHER)
    )

    with pytest.raises(bls.PointerMoved):
        promote(db)

    assert db.events[-3:] == ["status", "pointer", "rollback"]
    before["pointers"]["active"] = OTHER  # the other session's change stands
    assert db.committed == before


def test_concurrent_score_writer_aborts_the_rescore(monkeypatch):
    monkeypatch.setattr(bls, "WRITE_ROWS", 2)
    db = autocommit_db([fire(i, score=SEED_SCORE, version=SEED) for i in (1, 2, 3, 4)])
    before = copy.deepcopy(db.committed)
    # Another session rewrites fire 2 after this one read it.
    db.hooks["update"] = lambda d: d.commit_elsewhere(
        lambda state: state["fires"][2].update(score=3)
    )

    with pytest.raises(bls.ConcurrentScoreWriter, match="1 of 2"):
        promote(db)

    assert db.events == ["lock_timeout", "active", "page", "snapshot", "update", "rollback"]
    before["fires"][2]["score"] = 3  # the other session's change stands
    assert db.committed == before


def test_concurrent_tag_writer_aborts_the_rescore(monkeypatch):
    # Another session re-tags fire 2 after this one read it and leaves the
    # score alone. Written anyway, the snapshot's old tag would be stale.
    monkeypatch.setattr(bls, "WRITE_ROWS", 2)
    db = autocommit_db([fire(i, score=SEED_SCORE, version=SEED) for i in (1, 2, 3, 4)])
    before = copy.deepcopy(db.committed)
    db.hooks["update"] = lambda d: d.commit_elsewhere(
        lambda state: state["fires"][2].update(score_version=OTHER)
    )

    with pytest.raises(bls.ConcurrentScoreWriter, match="1 of 2"):
        promote(db)

    assert db.events == ["lock_timeout", "active", "page", "snapshot", "update", "rollback"]
    before["fires"][2]["score_version"] = OTHER  # the other session's change stands
    assert db.committed == before


def test_rescore_rolls_back_past_the_deadline(monkeypatch):
    monkeypatch.setattr(bls, "PAGE_ROWS", 2)
    db = autocommit_db(
        [
            fire(1, score=CANDIDATE_SCORE, version=CANDIDATE),  # page 1: unchanged
            fire(2, score=CANDIDATE_SCORE, version=CANDIDATE),
            fire(3, score=SEED_SCORE, version=SEED),  # page 2
            fire(4, score=SEED_SCORE, version=SEED),
        ]
    )
    before = copy.deepcopy(db.committed)
    clock_passes(monkeypatch, db, lambda d: len(d.of_kind("page")) >= 1)

    with pytest.raises(bls.RescoreDeadline):
        promote(db, deadline=DEADLINE)

    # Checked before the second page: it is never read.
    assert db.events == ["lock_timeout", "active", "page", "rollback"]
    assert db.committed == before


def test_rescore_rolls_back_when_the_deadline_passes_between_write_batches(
    monkeypatch,
):
    monkeypatch.setattr(bls, "WRITE_ROWS", 1)
    db = autocommit_db([fire(i, score=SEED_SCORE, version=SEED) for i in (1, 2, 3)])
    before = copy.deepcopy(db.committed)
    clock_passes(monkeypatch, db, lambda d: len(d.of_kind("update")) >= 1)

    with pytest.raises(bls.RescoreDeadline):
        promote(db, deadline=DEADLINE)

    assert db.events == ["lock_timeout", "active", "page", "snapshot", "update", "rollback"]
    assert db.committed == before


def test_never_touches_the_takeit_pointer():
    db = autocommit_db([fire(1, score=SEED_SCORE), gated(2)])

    promote(db)
    rescore(db)

    assert not [s for s in db.statements if "takeit" in s.text.lower()]
    assert db.committed["pointers"]["takeit"] == SEED


# ── Dry run and refusals ────────────────────────────────────────────────────


def test_dry_run_writes_nothing():
    fires = [fire(1, score=5), fire(2, score=SEED_SCORE, version=SEED), gated(3)]
    dry_db = autocommit_db(fires)
    wet_db = autocommit_db(fires)
    before = copy.deepcopy(dry_db.committed)

    dry = promote(dry_db, dry_run=True)
    wet = promote(wet_db)

    # A read-only transaction, so Postgres itself refuses a write, and no lock.
    assert dry_db.events == [
        "read_only", "lock_timeout", "active", "status_read", "page", "rollback",
    ]
    assert dry_db.of_kind("active")[0].text.endswith("WHERE name = 'active'")
    assert dry_db.committed == before
    assert dry_db.autocommit is True
    # The same counts, but nothing moved.
    assert (dry.scanned, dry.changed, dry.snapshot_rows, dry.score_changed) == (
        wet.scanned,
        wet.changed,
        wet.snapshot_rows,
        wet.score_changed,
    ) == (3, 3, 1, 2)
    assert (dry.pointer_moved, wet.pointer_moved) == (False, True)


@pytest.mark.parametrize("status", ["rejected", "promoted", "seed", None])
def test_dry_run_promotion_refuses_a_version_that_is_not_a_candidate(status):
    # The write would fail at its status UPDATE; the dry run must not report
    # success. None: the version has no row.
    statuses = {SEED: "seed", OTHER: "promoted"}
    if status is not None:
        statuses[CANDIDATE] = status
    db = autocommit_db([fire(1, score=SEED_SCORE)], statuses=statuses)

    with pytest.raises(bls.PointerMoved, match=f"{CANDIDATE} is {status}"):
        promote(db, dry_run=True)

    assert db.events == [
        "read_only", "lock_timeout", "active", "status_read", "rollback",
    ]


@pytest.mark.parametrize(
    "reason", ["", "x", "Manual", "1-off", "manual\n", "a" * 42, "re score"]
)
def test_bad_reason_is_refused_before_any_statement(reason):
    db = autocommit_db([fire(1, score=5)])

    with pytest.raises(ValueError, match="reason"):
        rescore(db, reason=reason)

    assert db.events == []


def test_invalid_weights_are_refused_before_any_statement():
    weights = copy.deepcopy(SEED_WEIGHTS)
    del weights["cutoffs"]
    db = autocommit_db([fire(1, score=5)])

    with pytest.raises(WeightsInvalid, match="cutoffs"):
        promote(db, weights=weights)

    assert db.events == []


def test_refuses_a_connection_inside_an_open_transaction():
    # Its commit would commit the caller's work and its rollback would drop it.
    db = FakeDb([fire(1, score=5)])
    with db.cursor() as cur:
        cur.execute("SELECT version FROM lottery_score_pointers WHERE name = 'active'")

    with pytest.raises(psycopg2.ProgrammingError, match="inside a transaction"):
        rescore(db)

    assert db.events == ["active"]  # the caller's transaction is left alone


# ── A pinned rescore ────────────────────────────────────────────────────────


def test_pinned_rescore_locks_the_active_pointer_first():
    db = autocommit_db([fire(1, score=5)])

    rescore(db, pin_active=True)

    # After the lock timeout, the pointer lock is the first statement.
    timeout, pin = db.statements[:2]
    assert (timeout.kind, pin.kind, pin.autocommit) == ("lock_timeout", "active", False)
    # FOR UPDATE, not FOR SHARE: two FOR SHARE writes would not exclude each
    # other.
    assert pin.text.endswith("FOR UPDATE")
    assert db.events == [
        "lock_timeout", "active", "page", "snapshot", "update", "commit",
    ]
    assert db.committed["pointers"] == {"active": SEED, "takeit": SEED}


def test_an_unpinned_write_still_locks_the_pointer_for_update():
    # A rescore with a version that is not the active one: it may write, but no
    # other write (a promotion, another hand run) may commit while it scans.
    # Without the lock, pages read before the other write's commit would keep
    # its tags and later pages would be rewritten back, splitting the fires
    # between versions.
    db = autocommit_db([fire(1, score=5)], active=CANDIDATE)

    result = rescore(db)

    pin = db.statements[1]
    assert (pin.kind, pin.autocommit) == ("active", False)
    assert pin.text.endswith("FOR UPDATE")
    assert db.events == [
        "lock_timeout", "active", "page", "snapshot", "update", "commit",
    ]
    assert scores(db) == {1: (9, SEED)}  # the pointer did not have to match
    assert db.committed["pointers"]["active"] == CANDIDATE
    assert result.changed == 1


def test_pinned_rescore_aborts_when_the_active_pointer_names_another_version():
    db = autocommit_db([fire(1, score=5)], active=CANDIDATE)
    before = copy.deepcopy(db.committed)

    with pytest.raises(bls.PointerMoved, match=f"names {CANDIDATE}, not {SEED}"):
        rescore(db, pin_active=True)

    assert db.events == ["lock_timeout", "active", "rollback"]
    assert db.committed == before


def test_pinned_dry_run_takes_no_lock():
    db = autocommit_db([fire(1, score=5)])

    result = rescore(db, pin_active=True, dry_run=True)

    assert db.events == ["read_only", "lock_timeout", "active", "page", "rollback"]
    assert db.of_kind("active")[0].text.endswith("WHERE name = 'active'")
    assert result.changed == 1


def test_an_unpinned_dry_run_reads_no_pointer():
    db = autocommit_db([fire(1, score=5)])

    rescore(db, dry_run=True)

    assert db.events == ["read_only", "lock_timeout", "page", "rollback"]


def test_pin_active_and_expect_active_are_exclusive():
    db = autocommit_db([fire(1, score=5)])

    with pytest.raises(ValueError, match="mutually exclusive"):
        promote(db, pin_active=True)

    assert db.events == []


# ── The CLI ─────────────────────────────────────────────────────────────────


@pytest.fixture
def cli(monkeypatch):
    """Run main() against a FakeDb: no env file read, no real connect."""
    env_files: list[Path] = []
    state: dict[str, Any] = {"db": FakeDb([fire(1, score=5), gated(2, score=4)])}

    def connect(dsn: str) -> FakeDb:
        state["dsn"] = dsn
        return state["db"]

    monkeypatch.setattr(_cli_paths, "load_env_file", env_files.append)
    monkeypatch.setattr(_pipeline_retry, "connect_with_retry", connect)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake-pooled")
    state["env_files"] = env_files
    return state


def test_cli_without_write_is_a_dry_run(cli, capsys):
    bls.main([])

    db = cli["db"]
    assert cli["env_files"] == [ROOT / ".env.local"]
    assert cli["dsn"] == "postgresql://fake-pooled"
    # Pinned, but a READ ONLY transaction takes no lock.
    assert db.events == [
        "load_pointer", "read_only", "lock_timeout", "active", "page", "rollback",
    ]
    assert db.of_kind("active")[0].text.endswith("WHERE name = 'active'")
    assert not [s for s in db.statements if s.kind in WRITES]
    assert db.closed
    out = capsys.readouterr().out
    assert "dry run" in out
    assert SEED in out


def test_cli_write_never_moves_a_pointer(cli, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", "postgresql://fake-direct")

    bls.main(["--write"])

    db = cli["db"]
    assert cli["dsn"] == "postgresql://fake-direct"
    assert db.events == [
        "load_pointer",
        "lock_timeout", "active", "page", "snapshot", "update", "commit",
    ]
    # After the lock timeout, the pin is the rescore transaction's first
    # statement.
    pin = db.statements[2]
    assert (pin.kind, pin.autocommit) == ("active", False)
    assert pin.text.endswith("FOR UPDATE")
    assert db.committed["pointers"] == {"active": SEED, "takeit": SEED}
    assert scores(db) == {1: (9, SEED), 2: (None, SEED)}
    assert db.committed["snapshots"][0]["reason"] == "manual"
    assert "wrote 2" in capsys.readouterr().out


def test_cli_stops_when_a_promotion_moves_the_pointer_after_its_read(cli):
    # load_pointer read the seed; a promotion commits before the rescore pins.
    db = cli["db"]
    before = copy.deepcopy(db.committed)
    db.hooks["active"] = lambda d: d.commit_elsewhere(
        lambda state: state["pointers"].update(active=CANDIDATE)
    )

    with pytest.raises(SystemExit, match=f"PointerMoved: .* names {CANDIDATE}"):
        bls.main(["--write"])

    assert db.events == ["load_pointer", "lock_timeout", "active", "rollback"]
    before["pointers"]["active"] = CANDIDATE  # the promotion's change stands
    assert db.committed == before
    assert db.closed


def test_cli_stops_on_a_concurrent_score_writer(cli):
    db = cli["db"]
    before = copy.deepcopy(db.committed)
    db.hooks["update"] = lambda d: d.commit_elsewhere(
        lambda state: state["fires"][1].update(score=7)
    )

    with pytest.raises(SystemExit, match="ConcurrentScoreWriter: 1 of 2"):
        bls.main(["--write"])

    assert db.events[-2:] == ["update", "rollback"]
    before["fires"][1]["score"] = 7  # the other session's change stands
    assert db.committed == before


def test_cli_stops_on_a_lock_timeout(cli):
    db = cli["db"]
    before = copy.deepcopy(db.committed)
    db.failures["active"] = (
        1,
        psycopg2.errors.LockNotAvailable(
            "canceling statement due to lock timeout\n"
            'CONTEXT:  while locking tuple (0,1) in relation "lottery_score_pointers"\n'
        ),
    )

    with pytest.raises(SystemExit) as exit_info:
        bls.main(["--write"])

    message = str(exit_info.value.code)
    assert message.startswith(
        "[rescore] LockNotAvailable: canceling statement due to lock timeout"
    )
    assert message.endswith("Rolled back, nothing written.")
    assert "\n" not in message
    assert db.events[-1] == "rollback"
    assert db.committed == before


def test_cli_version_flag_scores_with_that_version(cli):
    bls.main(["--version", CANDIDATE, "--reason", "boundary-fix", "--write"])

    db = cli["db"]
    assert db.events == [
        "load_version",
        "lock_timeout", "active", "page", "snapshot", "update", "commit",
    ]
    assert db.of_kind("load_version")[0].params == (CANDIDATE,)
    # An explicit version is not pinned (it is not the active one here), but
    # the write still locks the pointer, so no other write commits mid-scan.
    assert db.of_kind("active")[0].text.endswith("FOR UPDATE")
    assert scores(db) == {1: (11, CANDIDATE), 2: (None, CANDIDATE)}
    assert db.committed["snapshots"][0]["reason"] == "boundary-fix"
    assert db.committed["pointers"]["active"] == SEED


def test_cli_unknown_version_exits_before_any_rescore(cli):
    with pytest.raises(SystemExit, match="refit-2099-01-01"):
        bls.main(["--version", "refit-2099-01-01", "--write"])

    assert cli["db"].events == ["load_version"]
    assert cli["db"].closed


def test_cli_invalid_stored_weights_exit_before_any_rescore(cli):
    broken = copy.deepcopy(CANDIDATE_WEIGHTS)
    del broken["cutoffs"]
    cli["db"].weights[CANDIDATE] = broken

    with pytest.raises(SystemExit, match="cutoffs: missing"):
        bls.main(["--version", CANDIDATE, "--write"])

    assert cli["db"].events == ["load_version"]


def test_cli_bad_reason_is_a_usage_error(cli, capsys):
    with pytest.raises(SystemExit) as exit_info:
        bls.main(["--reason", "Manual", "--write"])

    assert exit_info.value.code == 2
    assert "--reason" in capsys.readouterr().err
    assert "dsn" not in cli


def test_cli_without_a_database_url_exits(cli, monkeypatch):
    monkeypatch.delenv("DATABASE_URL")

    with pytest.raises(SystemExit, match="DATABASE_URL"):
        bls.main([])

    assert "dsn" not in cli
