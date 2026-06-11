"""Phase 1 — assemble per-alert training rows for the take-it score model.

Reads enriched alert rows from Postgres (lottery_finder_fires, silent_boom_alerts),
derives features that aren't stored directly on the row, applies the win label
(peak_ceiling_pct >= WIN_LABEL_THRESHOLD_PCT), and writes one parquet per
alert type to ml/data/takeit/.

No leakage:
- Macro/microstructure features come from columns the detect cron set AT fire time.
- Sequential features (n_same_dir_fires_last_30min) use only fires whose
  fire_time < current fire_time. prior_session_win_rate_same_ticker uses only
  STRICTLY EARLIER dates so enrichment is guaranteed complete by scoring time.
- Cofire flags (silent_boom_cofire_within_5min, lottery_cofire_within_5min) use
  ONLY counterparts at or before the target's fire_time (a future counterpart
  isn't known at scoring time).
- The label (peak_ceiling_pct) is the ONLY column used from the outcome enrichment;
  it never leaks into a feature because every derived feature touches only
  pre-fire data.

CLI:
    ml/.venv/bin/python -m ml.src.takeit.build_training_set \\
        --out ml/data/takeit \\
        --threshold 20
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import deque
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Final, Literal

import pandas as pd
import psycopg2

from .config import (
    AGGRESSIVE_ASK_PCT_THRESHOLD,
    BURST_STORM_MIN_COFIRES,
    BURST_STORM_WINDOW_MIN,
    COFIRE_WINDOW_MIN,
    WIN_LABEL_THRESHOLD_PCT,
)

AlertType = Literal["lottery", "silentboom"]


@dataclass(frozen=True)
class BuildSummary:
    alert_type: AlertType
    rows_in: int
    rows_labeled: int
    rows_out: int
    win_rate: float
    date_min: date
    date_max: date
    out_path: Path


# ── Postgres queries ─────────────────────────────────────────────────────────

# These SELECTs pull only columns the detect cron sets at fire time, plus the
# enriched peak_ceiling_pct label. Outcome columns other than the label are
# excluded so they can't accidentally drift into a feature.

LOTTERY_SQL: Final = """
    SELECT
        id, date, trigger_time_ct, option_chain_id, underlying_symbol,
        option_type, strike, expiry, dte,
        trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
        trigger_delta, trigger_ask_pct, trigger_window_size,
        trigger_window_prints,
        entry_price, open_interest, spot_at_first, alert_seq,
        minutes_since_prev_fire,
        flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
        burst_ratio_vs_prev, entry_drop_pct_vs_prev,
        mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
        spx_flow_diff, spy_etf_diff, qqq_etf_diff, zero_dte_diff,
        spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi,
        spx_spot_vanna_oi,
        gex_strike_call_minus_put, gex_strike_call_ask_minus_bid,
        gex_strike_put_ask_minus_bid, gex_strike_actual_strike,
        gex_one_cvroflow, gex_net_put_dex, gex_one_dexoflow,
        gex_one_gexoflow, gex_zcvr, gex_zero_gamma, gex_spot,
        gex_captured_at,
        score, direction_gated,
        inferred_structure, is_isolated_leg, match_confidence,
        pattern_group_id,
        wave2_status, wave2_detected_at,
        peak_ceiling_pct
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL
    ORDER BY trigger_time_ct
"""

SILENTBOOM_SQL: Final = """
    SELECT
        id, date, bucket_ct, option_chain_id, underlying_symbol,
        option_type, strike, expiry, dte,
        spike_volume, baseline_volume, spike_ratio, ask_pct, vol_oi,
        entry_price, open_interest,
        mkt_tide_diff, mkt_tide_otm_diff, zero_dte_diff,
        spx_spot_gamma_oi,
        multi_leg_share, underlying_price_at_spike,
        score, score_tier, direction_gated,
        inferred_structure, is_isolated_leg, match_confidence,
        pattern_group_id,
        wave2_status, wave2_detected_at,
        gex_one_cvroflow, gex_net_put_dex, gex_one_dexoflow,
        gex_one_gexoflow, gex_zcvr, gex_zero_gamma, gex_spot,
        gex_captured_at,
        peak_ceiling_pct
    FROM silent_boom_alerts
    WHERE peak_ceiling_pct IS NOT NULL
    ORDER BY bucket_ct
"""


def _get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print(
            "ERROR: DATABASE_URL not set. Run: set -a && source .env.local && set +a",
            file=sys.stderr,
        )
        sys.exit(1)
    return psycopg2.connect(url, sslmode="require")


def load_lottery(conn) -> pd.DataFrame:
    df = pd.read_sql_query(LOTTERY_SQL, conn)
    df = df.rename(columns={"trigger_time_ct": "fire_time"})
    df["alert_type"] = "lottery"
    return df


def load_silentboom(conn) -> pd.DataFrame:
    df = pd.read_sql_query(SILENTBOOM_SQL, conn)
    df = df.rename(columns={"bucket_ct": "fire_time"})
    df["alert_type"] = "silentboom"
    return df


# ── Feature derivation ───────────────────────────────────────────────────────


def _session_phase_from_minute_ct(minute_of_day_ct: float) -> int:
    """Map CT minute-of-day to user's 5-phase intraday schedule.

    1: 8:30-9:00  pre-open warmup
    2: 9:00-10:30 morning execution
    3: 10:30-12:00 mid-morning
    4: 12:00-14:00 lunch/afternoon drift
    5: 14:00-15:00 close
    0 outside session (shouldn't occur with valid alerts).
    """
    if minute_of_day_ct < 8 * 60 + 30:
        return 0
    if minute_of_day_ct < 9 * 60:
        return 1
    if minute_of_day_ct < 10 * 60 + 30:
        return 2
    if minute_of_day_ct < 12 * 60:
        return 3
    if minute_of_day_ct < 14 * 60:
        return 4
    if minute_of_day_ct < 15 * 60:
        return 5
    return 0


# ── Phase 3: 7-phase categorical session label ───────────────────────────────
#
# Mirrors `sessionPhaseCatFromMinuteCt` / `SESSION_PHASES` in
# api/_lib/takeit-features.ts. Lives alongside the legacy numeric
# `session_phase` (0-5); both ship so the trainer can keep the existing
# bundle stable while letting the new categorical participate in one-hot
# expansion. LEFT-inclusive boundaries: 08:30:00 → 'open', 09:00:00 →
# 'opening_30', etc. DO NOT REORDER — the trainer pins one-hot column
# names like `session_phase_cat_open`; reordering would silently invalidate
# bundles.

SESSION_PHASES: Final = (
    "pre_open",
    "open",
    "opening_30",
    "morning",
    "lunch",
    "afternoon",
    "closing",
)


# Mirrors `INFERRED_STRUCTURE_LABELS` in api/_lib/takeit-features.ts. Pinned
# so the trainer emits a full one-hot block even if a label is absent in
# the training set — keeps `feature_cols` stable across retrains so the TS
# scorer (which always emits all 5 labels) never sets an un-pinned key.
# Order is the labels' identity, not a ranking — DO NOT REORDER.
INFERRED_STRUCTURE_LABELS: Final = (
    "isolated_leg",
    "vertical",
    "strangle",
    "risk_reversal",
    "butterfly",
)


def _session_phase_cat_from_minute_ct(minute_of_day_ct: float) -> str:
    """7-phase categorical label aligned to the user's trading schedule.

    CT (all LEFT-inclusive):
      pre_open   : < 08:30
      open       : 08:30-09:00 (cash-open overlap)
      opening_30 : 09:00-09:30 (gamma rebalance window)
      morning    : 09:30-11:00 (informed-flow window)
      lunch      : 11:00-13:00
      afternoon  : 13:00-14:00
      closing    : 14:00 onward
    """
    if minute_of_day_ct < 8 * 60 + 30:
        return "pre_open"
    if minute_of_day_ct < 9 * 60:
        return "open"
    if minute_of_day_ct < 9 * 60 + 30:
        return "opening_30"
    if minute_of_day_ct < 11 * 60:
        return "morning"
    if minute_of_day_ct < 13 * 60:
        return "lunch"
    if minute_of_day_ct < 14 * 60:
        return "afternoon"
    return "closing"


# ── Phase 5: Forced-flow features ────────────────────────────────────────────
#
# Mirrors api/_lib/forced-flow.ts. Two features are real (calendar quarter-end
# last hour CT, VIX intraday change > +3 pts when available); the other two
# are STUBS returning 0 by design (bilateral_flow + cross_name_cluster require
# context the alert row does not carry — see the TS file's STUB notes).
# Stub-zero is a truthful signal ("no info"); the rewire will swap in the
# real derivation without a feature-shape change.

CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS: Final = 3.0


def _is_quarter_end_last_hour_ct(ct_ts: pd.Timestamp) -> bool:
    """Quarter-end last hour CT (14:00 ≤ minute < 15:00, last weekday of
    Mar/Jun/Sep/Dec). Mirrors api/_lib/forced-flow.ts isQuarterEndLastHourCt.

    Simplifications kept identical to the TS version:
      - "Last trading day" approximated as last weekday (Mon-Fri).
      - No US holiday calendar wired in v1.
    """
    if pd.isna(ct_ts):
        return False
    month = ct_ts.month
    if month not in (3, 6, 9, 12):
        return False
    # Find last weekday of this CT month, iterating backward.
    year = ct_ts.year
    # Last day of month via timestamp math.
    next_month_first = pd.Timestamp(
        year=year + (1 if month == 12 else 0),
        month=1 if month == 12 else month + 1,
        day=1,
        tz=ct_ts.tz,
    )
    last_day = (next_month_first - pd.Timedelta(days=1)).day
    last_weekday = last_day
    for d in range(last_day, 0, -1):
        # weekday(): Mon=0..Sun=6 (matches the TS Mon-Fri = 1-5 after the
        # JS `getUTCDay()` Sun=0..Sat=6 conversion; here we use Python's
        # Mon=0..Sun=6 directly).
        probe = pd.Timestamp(year=year, month=month, day=d, tz=ct_ts.tz)
        if probe.weekday() < 5:  # Mon-Fri
            last_weekday = d
            break
    if ct_ts.day != last_weekday:
        return False
    minute_of_day = ct_ts.hour * 60 + ct_ts.minute
    return 14 * 60 <= minute_of_day < 15 * 60


def _derive_forced_flow_features(
    df: pd.DataFrame, ct_index: pd.DatetimeIndex
) -> pd.DataFrame:
    """Add the 4 forced-flow features to df.

    Mirrors `computeForcedFlowFeatures` in api/_lib/forced-flow.ts.

    Stub policy: bilateral_flow_score and cross_name_cluster_score are
    hard-coded 0 here (same as TS v1) — the alert row doesn't carry the
    sequential context they need. Documented dependency: when the alert row
    gains `bilateral_qualifying_opposite_count` /
    `sector_cluster_count_within_5min`, replace these column assignments
    with the real derivation.

    cross_asset_stress_flag: real iff the training row carries a
    `vix_intraday_change` column (positive = stress). Otherwise stubbed to
    0. The Phase 1 SELECT does NOT pull VIX intraday; consumers can join
    it in before calling derive_common_features() if available.
    """
    out = df.copy()
    out["bilateral_flow_score"] = 0.0
    out["cross_name_cluster_score"] = 0.0
    out["calendar_adjacency_flag"] = ct_index.map(_is_quarter_end_last_hour_ct).astype(
        "int8"
    )
    if "vix_intraday_change" in out.columns:
        vix = pd.to_numeric(out["vix_intraday_change"], errors="coerce")
        out["cross_asset_stress_flag"] = (
            (vix > CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS).fillna(False).astype("int8")
        )
    else:
        # Stub: no VIX intraday data in the alert row → 0. The model
        # learns the all-zero feature carries no info; rewire when VIX
        # joins the training SELECT.
        out["cross_asset_stress_flag"] = pd.Series(
            0, index=out.index, dtype="int8"
        )
    return out


def derive_common_features(df: pd.DataFrame, spot_col: str, ask_pct_col: str) -> pd.DataFrame:
    """Derive features common to both alert types.

    spot_col: column holding the underlying spot at fire time
              (lottery=spot_at_first, silentboom=underlying_price_at_spike).
    ask_pct_col: column holding ask-side share of fire-bucket volume
                 (lottery=trigger_ask_pct, silentboom=ask_pct).
    """
    out = df.copy()
    out["fire_time"] = pd.to_datetime(out["fire_time"], utc=True)
    ct = out["fire_time"].dt.tz_convert("America/Chicago")
    out["minute_of_day_ct"] = ct.dt.hour * 60 + ct.dt.minute
    out["day_of_week"] = ct.dt.dayofweek
    out["session_phase"] = out["minute_of_day_ct"].map(_session_phase_from_minute_ct)
    # Phase 3 (meta-detectors): 7-phase categorical session label, lives
    # alongside the legacy numeric session_phase. Encoded by pd.get_dummies
    # in train.py via CATEGORICAL_COLS additions.
    out["session_phase_cat"] = out["minute_of_day_ct"].map(
        _session_phase_cat_from_minute_ct
    )

    spot = out[spot_col]
    strike = out["strike"]
    is_call = out["option_type"].str.lower().isin(["c", "call"])
    valid_spot_strike = spot.notna() & strike.notna()
    is_itm_bool = (is_call & (spot >= strike)) | (~is_call & (spot <= strike))
    # Use nullable Int8 so NaN spot/strike produces <NA> rather than silent False.
    out["is_itm_at_fire"] = (
        is_itm_bool.astype("Int8").where(valid_spot_strike, pd.NA)
    )
    # otm_distance_pct positive when OTM, negative when ITM. NaN propagates.
    otm_call = (strike - spot) / spot
    otm_put = (spot - strike) / spot
    out["otm_distance_pct"] = otm_call.where(is_call, otm_put)

    # dealer_gamma_sign: +1 for net long dealer gamma (suppressive), -1 for net
    # short (procyclical). Derived from spx_spot_gamma_oi when present on the
    # alert row (lottery has it; silentboom has it).
    if "spx_spot_gamma_oi" in out.columns:
        gamma = out["spx_spot_gamma_oi"]
        sign = pd.Series(pd.NA, index=out.index, dtype="Int8")
        sign[gamma > 0] = 1
        sign[gamma < 0] = -1
        out["dealer_gamma_sign"] = sign

    out["aggressive_premium_flag"] = (
        (out[ask_pct_col] >= AGGRESSIVE_ASK_PCT_THRESHOLD).astype("Int8")
    )

    # Phase 5 (meta-detectors): forced-flow features. ct DatetimeIndex
    # is reused so we don't pay the tz conversion twice.
    out = _derive_forced_flow_features(out, pd.DatetimeIndex(ct))
    return out


def add_burst_storm(df: pd.DataFrame) -> pd.DataFrame:
    """For each fire, count distinct underlyings firing in the prior
    BURST_STORM_WINDOW_MIN minutes (strictly before this fire's fire_time).
    burst_storm_badge = 1 if count >= BURST_STORM_MIN_COFIRES.

    Computed within each date partition so the rolling deque stays bounded.
    Uses the deque-of-(time, underlying) sliding-window pattern: O(N) per day.
    """
    out = df.sort_values("fire_time").reset_index(drop=True).copy()
    badge = pd.Series(0, index=out.index, dtype="Int8")
    distinct_count = pd.Series(0, index=out.index, dtype="int32")

    window = timedelta(minutes=BURST_STORM_WINDOW_MIN)
    for _, idx_block in out.groupby("date", sort=False).groups.items():
        block_idx = list(idx_block)
        dq: deque = deque()
        underlying_counts: dict[str, int] = {}
        for i in block_idx:
            t = out.at[i, "fire_time"]
            cutoff = t - window
            while dq and dq[0][0] < cutoff:
                _, prev_under = dq.popleft()
                underlying_counts[prev_under] -= 1
                if underlying_counts[prev_under] == 0:
                    del underlying_counts[prev_under]
            distinct_count.at[i] = len(underlying_counts)
            if distinct_count.at[i] >= BURST_STORM_MIN_COFIRES:
                badge.at[i] = 1
            under = out.at[i, "underlying_symbol"]
            dq.append((t, under))
            underlying_counts[under] = underlying_counts.get(under, 0) + 1
    out["burst_storm_distinct_count"] = distinct_count
    out["burst_storm_badge"] = badge
    return out


def add_cofire_flag(
    target: pd.DataFrame, other: pd.DataFrame, flag_name: str
) -> pd.DataFrame:
    """For each row in `target`, set flag_name = 1 iff `other` has a row with
    same option_chain_id whose fire_time is at or before the target's fire_time
    AND within COFIRE_WINDOW_MIN of it.

    Directional (PIT-correct): at scoring time, a counterpart fire in the FUTURE
    is unknown, so only counterparts at t_other <= t_target can be counted.
    Implemented with a per-chain Python loop — quadratic only if a single chain
    has many alerts; in practice option-chain groups are small.
    """
    out = target.copy()
    if other.empty:
        out[flag_name] = pd.Series(0, index=out.index, dtype="Int8")
        return out
    window = pd.Timedelta(minutes=COFIRE_WINDOW_MIN)
    flag = pd.Series(0, index=out.index, dtype="Int8")
    other_sorted = other[["option_chain_id", "fire_time"]].copy()
    other_sorted["fire_time"] = pd.to_datetime(other_sorted["fire_time"], utc=True)
    other_sorted = other_sorted.sort_values("fire_time")
    by_chain = other_sorted.groupby("option_chain_id")["fire_time"].apply(list).to_dict()
    for i, row in out.iterrows():
        candidates = by_chain.get(row["option_chain_id"], [])
        t = row["fire_time"]
        for c in candidates:
            delta = t - c
            if pd.Timedelta(0) <= delta <= window:
                flag.at[i] = 1
                break
    out[flag_name] = flag
    return out


def add_cofire_diff_chain_flag(
    target: pd.DataFrame, other: pd.DataFrame, flag_name: str
) -> pd.DataFrame:
    """For each row in `target`, set flag_name = 1 iff `other` has a row with
    the SAME underlying + option_type but a DIFFERENT option_chain_id whose
    fire_time is at or before the target's fire_time AND within
    COFIRE_WINDOW_MIN of it.

    Sibling-chain cofire — coexists with `add_cofire_flag` and is NOT mutually
    exclusive. Same-chain cofires concentrate on one contract; sibling-chain
    cofires capture ticker-wide directional pressure across the strike ladder.
    Direction-locked (Call↔Call, Put↔Put).
    """
    out = target.copy()
    if other.empty:
        out[flag_name] = pd.Series(0, index=out.index, dtype="Int8")
        return out
    window = pd.Timedelta(minutes=COFIRE_WINDOW_MIN)
    flag = pd.Series(0, index=out.index, dtype="Int8")
    other_sorted = other[
        ["option_chain_id", "underlying_symbol", "option_type", "fire_time"]
    ].copy()
    other_sorted["fire_time"] = pd.to_datetime(other_sorted["fire_time"], utc=True)
    other_sorted = other_sorted.sort_values("fire_time")
    # Group by (underlying, option_type) → list of (fire_time, chain_id).
    by_dir: dict[tuple[str, str], list[tuple[pd.Timestamp, str]]] = {}
    for _, r in other_sorted.iterrows():
        key = (r["underlying_symbol"], r["option_type"])
        by_dir.setdefault(key, []).append((r["fire_time"], r["option_chain_id"]))
    for i, row in out.iterrows():
        key = (row["underlying_symbol"], row["option_type"])
        candidates = by_dir.get(key, [])
        t = row["fire_time"]
        target_chain = row["option_chain_id"]
        for c_time, c_chain in candidates:
            if c_chain == target_chain:
                continue
            delta = t - c_time
            if pd.Timedelta(0) <= delta <= window:
                flag.at[i] = 1
                break
    out[flag_name] = flag
    return out


def add_sequential_features(df: pd.DataFrame) -> pd.DataFrame:
    """n_same_dir_fires_last_30min and prior_session_win_rate_same_ticker.

    `n_same_dir_fires_last_30min`: count of strictly-prior fires with the same
    underlying + option_type within a 30-min lookback. PIT-correct.

    `prior_session_win_rate_same_ticker`: expanding mean of *daily* win rates
    across strictly earlier dates for the same ticker. NB this is mean-of-daily-
    means (each historical day weighted equally), not per-fire weighted; this
    smooths flukes from low-volume days but means a single big-fire day weighs
    the same as a single small-fire day. Acceptable for v1.
    """
    out = df.sort_values("fire_time").reset_index(drop=True).copy()

    # Same-direction fires in the last 30 min: same ticker + option_type, fire_time
    # strictly less than current, within 30-min lookback.
    out["_dir_key"] = out["underlying_symbol"].astype(str) + "::" + out["option_type"].astype(str)
    same_dir_count = pd.Series(0, index=out.index, dtype="int32")
    window = pd.Timedelta(minutes=30)
    by_key: dict[str, deque] = {}
    for i, row in out.iterrows():
        key = row["_dir_key"]
        t = row["fire_time"]
        dq = by_key.setdefault(key, deque())
        cutoff = t - window
        while dq and dq[0] < cutoff:
            dq.popleft()
        same_dir_count.at[i] = len(dq)  # strictly prior fires (current not yet appended)
        dq.append(t)
    out["n_same_dir_fires_last_30min"] = same_dir_count
    out = out.drop(columns=["_dir_key"])

    # Prior-session win-rate by ticker: of fires on this ticker on STRICTLY
    # earlier dates, what fraction had peak_ceiling_pct >= threshold. Uses an
    # expanding mean. Maps NaN when the ticker has never fired before.
    out["_is_win"] = (out["peak_ceiling_pct"] >= WIN_LABEL_THRESHOLD_PCT).astype(float)
    out = out.sort_values(["underlying_symbol", "date", "fire_time"]).reset_index(drop=True)
    # Per-ticker per-date aggregate, then expanding mean shifted by 1 date.
    daily = (
        out.groupby(["underlying_symbol", "date"])["_is_win"]
        .mean()
        .reset_index()
        .rename(columns={"_is_win": "_daily_win_rate"})
    )
    daily = daily.sort_values(["underlying_symbol", "date"]).reset_index(drop=True)
    # Expanding mean of daily win rates, then shift one date WITHIN each
    # ticker. NB: `groupby(...).expanding().mean()` returns a (ticker, idx)
    # MultiIndex; a bare `.shift(1)` on it shifts across the *concatenated*
    # groups, so each ticker's first date inherits the PRIOR ticker's final
    # mean — future + wrong-ticker leakage (AUD-C3). Materialize the per-ticker
    # expanding mean first, then shift per group so the first date of every
    # ticker correctly maps to NaN.
    daily["_expanding_win_rate"] = (
        daily.groupby("underlying_symbol")["_daily_win_rate"]
        .expanding()
        .mean()
        .reset_index(level=0, drop=True)
    )
    daily["prior_session_win_rate_same_ticker"] = daily.groupby(
        "underlying_symbol"
    )["_expanding_win_rate"].shift(1)
    daily = daily.drop(columns=["_expanding_win_rate"])
    out = out.merge(
        daily[["underlying_symbol", "date", "prior_session_win_rate_same_ticker"]],
        on=["underlying_symbol", "date"],
        how="left",
    )
    out = out.drop(columns=["_is_win"])
    return out


def add_label(df: pd.DataFrame, threshold_pct: float) -> pd.DataFrame:
    out = df.copy()
    out["win"] = (out["peak_ceiling_pct"] >= threshold_pct).astype("int8")
    return out


# ── Top-level pipelines ──────────────────────────────────────────────────────


def _summarize(df: pd.DataFrame, alert_type: AlertType, out_path: Path) -> BuildSummary:
    # rows_in == rows_out for v1: SQL filters peak_ceiling_pct IS NOT NULL
    # server-side so every loaded row is labeled. If the WHERE clause is ever
    # moved to Python, rows_in should reflect the pre-filter total.
    rows_labeled = int(df["peak_ceiling_pct"].notna().sum())
    win_rate = float(df["win"].mean()) if not df.empty else 0.0
    return BuildSummary(
        alert_type=alert_type,
        rows_in=len(df),
        rows_labeled=rows_labeled,
        rows_out=len(df),
        win_rate=win_rate,
        date_min=df["date"].min(),
        date_max=df["date"].max(),
        out_path=out_path,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("ml/data/takeit"),
        help="Output directory for training parquet files.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=WIN_LABEL_THRESHOLD_PCT,
        help="peak_ceiling_pct threshold for win=1 (default: %(default)s).",
    )
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    with _get_conn() as conn:
        # Pre-load both raw frames once so we can build cofire flags in either direction.
        lot_raw = load_lottery(conn)
        sb_raw = load_silentboom(conn)

    print(f"[takeit] loaded lottery={len(lot_raw)}, silentboom={len(sb_raw)} rows")

    lot = build_lottery_from_raw(lot_raw, sb_raw, args.threshold)
    sb = build_silentboom_from_raw(sb_raw, lot_raw, args.threshold)

    lot_path = args.out / "lottery_training.parquet"
    sb_path = args.out / "silentboom_training.parquet"
    lot.to_parquet(lot_path, index=False)
    sb.to_parquet(sb_path, index=False)

    for s in (_summarize(lot, "lottery", lot_path), _summarize(sb, "silentboom", sb_path)):
        print(
            f"[takeit] {s.alert_type:10s} rows={s.rows_out:>7d} "
            f"win_rate={s.win_rate:.3f} "
            f"date={s.date_min}->{s.date_max} out={s.out_path}"
        )


def build_lottery_from_raw(
    lot_raw: pd.DataFrame, sb_raw: pd.DataFrame, threshold_pct: float
) -> pd.DataFrame:
    """Public pipeline: lottery raw frame + silentboom raw frame -> labeled features.

    Both inputs must already have `fire_time` set (load_lottery/load_silentboom rename).
    """
    feat = derive_common_features(
        lot_raw, spot_col="spot_at_first", ask_pct_col="trigger_ask_pct"
    )
    feat = add_burst_storm(feat)
    feat = add_cofire_flag(feat, sb_raw, "silent_boom_cofire_within_5min")
    feat = add_cofire_diff_chain_flag(
        feat, sb_raw, "silent_boom_cofire_diff_chain_within_5min"
    )
    feat = add_sequential_features(feat)
    return add_label(feat, threshold_pct)


def build_silentboom_from_raw(
    sb_raw: pd.DataFrame, lot_raw: pd.DataFrame, threshold_pct: float
) -> pd.DataFrame:
    """Public pipeline: silentboom raw frame + lottery raw frame -> labeled features."""
    feat = derive_common_features(
        sb_raw, spot_col="underlying_price_at_spike", ask_pct_col="ask_pct"
    )
    feat = add_burst_storm(feat)
    feat = add_cofire_flag(feat, lot_raw, "lottery_cofire_within_5min")
    feat = add_cofire_diff_chain_flag(
        feat, lot_raw, "lottery_cofire_diff_chain_within_5min"
    )
    feat = add_sequential_features(feat)
    return add_label(feat, threshold_pct)


if __name__ == "__main__":
    main()
