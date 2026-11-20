"""The steps that run after the tape, in run order.

`main` hands `STEPS` to `steps.run_steps` after `run_tape`, every night. It also gives
`run_tape` a deadline that leaves `reserve_seconds(STEPS)` of the run for them, so each
entry's `min_seconds` comes out of the tape's catch-up window. A step never starts work
its budget cannot cover, but a unit of work that overruns cuts into the next step's
reserve, and only the watchdog bounds the run. `test_deadline_constants_bound_the_run`
keeps at least two tape days in every night whatever is registered here.

Import isolation (D2): this module imports no step module. `lazy_step` imports a step's
module when the step runs, so a step module that fails to import (a missing dependency, a
syntax error) fails that step alone, as an Exception `run_steps` catches, and never stops
`main` from landing the tape or running the other steps. `lazy_group_step` does the same for a
module that holds several steps, and every one of them fails alone when it cannot import.
"""

from __future__ import annotations

import importlib

from constants import (
    ENRICH_DAY_BUDGET_SECONDS,
    LARGE_REPORT_BUDGET_SECONDS,
    OUTCOME_CHECK_BUDGET_SECONDS,
    REFIT_BUDGET_SECONDS,
    REFIT_STEP_NAME,
    REPORT_BUDGET_SECONDS,
    RESEARCH_DAY_BUDGET_SECONDS,
)
from steps import Step, StepContext, StepResult


def lazy_step(name: str, module: str, min_seconds: int) -> Step:
    """A step that runs `module.run(ctx)`, importing `module` when it runs, not before."""

    def run(ctx: StepContext) -> StepResult:
        return importlib.import_module(module).run(ctx)

    return Step(name, run, min_seconds)


def lazy_group_step(name: str, module: str, min_seconds: int) -> Step:
    """`lazy_step` for a module that holds several steps: it runs `module.run_step(name, ctx)`,
    importing `module` when the step runs, not before."""

    def run(ctx: StepContext) -> StepResult:
        return importlib.import_module(module).run_step(name, ctx)

    return Step(name, run, min_seconds)


STEPS: tuple[Step, ...] = (
    lazy_step("enrich-outcomes", "enrich_step", ENRICH_DAY_BUDGET_SECONDS),
    lazy_step("outcome-check", "outcome_check", OUTCOME_CHECK_BUDGET_SECONDS),
    # After the enrichment, which fills the outcomes the refit trains on tonight.
    lazy_step(REFIT_STEP_NAME, "refit_step", REFIT_BUDGET_SECONDS),
    # Phase 3, the research steps (D2's budget table), after everything that writes outcomes
    # and weights. The derive step keeps the per-day state the reports read, so it comes first.
    lazy_step("research-derive", "research_derive", RESEARCH_DAY_BUDGET_SECONDS),
    lazy_group_step("eod-flow-rollup", "research_reports", REPORT_BUDGET_SECONDS),
    lazy_group_step("whale-plots", "research_reports", REPORT_BUDGET_SECONDS),
    lazy_group_step("exit-policy-report", "research_reports", LARGE_REPORT_BUDGET_SECONDS),
    lazy_group_step("flow-timing-report", "research_reports", LARGE_REPORT_BUDGET_SECONDS),
    lazy_group_step("feature-audit", "research_reports", REPORT_BUDGET_SECONDS),
    lazy_group_step("outcome-mining", "research_reports", REPORT_BUDGET_SECONDS),
    lazy_group_step("score-lineage", "research_reports", REPORT_BUDGET_SECONDS),
    lazy_group_step("lottery-tracking", "research_db_steps", REPORT_BUDGET_SECONDS),
    lazy_group_step("quality-sim", "research_db_steps", REPORT_BUDGET_SECONDS),
    lazy_group_step("takeit-drift", "research_db_steps", REPORT_BUDGET_SECONDS),
)
