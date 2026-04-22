"""Python backtest on the matched Pine Strategy Tester window.

Goal: run PAC BOS Config B over 2026-03-29 to 2026-04-18 (18 trading days)
and compare trade-by-trade to the Pine Strategy Tester output
(125 trades, 52% WR, $16,835 P&L on NQ1! over 2026-03-29 to 2026-04-22).

The archive only covers through 2026-04-17, so Pine's trades on 04-20
through 04-22 are excluded from the comparison (~20 of 125 trades).

Matches the Pine strategy() settings exactly:
- NQ contract ($5/tick = $20/point)
- BOS_BREAKOUT entry
- OPPOSITE_CHOCH exit trigger
- SWING_EXTREME stop, 2.25 ATR fallback
- RTH only, skip_events
- min_z_entry_vwap = 1.0
- exit_after_n_bos = 2
- on_opposite_signal = EXIT_ONLY
- commission $3/rt, slippage 1 tick
"""

from __future__ import annotations

import sys
from collections import Counter

import numpy as np
import pandas as pd

sys.path.insert(0, "ml/src")

from pac.archive_loader import load_bars  # noqa: E402
from pac.engine import PACEngine  # noqa: E402
from pac_backtest.loop import run_backtest  # noqa: E402
from pac_backtest.params import (  # noqa: E402
    EntryTrigger,
    ExitTrigger,
    OnOppositeSignal,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)


def main() -> None:
    # Archive goes through 2026-04-17 20:59 UTC; Pine shows 2026-03-29 to 2026-04-22
    # Use [2026-03-29, 2026-04-18) → 18 trading days overlap with Pine's test
    start, end = "2026-03-29", "2026-04-18"
    print(f"Loading NQ bars {start} to {end}...", flush=True)
    bars = load_bars("NQ", start, end)
    print(f"  {len(bars):,} bars, {bars.symbol.iloc[0]}", flush=True)

    print("Running PAC engine...", flush=True)
    enriched = PACEngine().batch_state(bars)
    print(f"  {len(enriched):,} enriched rows", flush=True)

    # Match Pine strategy() NQ config — NOT fold9's MNQ config.
    # NQ tick = $5, 4 ticks/point = $20/point (vs MNQ tick = $0.50).
    # Pine cash_per_order $1.50 = $3/rt.  slippage=1 tick.
    params = StrategyParams(
        entry_trigger=EntryTrigger.BOS_BREAKOUT,
        exit_trigger=ExitTrigger.OPPOSITE_CHOCH,
        stop_placement=StopPlacement.SWING_EXTREME,
        session=SessionFilter.RTH,
        stop_atr_multiple=2.25,
        target_atr_multiple=2.0,
        event_day_filter="skip_events",
        min_z_entry_vwap=1.0,
        on_opposite_signal=OnOppositeSignal.EXIT_ONLY,
        exit_after_n_bos=2,
        slippage_ticks=1.0,
        commission_per_rt=3.00,
        tick_value_dollars=5.00,  # NQ not MNQ
    )
    print(f"Params: {params}", flush=True)

    print("\nRunning backtest on matched Pine window...", flush=True)
    trades = run_backtest(enriched, params)
    print(f"Trades: {len(trades)}", flush=True)
    if not trades:
        print("No trades — check filters / data", flush=True)
        return

    pnls = np.array([t.pnl_dollars for t in trades])
    wins = int((pnls > 0).sum())
    losses = int((pnls < 0).sum())
    print(
        f"Wins: {wins} ({100 * wins / len(trades):.1f}%) / "
        f"Losses: {losses} ({100 * losses / len(trades):.1f}%)"
    )
    print(f"Total P&L: ${pnls.sum():,.2f}  Avg: ${pnls.mean():.2f}")
    print(f"Best: ${pnls.max():,.2f}   Worst: ${pnls.min():,.2f}")
    print(f"Exit reasons: {dict(Counter(t.exit_reason for t in trades))}")

    # Equity curve + max DD (anchored at $10,000 to match Pine Strategy Tester)
    df = pd.DataFrame({"exit_ts": [t.exit_ts for t in trades], "pnl": pnls})
    df = df.sort_values("exit_ts").reset_index(drop=True)
    df["equity"] = 10_000 + df["pnl"].cumsum()
    df["peak"] = df["equity"].cummax()
    df["dd_dollars"] = df["peak"] - df["equity"]
    df["dd_pct"] = df["dd_dollars"] / df["peak"] * 100
    print(
        f"\nMax DD (from $10K start): ${df.dd_dollars.max():,.2f} "
        f"({df.dd_pct.max():.1f}%)"
    )

    # Per-day breakdown
    df["day"] = df["exit_ts"].dt.tz_convert("America/Chicago").dt.date
    daily = df.groupby("day").agg(
        trades=("pnl", "size"),
        pnl=("pnl", "sum"),
        wr=("pnl", lambda x: (x > 0).mean() * 100),
    )
    print("\nPer-day breakdown:")
    print(daily.round(2).to_string())

    # Dump trades CSV for side-by-side comparison with Pine CSV
    print("\nDumping trades to /tmp/py_match_2026.csv...", flush=True)
    from pac_backtest.trades import trades_to_dataframe  # noqa: E402

    tdf = trades_to_dataframe(trades)
    tdf.to_csv("/tmp/py_match_2026.csv", index=False)
    print(f"  {len(tdf)} rows written", flush=True)


if __name__ == "__main__":
    main()
