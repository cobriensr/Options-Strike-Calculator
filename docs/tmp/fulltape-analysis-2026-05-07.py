"""Brief analysis: tag stratification of lottery fires + delta-based multi-leg filter on whales.

Output written to stdout. 3 days of data — directional read only, not statistical.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import polars as pl
import psycopg2

# --- Load .env.local (UW_API_KEY isn't used here but DATABASE_URL is) ---
env_path = Path(".env.local")
for line in env_path.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v.strip("\"'"))

DB_URL = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
if not DB_URL:
    sys.exit("DATABASE_URL not set")

DATES = ["2026-05-04", "2026-05-05", "2026-05-06"]
PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"

# Load 3 days of Full Tape — project to only relevant cols to keep memory reasonable.
ft_paths = [PARQUET_DIR / f"{d}-fulltape.parquet" for d in DATES]
for p in ft_paths:
    assert p.exists(), f"Missing: {p}"

FT_COLS = [
    "executed_at",
    "option_chain_id",
    "underlying_symbol",
    "exchange",
    "price",
    "size",
    "premium",
    "ask_vol",
    "bid_vol",
    "mid_vol",
    "no_side_vol",
    "multi_vol",
    "stock_multi_vol",
    "tags",
]
ft_lf = pl.concat([pl.scan_parquet(p).select(FT_COLS) for p in ft_paths])

# =========================================================================
# Analysis 1: Tag stratification of lottery_finder_fires
# =========================================================================
print("=" * 72)
print("ANALYSIS 1 — Tag stratification of lottery_finder_fires")
print("=" * 72)

with psycopg2.connect(DB_URL) as conn:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT date, option_chain_id, trigger_time_ct, underlying_symbol,
                   score, peak_ceiling_pct, minutes_to_peak,
                   realized_trail30_10_pct, realized_hard30m_pct,
                   realized_tier50_holdeod_pct, realized_eod_pct,
                   realized_flow_inversion_pct
            FROM lottery_finder_fires
            WHERE date BETWEEN %s AND %s
            ORDER BY date, trigger_time_ct
            """,
            (DATES[0], DATES[-1]),
        )
        cols = [c.name for c in cur.description]
        rows = cur.fetchall()

fires = pl.DataFrame(rows, schema=cols, orient="row")
print(f"Fires loaded: {fires.height:,}")
print(f"  Date breakdown: {dict(fires.group_by('date').len().sort('date').iter_rows())}")

# Build a per-chain tag profile from Full Tape: union of all tag tokens at this
# chain across the 3 days. Avoids the timestamp-precision issue between
# trigger_time_ct and Full Tape's executed_at.
print("\n→ Building per-chain tag profile from Full Tape...")
chain_tags = (
    ft_lf
    .select("option_chain_id", "tags")
    .with_columns(
        pl.col("tags").str.replace_all(r"[{}]", "").str.split(",").alias("tag_list")
    )
    .explode("tag_list")
    .filter(pl.col("tag_list").is_not_null() & (pl.col("tag_list") != ""))
    .group_by("option_chain_id")
    .agg(pl.col("tag_list").unique().alias("tags_present"))
    .collect(engine="streaming")
)
print(f"Chains with tags: {chain_tags.height:,}")

# Join fires to chain tags
fires_tagged = fires.join(chain_tags, on="option_chain_id", how="left")
matched = fires_tagged.filter(pl.col("tags_present").is_not_null()).height
print(f"Fires matched to a tag profile: {matched:,} / {fires.height:,} ({matched/fires.height*100:.1f}%)")

# Stratify by specific tag presence
print("\n--- Realized P&L stratified by tag presence ---")
print("(Cell value = median peak_ceiling_pct across fires; n = fires count)\n")

INTERESTING_TAGS = [
    "earnings_this_week",
    "earnings_next_week",
    "heavily_shorted",
    "etf",
    "index",
    "china",
    "dividend",
    "arbitrage",
    "bullish",
    "bearish",
]

# For each tag, split fires into has-tag and no-tag groups, compare medians
print(f"{'Tag':<24} {'n_with':>8} {'n_without':>10} {'med_peak_with':>15} {'med_peak_without':>18} {'med_eod_with':>14} {'med_eod_without':>17}")
print("-" * 110)
for tag in INTERESTING_TAGS:
    fires_with_tag = fires_tagged.filter(
        pl.col("tags_present").is_not_null() & pl.col("tags_present").list.contains(tag)
    )
    fires_no_tag = fires_tagged.filter(
        pl.col("tags_present").is_not_null() & ~pl.col("tags_present").list.contains(tag)
    )
    n_with = fires_with_tag.height
    n_without = fires_no_tag.height
    if n_with == 0:
        print(f"{tag:<24} {n_with:>8} {n_without:>10}  (no fires with this tag)")
        continue
    med_peak_with = fires_with_tag["peak_ceiling_pct"].median()
    med_peak_without = fires_no_tag["peak_ceiling_pct"].median()
    med_eod_with = fires_with_tag["realized_eod_pct"].median()
    med_eod_without = fires_no_tag["realized_eod_pct"].median()
    fmt = lambda v: f"{float(v):>+15.1f}" if v is not None else "          (n/a)"
    print(f"{tag:<24} {n_with:>8} {n_without:>10} {fmt(med_peak_with):>15} {fmt(med_peak_without):>18} {fmt(med_eod_with):>14} {fmt(med_eod_without):>17}")

# Win rate by tag (% of fires where peak_ceiling >= 50%)
print("\n--- Win-rate stratification: % of fires with peak_ceiling_pct >= 50% ---")
print(f"{'Tag':<24} {'with_tag':>10} {'without_tag':>12} {'lift':>8}")
print("-" * 60)
for tag in INTERESTING_TAGS:
    has = fires_tagged.filter(
        pl.col("tags_present").is_not_null() & pl.col("tags_present").list.contains(tag)
    )
    no = fires_tagged.filter(
        pl.col("tags_present").is_not_null() & ~pl.col("tags_present").list.contains(tag)
    )
    if has.height == 0:
        print(f"{tag:<24} {has.height:>10} {no.height:>12}    n/a")
        continue
    win_with = (has["peak_ceiling_pct"] >= 50).mean() * 100 if has.height > 0 else 0
    win_without = (no["peak_ceiling_pct"] >= 50).mean() * 100 if no.height > 0 else 0
    lift = win_with - win_without
    print(f"{tag:<24} {win_with:>9.1f}% {win_without:>11.1f}% {lift:>+7.1f}")

# =========================================================================
# Analysis 2: Delta-based multi-leg filter on whale candidates
# =========================================================================
print("\n" + "=" * 72)
print("ANALYSIS 2 — Delta-based multi-leg filter on whale candidates")
print("=" * 72)

# Define whale candidate: premium >= $100K (per single trade)
# Compute per-trade multi_vol delta: (multi_vol - prev_multi_vol) within (option_chain_id), sorted by executed_at
print("\n→ Computing per-trade multi_vol & stock_multi_vol deltas (within chain, sorted by time)...")

PREMIUM_THRESHOLDS = [25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]

# Sort and compute deltas. Cumulative diff per chain.
ft_with_deltas = (
    ft_lf
    .sort(["option_chain_id", "executed_at"])
    .with_columns(
        # Multi-leg delta — what fraction of THIS trade was multi-leg?
        (pl.col("multi_vol") - pl.col("multi_vol").shift(1).over("option_chain_id"))
            .fill_null(pl.col("multi_vol"))
            .alias("mv_delta"),
        # Stock-multi delta — what fraction was stock+option combo?
        (pl.col("stock_multi_vol") - pl.col("stock_multi_vol").shift(1).over("option_chain_id"))
            .fill_null(pl.col("stock_multi_vol"))
            .alias("smv_delta"),
        # Aggressor delta — ask/bid/mid/no_side
        (pl.col("ask_vol") - pl.col("ask_vol").shift(1).over("option_chain_id"))
            .fill_null(pl.col("ask_vol"))
            .alias("ask_delta"),
        (pl.col("bid_vol") - pl.col("bid_vol").shift(1).over("option_chain_id"))
            .fill_null(pl.col("bid_vol"))
            .alias("bid_delta"),
    )
    .collect(engine="streaming")
)

print(f"Total Full Tape rows (3 days): {ft_with_deltas.height:,}")

# Whale-candidate stratification
print(f"\n--- Multi-leg rate for whale candidates by premium threshold ---")
print(f"{'Threshold':>12} {'whales':>10} {'multi-leg':>10} {'%':>7} {'stock+opt':>10} {'%':>7}")
print("-" * 64)
for thresh in PREMIUM_THRESHOLDS:
    whales = ft_with_deltas.filter(pl.col("premium") >= thresh)
    if whales.height == 0:
        continue
    multi = (whales["mv_delta"] > 0).sum()
    stock_multi = (whales["smv_delta"] > 0).sum()
    print(
        f"${thresh:>10,} {whales.height:>10,} {multi:>10,} {multi/whales.height*100:>6.1f}% "
        f"{stock_multi:>10,} {stock_multi/whales.height*100:>6.1f}%"
    )

# How does it compare to the all-trades baseline?
print(f"\n--- Baseline (all 3-day Full Tape rows) ---")
all_multi = (ft_with_deltas["mv_delta"] > 0).sum()
all_stock = (ft_with_deltas["smv_delta"] > 0).sum()
print(f"All trades: {ft_with_deltas.height:,}")
print(f"  multi-leg:  {all_multi:>12,} ({all_multi/ft_with_deltas.height*100:.1f}%)")
print(f"  stock+opt:  {all_stock:>12,} ({all_stock/ft_with_deltas.height*100:.1f}%)")

# 5 sample $1M+ whale rows with their multi-leg classification
print(f"\n--- Sample 10 highest-premium whales ($100K+ premium) with multi-leg classification ---")
top_whales = (
    ft_with_deltas
    .filter(pl.col("premium") >= 100_000)
    .sort("premium", descending=True)
    .head(10)
    .select([
        "executed_at",
        "underlying_symbol",
        "option_chain_id",
        "premium",
        "size",
        "mv_delta",
        "smv_delta",
        "ask_delta",
        "bid_delta",
        "tags",
    ])
)
print(top_whales)

# Sanity: how often does mv_delta exactly equal size? (means full-spread leg)
sane = ft_with_deltas.filter(pl.col("premium") >= 100_000)
sane_eq_size = (sane["mv_delta"] == sane["size"]).sum()
sane_partial = ((sane["mv_delta"] > 0) & (sane["mv_delta"] != sane["size"])).sum()
print(f"\n--- Sanity check on whale rows ($100K+ premium, n={sane.height:,}) ---")
print(f"  mv_delta == size (entire trade is multi-leg):  {sane_eq_size:,} ({sane_eq_size/sane.height*100:.1f}%)")
print(f"  mv_delta > 0 but != size (partial multi-leg):  {sane_partial:,} ({sane_partial/sane.height*100:.1f}%)")
print(f"  mv_delta == 0 (purely naked):                  {(sane['mv_delta'] == 0).sum():,} ({(sane['mv_delta'] == 0).sum()/sane.height*100:.1f}%)")
