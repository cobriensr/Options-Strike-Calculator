"""
Vega Spike EDA — Dir Vega Spike Monitor exploratory analysis.

Joins vega_spike_events with etf_candles_1m to compute forward returns
(since the enrichment cron has not populated them yet), then runs six
analytical questions:

  1. Distribution comparison vs control — Mann-Whitney U (EOD horizon)
  2. Directionality hit-rate — Binomial test + Wilson CIs (EOD horizon)
  3. Time-to-peak — fwd_5m / fwd_15m / fwd_30m / fwd_60m / EOD trace plot
  4. Magnitude effect — z_score vs |fwd_return_eod| Theil-Sen regression
  5. Time-of-day stratification — AM / midday / PM boxplots (EOD horizon)
  6. Confluence vs solo comparison (EOD horizon)

Primary horizon: EOD (end-of-day = market close at 16:00 ET / 20:00 UTC during EDT).
Intermediate horizons [5, 15, 30, 60] are retained for the time-to-peak
arc plot only.

Usage:
    set -a && source .env.local && set +a
    ml/.venv/bin/python ml/src/vega_spike_eda.py
"""

import os
import sys
import warnings
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import pandas as pd
import psycopg2
from scipy import stats
from scipy.stats import mannwhitneyu

# ── Paths ─────────────────────────────────────────────────────
ML_ROOT = Path(__file__).resolve().parent.parent
PLOTS_DIR = ML_ROOT / "plots"
PLOTS_DIR.mkdir(exist_ok=True)

# ── Plot style — match existing ml/ dark theme ────────────────
plt.rcParams.update(
    {
        "figure.facecolor": "#1a1a2e",
        "axes.facecolor": "#16213e",
        "axes.edgecolor": "#444466",
        "axes.labelcolor": "#ccccdd",
        "axes.titlecolor": "#e0e0f0",
        "xtick.color": "#aaaacc",
        "ytick.color": "#aaaacc",
        "text.color": "#ccccdd",
        "grid.color": "#2a2a4a",
        "grid.alpha": 0.5,
        "lines.linewidth": 1.5,
        "font.size": 11,
        "axes.titlesize": 13,
        "axes.labelsize": 11,
        "legend.facecolor": "#1a1a2e",
        "legend.edgecolor": "#444466",
        "legend.fontsize": 10,
        "figure.titlesize": 14,
    }
)

TICKER_COLORS = {"SPY": "#5bc8f5", "QQQ": "#f5a623"}
REGULAR_SESSION_START_UTC = 13 * 60 + 30  # 13:30 UTC = 9:30 ET
# EOD close = 16:00 ET = 20:00 UTC (but last 1-min bar is stamped at 19:59 UTC
# i.e. the bar that *opens* at 19:59 and closes at 20:00).  We use <= 20:00
# so the 19:59-stamped bar (close = 16:00 ET price) is included.
REGULAR_SESSION_END_UTC = 20 * 60   # 20:00 UTC = 16:00 ET


# ── DB connection ─────────────────────────────────────────────


def get_connection() -> psycopg2.extensions.connection:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not set. Run with 'set -a && source .env.local && set +a'")
        sys.exit(1)
    try:
        return psycopg2.connect(database_url, sslmode="require", connect_timeout=15)
    except psycopg2.OperationalError as e:
        print(f"Error: Could not connect to database: {e}")
        sys.exit(1)


# ── Data loading ──────────────────────────────────────────────


def load_spikes(conn: psycopg2.extensions.connection) -> pd.DataFrame:
    """Load all spike events from vega_spike_events."""
    query = """
        SELECT
            id, ticker, date, timestamp,
            dir_vega_flow::float AS dir_vega_flow,
            z_score::float AS z_score,
            vs_prior_max::float AS vs_prior_max,
            prior_max::float AS prior_max,
            baseline_mad::float AS baseline_mad,
            bars_elapsed,
            confluence,
            fwd_return_5m::float AS fwd_return_5m,
            fwd_return_15m::float AS fwd_return_15m,
            fwd_return_30m::float AS fwd_return_30m
        FROM vega_spike_events
        ORDER BY timestamp ASC
    """
    df = pd.read_sql_query(query, conn, parse_dates=["date", "timestamp"])
    # Ensure timezone-aware
    if df["timestamp"].dt.tz is None:
        df["timestamp"] = df["timestamp"].dt.tz_localize("UTC")
    return df


def load_candles(conn: psycopg2.extensions.connection) -> pd.DataFrame:
    """Load all etf_candles_1m rows; regular session filtering happens downstream."""
    query = """
        SELECT
            ticker,
            timestamp,
            open::float AS open,
            high::float AS high,
            low::float AS low,
            close::float AS close,
            volume
        FROM etf_candles_1m
        ORDER BY ticker, timestamp ASC
    """
    df = pd.read_sql_query(query, conn, parse_dates=["timestamp"])
    if df["timestamp"].dt.tz is None:
        df["timestamp"] = df["timestamp"].dt.tz_localize("UTC")
    return df


# ── Forward-return computation ────────────────────────────────


def _build_eod_close_map(candles: pd.DataFrame) -> dict[tuple, float]:
    """
    Build a (ticker, date) -> eod_close map.

    EOD close = close price of the last 1-min bar whose timestamp is
    STRICTLY < 20:00 UTC (= 16:00 ET market close) on that date.  Bars
    are stamped at the START of the minute, so the 19:59 UTC bar covers
    15:59:00-15:59:59 ET (last regular-session minute) and the 20:00
    UTC bar covers 16:00:00-16:00:59 ET (first minute of after-hours).
    Strict < ensures we pick the 19:59 bar even when AH bars are
    present in etf_candles_1m.

    Returns {} if candles is empty.
    """
    eod_map: dict[tuple, float] = {}
    # Regular session bars only (last bar is the 19:59 UTC bar)
    eod_cutoff_seconds = REGULAR_SESSION_END_UTC * 60  # 20:00:00 UTC in seconds
    reg = candles[
        (candles["timestamp"].dt.hour * 3600 + candles["timestamp"].dt.minute * 60 +
         candles["timestamp"].dt.second) < eod_cutoff_seconds
    ].copy()
    if reg.empty:
        return eod_map
    # Date in UTC (same calendar date as the ET session — any bar before 20:00 UTC
    # belongs to the same trading day)
    reg["_date"] = reg["timestamp"].dt.date
    # Last bar per (ticker, date)
    idx = reg.groupby(["ticker", "_date"])["timestamp"].idxmax()
    for _, row in reg.loc[idx].iterrows():
        key = (row["ticker"], row["_date"])
        eod_map[key] = float(row["close"])
    return eod_map


def compute_fwd_returns(
    spikes: pd.DataFrame,
    candles: pd.DataFrame,
    horizons_min: list[int] = (5, 15, 30),
) -> pd.DataFrame:
    """
    Compute fwd_return_Nm and fwd_return_eod for each spike event.

    Horizons computed: 5m, 15m, 30m, 60m, and EOD (end-of-day).

    For fixed-minute horizons: find the candle bar at (spike timestamp + N min).
    For EOD: use the last regular-session bar on the spike's date
             (timestamp <= 20:00 UTC = 16:00 ET).

    If the spike DB column is already non-null for 5/15/30, it is used
    as-is. 60m and EOD are always computed here (not stored in DB).

    Return = (close_at_horizon - close_at_spike) / close_at_spike.
    """
    # Index candles by (ticker, timestamp) for O(1) fixed-horizon lookup
    candle_index: dict[tuple, float] = {}
    for row in candles.itertuples(index=False):
        candle_index[(row.ticker, row.timestamp)] = row.close

    # EOD close map: (ticker, date) -> close at last regular-session bar
    eod_close_map = _build_eod_close_map(candles)

    all_horizons = [5, 15, 30, 60]

    rows = []
    for _, spike in spikes.iterrows():
        ticker = spike["ticker"]
        t0 = spike["timestamp"]

        # Find the close price at the spike bar
        base_close = candle_index.get((ticker, t0))
        if base_close is None:
            t0_min = t0.replace(second=0, microsecond=0)
            base_close = candle_index.get((ticker, t0_min))

        entry: dict = spike.to_dict()

        # Fixed-minute horizons
        for h in all_horizons:
            col = f"fwd_return_{h}m"
            # Use DB value if already populated (only 5/15/30 may be)
            existing = spike.get(col) if col in spike.index else None
            if existing is not None and pd.notna(existing):
                entry[col] = float(existing)
                continue
            if base_close is None or base_close == 0:
                entry[col] = np.nan
                continue
            t_target = t0 + pd.Timedelta(minutes=h)
            t_target_min = t_target.replace(second=0, microsecond=0)
            fwd_close = candle_index.get((ticker, t_target_min))
            if fwd_close is None:
                entry[col] = np.nan
            else:
                entry[col] = (fwd_close - base_close) / base_close

        # EOD horizon
        spike_date = t0.date()
        eod_close = eod_close_map.get((ticker, spike_date))
        if base_close is None or base_close == 0 or eod_close is None:
            entry["fwd_return_eod"] = np.nan
        else:
            entry["fwd_return_eod"] = (eod_close - base_close) / base_close

        rows.append(entry)

    return pd.DataFrame(rows)


def add_time_of_day(df: pd.DataFrame) -> pd.DataFrame:
    """Add minute-of-day (UTC) and session_period (AM/midday/PM) columns."""
    df = df.copy()
    df["minute_utc"] = df["timestamp"].dt.hour * 60 + df["timestamp"].dt.minute
    # ET = UTC - 4h (EDT). 9:30 ET = 13:30 UTC, 11:30 ET = 15:30 UTC, 13:30 ET = 17:30 UTC
    df["session_period"] = pd.cut(
        df["minute_utc"],
        bins=[0, 15 * 60 + 30, 17 * 60 + 30, 24 * 60],
        labels=["AM", "midday", "PM"],
        right=False,
    )
    return df


# ── Control sample builder ────────────────────────────────────


def build_control_samples(
    spikes: pd.DataFrame,
    candles: pd.DataFrame,
    n_control_per_spike: int = 20,
    tod_window_min: int = 30,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Build control sample of non-spike minutes matched on ticker + time-of-day.

    For each spike, draw up to n_control_per_spike candle bars from the same
    ticker where minute_of_day_UTC is within ±tod_window_min of the spike's
    minute_of_day_UTC, excluding the spike bars themselves and their ±30-min
    neighbourhood (to avoid contamination).

    Forward returns are computed for each control bar at both 15-min and EOD
    horizons. Primary horizon for distribution comparison is EOD.
    """
    rng = np.random.default_rng(seed)

    # Regular session candles only
    candles_reg = candles.copy()
    candles_reg["minute_utc"] = (
        candles_reg["timestamp"].dt.hour * 60 + candles_reg["timestamp"].dt.minute
    )
    candles_reg = candles_reg[
        (candles_reg["minute_utc"] >= REGULAR_SESSION_START_UTC)
        & (candles_reg["minute_utc"] < REGULAR_SESSION_END_UTC)
    ]

    # Build candle index for fwd-return lookup
    candle_index: dict[tuple, float] = {
        (r.ticker, r.timestamp): r.close
        for r in candles.itertuples(index=False)
    }

    # EOD close map for control EOD returns
    eod_close_map = _build_eod_close_map(candles)

    # Build set of spike timestamps per ticker (±30 min exclusion zone)
    spike_times_by_ticker: dict[str, set] = {}
    for _, row in spikes.iterrows():
        ticker = row["ticker"]
        t = row["timestamp"]
        if ticker not in spike_times_by_ticker:
            spike_times_by_ticker[ticker] = set()
        for delta in range(-30, 31):
            excl = t + pd.Timedelta(minutes=delta)
            excl_min = excl.replace(second=0, microsecond=0)
            spike_times_by_ticker[ticker].add(excl_min)

    control_rows = []
    for _, spike in spikes.iterrows():
        ticker = spike["ticker"]
        spike_tod = spike["minute_utc"] if "minute_utc" in spike.index else (
            spike["timestamp"].hour * 60 + spike["timestamp"].minute
        )
        exclusions = spike_times_by_ticker.get(ticker, set())

        # Candidate control bars
        candidates = candles_reg[
            (candles_reg["ticker"] == ticker)
            & (candles_reg["minute_utc"] >= spike_tod - tod_window_min)
            & (candles_reg["minute_utc"] <= spike_tod + tod_window_min)
        ].copy()

        # Exclude spike neighbourhood
        candidates = candidates[
            ~candidates["timestamp"].apply(
                lambda t, excl=exclusions: t.replace(second=0, microsecond=0) in excl
            )
        ]

        if len(candidates) == 0:
            continue

        n_draw = min(n_control_per_spike, len(candidates))
        sampled = candidates.sample(n=n_draw, random_state=int(rng.integers(1_000_000_000)))

        for _, cand in sampled.iterrows():
            t0 = cand["timestamp"].replace(second=0, microsecond=0)
            base_close = candle_index.get((ticker, t0))
            if base_close is None or base_close == 0:
                continue

            # 15m return (kept for backward compat with any residual refs)
            t15 = t0 + pd.Timedelta(minutes=15)
            fwd_close_15 = candle_index.get((ticker, t15))
            fwd_return_15m = (
                (fwd_close_15 - base_close) / base_close
                if fwd_close_15 is not None else np.nan
            )

            # EOD return
            cand_date = t0.date()
            eod_close = eod_close_map.get((ticker, cand_date))
            fwd_return_eod = (
                (eod_close - base_close) / base_close
                if eod_close is not None else np.nan
            )

            # Only append if EOD return is computable
            if np.isnan(fwd_return_eod):
                continue

            control_rows.append(
                {
                    "ticker": ticker,
                    "fwd_return_15m": fwd_return_15m,
                    "fwd_return_eod": fwd_return_eod,
                    "minute_utc": cand["minute_utc"],
                }
            )

    return pd.DataFrame(control_rows)


# ── Wilson CI helper ──────────────────────────────────────────


def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score confidence interval for a proportion."""
    if n == 0:
        return (0.0, 0.0)
    phat = k / n
    denom = 1 + z**2 / n
    centre = (phat + z**2 / (2 * n)) / denom
    margin = z * np.sqrt(phat * (1 - phat) / n + z**2 / (4 * n**2)) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


# ── Plot 1: Distribution comparison ──────────────────────────


def plot_distribution_comparison(
    spikes: pd.DataFrame,
    control: pd.DataFrame,
    out_path: Path,
) -> dict:
    """Overlaid histograms + KDE of fwd_return_eod, spike vs control."""
    spike_vals = spikes["fwd_return_eod"].dropna().values
    ctrl_vals = control["fwd_return_eod"].dropna().values

    if len(spike_vals) == 0:
        print("  WARNING: No spike fwd_return_eod values — skipping distribution plot")
        return {}
    if len(ctrl_vals) == 0:
        print("  WARNING: No control fwd_return_eod values — skipping distribution plot")
        return {}

    # Mann-Whitney U (two-sided: do spikes differ from control?)
    u_stat, p_mw = mannwhitneyu(spike_vals, ctrl_vals, alternative="two-sided")

    fig, ax = plt.subplots(figsize=(12, 7))
    fig.patch.set_facecolor("#1a1a2e")

    bins = np.linspace(
        min(spike_vals.min(), ctrl_vals.min()),
        max(spike_vals.max(), ctrl_vals.max()),
        40,
    )

    ax.hist(ctrl_vals, bins=bins, alpha=0.45, color="#888899", label=f"Control (n={len(ctrl_vals)})", density=True)
    ax.hist(spike_vals, bins=bins, alpha=0.65, color="#f5a623", label=f"Spike (n={len(spike_vals)})", density=True)

    # KDE overlay
    for vals, color in [(ctrl_vals, "#aaaacc"), (spike_vals, "#ffcc55")]:
        if len(vals) >= 4:
            kde = stats.gaussian_kde(vals)
            xs = np.linspace(vals.min(), vals.max(), 300)
            ax.plot(xs, kde(xs), color=color, lw=2)

    ax.axvline(0, color="#ffffff", lw=1, ls="--", alpha=0.4)
    ax.axvline(np.median(spike_vals), color="#f5a623", lw=1.5, ls=":", alpha=0.8,
               label=f"Spike median={np.median(spike_vals):.4f}")
    ax.axvline(np.median(ctrl_vals), color="#aaaacc", lw=1.5, ls=":", alpha=0.8,
               label=f"Control median={np.median(ctrl_vals):.4f}")

    p_str = f"{p_mw:.4f}" if p_mw >= 0.0001 else "<0.0001"
    ax.set_title(
        f"fwd_return_eod: Spike vs Control\nMann-Whitney U={u_stat:.0f}, p={p_str} (two-sided, n_spike={len(spike_vals)}, n_ctrl={len(ctrl_vals)})",
        pad=12,
    )
    ax.set_xlabel("EOD Forward Return (spike bar to 16:00 ET close)")
    ax.set_ylabel("Density")
    ax.xaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=2))
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path.name}")

    return {
        "n_spikes": int(len(spike_vals)),
        "n_control": int(len(ctrl_vals)),
        "spike_median_eod": float(np.median(spike_vals)),
        "control_median_eod": float(np.median(ctrl_vals)),
        "mw_u": float(u_stat),
        "mw_p": float(p_mw),
    }


# ── Plot 2: Directionality ────────────────────────────────────


def plot_directionality(spikes: pd.DataFrame, out_path: Path) -> dict:
    """Hit-rate of sign(fwd_return_eod) == sign(dir_vega_flow), with Wilson CIs."""
    df = spikes[spikes["fwd_return_eod"].notna() & spikes["dir_vega_flow"].notna()].copy()
    if len(df) == 0:
        print("  WARNING: No valid rows for directionality plot — skipping")
        return {}

    df["sign_flow"] = np.sign(df["dir_vega_flow"])
    df["sign_ret"] = np.sign(df["fwd_return_eod"])
    df["agree"] = df["sign_flow"] == df["sign_ret"]

    results = []
    for group_label, subset in [("SPY", df[df["ticker"] == "SPY"]),
                                  ("QQQ", df[df["ticker"] == "QQQ"]),
                                  ("Overall", df)]:
        n = len(subset)
        k = int(subset["agree"].sum())
        if n == 0:
            continue
        lo, hi = wilson_ci(k, n)
        p_binom = stats.binomtest(k, n, p=0.5, alternative="two-sided").pvalue
        results.append({
            "label": group_label,
            "n": n,
            "k": k,
            "rate": k / n,
            "ci_lo": lo,
            "ci_hi": hi,
            "p_binom": p_binom,
        })

    if not results:
        print("  WARNING: Empty directionality results — skipping")
        return {}

    fig, ax = plt.subplots(figsize=(10, 6))
    fig.patch.set_facecolor("#1a1a2e")

    labels = [r["label"] for r in results]
    rates = [r["rate"] for r in results]
    err_lo = [r["rate"] - r["ci_lo"] for r in results]
    err_hi = [r["ci_hi"] - r["rate"] for r in results]
    colors = ["#5bc8f5", "#f5a623", "#aaffaa"]

    bars = ax.bar(labels, rates, color=colors[:len(labels)], alpha=0.75, width=0.5)
    ax.errorbar(
        labels, rates,
        yerr=[err_lo, err_hi],
        fmt="none", color="#ffffff", capsize=6, lw=2, capthick=2,
    )
    ax.axhline(0.5, color="#ff6666", lw=1.5, ls="--", label="50% null")

    for bar, r in zip(bars, results):
        p_str = f"{r['p_binom']:.3f}" if r["p_binom"] >= 0.001 else "<0.001"
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + err_hi[results.index(r)] + 0.02,
            f"{r['k']}/{r['n']}\np={p_str}",
            ha="center", va="bottom", fontsize=9, color="#ccccdd",
        )

    ax.set_ylim(0, 1.05)
    ax.set_title("Directionality: sign(fwd_return_eod) == sign(dir_vega_flow)\n95% Wilson CIs, Binomial test vs 50% null")
    ax.set_ylabel("Hit Rate")
    ax.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0))
    ax.legend()
    ax.grid(True, axis="y", alpha=0.3)

    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path.name}")

    return {r["label"]: {
        "n": r["n"], "k": r["k"], "rate": round(r["rate"], 4),
        "ci_lo": round(r["ci_lo"], 4), "ci_hi": round(r["ci_hi"], 4),
        "p_binom": round(r["p_binom"], 4),
    } for r in results}


# ── Plot 3: Time-to-peak ──────────────────────────────────────


def plot_time_to_peak(spikes: pd.DataFrame, out_path: Path) -> dict:
    """All spike traces [5m, 15m, 30m, 60m, EOD] + median ribbon, faceted by sign.

    Uses a categorical x-axis with labels '5m / 15m / 30m / 60m / EOD'.
    The EOD point has variable elapsed-minutes per spike depending on
    when the spike occurred; the categorical axis makes the arc readable
    without distorting scale for early-session spikes.
    """
    horizon_cols = ["fwd_return_5m", "fwd_return_15m", "fwd_return_30m",
                    "fwd_return_60m", "fwd_return_eod"]
    horizon_labels = ["5m", "15m", "30m", "60m", "EOD"]
    x_positions = list(range(len(horizon_labels)))

    df = spikes.copy()
    df["spike_sign"] = np.sign(df["dir_vega_flow"])
    df_pos = df[df["spike_sign"] > 0].dropna(subset=horizon_cols, how="all")
    df_neg = df[df["spike_sign"] < 0].dropna(subset=horizon_cols, how="all")

    if len(df_pos) == 0 and len(df_neg) == 0:
        print("  WARNING: No data for time-to-peak plot — skipping")
        return {}

    fig, axes = plt.subplots(1, 2, figsize=(14, 7), sharey=True)
    fig.patch.set_facecolor("#1a1a2e")

    stats_out = {}
    for ax, subset, sign_label, base_color in [
        (axes[0], df_pos, "Positive spikes (dir_vega_flow > 0)", "#5bc8f5"),
        (axes[1], df_neg, "Negative spikes (dir_vega_flow < 0)", "#f5a623"),
    ]:
        n = len(subset)
        ax.set_title(f"{sign_label}\n(n={n})")
        if n == 0:
            ax.text(0.5, 0.5, "No data", ha="center", va="center", transform=ax.transAxes)
            continue

        # Individual traces
        for _, row in subset.iterrows():
            ys = [row.get(c, np.nan) for c in horizon_cols]
            if any(pd.notna(y) for y in ys):
                ax.plot(x_positions, ys, color=base_color, alpha=0.2, lw=1)

        # Median + IQR ribbon
        medians = [float(subset[c].median()) for c in horizon_cols]
        q25s = [float(subset[c].quantile(0.25)) for c in horizon_cols]
        q75s = [float(subset[c].quantile(0.75)) for c in horizon_cols]

        ax.plot(x_positions, medians, color=base_color, lw=2.5, zorder=5, label="Median")
        ax.fill_between(x_positions, q25s, q75s, color=base_color, alpha=0.25, label="IQR")
        ax.axhline(0, color="#ffffff", lw=1, ls="--", alpha=0.4)

        ax.set_xlabel("Horizon")
        ax.set_ylabel("Forward Return")
        ax.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=2))
        ax.set_xticks(x_positions)
        ax.set_xticklabels(horizon_labels)
        ax.legend()
        ax.grid(True, alpha=0.3)

        sign_key = "positive" if "Positive" in sign_label else "negative"
        # Count spikes with EOD return
        n_eod = int(subset["fwd_return_eod"].notna().sum())
        stats_out[sign_key] = {
            "n": n,
            "n_eod": n_eod,
            "median_5m": round(medians[0], 5),
            "median_15m": round(medians[1], 5),
            "median_30m": round(medians[2], 5),
            "median_60m": round(medians[3], 5),
            "median_eod": round(medians[4], 5),
        }

    fig.suptitle("Time-to-peak: Forward returns at 5m / 15m / 30m / 60m / EOD horizons", y=1.01)
    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path.name}")
    return stats_out


# ── Plot 4: Magnitude scatter ─────────────────────────────────


def plot_magnitude_scatter(spikes: pd.DataFrame, out_path: Path) -> dict:
    """z_score vs |fwd_return_eod| scatter + Theil-Sen regression."""
    df = spikes[spikes["fwd_return_eod"].notna() & spikes["z_score"].notna()].copy()
    if len(df) < 4:
        print("  WARNING: Not enough data for magnitude scatter — skipping")
        return {}

    df["abs_ret_eod"] = df["fwd_return_eod"].abs()

    fig, ax = plt.subplots(figsize=(12, 8))
    fig.patch.set_facecolor("#1a1a2e")

    for ticker, color in TICKER_COLORS.items():
        sub = df[df["ticker"] == ticker]
        if len(sub) > 0:
            ax.scatter(sub["z_score"], sub["abs_ret_eod"],
                       color=color, alpha=0.8, s=60, label=ticker, zorder=4)

    # Theil-Sen regression
    x_all = df["z_score"].values
    y_all = df["abs_ret_eod"].values

    # NaN-safe filter
    valid = np.isfinite(x_all) & np.isfinite(y_all)
    x_v, y_v = x_all[valid], y_all[valid]

    if len(x_v) >= 4:
        ts_result = stats.theilslopes(y_v, x_v)
        slope, intercept = ts_result.slope, ts_result.intercept
        # 95% CI on slope
        slope_lo, slope_hi = ts_result.low_slope, ts_result.high_slope

        x_line = np.linspace(x_v.min(), x_v.max(), 200)
        y_line = slope * x_line + intercept
        y_lo = slope_lo * x_line + intercept
        y_hi = slope_hi * x_line + intercept

        ax.plot(x_line, y_line, color="#aaffaa", lw=2, label=f"Theil-Sen: slope={slope:.6f}")
        ax.fill_between(x_line, y_lo, y_hi, color="#aaffaa", alpha=0.15, label="95% CI slope")

        # Pearson r for annotation
        if len(x_v) >= 3:
            r, p_r = stats.pearsonr(x_v, y_v)
            p_str = f"{p_r:.4f}" if p_r >= 0.0001 else "<0.0001"
            ax.text(
                0.97, 0.05,
                f"Pearson r={r:.3f}, p={p_str}\nn={len(x_v)}",
                transform=ax.transAxes, ha="right", va="bottom",
                fontsize=10, color="#ccccdd",
                bbox={"facecolor": "#1a1a2e", "edgecolor": "#444466", "alpha": 0.8},
            )
        ts_stats = {
            "slope": float(slope),
            "intercept": float(intercept),
            "slope_ci": [float(slope_lo), float(slope_hi)],
            "n": int(len(x_v)),
        }
    else:
        ts_stats = {}

    ax.set_title("z_score vs |fwd_return_eod| — Theil-Sen regression")
    ax.set_xlabel("Z-score (spike magnitude)")
    ax.set_ylabel("|EOD Forward Return|")
    ax.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=3))
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path.name}")
    return ts_stats


# ── Plot 5: Time-of-day stratification ───────────────────────


def plot_tod_stratification(spikes: pd.DataFrame, out_path: Path) -> dict:
    """Boxplots of fwd_return_eod by AM/midday/PM, separated by spike sign."""
    df = spikes[spikes["fwd_return_eod"].notna()].copy()
    if len(df) == 0:
        print("  WARNING: No data for ToD stratification — skipping")
        return {}

    df["spike_sign"] = df["dir_vega_flow"].apply(lambda v: "Positive" if v > 0 else "Negative")
    periods = ["AM", "midday", "PM"]

    fig, axes = plt.subplots(1, 2, figsize=(14, 7), sharey=True)
    fig.patch.set_facecolor("#1a1a2e")

    stats_out = {}
    for ax, sign_label, color in [
        (axes[0], "Positive", "#5bc8f5"),
        (axes[1], "Negative", "#f5a623"),
    ]:
        subset = df[df["spike_sign"] == sign_label]
        ax.set_title(f"{sign_label} spikes by time-of-day\n(n={len(subset)})")

        data_for_box = []
        labels_for_box = []
        ns = []
        for period in periods:
            pdata = subset[subset["session_period"] == period]["fwd_return_eod"].dropna()
            if len(pdata) == 0:
                print(f"  WARNING: No spikes in {period} period for {sign_label} — stratum skipped")
                continue
            data_for_box.append(pdata.values)
            labels_for_box.append(f"{period}\n(n={len(pdata)})")
            ns.append(len(pdata))

        if not data_for_box:
            ax.text(0.5, 0.5, "No data", ha="center", va="center", transform=ax.transAxes)
            continue

        ax.boxplot(
            data_for_box,
            tick_labels=labels_for_box,
            patch_artist=True,
            medianprops={"color": "#ffffff", "lw": 2},
            boxprops={"facecolor": color, "alpha": 0.4},
            whiskerprops={"color": "#aaaacc"},
            capprops={"color": "#aaaacc"},
            flierprops={"marker": "o", "color": color, "alpha": 0.5, "markersize": 4},
        )

        ax.axhline(0, color="#ff6666", lw=1, ls="--", alpha=0.5)
        ax.set_ylabel("EOD Forward Return")
        ax.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=2))
        ax.grid(True, axis="y", alpha=0.3)

        period_stats = {}
        for label, data_vals in zip(labels_for_box, data_for_box):
            period_name = label.split("\n")[0]
            period_stats[period_name] = {
                "n": len(data_vals),
                "median": round(float(np.median(data_vals)), 5),
                "mean": round(float(np.mean(data_vals)), 5),
            }
        stats_out[sign_label.lower()] = period_stats

    fig.suptitle("fwd_return_eod by time-of-day period (9:30-11:30 / 11:30-13:30 / 13:30-close ET)", y=1.01)
    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path.name}")
    return stats_out


# ── Plot 6: Confluence vs solo ────────────────────────────────


def plot_confluence_vs_solo(spikes: pd.DataFrame, out_path: Path) -> dict:
    """Comparison of fwd_return_eod for confluence vs solo spikes."""
    df = spikes[spikes["fwd_return_eod"].notna()].copy()
    if len(df) == 0:
        print("  WARNING: No data for confluence plot — skipping")
        return {}

    conf_df = df[df["confluence"] == True]
    solo_df = df[df["confluence"] == False]

    n_conf = len(conf_df)
    n_solo = len(solo_df)

    fig, axes = plt.subplots(1, 2, figsize=(14, 7))
    fig.patch.set_facecolor("#1a1a2e")

    # Left: boxplot comparison
    ax1 = axes[0]
    data_groups = []
    xlabels = []
    if n_conf > 0:
        data_groups.append(conf_df["fwd_return_eod"].values)
        xlabels.append(f"Confluence\n(n={n_conf})")
    if n_solo > 0:
        data_groups.append(solo_df["fwd_return_eod"].values)
        xlabels.append(f"Solo\n(n={n_solo})")

    ax1.boxplot(
        data_groups,
        tick_labels=xlabels,
        patch_artist=True,
        medianprops={"color": "#ffffff", "lw": 2},
        boxprops={"facecolor": "#aaffaa", "alpha": 0.4},
        whiskerprops={"color": "#aaaacc"},
        capprops={"color": "#aaaacc"},
        flierprops={"marker": "o", "color": "#aaffaa", "alpha": 0.5, "markersize": 5},
    )
    ax1.axhline(0, color="#ff6666", lw=1, ls="--", alpha=0.5)
    ax1.set_title(f"fwd_return_eod: Confluence vs Solo\n(WARNING: n_confluence={n_conf} — eyeball only)")
    ax1.set_ylabel("EOD Forward Return")
    ax1.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=2))
    ax1.grid(True, axis="y", alpha=0.3)

    # Right: scatter by z_score coloured by confluence
    ax2 = axes[1]
    if n_solo > 0:
        ax2.scatter(solo_df["z_score"], solo_df["fwd_return_eod"].abs(),
                    color="#5bc8f5", alpha=0.7, s=50, label=f"Solo (n={n_solo})", zorder=3)
    if n_conf > 0:
        ax2.scatter(conf_df["z_score"], conf_df["fwd_return_eod"].abs(),
                    color="#ffcc00", alpha=0.9, s=120, marker="*",
                    label=f"Confluence (n={n_conf})", zorder=5)
    ax2.set_title("z_score vs |fwd_return_eod| by confluence")
    ax2.set_xlabel("Z-score")
    ax2.set_ylabel("|EOD Forward Return|")
    ax2.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1.0, decimals=3))
    ax2.legend()
    ax2.grid(True, alpha=0.3)

    fig.suptitle("Confluence (n=2) vs Solo (n=36) — exploratory only, not statistically testable", y=1.01)
    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {out_path.name}")

    stats_out: dict = {"n_confluence": n_conf, "n_solo": n_solo}
    if n_conf > 0:
        stats_out["confluence_median_eod"] = round(float(conf_df["fwd_return_eod"].median()), 5)
        stats_out["confluence_mean_eod"] = round(float(conf_df["fwd_return_eod"].mean()), 5)
    if n_solo > 0:
        stats_out["solo_median_eod"] = round(float(solo_df["fwd_return_eod"].median()), 5)
        stats_out["solo_mean_eod"] = round(float(solo_df["fwd_return_eod"].mean()), 5)
    return stats_out


# ── Findings markdown ─────────────────────────────────────────


def write_findings_md(
    dist_stats: dict,
    dir_stats: dict,
    peak_stats: dict,
    mag_stats: dict,
    tod_stats: dict,
    conf_stats: dict,
    n_total: int,
    n_with_fwd_15m: int,
    n_with_fwd_eod: int,
    median_mins_to_close: float,
    out_path: Path,
) -> None:
    """Write a concise findings summary to ml/plots/vega-spike-findings.md."""

    def fmt_pct(v: float) -> str:
        return f"{v * 100:.3f}%"

    lines = [
        "# Vega Spike EDA Findings",
        "",
        f"**Sample**: {n_total} total spike events.",
        f"- {n_with_fwd_15m} with computable 15m forward return (for reference).",
        f"- {n_with_fwd_eod} with computable EOD forward return (primary horizon — requires a close bar at 16:00 ET on the spike's date).",
        "",
        "> **Primary horizon changed to EOD (end-of-day / 16:00 ET close)** from the prior 15-minute horizon.",
        "> This captures the full directional arc rather than just the first 15 minutes of follow-through.",
        "",
        "> **Variable time window caveat**: The EOD horizon is NOT a fixed-duration return.",
        f"> A spike at 09:35 ET has ~6h 25min to close; a spike at 15:30 ET has only 30 min.",
        f"> Median time-to-close for EOD-computable spikes: **{median_mins_to_close:.0f} minutes** ({median_mins_to_close / 60:.1f}h).",
        "> Interpret EOD returns as 'how did the day end given this spike' rather than 'X-minute momentum'.",
        "> A future analysis stratified by time-to-close would more cleanly isolate the effect.",
        "",
        "> NOTE: 38 events is exploratory, not conclusive. All p-values and CIs should be treated "
        "as directional indicators only. The sample is too small for reliable inference.",
        "",
    ]

    # Plot 1
    lines += [
        "## 1. Distribution Comparison (spike vs control, EOD horizon)",
        "",
    ]
    if dist_stats:
        p_mw = dist_stats.get("mw_p", float("nan"))
        p_str = f"{p_mw:.4f}" if p_mw >= 0.0001 else "<0.0001"
        spike_med = dist_stats.get("spike_median_eod", float("nan"))
        ctrl_med = dist_stats.get("control_median_eod", float("nan"))
        lines += [
            f"Spike fwd_return_eod median: **{fmt_pct(spike_med)}**, "
            f"Control median: **{fmt_pct(ctrl_med)}**. "
            f"Mann-Whitney U={dist_stats.get('mw_u', 'N/A'):.0f}, p={p_str} (two-sided). "
            f"n_spike={dist_stats.get('n_spikes', 0)}, n_control={dist_stats.get('n_control', 0)}. "
            "A p-value below 0.05 would indicate the spike EOD return distribution is meaningfully "
            "different from random same-ticker, same-time-of-day baseline minutes.",
            "",
        ]
    else:
        lines += ["Insufficient data to compute.", ""]

    # Plot 2
    lines += [
        "## 2. Directionality (EOD horizon)",
        "",
    ]
    if dir_stats:
        ov = dir_stats.get("Overall", {})
        if ov:
            n, k = ov.get("n", 0), ov.get("k", 0)
            rate = ov.get("rate", float("nan"))
            lo, hi = ov.get("ci_lo", float("nan")), ov.get("ci_hi", float("nan"))
            p = ov.get("p_binom", float("nan"))
            p_str = f"{p:.4f}" if p >= 0.0001 else "<0.0001"
            lines += [
                f"Overall hit rate: **{k}/{n} = {rate * 100:.1f}%**, "
                f"95% Wilson CI [{lo * 100:.1f}%, {hi * 100:.1f}%], "
                f"binomial p={p_str} vs 50% null. "
                "Hit rate > 50% means spikes correctly predict the EOD price direction "
                "(whether the close is higher/lower than the spike bar). "
                "A CI entirely above 50% would be a tradeable directional signal.",
                "",
            ]
        for ticker in ["SPY", "QQQ"]:
            t = dir_stats.get(ticker, {})
            if t:
                p_str = f"{t.get('p_binom', float('nan')):.3f}"
                lines.append(
                    f"  - {ticker}: {t.get('k', 0)}/{t.get('n', 0)} = {t.get('rate', 0) * 100:.1f}%"
                    f", CI [{t.get('ci_lo', 0) * 100:.1f}%, {t.get('ci_hi', 0) * 100:.1f}%], p={p_str}"
                )
        lines.append("")
    else:
        lines += ["Insufficient data to compute.", ""]

    # Plot 3
    lines += [
        "## 3. Time-to-peak (arc across 5m / 15m / 30m / 60m / EOD)",
        "",
    ]
    if peak_stats:
        for sign_key in ["positive", "negative"]:
            ps = peak_stats.get(sign_key, {})
            if ps:
                lines.append(
                    f"**{sign_key.capitalize()} spikes** (n={ps.get('n', 0)}, n_eod={ps.get('n_eod', 0)}): "
                    f"median fwd_5m={fmt_pct(ps.get('median_5m', 0))}, "
                    f"fwd_15m={fmt_pct(ps.get('median_15m', 0))}, "
                    f"fwd_30m={fmt_pct(ps.get('median_30m', 0))}, "
                    f"fwd_60m={fmt_pct(ps.get('median_60m', 0))}, "
                    f"fwd_eod={fmt_pct(ps.get('median_eod', 0))}."
                )
        lines += [
            "",
            "If returns compound monotonically (5m → EOD growing in absolute terms), "
            "the spike effect persists and strengthens through the session. "
            "If EOD < 30m in absolute terms, there is intraday mean reversion.",
            "",
        ]
    else:
        lines += ["Insufficient data to compute.", ""]

    # Plot 4
    lines += [
        "## 4. Magnitude Effect (z_score vs |fwd_return_eod|)",
        "",
    ]
    if mag_stats:
        slope = mag_stats.get("slope", float("nan"))
        ci = mag_stats.get("slope_ci", [float("nan"), float("nan")])
        n = mag_stats.get("n", 0)
        lines += [
            f"Theil-Sen slope: **{slope:.7f}** per unit z-score "
            f"(95% CI [{ci[0]:.7f}, {ci[1]:.7f}]), n={n}. "
            "A positive slope means larger z-scores are associated with larger absolute EOD forward returns; "
            "a CI excluding 0 would confirm the relationship is robust.",
            "",
        ]
    else:
        lines += ["Insufficient data to compute.", ""]

    # Plot 5
    lines += [
        "## 5. Time-of-Day Stratification (EOD horizon)",
        "",
    ]
    if tod_stats:
        for sign_key in ["positive", "negative"]:
            ps = tod_stats.get(sign_key, {})
            if ps:
                parts = []
                for period in ["AM", "midday", "PM"]:
                    pdata = ps.get(period)
                    if pdata:
                        parts.append(f"{period} n={pdata['n']}, median={fmt_pct(pdata['median'])}")
                if parts:
                    lines.append(f"**{sign_key.capitalize()} spikes**: {'; '.join(parts)}.")
        lines += [
            "",
            "AM spikes (9:30-11:30 ET) have the most time remaining to EOD — their EOD return "
            "captures the full day's resolution. PM spikes (after 13:30 ET) have at most 2.5 hours "
            "to close and may show muted EOD magnitude. Time-to-close differences between strata "
            "complicate direct comparison.",
            "",
        ]
    else:
        lines += ["Insufficient data to compute.", ""]

    # Plot 6
    lines += [
        "## 6. Confluence vs Solo (EOD horizon)",
        "",
    ]
    if conf_stats:
        n_c = conf_stats.get("n_confluence", 0)
        n_s = conf_stats.get("n_solo", 0)
        c_med = conf_stats.get("confluence_median_eod")
        s_med = conf_stats.get("solo_median_eod")
        lines += [
            f"Confluence events: n={n_c}. Solo events: n={n_s}. "
            + (f"Confluence median EOD return: {fmt_pct(c_med)}. " if c_med is not None else "")
            + (f"Solo median EOD return: {fmt_pct(s_med)}. " if s_med is not None else "")
            + "With only 2 confluence events, statistical testing is not meaningful — "
            "treat as an observation for future data collection.",
            "",
        ]
    else:
        lines += ["Insufficient data to compute.", ""]

    # Caveats
    lines += [
        "## Caveats",
        "",
        f"- Total spike events: {n_total}.",
        f"- Events with computable 15m fwd return: {n_with_fwd_15m} (reference only).",
        f"- Events with computable EOD fwd return: {n_with_fwd_eod} (primary horizon).",
        f"  Spikes on dates where etf_candles_1m has no bar at or before 20:00 UTC are excluded.",
        "- The QQQ spike on 2026-03-17 predates candle coverage (candles start 2026-03-18) "
        "and produces NaN — correctly excluded.",
        "- EOD horizon is VARIABLE: a spike at 09:35 ET has ~390 min to close; "
        "a spike at 15:55 ET has only ~5 min. This heterogeneity is inherent to the EOD measure.",
        "- This analysis is exploratory. The 4-gate algorithm was calibrated on this same data; "
        "independent out-of-sample validation is required before drawing trading conclusions.",
        "- All forward returns are computed from 1-minute close prices. Slippage and bid-ask "
        "spread are not modelled.",
        "",
        "**Generated by** `ml/src/vega_spike_eda.py`",
    ]

    out_path.write_text("\n".join(lines))
    print(f"  Saved: {out_path.name}")


# ── Main ──────────────────────────────────────────────────────


def main() -> None:
    print("Vega Spike EDA")
    print("=" * 60)

    print("\nConnecting to database ...")
    conn = get_connection()

    print("Loading spike events ...")
    spikes_raw = load_spikes(conn)
    print(f"  {len(spikes_raw)} total spike events")
    print(f"  SPY: {(spikes_raw['ticker'] == 'SPY').sum()}, QQQ: {(spikes_raw['ticker'] == 'QQQ').sum()}")
    print(f"  Confluence: {spikes_raw['confluence'].sum()}")

    print("Loading candles ...")
    candles = load_candles(conn)
    print(f"  {len(candles)} candle bars (SPY + QQQ)")
    conn.close()

    print("Computing forward returns from candles ...")
    spikes = compute_fwd_returns(spikes_raw, candles)

    # Add time-of-day info
    spikes = add_time_of_day(spikes)

    n_with_fwd_15m = int(spikes["fwd_return_15m"].notna().sum())
    n_with_fwd_eod = int(spikes["fwd_return_eod"].notna().sum())
    print(f"  Spikes with fwd_return_15m: {n_with_fwd_15m}/{len(spikes)}")
    print(f"  Spikes with fwd_return_eod: {n_with_fwd_eod}/{len(spikes)}")

    if n_with_fwd_eod == 0:
        print("\nERROR: No spikes have computable EOD forward returns. Check candle coverage.")
        sys.exit(1)

    # Compute median time-to-close for EOD-valid spikes
    eod_valid = spikes[spikes["fwd_return_eod"].notna()].copy()
    # Market close = 20:00 UTC = 1200 minutes from midnight
    eod_close_minute_utc = 20 * 60
    mins_to_close = eod_close_minute_utc - eod_valid["minute_utc"]
    # Clip negatives (shouldn't exist since EOD is computable, but be safe)
    mins_to_close = mins_to_close.clip(lower=0)
    median_mins_to_close = float(mins_to_close.median())
    print(f"  Median time-to-close for EOD-valid spikes: {median_mins_to_close:.0f} min ({median_mins_to_close / 60:.1f}h)")

    spikes_valid = eod_valid  # Use EOD-valid set as the primary analysis frame

    print("\nBuilding control samples ...")
    control = build_control_samples(spikes_valid, candles)
    print(f"  {len(control)} control observations")

    print("\nGenerating plots ...")

    # 1. Distribution comparison
    dist_stats = plot_distribution_comparison(
        spikes_valid, control,
        PLOTS_DIR / "vega-spike-distribution-comparison.png",
    )

    # 2. Directionality
    dir_stats = plot_directionality(
        spikes_valid,
        PLOTS_DIR / "vega-spike-directionality.png",
    )

    # 3. Time-to-peak (use all spikes — dropna(how='all') handles missing horizons)
    peak_stats = plot_time_to_peak(
        spikes,
        PLOTS_DIR / "vega-spike-time-to-peak.png",
    )

    # 4. Magnitude scatter
    mag_stats = plot_magnitude_scatter(
        spikes_valid,
        PLOTS_DIR / "vega-spike-magnitude-scatter.png",
    )

    # 5. ToD stratification
    tod_stats = plot_tod_stratification(
        spikes_valid,
        PLOTS_DIR / "vega-spike-tod-stratification.png",
    )

    # 6. Confluence vs solo
    conf_stats = plot_confluence_vs_solo(
        spikes_valid,
        PLOTS_DIR / "vega-spike-confluence-vs-solo.png",
    )

    # Findings markdown
    print("\nWriting findings ...")
    write_findings_md(
        dist_stats=dist_stats,
        dir_stats=dir_stats,
        peak_stats=peak_stats,
        mag_stats=mag_stats,
        tod_stats=tod_stats,
        conf_stats=conf_stats,
        n_total=len(spikes_raw),
        n_with_fwd_15m=n_with_fwd_15m,
        n_with_fwd_eod=n_with_fwd_eod,
        median_mins_to_close=median_mins_to_close,
        out_path=PLOTS_DIR / "vega-spike-findings.md",
    )

    # Print summary to console
    print("\nKey findings:")
    if dir_stats.get("Overall"):
        ov = dir_stats["Overall"]
        print(
            f"  EOD hit rate: {ov['k']}/{ov['n']} = {ov['rate'] * 100:.1f}%, "
            f"95% CI [{ov['ci_lo'] * 100:.1f}%, {ov['ci_hi'] * 100:.1f}%], "
            f"p={ov['p_binom']:.4f}"
        )
    if dist_stats:
        p_str = f"{dist_stats['mw_p']:.4f}" if dist_stats["mw_p"] >= 0.0001 else "<0.0001"
        print(
            f"  Mann-Whitney p={p_str}: "
            + ("distributional difference detected" if dist_stats["mw_p"] < 0.05 else "no significant distributional difference")
        )
    print()
    print("Done.")


if __name__ == "__main__":
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=FutureWarning)
        warnings.filterwarnings("ignore", category=UserWarning)
        main()
