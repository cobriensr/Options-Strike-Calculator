"""The steps that run after the tape, in run order.

`main` hands `STEPS` to `steps.run_steps` after `run_tape`, every night. It also gives
`run_tape` a deadline that leaves `reserve_seconds(STEPS)` of the run for them, so each
entry's `min_seconds` comes out of the tape's catch-up window and an earlier step can
never starve a later one. `test_deadline_constants_bound_the_run` keeps at least two
tape days in every night whatever is registered here.

Import isolation (D2): this module imports no step module. `lazy_step` imports a step's
module when the step runs, so a step module that fails to import (a missing dependency, a
syntax error) fails that step alone, as an Exception `run_steps` catches, and never stops
`main` from landing the tape or running the other steps.
"""

from __future__ import annotations

import importlib

from constants import ENRICH_DAY_BUDGET_SECONDS, OUTCOME_CHECK_BUDGET_SECONDS
from steps import Step, StepContext, StepResult


def lazy_step(name: str, module: str, min_seconds: int) -> Step:
    """A step that runs `module.run(ctx)`, importing `module` when it runs, not before."""

    def run(ctx: StepContext) -> StepResult:
        return importlib.import_module(module).run(ctx)

    return Step(name, run, min_seconds)


STEPS: tuple[Step, ...] = (
    lazy_step("enrich-outcomes", "enrich_step", ENRICH_DAY_BUDGET_SECONDS),
    lazy_step("outcome-check", "outcome_check", OUTCOME_CHECK_BUDGET_SECONDS),
)
