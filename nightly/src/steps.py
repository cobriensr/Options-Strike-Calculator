"""The ordered steps that run after the tape, each with its own deadline and isolated
from the others.

`run_steps` runs the steps in order, every night, whatever the tape did. Each step gets
a deadline that leaves every later step its `min_seconds`. A step never starts work its
budget cannot cover, but a unit of work that overruns cuts into the next step's reserve,
and only the watchdog bounds the run. A step that starts with less than its own minimum
left is skipped (`skipped_deadline`) while the later ones still run.

Isolation: an Exception from a step becomes a `failed` outcome carrying the exception's
class name, plus one `capture_exception` tagged with the step. The event reaches Sentry
through `monitoring.scrub_event`, which cuts the text of data-library exceptions (a
psycopg2 connect error carries the Neon host, an insert error the failing row). The log
line names the class only, never the text or a traceback. A BaseException (SIGTERM's
SystemExit, Ctrl-C) propagates, so the run ends and `main` reports it. A result that
breaks the StepResult contract fails that step alone.

Rules for a step's author, because the scrubber cannot catch these:
- Do not let a raw conversion error escape. A builtin raised by C code directly under
  step code has no data-library frame, so no rule can tell that its text quotes a cell:
  `np.array([cell]).astype("int64")` and `int(cell)` raise `invalid literal for int()
  ... '<cell>'`, and that text would reach Sentry (cut to 300 characters, not redacted).
  Catch it and raise a fixed-message exception with `from None`. A raise without
  `from None`, whether `from exc` or nothing at all inside the `except`, keeps the
  original, with its text, in the chain Sentry sends. (Inside a callback that polars or
  pandas calls, such as `map_elements` or `apply`, the library's frames are on the stack
  and the scrubber does redact it.)
- `StepResult.detail` is a fixed phrase: no dates, counts, ids or exception text. It is
  part of the Sentry fingerprint (`monitoring.report_step`), so a detail that varies
  opens a new issue, and sends a new email, every night.

Outcomes go to `on_outcome` as each step is decided (`monitoring.report_step`), so a run
killed mid-way has already reported the steps that finished. Logs follow the service
rule: counts, durations, step names and exception class names, never exception text or
row data.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from time import monotonic
from typing import Literal, get_args

import sentry_sdk

from config import Settings
from tape_job import DayOutcome

log = logging.getLogger(__name__)

StepStatus = Literal["ok", "partial", "failed"]
OutcomeStatus = Literal["ok", "partial", "failed", "skipped_deadline"]

INVALID_RESULT = "invalid step result"
_SKIPPED_DEADLINE = "less than the step's minimum run time left"


@dataclass(frozen=True)
class StepContext:
    """What a step gets: the run's settings and clock, the last session, tonight's tape
    outcomes (empty if run_tape raised) and the monotonic() time THIS step must stop by."""

    settings: Settings
    now_utc: datetime
    last_session: date
    deadline: float
    tape: tuple[DayOutcome, ...]

    def seconds_left(self) -> float:
        return self.deadline - monotonic()


@dataclass(frozen=True)
class StepResult:
    """A step's report. `counts` maps snake_case names to ints >= 0 (never row data, and
    plain ints: a numpy integer is not one). `detail` is a fixed phrase, safe to log and
    to send to Sentry: no dates, counts, ids or exception text, since it is part of the
    Sentry fingerprint and a varying one opens a new issue and email every night.
    `partial` means work is left for the next night."""

    status: StepStatus
    counts: Mapping[str, int]
    detail: str = ""


@dataclass(frozen=True)
class Step:
    """A named unit of post-tape work. `min_seconds` is the worst case of one unit of
    work: the run reserves it for this step ahead of everything before it."""

    name: str
    run: Callable[[StepContext], StepResult]
    min_seconds: int


@dataclass(frozen=True)
class StepOutcome:
    """What happened to one step. `error` is the exception class name when it raised."""

    name: str
    status: OutcomeStatus
    counts: Mapping[str, int]
    detail: str
    seconds: float
    error: str | None = None


def reserve_seconds(steps: Sequence[Step]) -> int:
    """The run time the steps need at least: the sum of their `min_seconds`."""
    return sum(step.min_seconds for step in steps)


def run_steps(
    steps: Sequence[Step],
    *,
    settings: Settings,
    now_utc: datetime,
    last_session: date,
    run_deadline: float,
    tape: Sequence[DayOutcome],
    on_outcome: Callable[[StepOutcome], None],
) -> list[StepOutcome]:
    """Run `steps` in order and return one outcome per step.

    Step i gets `deadline = run_deadline - reserve_seconds(steps[i + 1:])`. Every
    Exception a step raises is its outcome; only a BaseException escapes. An Exception
    from `on_outcome` is logged by class name and the run goes on. `on_outcome` has no
    default: a caller that left it out would run its steps and report none of them.
    """
    tape_days = tuple(tape)
    reserved = reserve_seconds(steps)
    outcomes: list[StepOutcome] = []
    for step in steps:
        reserved -= step.min_seconds  # now what the steps after this one need
        context = StepContext(settings, now_utc, last_session, run_deadline - reserved, tape_days)
        outcome = _run_one(step, context)
        outcomes.append(outcome)
        _log_outcome(outcome)
        _notify(on_outcome, outcome)
    return outcomes


def _run_one(step: Step, context: StepContext) -> StepOutcome:
    if context.seconds_left() < step.min_seconds:
        return StepOutcome(step.name, "skipped_deadline", {}, _SKIPPED_DEADLINE, 0.0)
    started = monotonic()
    try:
        result = step.run(context)
    except Exception as exc:
        # The event is scrubbed in before_send; the outcome and the log keep the class only.
        sentry_sdk.capture_exception(exc, tags={"step": step.name})
        return StepOutcome(
            step.name, "failed", {}, "", monotonic() - started, error=type(exc).__name__
        )
    seconds = monotonic() - started
    if not _is_valid(result):
        return StepOutcome(step.name, "failed", {}, INVALID_RESULT, seconds)
    return StepOutcome(step.name, result.status, dict(result.counts), result.detail, seconds)


def _is_valid(result: object) -> bool:
    """Whether `result` is a StepResult with a known status, a str detail and a mapping
    of str names to ints >= 0."""
    if not isinstance(result, StepResult):
        return False
    return (
        result.status in get_args(StepStatus)
        and isinstance(result.detail, str)
        and isinstance(result.counts, Mapping)
        and all(isinstance(name, str) and _is_count(n) for name, n in result.counts.items())
    )


def _is_count(value: object) -> bool:
    # bool is an int, but a flag is not a count.
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _notify(on_outcome: Callable[[StepOutcome], None], outcome: StepOutcome) -> None:
    """Hand `outcome` to the caller's callback; a failing report never stops the run."""
    try:
        on_outcome(outcome)
    except Exception as exc:
        log.warning("step %s: outcome report failed (%s)", outcome.name, type(exc).__name__)


def _log_outcome(outcome: StepOutcome) -> None:
    level = logging.INFO if outcome.status == "ok" else logging.WARNING
    why = outcome.error or outcome.detail
    log.log(
        level,
        "step %s %s%s%s in %.1fs",
        outcome.name,
        outcome.status,
        f" ({why})" if why else "",
        "".join(f" {name}={n}" for name, n in outcome.counts.items()),
        outcome.seconds,
    )
