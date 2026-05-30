"""Unit tests for the shared pipeline retry helpers.

Run:

    ml/.venv/bin/pytest scripts/test_pipeline_retry.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _pipeline_retry import (  # noqa: E402
    RETRYABLE_HTTP_STATUS,
    backoff_delay,
    is_retryable_db_error,
    is_retryable_http_status,
    retry_call,
)


def test_backoff_sequence_matches_documented_cadence() -> None:
    delays = [backoff_delay(i) for i in range(6)]
    assert delays == pytest.approx([1, 2, 4, 8, 16, 32])


def test_backoff_caps_at_max_delay() -> None:
    # 2**6 = 64 would exceed the 60s cap.
    assert backoff_delay(6) == pytest.approx(60.0)
    assert backoff_delay(10, max_delay=60.0) == pytest.approx(60.0)


@pytest.mark.parametrize('code', sorted(RETRYABLE_HTTP_STATUS))
def test_retryable_http_status_true(code: int) -> None:
    assert is_retryable_http_status(code) is True


@pytest.mark.parametrize('code', [200, 201, 400, 401, 404, 422])
def test_retryable_http_status_false(code: int) -> None:
    assert is_retryable_http_status(code) is False


def test_403_is_retryable() -> None:
    # The 2026-05-29 regression: a transient UW edge 403 must be retried.
    assert 403 in RETRYABLE_HTTP_STATUS


def test_retryable_db_error_matches_neon_blip_signatures() -> None:
    assert is_retryable_db_error(psycopg2.OperationalError('server closed')) is True
    assert is_retryable_db_error(psycopg2.InterfaceError('connection bad')) is True
    assert is_retryable_db_error(ValueError('not a db error')) is False


def test_retry_call_returns_on_first_success_without_sleeping() -> None:
    sleeps: list[float] = []
    result = retry_call(
        lambda: 'ok',
        retryable=lambda exc: True,
        sleep=sleeps.append,
    )
    assert result == 'ok'
    assert sleeps == []


def test_retry_call_retries_then_succeeds() -> None:
    sleeps: list[float] = []
    calls = {'n': 0}

    def flaky() -> str:
        calls['n'] += 1
        if calls['n'] < 3:
            raise ConnectionError('transient')
        return 'recovered'

    result = retry_call(
        flaky,
        retryable=lambda exc: isinstance(exc, ConnectionError),
        sleep=sleeps.append,
    )
    assert result == 'recovered'
    assert calls['n'] == 3
    # Two failures => two backoff sleeps: 1s, 2s.
    assert sleeps == [1, 2]


def test_retry_call_exhausts_and_raises_last_exception() -> None:
    sleeps: list[float] = []

    def always_fail() -> str:
        raise TimeoutError('still down')

    with pytest.raises(TimeoutError, match='still down'):
        retry_call(
            always_fail,
            retryable=lambda exc: True,
            attempts=3,
            sleep=sleeps.append,
        )
    # 3 attempts => 2 sleeps between them (no sleep after the final attempt).
    assert sleeps == [1, 2]


def test_retry_call_does_not_retry_permanent_error() -> None:
    sleeps: list[float] = []
    calls = {'n': 0}

    def permanent() -> str:
        calls['n'] += 1
        raise ValueError('bad request')

    with pytest.raises(ValueError, match='bad request'):
        retry_call(
            permanent,
            retryable=lambda exc: False,
            sleep=sleeps.append,
        )
    assert calls['n'] == 1  # tried exactly once
    assert sleeps == []
