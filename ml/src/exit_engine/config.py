"""Shared constants for the exit-timing engine.

Mode literals mirror api/_lib/lottery-finder.ts (LotteryMode). The parquet
full tape is the source of truth; ws_option_trades is Project B's concern.
"""
from __future__ import annotations

import os
from pathlib import Path

MODE_INTRADAY = "A_intraday_0DTE"
MODE_MULTIDAY = "B_multi_day_DTE1_3"
IN_UNIVERSE_MODES = (MODE_INTRADAY, MODE_MULTIDAY)

# θ: minimum "meaningful further upside" measured as a forward fractional move
# on the CURRENT mark (0.15 == price rises 15% above where it is now).
THETA_FORWARD_DEFAULT = 0.15

# Mode-B multi-day holds reconstruct across this many calendar days max.
MAX_HOLD_DAYS = 4

PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"
PARQUET_TRADES_PATTERN = "{date}-trades.parquet"
PARQUET_FULLTAPE_PATTERN = "{date}-fulltape.parquet"

# Partitioned, resumable decision dataset (one part-YYYY-MM.parquet per entry month).
# EXIT_DATASET_DIR env override lets a second source (e.g. silent boom) build to its
# own dir without clobbering the lottery parts; all three drivers honor it uniformly.
DATASET_DIR = Path(
    os.environ.get(
        "EXIT_DATASET_DIR",
        str(
            Path(__file__).resolve().parents[2]
            / "experiments"
            / "exit-timing-engine"
            / "decision_dataset"
        ),
    )
)

# Walk-forward split (shared by all phase drivers).
N_TRAIN_DAYS = 20
TEST_BLOCK_DAYS = 5
# Regular-session timing (CT).
EOD_CT_HOUR = 15
SESSION_MINUTES = 390  # 6.5h regular cash session
