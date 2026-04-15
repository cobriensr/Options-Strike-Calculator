"""
MOC Imbalance — Phase 7: 0DTE directional options simulation

Our QQQ underlying analysis showed weak directional signals (~52-54% hit
rate on both MOC and MOO). For a SHARES trader, that's noise. For a 0DTE
options trader, it's not obviously noise — convexity can turn a 52%
directional edge into +EV because long OTM options have asymmetric
payoffs (small loss cap, large upside).

This phase simulates actual 0DTE option P&L for four strategies:

  A. MOC-directional: at 15:50 ET, long ATM call if MOC_signed_imbalance > 0,
     long ATM put if < 0, skip if 0. Hold to close.
  B. MOC-random (control): same window but random direction. Should give
     negative expected P&L equal to straddle-bleed (theta + IV).
  C. MOO-directional: at 9:30 ET, long ATM call if MOO > 0 else put.
     Hold to close (6.5 hour window).
  D. MOO-random (control).

Pricing: Black-Scholes ATM approximation ~= 0.4 * sigma * S * sqrt(T)
for call or put individually. Sigma derived from VIX (annualized).

Payoff: intrinsic at close (0DTE cash-settled).

The critical test: does the DIRECTIONAL strategy (A or C) systematically
beat the RANDOM control (B or D) by more than bid-ask would eat? If
directional mean_pnl - random mean_pnl > 2-3 bps (typical round-trip
friction on SPX 0DTE), there's a real edge.

Uses QQQ as SPX proxy (correlation > 0.95 intraday on short windows).
Results in bps translate 1:1 to SPX since the simulation is
percent-of-underlying throughout.

Usage:
    ml/.venv/bin/python ml/src/moc_options_sim.py
"""

import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install matplotlib seaborn pandas numpy")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


ET = "US/Eastern"
PLOTS_DIR = ML_ROOT / "plots" / "moc"
MOC_FEATURES = ML_ROOT / "data" / "moc_features_qqq.parquet"
MOO_FEATURES = ML_ROOT / "data" / "moo_features_qqq.parquet"
VIX_CACHE = ML_ROOT / "data" / "vix_daily.parquet"

TRADING_DAYS_PER_YEAR = 252
SESSION_MINUTES = 390  # 6.5h
# BS ATM call OR put approximation — each leg of a straddle is half:
# straddle ~= sqrt(2/pi) * sigma * S * sqrt(T)
# one_side  ~= 0.5 * straddle ~= 0.399 * sigma * S * sqrt(T)
ATM_ONE_SIDE_FACTOR = np.sqrt(2 / np.pi) / 2

VIX_BUCKETS = [
    ("Calm (<15)", 0, 15),
    ("Normal (15-20)", 15, 20),
    ("Elevated (20-30)", 20, 30),
    ("Stress (>30)", 30, 200),
]

sns.set_theme(style="darkgrid", context="notebook")
plt.rcParams.update({"figure.dpi": 110, "savefig.dpi": 140})


# ── Data loading ─────────────────────────────────────────────


def load_data() -> pd.DataFrame:
    """
    Build a per-day row with everything we need:
      - moc_signed_imbalance (from moc_features)
      - moo_signed_imbalance (from moo_features)
      - spot_at_T50, close_at_T60 (for MOC P&L, already computed)
      - day_open, day_close (for MOO P&L, already in moo_features as
        day_open / day_close)
      - vix_close
    """
    for path in (MOC_FEATURES, MOO_FEATURES, VIX_CACHE):
        if not path.exists():
            print(f"ERROR: {path} missing. Run prior phases first.")
            sys.exit(1)

    moc = pd.read_parquet(MOC_FEATURES)[
        ["T50_signed_imbalance", "spot_at_T50", "close_at_T60"]
    ].rename(columns={"T50_signed_imbalance": "moc_signed_imbalance"})

    moo = pd.read_parquet(MOO_FEATURES)[
        ["moo_signed_imbalance", "day_open", "day_close"]
    ]

    vix = pd.read_parquet(VIX_CACHE)

    for df in (moc, moo, vix):
        df.index = pd.to_datetime(df.index).tz_localize(None)

    joined = moc.join(moo, how="inner").join(vix, how="left").dropna()

    # VIX bucket for regime splits.
    labels = []
    for v in joined["vix_close"]:
        for label, lo, hi in VIX_BUCKETS:
            if lo <= v < hi:
                labels.append(label)
                break
        else:
            labels.append("Stress (>30)")
    joined["vix_bucket"] = pd.Categorical(
        labels,
        categories=[b[0] for b in VIX_BUCKETS],
        ordered=True,
    )
    print(f"  {len(joined):,} days with MOC + MOO + VIX")
    return joined


# ── Options pricing ──────────────────────────────────────────


def atm_one_side_price_bps(
    vix: float, window_minutes: float, spot: float
) -> float:
    """
    Price of a single 0DTE ATM call OR put in basis points of spot.
    Black-Scholes ATM approximation at short T. Strike = spot.
    """
    del spot  # unused — we return bps so cancels
    sigma_annual = vix / 100.0
    T = window_minutes / (TRADING_DAYS_PER_YEAR * SESSION_MINUTES)
    return ATM_ONE_SIDE_FACTOR * sigma_annual * np.sqrt(T) * 10_000


def directional_pnl_bps(
    direction: int,
    spot_entry: float,
    spot_exit: float,
    vix: float,
    window_minutes: float,
) -> float:
    """
    P&L of a long ATM call (direction=+1) or put (direction=-1) held from
    entry to exit. Strike = spot_entry (truly ATM).

    Cost: BS ATM approximation using VIX as IV.
    Payoff: intrinsic at exit = max(0, direction * (spot_exit - spot_entry))
    Result in bps of spot_entry.
    """
    if direction == 0 or spot_entry <= 0:
        return np.nan
    cost_bps = atm_one_side_price_bps(vix, window_minutes, spot_entry)
    move_bps = (spot_exit - spot_entry) / spot_entry * 10_000
    payoff_bps = max(0.0, direction * move_bps)
    return payoff_bps - cost_bps


# ── Strategy simulation ──────────────────────────────────────


def simulate_strategy(
    frame: pd.DataFrame,
    signal_col: str,
    entry_col: str,
    exit_col: str,
    window_minutes: float,
    label: str,
    rng_seed: int | None = None,
) -> pd.DataFrame:
    """
    Walk each day. If signal sign is non-zero, go long a 0DTE call (sign=+1)
    or put (sign=-1), price via BS, payoff at exit. If rng_seed provided,
    override signal with random ±1 direction (the "random direction" control).
    """
    rng = np.random.default_rng(rng_seed) if rng_seed is not None else None
    rows = []
    for ts, r in frame.iterrows():
        if rng is not None:
            direction = 1 if rng.random() < 0.5 else -1
        else:
            sign = np.sign(r[signal_col])
            if sign == 0:
                continue
            direction = int(sign)
        pnl = directional_pnl_bps(
            direction,
            r[entry_col],
            r[exit_col],
            r["vix_close"],
            window_minutes,
        )
        if not np.isfinite(pnl):
            continue
        rows.append(
            {
                "date": ts,
                "strategy": label,
                "direction": direction,
                "pnl_bps": pnl,
                "vix_bucket": r["vix_bucket"],
                "vix_close": r["vix_close"],
            }
        )
    return pd.DataFrame(rows)


# ── Analyses ─────────────────────────────────────────────────


def summary(trades: pd.DataFrame) -> pd.DataFrame:
    summary = (
        trades.groupby("strategy", observed=True)
        .agg(
            n=("pnl_bps", "count"),
            mean_pnl=("pnl_bps", "mean"),
            median_pnl=("pnl_bps", "median"),
            std_pnl=("pnl_bps", "std"),
            win_rate=("pnl_bps", lambda s: (s > 0).mean()),
            p95_pnl=("pnl_bps", lambda s: s.quantile(0.95)),
            best=("pnl_bps", "max"),
            worst=("pnl_bps", "min"),
        )
        .round(2)
    )
    summary["sharpe_per_trade"] = (summary["mean_pnl"] / summary["std_pnl"]).round(3)
    subsection("Per-trade P&L summary by strategy (bps of underlying)")
    print(summary.to_string())
    return summary


def summary_by_bucket(trades: pd.DataFrame) -> None:
    subsection("Mean P&L by (strategy x VIX bucket)")
    by = (
        trades.groupby(["strategy", "vix_bucket"], observed=True)
        .agg(
            n=("pnl_bps", "count"),
            mean_pnl=("pnl_bps", "mean"),
            win_rate=("pnl_bps", lambda s: (s > 0).mean()),
        )
        .round(2)
    )
    print(by.to_string())


def directional_vs_random(trades: pd.DataFrame) -> None:
    subsection("Directional vs random edge (the decisive test)")
    summary = (
        trades.groupby("strategy", observed=True)["pnl_bps"]
        .agg(["mean", "count"])
    )
    print(summary.to_string())
    print()
    for signal in ("MOC", "MOO"):
        directional = summary.loc[f"{signal}_directional", "mean"]
        random_ = summary.loc[f"{signal}_random", "mean"]
        edge = directional - random_
        n_dir = int(summary.loc[f"{signal}_directional", "count"])
        se_approx = trades[trades["strategy"] == f"{signal}_directional"]["pnl_bps"].std() / np.sqrt(n_dir)
        t_stat = edge / (se_approx if se_approx > 0 else 1)
        print(f"  {signal}: directional={directional:+.2f}  random={random_:+.2f}  edge={edge:+.2f} bps  (approx t={t_stat:.2f})")


# ── Plots ────────────────────────────────────────────────────


def plot_equity_curves(trades: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    palette = {
        "MOC_directional": "#4c72b0",
        "MOC_random": "#94a0b8",
        "MOO_directional": "#c44e52",
        "MOO_random": "#c9a0a0",
    }
    for strat, color in palette.items():
        s = trades[trades["strategy"] == strat].sort_values("date")
        if s.empty:
            continue
        cum = s["pnl_bps"].cumsum()
        ax.plot(s["date"].values, cum.values, color=color, label=strat, linewidth=1.4)
    ax.axhline(0, color="black", linewidth=0.5)
    ax.set_ylabel("Cumulative P&L (bps of underlying)")
    ax.set_title(
        "Directional 0DTE options — equity curves by strategy\n"
        "(directional beats random = real edge. Random is naive long-option bleed.)"
    )
    ax.legend(loc="upper left")
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "21_options_equity_curves.png")
    plt.close(fig)


def plot_pnl_distributions(trades: pd.DataFrame) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    strategies = ["MOC_directional", "MOC_random", "MOO_directional", "MOO_random"]
    palette = ["#4c72b0", "#94a0b8", "#c44e52", "#c9a0a0"]
    for ax, strat, color in zip(axes.flatten(), strategies, palette):
        data = trades[trades["strategy"] == strat]["pnl_bps"]
        upper = data.quantile(0.99) if not data.empty else 0
        ax.hist(data.clip(upper=upper), bins=50, color=color, edgecolor="white")
        ax.axvline(0, color="black", linewidth=0.5)
        ax.axvline(data.mean(), color="red", linestyle="--", linewidth=1, label=f"mean {data.mean():+.1f}")
        ax.set_title(strat)
        ax.set_xlabel("P&L (bps)")
        ax.legend(loc="upper right")
    fig.suptitle("0DTE options P&L distributions per trade", fontsize=13)
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "22_options_pnl_hist.png")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    section("MOC — Phase 7: 0DTE directional options simulation")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    frame = load_data()

    # MOC window: 15:50 ET -> 16:00 ET = 10 min.
    moc_dir = simulate_strategy(
        frame, "moc_signed_imbalance", "spot_at_T50", "close_at_T60",
        window_minutes=10, label="MOC_directional",
    )
    moc_rnd = simulate_strategy(
        frame, "moc_signed_imbalance", "spot_at_T50", "close_at_T60",
        window_minutes=10, label="MOC_random", rng_seed=42,
    )

    # MOO window: 9:30 ET -> 16:00 ET = 390 min.
    moo_dir = simulate_strategy(
        frame, "moo_signed_imbalance", "day_open", "day_close",
        window_minutes=SESSION_MINUTES, label="MOO_directional",
    )
    moo_rnd = simulate_strategy(
        frame, "moo_signed_imbalance", "day_open", "day_close",
        window_minutes=SESSION_MINUTES, label="MOO_random", rng_seed=42,
    )

    trades = pd.concat([moc_dir, moc_rnd, moo_dir, moo_rnd], ignore_index=True)

    summary(trades)
    summary_by_bucket(trades)
    directional_vs_random(trades)

    plot_equity_curves(trades)
    plot_pnl_distributions(trades)

    takeaway(
        "2 plots -> plots/moc/. THE decisive cell:\n"
        "  directional_vs_random 'edge' per signal.\n"
        "  If edge > +3 bps AND approx t > 2, there's real directional alpha\n"
        "  that survives friction (~1-2 bps round-trip on SPX 0DTE).\n"
        "  If edge < +2 bps or t < 2, convexity doesn't rescue the signal."
    )


if __name__ == "__main__":
    main()
