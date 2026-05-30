#!/usr/bin/env python
"""V2.2 Phase E.8 — Online ticker weight EMA updates.

Nightly: blend today's per-ticker mean outcome into the existing V2 ticker
weights via exponential smoothing. Captures regime change within ~10 trading
days instead of waiting for full retrains.

Algorithm (per ticker):
    today_mean_outcome  = mean(outcome_pct) for fires of this ticker today
    global_mean_outcome = mean(outcome_pct) across all today's fires
    spread              = max_ticker_mean_today - min_ticker_mean_today
                          (fallback: 50 when only one ticker fires today)
    today_implied_weight = round(
        clamp(5 * (today_mean - global_mean) / spread, -5, +10)
    )
    new_weight = round(0.95 * old_weight + 0.05 * today_implied_weight)

Guards:
  - Skip entirely if today's enriched fire count < 100 (low-signal day)
  - Skip per-ticker update when ticker has < 10 fires today
  - Cap weight change per night to ±1 (prevents thrashing)
  - Runs AFTER sync_lottery_score_weights_v2.py in make update pipeline

Spec: docs/superpowers/specs/lottery-v2-2-profitability-improvements-2026-05-22.md
      Phase E (item 8)

Usage:
    ml/.venv/bin/python scripts/online_ticker_update.py
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

import pandas as pd

from _pipeline_retry import connect_with_retry

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.local"
WEIGHTS_PATH = ROOT / "ml" / "output" / "lottery_score_weights.json"
HISTORY_CSV = ROOT / "docs" / "tmp" / "lottery-ticker-weight-history.csv"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EMA_ALPHA = 0.05            # weight on today's implied value (decay ~10 days)
SCALE_FACTOR = 5            # maps normalised delta to weight units
MIN_FIRES_TODAY = 100       # skip entire update if fewer fires than this
MIN_TICKER_FIRES = 10       # skip per-ticker update below this count
MAX_NIGHTLY_CHANGE = 1      # ±1 cap per night prevents thrashing
WEIGHT_FLOOR = -5           # today_implied_weight lower bound
WEIGHT_CAP = 10             # today_implied_weight upper bound
FALLBACK_SPREAD = 50.0      # used when only one unique ticker fires today

CSV_FIELDNAMES = [
    "date", "ticker", "old_weight", "new_weight", "today_n", "today_mean",
]

# ---------------------------------------------------------------------------
# Environment loading (same pattern as mine_outcome_patterns.py)
# ---------------------------------------------------------------------------


def load_env() -> None:
    """Load DATABASE_URL from .env.local into os.environ."""
    if not ENV_FILE.exists():
        sys.exit(f"Missing env file: {ENV_FILE}")
    with ENV_FILE.open() as fh:
        for line in fh:
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


# ---------------------------------------------------------------------------
# DB fetch — today's enriched aligned fires
# ---------------------------------------------------------------------------

TODAY_QUERY = """
SELECT
    underlying_symbol,
    realized_flow_inversion_pct,
    realized_eod_pct,
    peak_ceiling_pct,
    cum_ncp_at_fire,
    cum_npp_at_fire
FROM lottery_finder_fires
WHERE
    date = CURRENT_DATE
    AND cum_ncp_at_fire IS NOT NULL
    AND cum_npp_at_fire IS NOT NULL
    AND (
        (option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
        OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)
    )
    AND inferred_structure IS NULL
    AND COALESCE(realized_flow_inversion_pct, realized_eod_pct) IS NOT NULL
ORDER BY id
"""


def fetch_today_fires() -> pd.DataFrame:
    """Return today's enriched aligned fires as a DataFrame."""
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get(
        "DATABASE_URL"
    )
    if not db_url:
        sys.exit("DATABASE_URL not set — run load_env() first")

    print("Connecting to database...")
    conn = connect_with_retry(db_url, sslmode="require", connect_timeout=15)
    print("Fetching today's fires...")
    df = pd.read_sql_query(TODAY_QUERY, conn)
    conn.close()
    print(f"Fetched {len(df):,} rows")
    return df


def build_outcome_col(df: pd.DataFrame) -> pd.DataFrame:
    """Add outcome_pct column (flow_inversion preferred over eod)."""
    df = df.copy()
    df["outcome_pct"] = df["realized_flow_inversion_pct"].combine_first(
        df["realized_eod_pct"]
    )
    # Drop enrichment-bug rows (flow_inv > peak*1.05)
    mask_bug = (
        df["realized_flow_inversion_pct"].notna()
        & df["peak_ceiling_pct"].notna()
        & (df["realized_flow_inversion_pct"] > df["peak_ceiling_pct"] * 1.05)
    )
    n_dropped = mask_bug.sum()
    if n_dropped:
        print(f"Dropped {n_dropped:,} enrichment-bug rows (flow_inv > peak*1.05)")
        df = df[~mask_bug].copy()
    return df


# ---------------------------------------------------------------------------
# Core EMA update logic
# ---------------------------------------------------------------------------


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def compute_updates(
    ticker_weights: dict[str, int],
    df: pd.DataFrame,
) -> list[dict]:
    """
    Compute per-ticker EMA weight updates.

    Returns a list of dicts with keys:
        ticker, old_weight, new_weight, today_n, today_mean, today_implied
    Only tickers that change (new_weight != old_weight) are included.
    """
    global_mean = float(df["outcome_pct"].mean())

    # Per-ticker stats for today
    ticker_stats = (
        df.groupby("underlying_symbol")["outcome_pct"]
        .agg(["mean", "count"])
        .rename(columns={"mean": "today_mean", "count": "today_n"})
    )
    ticker_stats = ticker_stats[ticker_stats["today_n"] >= MIN_TICKER_FIRES]

    if ticker_stats.empty:
        print("No tickers with >= 10 fires today; no updates applied.")
        return []

    # Spread of per-ticker means (normalisation denominator)
    spread = ticker_stats["today_mean"].max() - ticker_stats["today_mean"].min()
    if spread < 1e-6:
        spread = FALLBACK_SPREAD
        print(f"Spread near-zero; using fallback spread={FALLBACK_SPREAD}")
    else:
        print(f"Today's ticker mean spread: {spread:.2f}")

    updates = []

    # Iterate over tickers present in the existing weights model plus any new
    # tickers with enough fires today.
    all_tickers = set(ticker_weights.keys()) | set(ticker_stats.index)

    for ticker in sorted(all_tickers):
        if ticker not in ticker_stats.index:
            # Not enough fires today for this ticker — skip
            continue

        row = ticker_stats.loc[ticker]
        today_mean = float(row["today_mean"])
        today_n = int(row["today_n"])

        old_weight = ticker_weights.get(ticker, 0)

        # Implied weight from today's outcome
        raw_implied = SCALE_FACTOR * (today_mean - global_mean) / spread
        today_implied = round(_clamp(raw_implied, WEIGHT_FLOOR, WEIGHT_CAP))

        # EMA blend
        blended = (1.0 - EMA_ALPHA) * old_weight + EMA_ALPHA * today_implied
        new_weight_raw = round(blended)

        # ±1 cap per night
        delta = new_weight_raw - old_weight
        if abs(delta) > MAX_NIGHTLY_CHANGE:
            delta = MAX_NIGHTLY_CHANGE if delta > 0 else -MAX_NIGHTLY_CHANGE
        new_weight = old_weight + delta

        updates.append(
            {
                "ticker": ticker,
                "old_weight": old_weight,
                "new_weight": new_weight,
                "today_n": today_n,
                "today_mean": round(today_mean, 2),
                "today_implied": today_implied,
                "delta": delta,
            }
        )

    return updates


# ---------------------------------------------------------------------------
# JSON write-back
# ---------------------------------------------------------------------------


def write_weights_json(weights: dict, ticker_weights: dict[str, int]) -> None:
    """Write updated ticker_weights back into the JSON, preserving all other fields."""
    weights["features"]["ticker_weights"] = ticker_weights

    # Add a note that this field is updated nightly via EMA while other
    # features remain from the last full training run.
    weights["ticker_weights_update_note"] = (
        "ticker_weights is updated nightly by scripts/online_ticker_update.py "
        "via exponential smoothing (alpha=0.05, ±1 cap/night). All other "
        "features remain from the last full training run."
    )

    WEIGHTS_PATH.write_text(
        json.dumps(weights, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote updated weights to {WEIGHTS_PATH}")


# ---------------------------------------------------------------------------
# CSV history append
# ---------------------------------------------------------------------------


def upsert_history_csv(today: date, updates: list[dict]) -> None:
    """Write today's rows to the history CSV, replacing any prior same-day rows.

    Upsert-by-date (not append) so repeated `make update` runs don't accumulate
    duplicate (date, ticker) rows — mirrors daily_tracker.py's idempotent
    one-row-per-day pattern.
    """
    HISTORY_CSV.parent.mkdir(parents=True, exist_ok=True)
    date_str = today.isoformat()

    # Keep every prior row except an earlier write for today's date.
    kept: list[dict] = []
    if HISTORY_CSV.exists():
        with HISTORY_CSV.open(newline="", encoding="utf-8") as fh:
            kept = [r for r in csv.DictReader(fh) if r.get("date") != date_str]

    today_rows = [
        {
            "date": date_str,
            "ticker": u["ticker"],
            "old_weight": u["old_weight"],
            "new_weight": u["new_weight"],
            "today_n": u["today_n"],
            "today_mean": u["today_mean"],
        }
        for u in updates
    ]

    with HISTORY_CSV.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        writer.writerows(kept)
        writer.writerows(today_rows)

    print(
        f"Wrote {len(today_rows):,} rows for {date_str} to {HISTORY_CSV} "
        f"(replaced any prior same-day rows; {len(kept):,} earlier rows kept)"
    )


def already_applied_today(
    today: date, current_ticker_weights: dict[str, int]
) -> bool:
    """True if today's EMA nudge is already reflected in the live weights.

    Idempotence guard for a standalone re-run. The history CSV records the
    post-nudge weight per ticker for the date it was applied. If the live
    ticker_weights already equal today's recorded new_weights, the nudge has
    already been applied and re-running would blend the same day onto it again
    (double-applied drift) — so skip.

    Composition-safe with `make update`: the preceding `refit` (lottery_scoring.py)
    RESETS ticker_weights to the from-scratch baseline, so on a second
    `make update` the live weights differ from today's recorded new_weights and
    the EMA correctly re-applies from the fresh baseline. This guard only
    short-circuits a bare re-run that has no intervening refit.
    """
    if not HISTORY_CSV.exists():
        return False
    date_str = today.isoformat()
    with HISTORY_CSV.open(newline="", encoding="utf-8") as fh:
        recorded = {
            r["ticker"]: int(r["new_weight"])
            for r in csv.DictReader(fh)
            if r.get("date") == date_str
        }
    if not recorded:
        return False
    return all(
        current_ticker_weights.get(t) == w for t, w in recorded.items()
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    load_env()

    # Load existing weights JSON
    if not WEIGHTS_PATH.exists():
        sys.exit(f"Weights file missing: {WEIGHTS_PATH}")
    weights = json.loads(WEIGHTS_PATH.read_text(encoding="utf-8"))
    ticker_weights: dict[str, int] = dict(
        weights["features"]["ticker_weights"]
    )
    print(f"Loaded weights: {weights['model_version']}")
    print(f"  {len(ticker_weights):,} tickers in model")

    # Idempotence guard: if today's nudge is already baked into the live
    # weights (a bare re-run with no intervening refit), skip — re-applying
    # would double-blend. In `make update`, refit resets the baseline first,
    # so this never blocks a legitimate re-apply.
    today = date.today()
    if already_applied_today(today, ticker_weights):
        print(
            f"SKIP: today's EMA nudge ({today.isoformat()}) is already reflected "
            "in the live ticker_weights — re-run would double-apply it. No-op."
        )
        return

    # Fetch today's fires
    df = fetch_today_fires()
    df = build_outcome_col(df)

    today_n = len(df)
    print(f"Today's enriched aligned fires: {today_n:,}")

    if today_n < MIN_FIRES_TODAY:
        print(
            f"SKIP: only {today_n} enriched fires today (threshold: {MIN_FIRES_TODAY}). "
            "Low-signal day — no weight update applied."
        )
        return

    global_mean = float(df["outcome_pct"].mean())
    print(f"Global mean outcome today: {global_mean:.2f}%")

    # Compute EMA updates
    updates = compute_updates(ticker_weights, df)

    # Build summary — split into moved vs unchanged
    changed = [u for u in updates if u["delta"] != 0]
    unchanged = [u for u in updates if u["delta"] == 0]

    print(f"\n{'='*60}")
    print(f"  TICKER WEIGHT UPDATES — {date.today().isoformat()}")
    print(f"{'='*60}")
    print(f"  Tickers with >= {MIN_TICKER_FIRES} fires today: {len(updates):,}")
    print(f"  Changed (delta != 0): {len(changed):,}")
    print(f"  Unchanged:           {len(unchanged):,}")
    print(f"  Global mean outcome: {global_mean:.2f}%")
    print()

    if changed:
        print("  CHANGES:")
        for u in sorted(changed, key=lambda x: abs(x["delta"]), reverse=True):
            arrow = "UP  " if u["delta"] > 0 else "DOWN"
            print(
                f"    {arrow} {u['ticker']:<8}  {u['old_weight']:+d} -> {u['new_weight']:+d}"
                f"  (n={u['today_n']}, mean={u['today_mean']:+.1f}%,"
                f" implied={u['today_implied']:+d})"
            )
    else:
        print("  No ticker weights changed tonight (all deltas rounded to 0).")

    if unchanged:
        stable_str = ", ".join(u["ticker"] for u in unchanged)
        print(f"\n  STABLE ({len(unchanged)}): {stable_str}")

    print(f"{'='*60}\n")

    if not updates:
        print("No updates to write.")
        return

    # Apply changes to weight dict
    for u in updates:
        ticker_weights[u["ticker"]] = u["new_weight"]

    # Sort ticker_weights alphabetically (consistent with existing JSON ordering)
    weights["features"]["ticker_weights"] = dict(
        sorted(ticker_weights.items())
    )

    # Write JSON back
    write_weights_json(weights, dict(sorted(ticker_weights.items())))

    # Upsert history CSV (all tickers that had >= MIN_TICKER_FIRES today,
    # including unchanged ones — gives a complete daily snapshot). Replaces
    # any prior same-day rows so repeated runs don't duplicate.
    upsert_history_csv(today, updates)


if __name__ == "__main__":
    main()
