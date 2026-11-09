"""The steps that run after the tape, in run order.

`main` hands `STEPS` to `steps.run_steps` after `run_tape`, every night. It also gives
`run_tape` a deadline that leaves `reserve_seconds(STEPS)` of the run for them, so each
entry's `min_seconds` comes out of the tape's catch-up window and an earlier step can
never starve a later one. `test_deadline_constants_bound_the_run` keeps at least two
tape days in every night whatever is registered here.
"""

from __future__ import annotations

from steps import Step

STEPS: tuple[Step, ...] = ()
