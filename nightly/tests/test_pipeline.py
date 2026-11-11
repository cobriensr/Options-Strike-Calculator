"""Tests for the step registry: valid unique names, lazy step imports and import isolation.

`lazy_step` imports a step's module when the step runs, so a module that cannot import
fails that step alone (D2). The laziness is checked in a fresh interpreter, because this
process has already imported the step modules.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from time import monotonic
from types import SimpleNamespace
from unittest.mock import Mock, create_autospec

import pytest
import sentry_sdk

import enrich_step
import main
import outcome_check
from config import Settings, load_settings
from constants import ENRICH_DAY_BUDGET_SECONDS, OUTCOME_CHECK_BUDGET_SECONDS
from pipeline import STEPS, lazy_step
from steps import Step, StepContext, StepOutcome, StepResult, run_steps

NIGHTLY_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = NIGHTLY_DIR.parent / "scripts"
NOW = datetime(2026, 11, 7, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 6)
# A step name is a Sentry tag value and a fingerprint part (steps.py, monitoring.py).
NAME = re.compile(r"[a-z][a-z0-9-]*[a-z0-9]")
MAX_NAME_LENGTH = 32


@pytest.fixture
def settings() -> Settings:
    return load_settings()


@pytest.fixture
def capture_exception(monkeypatch: pytest.MonkeyPatch) -> Mock:
    mock = create_autospec(sentry_sdk.capture_exception)
    monkeypatch.setattr(sentry_sdk, "capture_exception", mock)
    return mock


def _ctx(settings: Settings) -> StepContext:
    return StepContext(settings, NOW, LAST_SESSION, deadline=monotonic() + 1_000, tape=())


def _run(settings: Settings, step_list: list[Step]) -> list[StepOutcome]:
    return run_steps(
        step_list,
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=monotonic() + 1_000,
        tape=(),
    )


# --- the registry ---------------------------------------------------------------------


def test_pipeline_step_names_unique_and_valid() -> None:
    names = [step.name for step in STEPS]

    assert len(set(names)) == len(names)
    for name in names:
        assert NAME.fullmatch(name), f"{name!r} is not lowercase kebab-case"
        assert len(name) <= MAX_NAME_LENGTH


def test_outcome_check_is_registered_with_its_budget() -> None:
    (step,) = (s for s in STEPS if s.name == "outcome-check")

    assert step.min_seconds == OUTCOME_CHECK_BUDGET_SECONDS


def test_enrich_is_registered_with_its_budget() -> None:
    (step,) = (s for s in STEPS if s.name == "enrich-outcomes")

    assert step.min_seconds == ENRICH_DAY_BUDGET_SECONDS


def test_the_outcome_check_runs_after_the_enrichment() -> None:
    # The check reads what the enrichment just wrote; the other order alerts on yesterday's gaps.
    names = [step.name for step in STEPS]

    assert names.index("enrich-outcomes") < names.index("outcome-check")


def test_main_runs_the_registered_steps() -> None:
    # test_main.py empties main.STEPS for every test, so nothing there sees main's
    # own binding: this file's tests do not use that fixture.
    assert main.STEPS is STEPS


def test_the_registered_outcome_check_runs_the_outcome_check_module(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    # The module is named by a string: a typo there would only fail at 07:15 UTC.
    (step,) = (s for s in STEPS if s.name == "outcome-check")
    result = StepResult("ok", {"days_checked": 3})
    fake = create_autospec(outcome_check.run, return_value=result)
    monkeypatch.setattr(outcome_check, "run", fake)
    ctx = _ctx(settings)

    assert step.run(ctx) is result

    fake.assert_called_once_with(ctx)


def test_the_registered_enrichment_runs_the_enrich_step_module(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    # The module is named by a string: a typo there would only fail at 07:15 UTC.
    (step,) = (s for s in STEPS if s.name == "enrich-outcomes")
    result = StepResult("ok", {"days_processed": 1})
    fake = create_autospec(enrich_step.run, return_value=result)
    monkeypatch.setattr(enrich_step, "run", fake)
    ctx = _ctx(settings)

    assert step.run(ctx) is result

    fake.assert_called_once_with(ctx)


def test_pipeline_imports_no_step_module_at_load() -> None:
    # The child puts src/ and scripts/ on sys.path as the conftest does; it needs no
    # database, network or environment variable to import the registry. The scripts
    # (numpy, pandas, psycopg2) are the heavy part of a step module: none loads either.
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(NIGHTLY_DIR / "src"), str(SCRIPTS_DIR)]),
    }
    loaded = (
        "outcome_check",
        "enrich_step",
        "enrich_lottery_outcomes",
        "enrich_silent_boom_outcomes",
    )
    code = f"import sys, pipeline; print([name in sys.modules for name in {loaded!r}])"

    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=NIGHTLY_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[False, False, False, False]"


# --- lazy_step ------------------------------------------------------------------------


def test_lazy_step_carries_its_name_and_minimum() -> None:
    step = lazy_step("some-step", "no_such_step_module", 42)

    assert (step.name, step.min_seconds) == ("some-step", 42)
    assert callable(step.run)


def test_lazy_step_imports_the_module_when_it_runs_and_hands_it_the_context(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    result = StepResult("ok", {"things": 1})
    fake_run = create_autospec(outcome_check.run, return_value=result)
    ctx = _ctx(settings)
    step = lazy_step("fake-step", "fake_step_module", 0)
    assert "fake_step_module" not in sys.modules  # building the step imports nothing

    monkeypatch.setitem(sys.modules, "fake_step_module", SimpleNamespace(run=fake_run))

    assert step.run(ctx) is result
    fake_run.assert_called_once_with(ctx)


@pytest.mark.parametrize(
    ("source", "error"),
    [
        (None, "ModuleNotFoundError"),
        ("raise ImportError('cannot import name x')", "ImportError"),
        ("def broken(:", "SyntaxError"),
    ],
    ids=["missing-module", "failing-import", "syntax-error"],
)
def test_import_error_in_a_step_module_fails_only_that_step(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    settings: Settings,
    capture_exception: Mock,
    source: str | None,
    error: str,
) -> None:
    if source is not None:
        (tmp_path / "broken_step_module.py").write_text(source, encoding="utf-8")
        monkeypatch.syspath_prepend(str(tmp_path))
    module = "no_such_step_module" if source is None else "broken_step_module"
    ran: list[StepContext] = []

    def passing(ctx: StepContext) -> StepResult:
        ran.append(ctx)
        return StepResult("ok", {"things": 1})

    broken, after = _run(settings, [lazy_step("broken", module, 0), Step("after", passing, 0)])

    assert broken.name == "broken"
    assert broken.status == "failed"
    assert broken.error == error
    assert after.status == "ok"
    assert len(ran) == 1  # the step after the broken one still ran
    capture_exception.assert_called_once()
    assert capture_exception.call_args.kwargs == {"tags": {"step": "broken"}}
    assert sys.modules.get(module) is None  # a failed import leaves nothing behind
