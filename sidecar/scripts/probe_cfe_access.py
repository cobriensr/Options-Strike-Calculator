#!/usr/bin/env python3
"""Probe whether the current Databento license covers CFE (XCBF.PITCH).

Run from the sidecar/ directory:

    cd sidecar && .venv/bin/python scripts/probe_cfe_access.py

Metadata calls (list_datasets, list_schemas, get_cost) are free. The
script only issues a billable `get_range` request if the cost quote
is under $0.01, which is the case for one day of VX.n.0 ohlcv-1m.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import databento as db
from dotenv import load_dotenv


CFE_DATASET = "XCBF.PITCH"
PROBE_SCHEMA = "ohlcv-1m"
PROBE_SYMBOL = "VX.n.0"
PROBE_START = "2026-04-16"
PROBE_END = "2026-04-17"
PULL_COST_THRESHOLD = 0.01


def main() -> int:
    # .env lives in sidecar/, this script lives in sidecar/scripts/.
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")

    api_key = os.environ.get("DATABENTO_API_KEY")
    if not api_key:
        print("[FAIL] DATABENTO_API_KEY not set in sidecar/.env")
        return 1

    client = db.Historical(api_key)

    datasets = client.metadata.list_datasets()
    print("Accessible datasets:")
    for d in datasets:
        print(f"  - {d}")

    if CFE_DATASET not in datasets:
        print(f"\n[FAIL] {CFE_DATASET} is NOT in accessible datasets.")
        print("Current license does not cover CFE — upgrade required.")
        return 1

    print(f"\n[OK] {CFE_DATASET} is accessible.")

    schemas = client.metadata.list_schemas(dataset=CFE_DATASET)
    print(f"\nSchemas available on {CFE_DATASET}:")
    for s in schemas:
        print(f"  - {s}")
    if PROBE_SCHEMA not in schemas:
        print(f"\n[FAIL] {PROBE_SCHEMA} not available for {CFE_DATASET}.")
        return 1

    cost = client.metadata.get_cost(
        dataset=CFE_DATASET,
        schema=PROBE_SCHEMA,
        symbols=[PROBE_SYMBOL],
        stype_in="continuous",
        start=PROBE_START,
        end=PROBE_END,
    )
    print(
        f"\n1-day {PROBE_SYMBOL} {PROBE_SCHEMA} cost quote: ${cost:.4f}",
    )

    if cost >= PULL_COST_THRESHOLD:
        print(
            f"\n(Skipping actual pull — quote ${cost:.4f} exceeds "
            f"${PULL_COST_THRESHOLD:.2f} threshold.)"
        )
        return 0

    df = client.timeseries.get_range(
        dataset=CFE_DATASET,
        schema=PROBE_SCHEMA,
        symbols=[PROBE_SYMBOL],
        stype_in="continuous",
        start=PROBE_START,
        end=PROBE_END,
    ).to_df()
    print(f"\n[OK] Pulled {len(df)} bars. First 3:")
    print(df.head(3))
    return 0


if __name__ == "__main__":
    sys.exit(main())
