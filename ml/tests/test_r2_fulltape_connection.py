"""Tests for utils.r2.fulltape_connection's optional per-caller resources.

`duckdb.connect` is replaced at the module boundary with a recorder, so no
httpfs download or R2 call happens. What is under test is which SET statements
run, in what order, and which arguments are refused before any connection is
opened.
"""

from __future__ import annotations

import duckdb
import pytest

from utils import r2


class RecordingConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, sql: str):
        self.statements.append(sql)
        return self


@pytest.fixture
def recorder(monkeypatch) -> RecordingConnection:
    con = RecordingConnection()
    monkeypatch.setattr(duckdb, "connect", lambda *args, **kwargs: con)
    monkeypatch.setenv("R2_ENDPOINT_URL", "https://acct.example.invalid")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    return con


def test_defaults_leave_threads_and_memory_to_duckdb(recorder):
    r2.fulltape_connection()
    assert not any("threads" in s or "memory_limit" in s for s in recorder.statements)
    assert recorder.statements[0] == "INSTALL httpfs; LOAD httpfs;"


def test_threads_and_memory_limit_are_set_before_any_query(recorder):
    r2.fulltape_connection(threads=3, memory_limit="900MiB")
    assert "SET threads=3;" in recorder.statements
    assert "SET memory_limit='900MiB';" in recorder.statements
    # R2 settings still follow.
    assert any(s.startswith("SET s3_endpoint=") for s in recorder.statements)


def test_threads_can_be_set_without_a_memory_limit(recorder):
    r2.fulltape_connection(threads=2)
    assert "SET threads=2;" in recorder.statements
    assert not any("memory_limit" in s for s in recorder.statements)


@pytest.mark.parametrize("threads", [0, -1])
def test_a_thread_count_below_one_is_refused_before_connecting(monkeypatch, threads):
    def connect(*args, **kwargs):
        raise AssertionError("must not connect with bad arguments")

    monkeypatch.setattr(duckdb, "connect", connect)
    with pytest.raises(ValueError, match="threads must be >= 1"):
        r2.fulltape_connection(threads=threads)


@pytest.mark.parametrize(
    "limit",
    ["", "lots", "10", "10 parsecs", "1GiB'; DROP TABLE t; --", "-5GiB", "1GiB\n"],
)
def test_a_malformed_memory_limit_is_refused_before_connecting(monkeypatch, limit):
    def connect(*args, **kwargs):
        raise AssertionError("must not connect with bad arguments")

    monkeypatch.setattr(duckdb, "connect", connect)
    with pytest.raises(ValueError, match="bad memory_limit"):
        r2.fulltape_connection(memory_limit=limit)


@pytest.mark.parametrize("limit", ["512MiB", "6000MiB", "24.9 GiB", "2GB", "1TiB"])
def test_the_memory_limit_formats_duckdb_accepts_pass(recorder, limit):
    r2.fulltape_connection(memory_limit=limit)
    assert f"SET memory_limit='{limit}';" in recorder.statements
