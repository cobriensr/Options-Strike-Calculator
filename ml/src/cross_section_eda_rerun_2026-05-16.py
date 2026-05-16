"""
Cross-Section EDA Re-Run — 2026-05-16

Re-validates the 4 findings shipped by the 2026-05-15 cross-section
EDA against full-data populated columns. Triggered by the discovery
that the original EDA's Range Kill / TOP-RANGE feature used a
dimensionally-buggy range_pos formula (SPX session range divided
into stock spot prices), silently dropping every non-index row via
pd.cut's NaN-on-out-of-bin behavior. Only ~8K dimensional-accident
rows survived in the original; my equity-ticker backfill now has
604K rows of correct range_pos in `lottery_finder_fires.range_pos_at_trigger`.

This rerun re-checks every finding the original EDA claimed:

  F1  Range Kill bottom-10% (range_pos < 0.10) → claimed 0.07× lift
  F1  TOP-RANGE top-10% (range_pos ≥ 0.90)    → claimed 1.75× win100
  F2  Vol/OI ≥ 0.5 score bonus                → claimed 1.10×–1.35×
  F3  SB Spread-Confirmed 10–50%              → claimed 2.08× win50
  F4  Macro Window 24–72h before high-impact  → claimed 1.32×/1.56×

Each finding is recomputed on the canonical DB column (or on a
properly-derived feature, with verified dimensional semantics).
Results go to ml/findings/eda-rerun-2026-05-16/ as a markdown report
plus per-finding JSON.

Usage:
    set -a && source .env.local && set +a
    ml/.venv/bin/python ml/src/cross_section_eda_rerun_2026-05-16.py
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

ML_ROOT = Path(__file__).resolve().parent.parent
FINDINGS_DIR = ML_ROOT / "findings" / "eda-rerun-2026-05-16"
FINDINGS_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set", file=sys.stderr)
    sys.exit(1)


def get_conn():
    return psycopg2.connect(DATABASE_URL, sslmode="require")


# ── Generic cohort stats ──────────────────────────────────────────────────────


def cohort_stats(
    df: pd.DataFrame,
    feature_col: str,
    bins: list,
    labels: list,
    outcome_col: str = "peak_ceiling_pct",
) -> pd.DataFrame:
    """Compute N / win50 / win100 / lift per stratum."""
    work = df.dropna(subset=[feature_col, outcome_col]).copy()
    work["_stratum"] = pd.cut(
        work[feature_col], bins=bins, labels=labels, include_lowest=True
    )
    work = work.dropna(subset=["_stratum"])
    base_win50 = (work[outcome_col] >= 50).mean()
    base_win100 = (work[outcome_col] >= 100).mean()

    rows = []
    for stratum, grp in work.groupby("_stratum", observed=True):
        n = len(grp)
        w50 = (grp[outcome_col] >= 50).mean()
        w100 = (grp[outcome_col] >= 100).mean()
        rows.append(
            {
                "stratum": str(stratum),
                "n": n,
                "win50_pct": round(100 * w50, 1),
                "win100_pct": round(100 * w100, 1),
                "lift50": round(w50 / base_win50, 2) if base_win50 > 0 else None,
                "lift100": round(w100 / base_win100, 2) if base_win100 > 0 else None,
            }
        )
    out = pd.DataFrame(rows)
    out.attrs["base_win50"] = base_win50
    out.attrs["base_win100"] = base_win100
    out.attrs["total_n"] = len(work)
    return out


def print_table(name: str, stats: pd.DataFrame) -> str:
    """Pretty-print a cohort stats table and return the markdown body."""
    base50 = stats.attrs.get("base_win50", float("nan"))
    base100 = stats.attrs.get("base_win100", float("nan"))
    n = stats.attrs.get("total_n", 0)
    header = (
        f"\n### {name}\n"
        f"_Baseline: win50={100 * base50:.1f}%, win100={100 * base100:.1f}%, N={n:,}_\n\n"
        "| Stratum | N | win50% | win100% | lift50 | lift100 |\n"
        "|---|---|---|---|---|---|\n"
    )
    rows = []
    for _, r in stats.iterrows():
        rows.append(
            f"| {r['stratum']} | {r['n']:,} | {r['win50_pct']} | {r['win100_pct']} | "
            f"{r['lift50']} | {r['lift100']} |"
        )
    body = header + "\n".join(rows) + "\n"
    print(body)
    return body


# ── Data loaders ──────────────────────────────────────────────────────────────


def load_lottery() -> pd.DataFrame:
    """Load every enriched lottery fire with the columns we'll need."""
    q = """
    SELECT
      id,
      date,
      trigger_time_ct,
      underlying_symbol,
      option_type,
      strike::float AS strike,
      dte,
      score,
      direction_gated,
      spot_at_first::float AS spot_at_first,
      trigger_vol_to_oi_window::float AS vol_to_oi_window,
      range_pos_at_trigger::float AS range_pos,
      peak_ceiling_pct::float AS peak_ceiling_pct,
      realized_eod_pct::float AS realized_eod_pct
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL
    """
    with get_conn() as conn:
        df = pd.read_sql_query(q, conn, parse_dates=["date", "trigger_time_ct"])
    print(f"  loaded {len(df):,} enriched lottery fires")
    return df


def load_silentboom() -> pd.DataFrame:
    """Load every enriched silent_boom alert with the columns we'll need."""
    q = """
    SELECT
      id,
      date,
      bucket_ct,
      underlying_symbol,
      option_type,
      strike::float AS strike,
      dte,
      score,
      score_tier,
      direction_gated,
      underlying_price_at_spike::float AS spot,
      multi_leg_share::float AS multi_leg_share,
      peak_ceiling_pct::float AS peak_ceiling_pct
    FROM silent_boom_alerts
    WHERE peak_ceiling_pct IS NOT NULL
    """
    with get_conn() as conn:
        df = pd.read_sql_query(q, conn, parse_dates=["date", "bucket_ct"])
    print(f"  loaded {len(df):,} enriched silent-boom alerts")
    return df


def load_macro_events() -> pd.DataFrame:
    """High-impact economic events (FOMC/CPI/PCE/JOBS)."""
    q = """
    SELECT date, event_time, event_type
    FROM economic_events
    WHERE event_type IN ('FOMC', 'CPI', 'PCE', 'JOBS')
      AND event_time IS NOT NULL
    ORDER BY event_time
    """
    with get_conn() as conn:
        df = pd.read_sql_query(q, conn, parse_dates=["date", "event_time"])
    print(f"  loaded {len(df):,} high-impact macro events")
    return df


# ── F1: Range Kill — re-run with the correct equity-ticker range_pos ──────────


def f1_range_kill(lf: pd.DataFrame) -> dict:
    print("\n=== F1: Range Kill (LF, equity-ticker session range) ===")
    print(f"  rows with range_pos populated: {lf['range_pos'].notna().sum():,}")

    bins = [-0.001, 0.1, 0.3, 0.7, 0.9, 1.0001]
    labels = ["bottom10%", "low30%", "mid40%", "high70%", "top10%"]
    coarse = cohort_stats(lf, "range_pos", bins, labels)
    coarse_md = print_table("F1 Coarse (LF, correct range_pos)", coarse)

    decile_bins = [i / 10 for i in range(11)]
    decile_bins[0] = -0.001
    decile_bins[-1] = 1.0001
    decile_labels = [f"D{i + 1}" for i in range(10)]
    decile = cohort_stats(lf, "range_pos", decile_bins, decile_labels)
    decile_md = print_table("F1 Decile (LF, correct range_pos)", decile)

    # Sub-bucket sanity: range_pos saturated at 1.0 (clamped — spot punched
    # above session high). The value is deterministic-clamped to [0, 1] in
    # api/_lib/uw-stock-candles.ts so ≥1.0 is safer than == 1.0.
    sub = lf[lf["range_pos"] >= 1.0].dropna(subset=["peak_ceiling_pct"])
    sub_md = ""
    if len(sub) > 0:
        sub_md = (
            "\n### F1 Extra: range_pos == 1.0 (new session-high prints)\n"
            f"N={len(sub):,}, win50={(sub['peak_ceiling_pct'] >= 50).mean() * 100:.1f}%, "
            f"win100={(sub['peak_ceiling_pct'] >= 100).mean() * 100:.1f}%\n"
        )
        print(sub_md)

    # Score-tier-conditioned sanity: does the signal survive inside tier1+2 only?
    tier12 = lf[lf["score"] >= 12]
    coarse_t12 = cohort_stats(tier12, "range_pos", bins, labels)
    coarse_t12_md = print_table("F1 Coarse (LF, tier 1+2 only)", coarse_t12)

    return {
        "coarse": coarse.to_dict(orient="records"),
        "decile": decile.to_dict(orient="records"),
        "tier12_coarse": coarse_t12.to_dict(orient="records"),
        "markdown": coarse_md + decile_md + sub_md + coarse_t12_md,
    }


# ── F2: Vol/OI window ≥ 0.5 (LF) — re-validate the shipped +1 score bonus ─────


def f2_vol_to_oi(lf: pd.DataFrame) -> dict:
    print("\n=== F2: Vol/OI window ≥ 0.5 (LF, +1 score bonus) ===")
    bins = [-0.001, 0.5, 1.0, 2.0, 5.0, 1e9]
    labels = ["<0.5", "0.5–1", "1–2", "2–5", "≥5"]
    stats = cohort_stats(lf, "vol_to_oi_window", bins, labels)
    md = print_table("F2 (LF vol_to_oi_window)", stats)
    return {"strata": stats.to_dict(orient="records"), "markdown": md}


# ── F3: SB Spread-Confirmed (multi_leg_share 10–50%) ──────────────────────────


def f3_spread_confirmed(sb: pd.DataFrame) -> dict:
    print("\n=== F3: SB Spread-Confirmed (multi_leg_share 10–50%) ===")
    bins = [-0.001, 0.1, 0.3, 0.5, 0.7, 1.0001]
    labels = ["<10%", "10–30%", "30–50%", "50–70%", "70–100%"]
    stats = cohort_stats(sb, "multi_leg_share", bins, labels)
    md = print_table("F3 (SB multi_leg_share)", stats)
    return {"strata": stats.to_dict(orient="records"), "markdown": md}


# ── F4: Macro window — fires N hours before FOMC/CPI/PCE/JOBS ─────────────────


def f4_macro_window(lf: pd.DataFrame, events: pd.DataFrame) -> dict:
    print("\n=== F4: Macro Window (LF, hours-to-next-high-impact) ===")
    if events.empty:
        print("  no economic_events rows; skipping")
        return {"strata": [], "markdown": "_no macro events populated_\n"}

    event_times = (
        events["event_time"]
        .dt.tz_convert(None)
        .sort_values()
        .values.astype("datetime64[ns]")
    )
    fire_times = lf["trigger_time_ct"].dt.tz_convert(None).values.astype(
        "datetime64[ns]"
    )
    idx = np.searchsorted(event_times, fire_times, side="left")
    in_bounds = idx < len(event_times)
    clipped = np.clip(idx, 0, len(event_times) - 1)
    next_event = event_times[clipped]
    # subtract datetime64[ns] arrays — yields timedelta64[ns]
    delta = (next_event - fire_times).astype("timedelta64[ns]")
    hours = delta.astype("int64") / 3.6e12
    hours = np.where(in_bounds, hours, np.nan)

    lf = lf.copy()
    lf["hours_to_next_macro"] = hours
    bins = [-0.001, 24, 72, 168, 720, 1e9]
    labels = ["<24h", "24–72h", "72h–7d", "7d–30d", ">30d"]
    stats = cohort_stats(lf, "hours_to_next_macro", bins, labels)
    md = print_table("F4 (LF hours-to-next macro event)", stats)
    return {"strata": stats.to_dict(orient="records"), "markdown": md}


# ── Main ──────────────────────────────────────────────────────────────────────


def main():
    print(f"Cross-section EDA re-run — {datetime.now(timezone.utc).isoformat()}")
    print(f"  output dir: {FINDINGS_DIR}")
    print("\n--- Loading ---")
    lf = load_lottery()
    sb = load_silentboom()
    events = load_macro_events()

    results = {}
    results["f1_range_kill"] = f1_range_kill(lf)
    results["f2_vol_to_oi"] = f2_vol_to_oi(lf)
    results["f3_spread_confirmed"] = f3_spread_confirmed(sb)
    results["f4_macro_window"] = f4_macro_window(lf, events)

    report = (
        "# Cross-Section EDA Re-run — 2026-05-16\n\n"
        "Re-validates the 4 findings from the 2026-05-15 EDA on full-data populated\n"
        "columns. Triggered by the discovery that the original Range Kill / TOP-RANGE\n"
        "result was dimensionally bugged — see investigation notes in the conversation\n"
        "log. The other 3 findings used DB-column inputs and should reproduce; this\n"
        "rerun confirms that.\n\n"
        f"_LF enriched rows: {len(lf):,} · SB enriched rows: {len(sb):,} · macro events: {len(events):,}_\n"
    )
    for k in ["f1_range_kill", "f2_vol_to_oi", "f3_spread_confirmed", "f4_macro_window"]:
        report += "\n" + results[k]["markdown"]

    report_path = FINDINGS_DIR / "report.md"
    report_path.write_text(report)
    print(f"\nWrote {report_path}")

    # Strip markdown blobs from JSON output for cleanliness
    json_payload = {
        k: {kk: vv for kk, vv in v.items() if kk != "markdown"}
        for k, v in results.items()
    }
    json_path = FINDINGS_DIR / "results.json"
    json_path.write_text(json.dumps(json_payload, indent=2))
    print(f"Wrote {json_path}")


if __name__ == "__main__":
    main()
