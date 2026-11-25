"""Tests for the step registry: valid unique names, lazy step imports and import isolation.

`lazy_step` imports a step's module when the step runs, so a module that cannot import
fails that step alone (D2). The laziness is checked in a fresh interpreter, because this
process has already imported the step modules.
"""

from __future__ import annotations

import json
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
import interval_ba_step
import main
import outcome_check
import refit_step
import research_db_steps
import research_derive
import research_reports
from config import Settings, load_settings
from constants import (
    ENRICH_DAY_BUDGET_SECONDS,
    INTERVAL_BA_DAY_BUDGET_SECONDS,
    LARGE_REPORT_BUDGET_SECONDS,
    OUTCOME_CHECK_BUDGET_SECONDS,
    PROMOTION_MIN_SECONDS,
    REFIT_BUDGET_SECONDS,
    REPORT_BUDGET_SECONDS,
    RESEARCH_DAY_BUDGET_SECONDS,
)
from pipeline import STEPS, lazy_group_step, lazy_step
from steps import Step, StepContext, StepOutcome, StepResult, reserve_seconds, run_steps

NIGHTLY_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = NIGHTLY_DIR.parent / "scripts"
ML_SRC_DIR = NIGHTLY_DIR.parent / "ml" / "src"
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
        on_outcome=lambda _outcome: None,  # these tests read the returned outcomes
    )


# --- the registry ---------------------------------------------------------------------


def test_pipeline_step_names_unique_and_valid() -> None:
    names = [step.name for step in STEPS]

    assert len(set(names)) == len(names)
    for name in names:
        assert NAME.fullmatch(name), f"{name!r} is not lowercase kebab-case"
        assert len(name) <= MAX_NAME_LENGTH


def test_pipeline_order_and_reserve() -> None:
    # The names are literals on purpose: they pin the value of REFIT_STEP_NAME, which the
    # registry takes from constants. Each step's place is a data dependency: the check
    # reads what the enrichment just wrote (the other order alerts on yesterday's gaps),
    # the Interval B/A step writes Neon and carries live's outage alert, so it runs before
    # the long steps that could squeeze it, the refit trains on tonight's fresh outcomes,
    # and the research steps come last: the derive step keeps the per-day state the reports
    # read, so it runs before them, and all of them read the outcomes the enrichment just
    # filled.
    expected = [
        ("enrich-outcomes", ENRICH_DAY_BUDGET_SECONDS),
        ("outcome-check", OUTCOME_CHECK_BUDGET_SECONDS),
        ("interval-ba-tape", INTERVAL_BA_DAY_BUDGET_SECONDS),
        ("lottery-refit", REFIT_BUDGET_SECONDS),
        ("research-derive", RESEARCH_DAY_BUDGET_SECONDS),
        ("eod-flow-rollup", REPORT_BUDGET_SECONDS),
        ("whale-plots", REPORT_BUDGET_SECONDS),
        ("exit-policy-report", LARGE_REPORT_BUDGET_SECONDS),
        ("flow-timing-report", LARGE_REPORT_BUDGET_SECONDS),
        ("feature-audit", REPORT_BUDGET_SECONDS),
        ("outcome-mining", REPORT_BUDGET_SECONDS),
        ("score-lineage", REPORT_BUDGET_SECONDS),
        ("lottery-tracking", REPORT_BUDGET_SECONDS),
        ("quality-sim", REPORT_BUDGET_SECONDS),
        ("takeit-drift", REPORT_BUDGET_SECONDS),
    ]

    assert [(step.name, step.min_seconds) for step in STEPS] == expected
    # Phase 2's two, the Interval B/A step's, the refit's, the derive step's, eight steps at the
    # report budget and two at the large one (D2's budget table; 8,400 s today). The sum is
    # spelled out, never a literal total.
    assert reserve_seconds(STEPS) == (
        ENRICH_DAY_BUDGET_SECONDS
        + OUTCOME_CHECK_BUDGET_SECONDS
        + INTERVAL_BA_DAY_BUDGET_SECONDS
        + REFIT_BUDGET_SECONDS
        + RESEARCH_DAY_BUDGET_SECONDS
        + 8 * REPORT_BUDGET_SECONDS
        + 2 * LARGE_REPORT_BUDGET_SECONDS
    )
    # A promotion starts only with PROMOTION_MIN_SECONDS left (the step's deadline counts),
    # so the refit's reserve must cover one.
    assert PROMOTION_MIN_SECONDS <= REFIT_BUDGET_SECONDS


def test_each_steps_minimum_is_read_from_its_named_constant() -> None:
    # The test above compares values, which a literal that happens to equal its constant (300
    # and REPORT_BUDGET_SECONDS) passes. A child that gives every constant a value of its own
    # before the registry loads shows where each minimum comes from.
    table = [
        ("enrich-outcomes", "ENRICH_DAY_BUDGET_SECONDS"),
        ("outcome-check", "OUTCOME_CHECK_BUDGET_SECONDS"),
        ("interval-ba-tape", "INTERVAL_BA_DAY_BUDGET_SECONDS"),
        ("lottery-refit", "REFIT_BUDGET_SECONDS"),
        ("research-derive", "RESEARCH_DAY_BUDGET_SECONDS"),
        ("eod-flow-rollup", "REPORT_BUDGET_SECONDS"),
        ("whale-plots", "REPORT_BUDGET_SECONDS"),
        ("exit-policy-report", "LARGE_REPORT_BUDGET_SECONDS"),
        ("flow-timing-report", "LARGE_REPORT_BUDGET_SECONDS"),
        ("feature-audit", "REPORT_BUDGET_SECONDS"),
        ("outcome-mining", "REPORT_BUDGET_SECONDS"),
        ("score-lineage", "REPORT_BUDGET_SECONDS"),
        ("lottery-tracking", "REPORT_BUDGET_SECONDS"),
        ("quality-sim", "REPORT_BUDGET_SECONDS"),
        ("takeit-drift", "REPORT_BUDGET_SECONDS"),
    ]
    patched = {name: 7_001 + index for index, name in enumerate(sorted({c for _, c in table}))}
    code = (
        "import json, constants\n"
        + "".join(f"constants.{name} = {value}\n" for name, value in patched.items())
        + "import pipeline\n"
        + "print(json.dumps([[step.name, step.min_seconds] for step in pipeline.STEPS]))\n"
    )

    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=NIGHTLY_DIR,
        env={
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [str(NIGHTLY_DIR / "src"), str(SCRIPTS_DIR), str(ML_SRC_DIR)]
            ),
        },
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [[name, patched[constant]] for name, constant in table]


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


def test_the_registered_interval_ba_tape_runs_interval_ba_step(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    # The module is named by a string: a typo there would only fail at 07:15 UTC.
    (step,) = (s for s in STEPS if s.name == "interval-ba-tape")
    result = StepResult("ok", {"days_done": 1})
    fake = create_autospec(interval_ba_step.run, return_value=result)
    monkeypatch.setattr(interval_ba_step, "run", fake)
    ctx = _ctx(settings)

    assert step.run(ctx) is result

    fake.assert_called_once_with(ctx)


def test_the_registered_refit_runs_the_refit_step_module(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    # The module is named by a string: a typo there would only fail at 07:15 UTC.
    (step,) = (s for s in STEPS if s.name == "lottery-refit")
    result = StepResult("ok", {"candidates_built": 1})
    fake = create_autospec(refit_step.run, return_value=result)
    monkeypatch.setattr(refit_step, "run", fake)
    ctx = _ctx(settings)

    assert step.run(ctx) is result

    fake.assert_called_once_with(ctx)


def test_pipeline_imports_no_step_module_at_load() -> None:
    # The child puts src/, scripts/ and ml/src/ on sys.path in the Dockerfile's order,
    # so a module of ml/src that something did load would import; it needs no database,
    # network or environment variable to import the registry. The scripts (numpy, pandas,
    # psycopg2) and the refit's ml/src modules are the heavy part of a step module: none
    # loads either (D2), so a bad shared file fails its own step and not the tape.
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [str(NIGHTLY_DIR / "src"), str(SCRIPTS_DIR), str(ML_SRC_DIR)]
        ),
    }
    # The step modules and the shared files (scripts/, ml/src/) they pull in: every repo module
    # that importing `refit_step`, `enrich_step`, `outcome_check`, `interval_ba_step` and the
    # three research modules loads and `pipeline` itself does not. `monitoring` and `resources`
    # are not here: they are nightly's own infrastructure, which `main` imports at load before
    # any step runs, so keeping them out of `pipeline` would protect nothing. A step's module
    # missing from this list could be pulled in at load without this test seeing it. The
    # research list ends with the two packages the report scripts load first: duckdb and
    # matplotlib.
    loaded = (
        "outcome_check",
        "enrich_step",
        "enrich_lottery_outcomes",
        "enrich_silent_boom_outcomes",
        "interval_ba_step",
        "interval_ba_replay",
        "refit_step",
        "weights_store",
        "_tape_reader",
        "_pipeline_retry",
        "_cli_paths",
        "backfill_lottery_scores",
        "lottery_scoring",
        "lottery_weights",
        "lottery_refit_gates",
        "lottery_exit_policies",
        "research_derive",
        "research_reports",
        "research_db_steps",
        "research_store",
        "_eod_flow",
        "_report_weights",
        "exit_policy_search",
        "flow_inversion_timing",
        "daily_tracker",
        "whale_plots",
        "takeit_drift_monitor",
        "duckdb",
        "matplotlib",
    )
    # Print the names that did load, so a failure names the module that broke D2.
    code = f"import sys, pipeline; print([name for name in {loaded!r} if name in sys.modules])"

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
    assert result.stdout.strip() == "[]"


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


# --- lazy_group_step ------------------------------------------------------------------


def test_lazy_group_step_carries_its_name_and_minimum() -> None:
    step = lazy_group_step("some-step", "no_such_group_module", 42)

    assert (step.name, step.min_seconds) == ("some-step", 42)
    assert callable(step.run)


def test_lazy_group_step_imports_late_and_dispatches_by_name(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    calls: list[tuple[str, StepContext]] = []

    def fake_run_step(name: str, ctx: StepContext) -> StepResult:
        calls.append((name, ctx))
        return StepResult("ok", {"calls": len(calls)})

    ctx = _ctx(settings)
    first = lazy_group_step("first-step", "fake_group_module", 0)
    second = lazy_group_step("second-step", "fake_group_module", 0)
    assert "fake_group_module" not in sys.modules  # building the steps imports nothing

    monkeypatch.setitem(sys.modules, "fake_group_module", SimpleNamespace(run_step=fake_run_step))

    # Each step hands the module its own name, and only its own.
    assert first.run(ctx) == StepResult("ok", {"calls": 1})
    assert second.run(ctx) == StepResult("ok", {"calls": 2})
    assert calls == [("first-step", ctx), ("second-step", ctx)]


@pytest.mark.parametrize(
    ("source", "error"),
    [
        (None, "ModuleNotFoundError"),
        ("raise ImportError('cannot import name x')", "ImportError"),
        ("def broken(:", "SyntaxError"),
    ],
    ids=["missing-module", "failing-import", "syntax-error"],
)
def test_import_error_in_a_group_module_fails_only_that_step(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    settings: Settings,
    capture_exception: Mock,
    source: str | None,
    error: str,
) -> None:
    if source is not None:
        (tmp_path / "broken_group_module.py").write_text(source, encoding="utf-8")
        monkeypatch.syspath_prepend(str(tmp_path))
    module = "no_such_group_module" if source is None else "broken_group_module"
    ran: list[str] = []

    def fake_run_step(name: str, ctx: StepContext) -> StepResult:
        ran.append(name)
        return StepResult("ok", {"things": 1})

    monkeypatch.setitem(sys.modules, "good_group_module", SimpleNamespace(run_step=fake_run_step))

    broken, same_module, other_module = _run(
        settings,
        [
            lazy_group_step("broken", module, 0),
            lazy_group_step("also-broken", module, 0),
            lazy_group_step("fine", "good_group_module", 0),
        ],
    )

    assert (broken.name, broken.status, broken.error) == ("broken", "failed", error)
    # Every step of the broken module fails alone, on its own import...
    assert (same_module.name, same_module.status, same_module.error) == (
        "also-broken",
        "failed",
        error,
    )
    # ...and a step of another module still runs after them.
    assert other_module.status == "ok"
    assert ran == ["fine"]
    assert [call.kwargs for call in capture_exception.call_args_list] == [
        {"tags": {"step": "broken"}},
        {"tags": {"step": "also-broken"}},
    ]
    assert sys.modules.get(module) is None  # a failed import leaves nothing behind


# --- the research steps ---------------------------------------------------------------

REPORT_STEP_NAMES = (
    "eod-flow-rollup",
    "whale-plots",
    "exit-policy-report",
    "flow-timing-report",
    "feature-audit",
    "outcome-mining",
    "score-lineage",
)
DB_STEP_NAMES = ("lottery-tracking", "quality-sim", "takeit-drift")


def test_every_group_step_name_is_registered() -> None:
    registered = {step.name for step in STEPS}

    assert registered >= research_reports.STEP_NAMES
    assert registered >= research_db_steps.STEP_NAMES
    # And the other way: a registered research step that no module holds would raise KeyError
    # at 07:15. The steps with a module of their own are registered by lazy_step.
    own_module_steps = {
        "enrich-outcomes",
        "outcome-check",
        "interval-ba-tape",
        "lottery-refit",
        "research-derive",
    }
    assert (
        registered - own_module_steps == research_reports.STEP_NAMES | research_db_steps.STEP_NAMES
    )
    assert set(REPORT_STEP_NAMES) == research_reports.STEP_NAMES
    assert set(DB_STEP_NAMES) == research_db_steps.STEP_NAMES


def test_the_registered_research_steps_run_the_module_that_holds_them(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    # The modules are named by strings: a step registered against the wrong one would only fail
    # at 07:15, with a KeyError from the other module's run_step.
    calls: list[tuple[str, str]] = []

    def recording(module: str) -> object:
        def fake_run_step(name: str, ctx: StepContext) -> StepResult:
            calls.append((module, name))
            return StepResult("ok", {})

        return fake_run_step

    monkeypatch.setattr(research_reports, "run_step", recording("research_reports"))
    monkeypatch.setattr(research_db_steps, "run_step", recording("research_db_steps"))
    derive = create_autospec(research_derive.run, return_value=StepResult("ok", {}))
    monkeypatch.setattr(research_derive, "run", derive)
    ctx = _ctx(settings)
    by_name = {step.name: step for step in STEPS}

    for name in ("research-derive", *REPORT_STEP_NAMES, *DB_STEP_NAMES):
        assert by_name[name].run(ctx) == StepResult("ok", {})

    derive.assert_called_once_with(ctx)
    assert calls == [
        *(("research_reports", name) for name in REPORT_STEP_NAMES),
        *(("research_db_steps", name) for name in DB_STEP_NAMES),
    ]
