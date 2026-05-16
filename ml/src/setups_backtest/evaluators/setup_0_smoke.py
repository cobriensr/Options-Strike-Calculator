"""Smoke-test evaluator — NOT one of the 8 real setups.

Always fires LONG ES at the 2nd RTH minute, stops 5pt below entry, targets
10pt above. Exists only to validate CLI + harness + metrics wiring end-to-end
before we plug in real setup logic.

Register-by-import only; never appears in the SETUP_MODULES map.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from ..harness import Direction, Signal


@dataclass
class SmokeEvaluator:
    """Duck-typed match for ``harness.SetupEvaluator``; no runtime Protocol subclass."""

    name: str = "smoke-stub"
    contract_prefix: str = "ES"

    def prepare(self, conn, pg, start, end):
        # Required by SetupEvaluator protocol; smoke stub has no state to prepare.
        del conn, pg, start, end
        return None

    def evaluate_minute(self, now: pd.Timestamp, ctx, bars: pd.DataFrame) -> Signal | None:
        del ctx  # No prepared context needed for the stub.
        if len(bars) == 2:
            last = float(bars.iloc[-1]["close"])
            return Signal(
                setup_name=self.name,
                decision_ts=now,
                direction=Direction.LONG,
                contract="",
                stop_price=last - 5,
                target_price=last + 10,
            )
        return None


EVALUATOR = SmokeEvaluator()
