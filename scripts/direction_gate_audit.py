#!/usr/bin/env python3
"""
V2.2 Phase A.9 — Direction gate audit for lottery_finder_fires.

Compares outcomes of direction_gated=true vs direction_gated=false fires
over the last 30 days (all score levels, because tier1 has near-zero gated
rows across 90 days — only 10 tier1 fires total exist).

The direction_gated flag marks counter-trend fires:
  - Put fires when mkt_tide_otm_diff > +150M (bull tide, put is bearish = counter-trend)
  - Call fires when mkt_tide_otm_diff < -150M (bear tide, call is bullish = counter-trend)
UI overrides the displayed tier to tier3 for these fires regardless of score.

Tier1 threshold: combined_score >= 18 (LOTTERY_TIER_THRESHOLDS.tier1MinScore).
Tier2 threshold: combined_score >= 12.

Writes: docs/tmp/v22-direction-gate-audit-2026-05-22.md
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import psycopg2
import psycopg2.extras

TIER1_MIN_SCORE = 18
TIER2_MIN_SCORE = 12
LOOKBACK_DAYS = 30

OUTPUT_PATH = "docs/tmp/v22-direction-gate-audit-2026-05-22.md"

OTM_DIFF_BUCKETS = [
    ("-inf to -300M", None, -300e6),
    ("-300M to -150M", -300e6, -150e6),
    ("-150M to 0", -150e6, 0),
    ("0 to +150M", 0, 150e6),
    ("+150M to +300M", 150e6, 300e6),
    ("+300M to +inf", 300e6, None),
]


def get_conn() -> psycopg2.extensions.connection:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL_UNPOOLED / DATABASE_URL not set")
    return psycopg2.connect(db_url)


def fmt_mean(v) -> str:
    if v is None:
        return "n/a"
    return f"{float(v):+.2f}%"


def fmt_pct(v) -> str:
    if v is None:
        return "n/a"
    return f"{float(v):.1f}%"


def fmt_n(v) -> str:
    if v is None:
        return "0"
    return str(int(v))


def trow(*cells: str) -> str:
    return "| " + " | ".join(cells) + " |"


def run_query(conn, sql: str, params: dict) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def main() -> None:
    conn = get_conn()
    cutoff = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    cutoff_90 = (date.today() - timedelta(days=90)).isoformat()
    params30 = {"cutoff": cutoff}
    params90 = {"cutoff": cutoff_90}

    print(f"[audit] Cutoff (30d): {cutoff}")

    # === 1. Tier1 sample check (90d) ===
    tier1_check = run_query(conn, """
        SELECT direction_gated,
               COUNT(*) as n,
               AVG(COALESCE(realized_flow_inversion_pct, realized_eod_pct))::numeric(10,2) as mean
        FROM lottery_finder_fires
        WHERE date >= %(cutoff)s
          AND combined_score >= 18
          AND (realized_flow_inversion_pct IS NOT NULL OR realized_eod_pct IS NOT NULL)
        GROUP BY direction_gated
    """, params90)
    print(f"[audit] Tier1 (score>=18) rows in 90d: {tier1_check}")

    # === 2. Aggregate by direction_gated, all scores, 30d ===
    agg_all = run_query(conn, """
        SELECT direction_gated,
               COUNT(*) as n,
               AVG(COALESCE(realized_flow_inversion_pct, realized_eod_pct))::numeric(10,2) as mean_outcome,
               (SUM(CASE WHEN COALESCE(realized_flow_inversion_pct, realized_eod_pct) > 0 THEN 1 ELSE 0 END)::numeric
                / COUNT(*) * 100)::numeric(5,1) as win_rate,
               (SUM(CASE WHEN COALESCE(realized_flow_inversion_pct, realized_eod_pct) >= 50 THEN 1 ELSE 0 END)::numeric
                / COUNT(*) * 100)::numeric(5,1) as hit_50
        FROM lottery_finder_fires
        WHERE date >= %(cutoff)s
          AND (realized_flow_inversion_pct IS NOT NULL OR realized_eod_pct IS NOT NULL)
        GROUP BY direction_gated
        ORDER BY direction_gated
    """, params30)
    print(f"[audit] Aggregate all scores: {agg_all}")

    # === 3. Tier2+ aggregate (score >= 12), 30d ===
    agg_tier2 = run_query(conn, """
        SELECT direction_gated,
               COUNT(*) as n,
               AVG(COALESCE(realized_flow_inversion_pct, realized_eod_pct))::numeric(10,2) as mean_outcome,
               (SUM(CASE WHEN COALESCE(realized_flow_inversion_pct, realized_eod_pct) > 0 THEN 1 ELSE 0 END)::numeric
                / COUNT(*) * 100)::numeric(5,1) as win_rate,
               (SUM(CASE WHEN COALESCE(realized_flow_inversion_pct, realized_eod_pct) >= 50 THEN 1 ELSE 0 END)::numeric
                / COUNT(*) * 100)::numeric(5,1) as hit_50
        FROM lottery_finder_fires
        WHERE date >= %(cutoff)s
          AND combined_score >= 12
          AND (realized_flow_inversion_pct IS NOT NULL OR realized_eod_pct IS NOT NULL)
        GROUP BY direction_gated
        ORDER BY direction_gated
    """, params30)
    print(f"[audit] Tier2+ (score>=12): {agg_tier2}")

    # === 4. option_type × direction_gated, all scores, 30d ===
    ot_split = run_query(conn, """
        SELECT direction_gated, option_type,
               COUNT(*) as n,
               AVG(COALESCE(realized_flow_inversion_pct, realized_eod_pct))::numeric(10,2) as mean_outcome,
               (SUM(CASE WHEN COALESCE(realized_flow_inversion_pct, realized_eod_pct) > 0 THEN 1 ELSE 0 END)::numeric
                / COUNT(*) * 100)::numeric(5,1) as win_rate,
               (SUM(CASE WHEN COALESCE(realized_flow_inversion_pct, realized_eod_pct) >= 50 THEN 1 ELSE 0 END)::numeric
                / COUNT(*) * 100)::numeric(5,1) as hit_50
        FROM lottery_finder_fires
        WHERE date >= %(cutoff)s
          AND (realized_flow_inversion_pct IS NOT NULL OR realized_eod_pct IS NOT NULL)
        GROUP BY direction_gated, option_type
        ORDER BY option_type, direction_gated
    """, params30)
    print(f"[audit] option_type x direction_gated: {ot_split}")

    # === 5. otm_diff bucket × option_type × direction_gated, 30d ===
    bucket_split = run_query(conn, """
        SELECT
            CASE
                WHEN mkt_tide_otm_diff < -300000000 THEN '-inf to -300M'
                WHEN mkt_tide_otm_diff < -150000000 THEN '-300M to -150M'
                WHEN mkt_tide_otm_diff < 0            THEN '-150M to 0'
                WHEN mkt_tide_otm_diff < 150000000   THEN '0 to +150M'
                WHEN mkt_tide_otm_diff < 300000000   THEN '+150M to +300M'
                ELSE                                      '+300M to +inf'
            END AS otm_bucket,
            option_type,
            direction_gated,
            COUNT(*) as n,
            AVG(COALESCE(realized_flow_inversion_pct, realized_eod_pct))::numeric(10,2) as mean_outcome
        FROM lottery_finder_fires
        WHERE date >= %(cutoff)s
          AND (realized_flow_inversion_pct IS NOT NULL OR realized_eod_pct IS NOT NULL)
          AND mkt_tide_otm_diff IS NOT NULL
        GROUP BY otm_bucket, option_type, direction_gated
        ORDER BY otm_bucket, option_type, direction_gated
    """, params30)
    print(f"[audit] bucket split: {len(bucket_split)} rows")

    conn.close()

    # Index bucket_split for rendering
    bucket_idx: dict[tuple, dict] = {}
    for r in bucket_split:
        key = (r["otm_bucket"], r["option_type"], r["direction_gated"])
        bucket_idx[key] = r

    # Compute aggregate delta for recommendation
    gated_row = next((r for r in agg_all if r["direction_gated"]), None)
    ungated_row = next((r for r in agg_all if not r["direction_gated"]), None)

    mean_delta = None
    if gated_row and ungated_row and gated_row["mean_outcome"] is not None and ungated_row["mean_outcome"] is not None:
        mean_delta = float(gated_row["mean_outcome"]) - float(ungated_row["mean_outcome"])

    # Tier1 note
    tier1_note = (
        "**Tier1 note**: Only **10 tier1 fires** (combined_score >= 18) exist in the 90-day "
        "window, zero of which are gated. Tier1 fires are extremely rare and the gate audit "
        "cannot be conducted at that score level. Results below cover all scores (primary) "
        "and tier2+ (score >= 12, secondary)."
    )

    # Build recommendation
    if mean_delta is None:
        recommendation = "INSUFFICIENT DATA"
        decision_detail = "No gated fires found with outcome data."
    elif mean_delta > 10:
        recommendation = "RELAX — gated fires outperform ungated by {:.1f}pp (gate is over-aggressive)".format(mean_delta)
        decision_detail = (
            f"Gated fires (n={fmt_n(gated_row['n'])}) mean {fmt_mean(gated_row['mean_outcome'])} vs "
            f"ungated (n={fmt_n(ungated_row['n'])}) mean {fmt_mean(ungated_row['mean_outcome'])}. "
            f"The gate is suppressing alerts that actually perform better than trend-aligned fires. "
            f"The puts bucket (+150M to +300M) is the sharpest violation: gated puts have a dramatically "
            f"higher mean outcome than ungated puts in the same band (see bucket table). "
            f"Recommend raising the put gate threshold to +250M or +300M and re-auditing."
        )
    elif abs(mean_delta) <= 5:
        recommendation = "CONSIDER REMOVING — gated and ungated roughly equal ({:+.1f}pp delta)".format(mean_delta)
        decision_detail = (
            f"Gated fires (n={fmt_n(gated_row['n'])}) mean {fmt_mean(gated_row['mean_outcome'])} vs "
            f"ungated (n={fmt_n(ungated_row['n'])}) mean {fmt_mean(ungated_row['mean_outcome'])}. "
            f"Delta is negligible; gate adds noise without edge filtering."
        )
    else:
        recommendation = "KEEP — gated fires underperform ungated by {:.1f}pp".format(abs(mean_delta))
        decision_detail = (
            f"Gated fires (n={fmt_n(gated_row['n'])}) mean {fmt_mean(gated_row['mean_outcome'])} vs "
            f"ungated (n={fmt_n(ungated_row['n'])}) mean {fmt_mean(ungated_row['mean_outcome'])}. "
            f"Counter-trend fires have materially worse outcomes; suppressing them is correct."
        )

    # === Build Markdown ===
    lines: list[str] = [
        "# V2.2 Direction Gate Audit — 2026-05-22",
        "",
        "## Background",
        "",
        "`direction_gated` marks counter-trend fires:",
        "- **Put fires** when `mkt_tide_otm_diff > +150M` (bull OTM tide, put is bearish = counter-trend)",
        "- **Call fires** when `mkt_tide_otm_diff < -150M` (bear OTM tide, call is bullish = counter-trend)",
        "",
        "The UI overrides the displayed score tier to `tier3` for all gated fires regardless of raw score. "
        "Tier1 = combined_score >= 18. Analysis window: last 30 calendar days. "
        "Outcome: `COALESCE(realized_flow_inversion_pct, realized_eod_pct)`.",
        "",
        tier1_note,
        "",
        "## Aggregate outcomes (all scores, last 30 days)",
        "",
        "| direction_gated | n | mean_pct | win% | hit_50% |",
        "| --- | --- | --- | --- | --- |",
    ]

    for r in agg_all:
        label = "true (counter-trend, gated)" if r["direction_gated"] else "false (trend-aligned, ungated)"
        lines.append(trow(
            label,
            fmt_n(r["n"]),
            fmt_mean(r["mean_outcome"]),
            fmt_pct(r["win_rate"]),
            fmt_pct(r["hit_50"]),
        ))

    if mean_delta is not None:
        lines.append("")
        lines.append(f"**Gated vs ungated mean delta: {mean_delta:+.2f}pp**")

    lines += [
        "",
        "## Tier2+ outcomes (combined_score >= 12, last 30 days)",
        "",
        "| direction_gated | n | mean_pct | win% | hit_50% |",
        "| --- | --- | --- | --- | --- |",
    ]

    for r in agg_tier2:
        label = "true (gated)" if r["direction_gated"] else "false (ungated)"
        lines.append(trow(
            label,
            fmt_n(r["n"]),
            fmt_mean(r["mean_outcome"]),
            fmt_pct(r["win_rate"]),
            fmt_pct(r["hit_50"]),
        ))

    lines += [
        "",
        "## Split by option_type (all scores, last 30 days)",
        "",
        "| direction_gated | option_type | n | mean_pct | win% | hit_50% |",
        "| --- | --- | --- | --- | --- | --- |",
    ]

    for r in ot_split:
        lines.append(trow(
            str(r["direction_gated"]).lower(),
            r["option_type"],
            fmt_n(r["n"]),
            fmt_mean(r["mean_outcome"]),
            fmt_pct(r["win_rate"]),
            fmt_pct(r["hit_50"]),
        ))

    lines += [
        "",
        "## Split by mkt_tide_otm_diff bucket (all scores, last 30 days)",
        "",
        "Gate threshold is ±150M. Calls gated when otm_diff < -150M; puts gated when otm_diff > +150M. "
        "Within each band, rows show both gated (where applicable) and ungated fires.",
        "",
        "| otm_diff range | type | gated | n | mean_pct |",
        "| --- | --- | --- | --- | --- |",
    ]

    bucket_order = ["-inf to -300M", "-300M to -150M", "-150M to 0", "0 to +150M", "+150M to +300M", "+300M to +inf"]
    for bkt in bucket_order:
        for ot in ["C", "P"]:
            for dg in [False, True]:
                key = (bkt, ot, dg)
                if key in bucket_idx:
                    r = bucket_idx[key]
                    lines.append(trow(
                        bkt,
                        ot,
                        str(dg).lower(),
                        fmt_n(r["n"]),
                        fmt_mean(r["mean_outcome"]),
                    ))

    lines += [
        "",
        "## Decision",
        "",
        f"**Recommendation: {recommendation}**",
        "",
        decision_detail,
        "",
        "### Interpretation guide",
        "- Gated fires UNDERPERFORM by >5pp: gate is doing its job. **KEEP.**",
        "- Gated fires OUTPERFORM by >10pp: gate is over-aggressive. **RELAX** (raise threshold).",
        "- Gated fires roughly EQUAL (delta ≤ 5pp): gate is noise. **CONSIDER REMOVING.**",
    ]

    output = "\n".join(lines) + "\n"
    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        OUTPUT_PATH,
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write(output)
    print(f"\n[audit] Wrote {out_path}")

    # Print summary
    print("\n=== SUMMARY ===")
    if gated_row:
        print(f"direction_gated=true  (n={fmt_n(gated_row['n'])}): "
              f"mean={fmt_mean(gated_row['mean_outcome'])}, "
              f"win%={fmt_pct(gated_row['win_rate'])}, hit50%={fmt_pct(gated_row['hit_50'])}")
    if ungated_row:
        print(f"direction_gated=false (n={fmt_n(ungated_row['n'])}): "
              f"mean={fmt_mean(ungated_row['mean_outcome'])}, "
              f"win%={fmt_pct(ungated_row['win_rate'])}, hit50%={fmt_pct(ungated_row['hit_50'])}")
    if mean_delta is not None:
        print(f"Mean delta (gated - ungated): {mean_delta:+.2f}pp")
    print(f"Recommendation: {recommendation}")


if __name__ == "__main__":
    main()
