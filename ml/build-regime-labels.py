"""One-shot driver to build the per-(ticker, date) regime labels parquet.

Pulls per-ticker session open/close from `strike_iv_snapshots` so the
regime classifier uses the actual day's bounds, not the first/last
ALERT's spot. Output is read by all D/E phase scripts via
`load_session_regime_labels()`.

Re-run after any backfill that adds new dates or new tickers.

Usage:
    ml/.venv/bin/python ml/build-regime-labels.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "ml"))

from iv_anomaly_utils import (  # noqa: E402
    REGIME_LABELS_PARQUET,
    fetch_session_regime_labels,
)

ENV_LOCAL = REPO_ROOT / ".env.local"

TICKERS = [
    "SPXW", "NDXP", "SPY", "QQQ", "IWM", "SMH",
    "NVDA", "TSLA", "META", "MSFT", "SNDK", "MSTR", "MU",
]


def load_env() -> None:
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k, v.strip().strip('"'))


def main() -> None:
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    print(f"Pulling session bounds for {len(TICKERS)} tickers...", file=sys.stderr)
    with psycopg2.connect(db_url) as conn:
        df = fetch_session_regime_labels(conn, TICKERS)

    out = REPO_ROOT / REGIME_LABELS_PARQUET
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    print(f"Wrote {out} ({len(df):,} rows; {df['ticker'].nunique()} tickers, "
          f"{df['date'].nunique()} dates)")
    print("\nRegime distribution:")
    print(df["regime"].value_counts().to_string())


if __name__ == "__main__":
    main()
