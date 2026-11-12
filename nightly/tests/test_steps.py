"""Tests for the step runner: order, per-step deadlines, isolation and result checks.

Steps here are plain functions handed to `run_steps`, so the only things patched are the
clock (`steps.monotonic`) and the Sentry capture on the sentry_sdk module, as in test_main.
The leak test builds the Sentry event for the exception `run_steps` captured, with the
SDK's own `event_from_exception`, and runs it through `monitoring.scrub_event`.
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock, create_autospec

import psycopg2
import pytest
import sentry_sdk
from sentry_sdk.utils import event_from_exception

import steps
from config import Settings, load_settings
from monitoring import scrub_event
from steps import Step, StepContext, StepOutcome, StepResult, reserve_seconds, run_steps
from tape_job import DayOutcome

NOW = datetime(2026, 11, 7, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 6)
START = 1_000.0  # the fake clock's start, in monotonic() seconds
RUN_DEADLINE = START + 5_000.0
INVALID = "invalid step result"
REDACTED = "<redacted data-library message>"
# What a failed Neon connect puts in the message of psycopg2's OperationalError.
HOST = "ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech"
CONNECT_ERROR = (
    f'connection to server at "{HOST}" (3.140.0.1), port 5432 failed: '
    'FATAL: password authentication failed for user "neondb_owner"'
)
ROW_VALUE = "-".join(("SECRET", "ROW", "VALUE"))


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    clock = SimpleNamespace(now=START)
    monkeypatch.setattr(steps, "monotonic", lambda: clock.now)
    return clock


@pytest.fixture
def settings() -> Settings:
    return load_settings()


@pytest.fixture
def capture_exception(monkeypatch: pytest.MonkeyPatch) -> Mock:
    mock = create_autospec(sentry_sdk.capture_exception)
    monkeypatch.setattr(sentry_sdk, "capture_exception", mock)
    return mock


def _discard(outcome: StepOutcome) -> None:
    """The reporter for a test that does not look at the reports."""


def _run(
    step_list: list[Step],
    settings: Settings,
    *,
    run_deadline: float = RUN_DEADLINE,
    tape: tuple[DayOutcome, ...] | list[DayOutcome] = (),
    on_outcome: Callable[[StepOutcome], None] = _discard,
) -> list[StepOutcome]:
    return run_steps(
        step_list,
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=run_deadline,
        tape=tape,
        on_outcome=on_outcome,
    )


def _ok(name: str, seen: list[StepContext], min_seconds: int = 0) -> Step:
    """A step that records its context and succeeds."""

    def run(ctx: StepContext) -> StepResult:
        seen.append(ctx)
        return StepResult("ok", {"things": 1})

    return Step(name, run, min_seconds)


def _returning(result: Any) -> Step:
    return Step("returns", lambda ctx: result, 0)


def _raising(exc: BaseException, name: str = "raises") -> Step:
    def run(ctx: StepContext) -> StepResult:
        raise exc

    return Step(name, run, 0)


def test_run_steps_requires_an_on_outcome_keyword() -> None:
    # A caller that left it out would run its steps and report none of them to Sentry.
    # The `_run` helper above supplies a no-op reporter for the tests that ignore reports.
    on_outcome = inspect.signature(run_steps).parameters["on_outcome"]

    assert on_outcome.kind is inspect.Parameter.KEYWORD_ONLY
    assert on_outcome.default is inspect.Parameter.empty


# --- order and deadlines ---------------------------------------------------------


def test_runs_steps_in_order_with_their_own_deadlines(settings: Settings, clock) -> None:
    seen: list[StepContext] = []
    step_list = [_ok("alpha", seen, 100), _ok("bravo", seen, 50), _ok("charlie", seen, 10)]

    outcomes = _run(step_list, settings)

    assert [o.name for o in outcomes] == ["alpha", "bravo", "charlie"]
    assert [o.status for o in outcomes] == ["ok", "ok", "ok"]
    # Each step must stop early enough to leave every later step its minimum.
    assert [c.deadline for c in seen] == [RUN_DEADLINE - 60, RUN_DEADLINE - 10, RUN_DEADLINE]


def test_context_carries_the_run_and_tonights_tape(settings: Settings, clock) -> None:
    seen: list[StepContext] = []
    tape = [DayOutcome(date(2026, 11, 6), "landed", rows=10, bytes=100)]

    _run([_ok("alpha", seen)], settings, tape=tape)

    (ctx,) = seen
    assert ctx.settings is settings
    assert ctx.now_utc == NOW
    assert ctx.last_session == LAST_SESSION
    assert ctx.tape == tuple(tape)
    assert isinstance(ctx.tape, tuple)


def test_seconds_left_reads_the_clock(settings: Settings, clock) -> None:
    ctx = StepContext(settings, NOW, LAST_SESSION, deadline=START + 500.0, tape=())
    assert ctx.seconds_left() == 500.0
    clock.now = START + 620.5
    assert ctx.seconds_left() == -120.5


def test_no_steps_means_no_outcomes(settings: Settings, clock) -> None:
    assert _run([], settings) == []


def test_outcome_reports_result_fields_and_seconds_spent(settings: Settings, clock) -> None:
    counts = {"rows": 7, "days": 2}

    def run(ctx: StepContext) -> StepResult:
        clock.now += 12.5
        return StepResult("partial", counts, "work left for tomorrow")

    (outcome,) = _run([Step("alpha", run, 0)], settings)

    assert outcome == StepOutcome(
        "alpha", "partial", {"rows": 7, "days": 2}, "work left for tomorrow", 12.5
    )
    assert outcome.error is None
    # A copy: a step that keeps editing its dict must not change a delivered outcome.
    assert outcome.counts is not counts


def test_reserve_seconds_sums_min_seconds() -> None:
    a, b, c = (
        Step(n, lambda ctx: StepResult("ok", {}), s) for n, s in (("a", 100), ("b", 50), ("c", 0))
    )
    assert reserve_seconds([a, b, c]) == 150
    assert reserve_seconds((b,)) == 50
    assert reserve_seconds([]) == 0


# --- skipping on the deadline ----------------------------------------------------


def test_step_skipped_when_under_min_seconds_left(settings: Settings, clock) -> None:
    seen: list[StepContext] = []
    ran: list[str] = []

    def big(ctx: StepContext) -> StepResult:
        ran.append("big")
        return StepResult("ok", {})

    # 100 s to the run deadline: the 500 s step cannot start, the 0 s one can.
    outcomes = _run(
        [Step("big", big, 500), _ok("zero", seen, 0)], settings, run_deadline=START + 100.0
    )

    assert ran == []
    assert outcomes[0] == StepOutcome(
        "big", "skipped_deadline", {}, "less than the step's minimum run time left", 0.0
    )
    assert outcomes[1].status == "ok"
    assert [c.deadline for c in seen] == [START + 100.0]  # a skip changes nobody's deadline


@pytest.mark.parametrize(("left", "runs"), [(500.0, True), (499.999, False)])
def test_a_step_starts_with_exactly_its_minimum_left(
    settings: Settings, clock, left: float, runs: bool
) -> None:
    seen: list[StepContext] = []

    (outcome,) = _run([_ok("edge", seen, 500)], settings, run_deadline=START + left)

    assert (outcome.status == "ok") is runs
    assert bool(seen) is runs


def test_a_step_that_overruns_leaves_the_next_one_skipped(settings: Settings, clock) -> None:
    seen: list[StepContext] = []

    def slow(ctx: StepContext) -> StepResult:
        clock.now = ctx.deadline + 30  # ignores its own deadline, eating the later step's reserve
        return StepResult("ok", {})

    outcomes = _run(
        [Step("slow", slow, 0), _ok("late", seen, 50), _ok("last", seen, 0)],
        settings,
        run_deadline=START + 1_000.0,
    )

    assert [(o.name, o.status) for o in outcomes] == [
        ("slow", "ok"),
        ("late", "skipped_deadline"),
        ("last", "ok"),
    ]
    assert [c.deadline for c in seen] == [START + 1_000.0]


def test_a_skipped_step_is_reported_to_on_outcome(settings: Settings, clock) -> None:
    reported: list[StepOutcome] = []
    seen: list[StepContext] = []

    outcomes = _run(
        [Step("big", lambda ctx: StepResult("ok", {}), 500), _ok("zero", seen)],
        settings,
        run_deadline=START + 100.0,
        on_outcome=reported.append,
    )

    assert reported == outcomes
    assert [o.status for o in reported] == ["skipped_deadline", "ok"]


# --- isolation -------------------------------------------------------------------


def test_exception_becomes_failed_and_later_steps_run(
    settings: Settings, clock, capture_exception: Mock, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[StepContext] = []
    boom = KeyError(ROW_VALUE)

    with caplog.at_level(logging.DEBUG):
        outcomes = _run([_raising(boom, "boom"), _ok("after", seen)], settings)

    assert outcomes[0] == StepOutcome("boom", "failed", {}, "", 0.0, error="KeyError")
    assert outcomes[1].status == "ok"
    assert len(seen) == 1
    capture_exception.assert_called_once()
    assert capture_exception.call_args.args == (boom,)
    assert capture_exception.call_args.kwargs == {"tags": {"step": "boom"}}
    # The log names the class and the step, and carries no exception text or traceback.
    assert "KeyError" in caplog.text
    assert "boom" in caplog.text
    assert ROW_VALUE not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_a_failed_step_is_reported_to_on_outcome_once(
    settings: Settings, clock, capture_exception: Mock
) -> None:
    reported: list[StepOutcome] = []

    outcomes = _run([_raising(OSError("x"), "boom")], settings, on_outcome=reported.append)

    assert reported == outcomes
    assert reported[0].error == "OSError"


def test_seconds_are_measured_for_a_step_that_raises(
    settings: Settings, clock, capture_exception: Mock
) -> None:
    def run(ctx: StepContext) -> StepResult:
        clock.now += 3.0
        raise ValueError("x")

    (outcome,) = _run([Step("boom", run, 0)], settings)

    assert outcome.seconds == 3.0


@pytest.mark.parametrize(
    "result",
    [
        pytest.param(StepResult("bogus", {}), id="unknown-status"),
        pytest.param(StepResult("skipped_deadline", {}), id="outcome-only-status"),
        pytest.param(StepResult("ok", {"rows": -1}), id="negative-count"),
        pytest.param(StepResult("ok", {"rows": 1.5}), id="float-count"),
        pytest.param(StepResult("ok", {"rows": "3"}), id="string-count"),
        pytest.param(StepResult("ok", {"rows": None}), id="none-count"),
        pytest.param(StepResult("ok", {"rows": True}), id="bool-count"),
        pytest.param(StepResult("ok", {7: 1}), id="non-string-name"),
        pytest.param(StepResult("ok", [("rows", 1)]), id="counts-not-a-mapping"),
        pytest.param(StepResult("ok", {}, detail=5), id="non-string-detail"),
        pytest.param(None, id="no-result"),
        pytest.param({"status": "ok", "counts": {}}, id="a-dict-not-a-StepResult"),
    ],
)
def test_invalid_result_is_failed(
    settings: Settings,
    clock,
    capture_exception: Mock,
    caplog: pytest.LogCaptureFixture,
    result: Any,
) -> None:
    seen: list[StepContext] = []

    with caplog.at_level(logging.DEBUG):
        outcomes = _run([_returning(result), _ok("after", seen)], settings)

    assert outcomes[0] == StepOutcome("returns", "failed", {}, INVALID, 0.0)
    assert outcomes[1].status == "ok"  # the bad result isolated one step only
    capture_exception.assert_not_called()  # nothing was raised; report_step sends the event
    assert "returns" in caplog.text
    assert INVALID in caplog.text


@pytest.mark.parametrize(
    "result",
    [
        pytest.param(StepResult("ok", {}), id="empty-counts"),
        pytest.param(StepResult("ok", {"rows": 0}), id="zero-count"),  # nothing to do is a count
        pytest.param(StepResult("partial", {"rows": 7, "days_left": 2}, "work left"), id="partial"),
        pytest.param(StepResult("failed", {"rows": 0}, "nothing landed"), id="failed-result"),
    ],
)
def test_valid_results_keep_their_status_counts_and_detail(
    settings: Settings, clock, result: StepResult
) -> None:
    (outcome,) = _run([_returning(result)], settings)
    assert outcome == StepOutcome("returns", result.status, dict(result.counts), result.detail, 0.0)
    assert outcome.error is None


# --- the log line -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("step", "run_deadline", "level"),
    [
        pytest.param(
            _returning(StepResult("ok", {"rows": 1})), RUN_DEADLINE, logging.INFO, id="ok"
        ),
        pytest.param(
            _returning(StepResult("partial", {"rows": 1})),
            RUN_DEADLINE,
            logging.WARNING,
            id="partial",
        ),
        pytest.param(
            _returning(StepResult("failed", {"rows": 1})),
            RUN_DEADLINE,
            logging.WARNING,
            id="failed",
        ),
        pytest.param(_returning(None), RUN_DEADLINE, logging.WARNING, id="invalid-result"),
        pytest.param(_raising(OSError("x")), RUN_DEADLINE, logging.WARNING, id="raised"),
        pytest.param(
            Step("returns", lambda ctx: StepResult("ok", {}), 10_000),
            START + 1.0,
            logging.WARNING,
            id="skipped",
        ),
    ],
)
def test_only_a_clean_step_logs_at_info(
    settings: Settings,
    clock,
    capture_exception: Mock,
    caplog: pytest.LogCaptureFixture,
    step: Step,
    run_deadline: float,
    level: int,
) -> None:
    with caplog.at_level(logging.DEBUG, logger="steps"):
        _run([step], settings, run_deadline=run_deadline)

    records = [r for r in caplog.records if r.name == "steps"]
    assert len(records) == 1
    assert records[0].levelno == level
    assert records[0].getMessage().startswith(f"step {step.name} ")


# --- hard stops and the outcome callback -----------------------------------------


@pytest.mark.parametrize("stop", [SystemExit(143), KeyboardInterrupt()])
def test_base_exception_propagates(
    settings: Settings, clock, capture_exception: Mock, stop: BaseException
) -> None:
    seen: list[StepContext] = []
    reported: list[StepOutcome] = []

    with pytest.raises(type(stop)):
        _run(
            [_ok("first", seen), _raising(stop, "stopped"), _ok("never", seen)],
            settings,
            on_outcome=reported.append,
        )

    assert len(seen) == 1  # the step after the stop never started
    assert [o.name for o in reported] == ["first"]  # the stopped step reported nothing
    capture_exception.assert_not_called()


def test_base_exception_from_on_outcome_propagates(settings: Settings, clock) -> None:
    seen: list[StepContext] = []

    def stop(outcome: StepOutcome) -> None:
        raise SystemExit(143)

    with pytest.raises(SystemExit):
        _run([_ok("first", seen), _ok("never", seen)], settings, on_outcome=stop)

    assert len(seen) == 1


def test_on_outcome_failure_does_not_stop_the_run(
    settings: Settings, clock, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[StepContext] = []
    calls: list[str] = []

    def broken(outcome: StepOutcome) -> None:
        calls.append(outcome.name)
        raise RuntimeError(ROW_VALUE)

    with caplog.at_level(logging.DEBUG):
        outcomes = _run([_ok("one", seen), _ok("two", seen)], settings, on_outcome=broken)

    assert [o.name for o in outcomes] == ["one", "two"]
    assert [o.status for o in outcomes] == ["ok", "ok"]
    assert calls == ["one", "two"]  # still called for the step after the failure
    assert "RuntimeError" in caplog.text
    assert ROW_VALUE not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_on_outcome_sees_outcomes_in_step_order(settings: Settings, clock) -> None:
    seen: list[StepContext] = []
    reported: list[StepOutcome] = []

    outcomes = _run([_ok("one", seen), _ok("two", seen)], settings, on_outcome=reported.append)

    assert reported == outcomes
    assert [o.name for o in reported] == ["one", "two"]


# --- what leaves the process -----------------------------------------------------


def _connect_fails() -> None:
    raise psycopg2.OperationalError(CONNECT_ERROR)


def _wrapped_with_cause() -> None:
    try:
        _connect_fails()
    except psycopg2.OperationalError as exc:
        raise RuntimeError("could not reach the database") from exc


def _wrapped_implicitly() -> None:
    try:
        _connect_fails()
    except psycopg2.OperationalError:
        raise RuntimeError("could not reach the database")  # noqa: B904 - the chain is the case


def _connect_fails_while_handling_another() -> None:
    try:
        raise OSError("socket closed")
    except OSError:
        _connect_fails()  # the OperationalError is raised last, with the OSError as context


WRAPPED = {"RuntimeError": "could not reach the database"}


@pytest.mark.parametrize(
    ("raiser", "class_name", "kept"),
    [
        pytest.param(_connect_fails, "OperationalError", {}, id="direct"),
        pytest.param(_wrapped_with_cause, "RuntimeError", WRAPPED, id="chained-cause"),
        pytest.param(_wrapped_implicitly, "RuntimeError", WRAPPED, id="chained-context"),
        pytest.param(
            _connect_fails_while_handling_another,
            "OperationalError",
            {"OSError": "socket closed"},
            id="data-library-error-last-in-the-chain",
        ),
    ],
)
def test_a_failed_connect_leaks_no_host_to_the_log_or_the_event(
    settings: Settings,
    clock,
    capture_exception: Mock,
    caplog: pytest.LogCaptureFixture,
    raiser: Callable[[], None],
    class_name: str,
    kept: dict[str, str],
) -> None:
    # connect_db lets the OperationalError from a failed connect propagate unchanged, and
    # its message carries the Neon host. Neither the log nor the event may carry it.
    def run(ctx: StepContext) -> StepResult:
        raiser()
        return StepResult("ok", {})

    with caplog.at_level(logging.DEBUG):
        (outcome,) = _run([Step("enrich-outcomes", run, 0)], settings)

    assert outcome.error == class_name
    for needle in (HOST, "neondb_owner", "password authentication"):
        assert needle not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)

    capture_exception.assert_called_once()
    (captured,) = capture_exception.call_args.args
    event, _hint = event_from_exception(captured)
    event = json.loads(json.dumps(event, default=str))
    assert HOST in json.dumps(event)  # the leak this guards against: it is in the raw event
    values = event["exception"]["values"]
    assert len(values) == 1 + len(kept)  # a chain adds an entry per link
    assert values[-1]["type"] == class_name  # the exception that escaped is the last entry

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    text = json.dumps(scrubbed)
    for needle in (HOST, "neondb_owner", "password authentication"):
        assert needle not in text
    by_type = {v["type"]: v["value"] for v in scrubbed["exception"]["values"]}
    # The data-library link is redacted wherever it sits; every other link keeps its text.
    assert by_type == {"OperationalError": REDACTED, **kept}


def _convert_a_cell() -> None:
    int(ROW_VALUE)


def _convert_and_re_raise_fixed_from_none() -> None:
    try:
        _convert_a_cell()
    except ValueError:
        raise RuntimeError("could not convert a cell") from None


def _convert_and_re_raise_fixed_from_exc() -> None:
    try:
        _convert_a_cell()
    except ValueError as exc:
        raise RuntimeError("could not convert a cell") from exc


@pytest.mark.parametrize(
    ("raiser", "leaks"),
    [
        pytest.param(_convert_and_re_raise_fixed_from_none, False, id="from-none"),
        # The rule in steps.py: a plain `from exc` keeps the original, and its text, in the
        # chain, and the scrubber cannot tell that a first-party ValueError quotes a cell.
        pytest.param(_convert_and_re_raise_fixed_from_exc, True, id="from-exc"),
    ],
)
def test_a_fixed_message_raised_from_none_keeps_a_raw_conversion_error_out_of_the_event(
    settings: Settings,
    clock,
    capture_exception: Mock,
    raiser: Callable[[], None],
    leaks: bool,
) -> None:
    def run(ctx: StepContext) -> StepResult:
        raiser()
        return StepResult("ok", {})

    _run([Step("enrich-outcomes", run, 0)], settings)

    (captured,) = capture_exception.call_args.args
    event, _hint = event_from_exception(captured)
    scrubbed = scrub_event(json.loads(json.dumps(event, default=str)), {})

    assert scrubbed is not None
    assert (ROW_VALUE in json.dumps(scrubbed)) is leaks
    values = scrubbed["exception"]["values"]
    assert values[-1]["value"] == "could not convert a cell"
    assert len(values) == (2 if leaks else 1)
