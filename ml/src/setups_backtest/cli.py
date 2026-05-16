"""CLI driver for the futures-setups backtest.

Usage:

  cd ml
  .venv/bin/python -m src.setups_backtest.cli run \
      --setup 1 \
      --start 2026-01-01 \
      --end 2026-04-17 \
      --out experiments/futures-setups-2026-05-15

  # Dry-run on a small window for harness wiring validation:
  .venv/bin/python -m src.setups_backtest.cli run \
      --setup 1 \
      --start 2026-04-13 \
      --end 2026-04-17 \
      --out /tmp/setup1-dryrun
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from . import data_loaders, harness, metrics

log = logging.getLogger("setups_backtest.cli")


SETUP_MODULES: dict[int, str] = {
    1: "src.setups_backtest.evaluators.setup_1_nq_ofi_extreme",
    2: "src.setups_backtest.evaluators.setup_2_nq_leads_es",
    3: "src.setups_backtest.evaluators.setup_3_overnight_sweep",
    4: "src.setups_backtest.evaluators.setup_4_basis_stress",
    5: "src.setups_backtest.evaluators.setup_5_zg_magnet",
    6: "src.setups_backtest.evaluators.setup_6_cvd_divergence",
    7: "src.setups_backtest.evaluators.setup_7_flight_to_safety",
    8: "src.setups_backtest.evaluators.setup_8_mega_cap_earnings",
}

SETUP_SLUGS: dict[int, str] = {
    1: "nq-ofi-extreme",
    2: "nq-leads-es-catchup",
    3: "overnight-extreme-sweep",
    4: "basis-stress-fade",
    5: "zero-gamma-magnet",
    6: "cvd-divergence-fade",
    7: "flight-to-safety-continuation",
    8: "mega-cap-earnings-fade",
}


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _load_evaluator(setup_n: int) -> harness.SetupEvaluator:
    if setup_n not in SETUP_MODULES:
        raise ValueError(f"Unknown setup number {setup_n}. Choose 1-8.")
    module_name = SETUP_MODULES[setup_n]
    try:
        mod = importlib.import_module(module_name)
    except ImportError as e:
        raise SystemExit(
            f"Evaluator module {module_name} not implemented yet. "
            f"This setup's evaluator must be written before it can be run. "
            f"Underlying error: {e}"
        ) from e
    if not hasattr(mod, "EVALUATOR"):
        raise SystemExit(
            f"{module_name} must export an ``EVALUATOR`` instance "
            f"implementing the SetupEvaluator protocol."
        )
    return mod.EVALUATOR


def _try_open_neon():
    """Open Neon connection if DATABASE_URL is set; return None otherwise."""
    try:
        return data_loaders.neon_connection()
    except RuntimeError as e:
        log.warning("Neon connection not available: %s", e)
        return None


def cmd_run(args: argparse.Namespace) -> int:
    setup_n: int = args.setup
    start = _parse_date(args.start)
    end = _parse_date(args.end)
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    slug = SETUP_SLUGS[setup_n]
    setup_dir = out_root / f"setup-{setup_n}-{slug}"
    setup_dir.mkdir(parents=True, exist_ok=True)

    evaluator = _load_evaluator(setup_n)

    with data_loaders.duckdb_session() as conn:
        pg = _try_open_neon()
        try:
            trading_days = data_loaders.list_trading_days(conn, start, end)
            if not trading_days:
                log.warning(
                    "No trading days in window %s -> %s; writing empty result.",
                    start, end,
                )
                trades = []
            else:
                log.info(
                    "Trading days in window: %d (%s -> %s)",
                    len(trading_days),
                    trading_days[0],
                    trading_days[-1],
                )
                trades = harness.run_backtest(
                    evaluator, trading_days, conn=conn, pg=pg
                )
        finally:
            if pg is not None:
                pg.close()

    trades_df = harness.trades_to_dataframe(trades)
    metrics_dict = metrics.compute_metrics(trades_df)

    results: dict[str, Any] = {
        "setup_n": setup_n,
        "setup_name": slug,
        "test_window": [start.isoformat(), end.isoformat()],
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S") + "Z",
        "metrics": metrics_dict,
    }

    results_path = setup_dir / "results.json"
    trades_path = setup_dir / "trades.parquet"
    report_path = setup_dir / "report.md"

    results_path.write_text(json.dumps(results, indent=2, default=str))
    if not trades_df.empty:
        # Ensure timestamps are tz-aware before parquet write.
        for col in ("entry_ts", "exit_ts"):
            if col in trades_df.columns:
                trades_df[col] = pd.to_datetime(trades_df[col], utc=True)
        trades_df.to_parquet(trades_path, index=False)
    # Evaluators may expose a `report_notes` attribute or `report_notes(ctx)`
    # method to add a per-setup notes block to the Markdown report.
    notes = None
    if hasattr(evaluator, "report_notes"):
        attr = evaluator.report_notes
        notes = attr() if callable(attr) else attr
    report = metrics.format_report(
        slug, metrics_dict, (start.isoformat(), end.isoformat()), notes=notes
    )
    report_path.write_text(report)

    print(f"\nWrote: {results_path}")
    if not trades_df.empty:
        print(f"Wrote: {trades_path}")
    print(f"Wrote: {report_path}")
    print(f"\nN signals: {metrics_dict['n_signals']}")
    if metrics_dict["n_signals"]:
        print(
            f"Win rate: {metrics_dict['win_rate']:.1%}    "
            f"Expectancy: ${metrics_dict['expectancy_dollars']:.2f}    "
            f"Cum P&L: ${metrics_dict['cumulative_net_pnl_dollars']:.2f}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run a single futures-setup backtest.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    run_p = sub.add_parser("run", help="Run one setup over a date window.")
    run_p.add_argument("--setup", type=int, required=True, choices=range(1, 9))
    run_p.add_argument("--start", type=str, required=True, help="YYYY-MM-DD")
    run_p.add_argument("--end", type=str, required=True, help="YYYY-MM-DD")
    run_p.add_argument(
        "--out",
        type=str,
        required=True,
        help="Output directory (e.g. experiments/futures-setups-2026-05-15)",
    )
    run_p.add_argument(
        "--verbose", "-v", action="store_true", help="DEBUG-level logging"
    )

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.cmd == "run":
        return cmd_run(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
