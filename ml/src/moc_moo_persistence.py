"""
MOC Imbalance — Phase 6: MOO (Market-on-Open) persistence test

Triggered by a UW community member who reports success "sniping SPX after
MOC numbers are released" and asks whether we've looked at MOO (the
morning opening-cross imbalance published by NASDAQ from 9:25-9:29 ET).

His intuition: the morning imbalance "sets up the day" — direction + magnitude
at the open carries predictive power across the whole session.

Our Phase 1-3 study filtered to `auction_type == 'C'` and threw away the
opening-cross data. This phase tests whether that was a mistake.

Questions:
  1. Does MOO signed imbalance predict the day's close-to-open return?
     (directional-bias test — "does the morning tape call the day?")
  2. Does MOO magnitude predict intraday range?
     (volatility-regime test — "does heavy opening flow mean a big range day?")
  3. Does MOO persist into the first 30 min of trading?
     (continuation test — a shorter, cleaner version of #1)
  4. Does MOO predict the afternoon MOC imbalance?
     (flow-persistence test — "does morning flow carry through all day?")

Expectation setting: MOO is structurally more informative than MOC because
the open is where overnight news gets priced. Imbalance at the open
reflects institutional positioning responses to overnight events — a
genuinely different data generating process than the MOC flow we tested.

If MOO shows stronger correlation than MOC did (|r| > 0.2 on return or
range), the community member's thesis is validated and SPY ARCX imbalance
becomes worth pulling for a true SPX-options test.

Usage:
    ml/.venv/bin/python ml/src/moc_moo_persistence.py
"""

import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
    from scipy import stats
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install matplotlib seaborn scipy pandas numpy")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


ET = "US/Eastern"
PLOTS_DIR = ML_ROOT / "plots" / "moc"
IMBALANCE_CACHE = ML_ROOT / "data" / "moc_imbalance_raw.parquet"
BARS_CACHE = ML_ROOT / "data" / "qqq_bars_1m.parquet"
MOC_FEATURES = ML_ROOT / "data" / "moc_features_qqq.parquet"
VIX_CACHE = ML_ROOT / "data" / "vix_daily.parquet"
OUTPUT = ML_ROOT / "data" / "moo_features_qqq.parquet"

SYMBOL = "QQQ"
# Snapshot for MOO: NASDAQ publishes from 9:25 onward every 10s until 9:29,
# then every 1s into the open. We take the LAST message at or before 9:29:30
# on each day — similar reasoning to the MOC snapshot: later messages in the
# window have more-mature clearing prices and quantities.
MOO_SNAPSHOT_HOUR = 9
MOO_SNAPSHOT_MINUTE_MAX = 29

VIX_BUCKETS = [
    ("Calm (<15)", 0, 15),
    ("Normal (15-20)", 15, 20),
    ("Elevated (20-30)", 20, 30),
    ("Stress (>30)", 30, 200),
]

sns.set_theme(style="darkgrid", context="notebook")
plt.rcParams.update({"figure.dpi": 110, "savefig.dpi": 140})


# ── Loaders ──────────────────────────────────────────────────


def load_moo_messages() -> pd.DataFrame:
    """Filter raw imbalance data to QQQ opening-cross messages."""
    if not IMBALANCE_CACHE.exists():
        print(f"ERROR: {IMBALANCE_CACHE} not found. Run moc_inspect.py first.")
        sys.exit(1)
    raw = pd.read_parquet(IMBALANCE_CACHE)
    moo = raw[(raw["symbol"] == SYMBOL) & (raw["auction_type"] == "O")]
    print(f"  {len(moo):,} QQQ opening-cross messages")
    return moo


def load_bars() -> pd.DataFrame:
    if not BARS_CACHE.exists():
        print(f"ERROR: {BARS_CACHE} not found. Run moc_features.py first.")
        sys.exit(1)
    return pd.read_parquet(BARS_CACHE)


def load_moc_features() -> pd.DataFrame:
    if not MOC_FEATURES.exists():
        return pd.DataFrame()
    return pd.read_parquet(MOC_FEATURES)[["T50_signed_imbalance"]].rename(
        columns={"T50_signed_imbalance": "moc_signed_imbalance"}
    )


def load_vix() -> pd.DataFrame:
    if not VIX_CACHE.exists():
        print(f"ERROR: {VIX_CACHE} not found. Run moc_regime_vix.py first.")
        sys.exit(1)
    return pd.read_parquet(VIX_CACHE)


# ── MOO snapshot extraction ──────────────────────────────────


def extract_moo_snapshot(day_messages: pd.DataFrame) -> pd.Series | None:
    """
    Return the last message at or before 9:29:30 ET on this day. This is
    the "most mature" MOO publication the trader has before the 9:30 open.
    """
    ts_et = day_messages.index.tz_convert(ET)
    day_minutes = ts_et.hour * 60 + ts_et.minute
    cutoff_minutes = MOO_SNAPSHOT_HOUR * 60 + MOO_SNAPSHOT_MINUTE_MAX
    # Use only pre-open messages (strictly before 9:30) so we're not
    # accidentally picking a post-open print.
    mask = (day_minutes >= MOO_SNAPSHOT_HOUR * 60 + 25) & (day_minutes <= cutoff_minutes)
    candidates = day_messages.loc[mask]
    if candidates.empty:
        return None
    return candidates.iloc[-1]  # latest in window


def build_moo_features(moo: pd.DataFrame) -> pd.DataFrame:
    """One row per trading day with the MOO snapshot features."""
    rows: list[dict] = []
    for trade_date, grp in moo.groupby(moo.index.tz_convert(ET).date):
        msg = extract_moo_snapshot(grp)
        if msg is None:
            continue
        side = msg["side"]
        sign = 1 if side == "B" else (-1 if side == "A" else 0)
        total_qty = int(msg["total_imbalance_qty"])
        paired_qty = int(msg["paired_qty"])
        rows.append(
            {
                "trade_date": pd.Timestamp(trade_date),
                "moo_signed_imbalance": sign * total_qty,
                "moo_total_qty": total_qty,
                "moo_side": side,
                "moo_paired_ratio": paired_qty / total_qty if total_qty > 0 else np.nan,
                "moo_ref_price": msg["ref_price"],
            }
        )
    frame = pd.DataFrame(rows).set_index("trade_date").sort_index()
    print(f"  MOO snapshots: {len(frame):,} days")
    return frame


# ── Intraday target construction ─────────────────────────────


def compute_day_targets(day_bars: pd.DataFrame) -> dict | None:
    """
    Extract day-level price targets from 1-min bars:
      - open (9:30), 10am close, 4pm close, day high, day low
      - return open->close, open->10am
      - intraday range as pct of open
    """
    ts_et = day_bars.index.tz_convert(ET)
    day_minutes = ts_et.hour * 60 + ts_et.minute
    rth_mask = (day_minutes >= 9 * 60 + 30) & (day_minutes < 16 * 60)
    rth = day_bars.loc[rth_mask]
    if len(rth) < 100:
        return None
    first_bar = rth.iloc[0]
    last_bar = rth.iloc[-1]
    open_price = first_bar["open"]
    if open_price <= 0 or np.isnan(open_price):
        return None

    # 10:00 AM ET snapshot — close of the 10:00 bar (or first bar >= 10:00).
    # Recompute minutes from rth's index directly (day_minutes is a
    # DatetimeIndex-derived ndarray, not a Series, so can't .loc into it).
    rth_et = rth.index.tz_convert(ET)
    rth_minutes = rth_et.hour * 60 + rth_et.minute
    ten_am_bars = rth.loc[rth_minutes == 10 * 60]
    ten_am_price = ten_am_bars.iloc[0]["close"] if len(ten_am_bars) else np.nan

    return {
        "day_open": open_price,
        "day_close": last_bar["close"],
        "day_high": rth["high"].max(),
        "day_low": rth["low"].min(),
        "price_10am": ten_am_price,
        "return_day_bps": (last_bar["close"] - open_price) / open_price * 10_000,
        "return_to_10am_bps": (
            (ten_am_price - open_price) / open_price * 10_000
            if np.isfinite(ten_am_price)
            else np.nan
        ),
        "intraday_range_bps": (rth["high"].max() - rth["low"].min())
        / open_price
        * 10_000,
    }


def build_day_targets(bars: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for trade_date, grp in bars.groupby(bars.index.tz_convert(ET).date):
        t = compute_day_targets(grp)
        if t is None:
            continue
        t["trade_date"] = pd.Timestamp(trade_date)
        rows.append(t)
    return pd.DataFrame(rows).set_index("trade_date").sort_index()


# ── Analyses ─────────────────────────────────────────────────


def join_all(
    moo: pd.DataFrame,
    targets: pd.DataFrame,
    moc: pd.DataFrame,
    vix: pd.DataFrame,
) -> pd.DataFrame:
    moo.index = pd.to_datetime(moo.index).tz_localize(None)
    targets.index = pd.to_datetime(targets.index).tz_localize(None)
    joined = moo.join(targets, how="inner")
    if not moc.empty:
        moc.index = pd.to_datetime(moc.index).tz_localize(None)
        joined = joined.join(moc, how="left")
    joined = joined.join(vix, how="left")
    joined = joined.dropna(subset=["moo_signed_imbalance", "return_day_bps"])

    # VIX bucket
    labels = []
    for v in joined["vix_close"]:
        if pd.isna(v):
            labels.append(None)
            continue
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
    print(f"  Joined: {len(joined):,} days with MOO + intraday targets + VIX")
    return joined


def correlations(frame: pd.DataFrame) -> None:
    subsection("Correlations — MOO signed imbalance vs intraday targets")
    targets = [
        "return_day_bps",
        "return_to_10am_bps",
        "intraday_range_bps",
        "moc_signed_imbalance",
    ]
    available = [t for t in targets if t in frame.columns]
    rows = []
    for signed in [True, False]:
        x_col = "moo_signed_imbalance"
        x = frame[x_col] if signed else frame[x_col].abs()
        for t in available:
            y = frame[t] if signed else frame[t].abs()
            mask = x.notna() & y.notna()
            if mask.sum() < 30:
                continue
            p, pp = stats.pearsonr(x[mask], y[mask])
            s, sp = stats.spearmanr(x[mask], y[mask])
            rows.append(
                {
                    "x": x_col if signed else f"|{x_col}|",
                    "y": t if signed else f"|{t}|",
                    "n": int(mask.sum()),
                    "pearson": round(p, 3),
                    "pearson_p": round(pp, 4),
                    "spearman": round(s, 3),
                    "spearman_p": round(sp, 4),
                }
            )
    print(pd.DataFrame(rows).to_string(index=False))


def directional_accuracy(frame: pd.DataFrame) -> None:
    subsection("Directional accuracy — MOO sign predicts direction of:")
    for target in ["return_day_bps", "return_to_10am_bps", "moc_signed_imbalance"]:
        if target not in frame.columns:
            continue
        x = frame["moo_signed_imbalance"]
        y = frame[target]
        mask = (x != 0) & (y != 0) & y.notna() & x.notna()
        agreement = (np.sign(x[mask]) == np.sign(y[mask])).mean()
        print(f"  MOO sign -> {target:25s}  agreement = {agreement:.1%}  n={mask.sum()}")


def decile_binning(frame: pd.DataFrame) -> None:
    subsection("|MOO imbalance| deciles vs intraday range and day return")
    abs_imb = frame["moo_signed_imbalance"].abs()
    deciles = pd.qcut(abs_imb, q=10, labels=False, duplicates="drop")
    grouped = (
        frame.assign(decile=deciles)
        .groupby("decile")
        .agg(
            median_abs_imb=("moo_signed_imbalance", lambda s: s.abs().median()),
            median_range=("intraday_range_bps", "median"),
            p95_range=("intraday_range_bps", lambda s: s.quantile(0.95)),
            median_abs_return=("return_day_bps", lambda s: s.abs().median()),
            p95_abs_return=("return_day_bps", lambda s: s.abs().quantile(0.95)),
            n=("return_day_bps", "count"),
        )
        .round(1)
    )
    print(grouped.to_string())


def incremental_r2_vs_vix(frame: pd.DataFrame) -> None:
    subsection("Incremental R^2: does MOO add to VIX for intraday range?")
    from sklearn.linear_model import LinearRegression

    valid = frame.dropna(
        subset=["vix_close", "moo_signed_imbalance", "intraday_range_bps"]
    )
    y = valid["intraday_range_bps"].to_numpy()
    X_vix = valid[["vix_close"]].to_numpy()
    X_both = valid[["vix_close", "moo_signed_imbalance"]].to_numpy()

    r2_vix = LinearRegression().fit(X_vix, y).score(X_vix, y)
    r2_both = LinearRegression().fit(X_both, y).score(X_both, y)
    print(f"  R^2 VIX only:                   {r2_vix:.4f}")
    print(f"  R^2 VIX + |MOO signed imb|:     {r2_both:.4f}")
    print(f"  Incremental R^2 from MOO:        {r2_both - r2_vix:+.4f}")
    if r2_both - r2_vix > 0.02:
        print("  --> MOO meaningfully improves on VIX alone.")
    elif r2_both - r2_vix > 0.005:
        print("  --> MOO adds marginal signal.")
    else:
        print("  --> MOO adds essentially nothing on top of VIX.")


# ── Plots ────────────────────────────────────────────────────


def plot_directional(frame: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    x = frame["moo_signed_imbalance"]
    y = frame["return_day_bps"]
    colors = np.where(np.sign(x) == np.sign(y), "#55a868", "#c44e52")
    ax.scatter(x, y, s=10, alpha=0.4, c=colors)
    ax.axhline(0, color="black", linewidth=0.5)
    ax.axvline(0, color="black", linewidth=0.5)
    ax.set_xlabel("MOO signed imbalance (shares)")
    ax.set_ylabel("QQQ close-to-open return (bps)")
    ax.set_title(
        "Does morning imbalance direction predict the day's direction?\n"
        "(green = signs agree, red = signs disagree)"
    )
    ax.set_xlim(x.quantile(0.01), x.quantile(0.99))
    ax.set_ylim(y.quantile(0.01), y.quantile(0.99))
    mask = (x != 0) & (y != 0)
    agreement = (np.sign(x[mask]) == np.sign(y[mask])).mean()
    p, _ = stats.pearsonr(x[mask], y[mask])
    ax.text(
        0.98, 0.95,
        f"sign agreement = {agreement:.1%}\nPearson r = {p:+.3f}\nn = {mask.sum():,}",
        transform=ax.transAxes, ha="right", va="top",
        bbox={"facecolor": "white", "alpha": 0.85, "edgecolor": "none"},
        fontsize=10,
    )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "18_moo_directional.png")
    plt.close(fig)


def plot_range_decile(frame: pd.DataFrame) -> None:
    abs_imb = frame["moo_signed_imbalance"].abs()
    deciles = pd.qcut(abs_imb, q=10, labels=False, duplicates="drop")
    grouped = (
        frame.assign(decile=deciles)
        .groupby("decile")
        .agg(
            median_range=("intraday_range_bps", "median"),
            p95_range=("intraday_range_bps", lambda s: s.quantile(0.95)),
        )
    )
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.plot(grouped.index, grouped["median_range"], "-o", color="#c44e52", label="median range")
    ax.plot(grouped.index, grouped["p95_range"], "-o", color="#4c72b0", label="95th-pct range")
    ax.set_xlabel("|MOO signed imbalance| decile (0 = smallest, 9 = largest)")
    ax.set_ylabel("intraday range (bps of open)")
    ax.set_title("Does MOO size predict intraday range?")
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "19_moo_range_decile.png")
    plt.close(fig)


def plot_persistence(frame: pd.DataFrame) -> None:
    """MOO signed imbalance vs MOC signed imbalance — does morning flow carry through?"""
    if "moc_signed_imbalance" not in frame.columns:
        return
    fig, ax = plt.subplots(figsize=(10, 6))
    x = frame["moo_signed_imbalance"]
    y = frame["moc_signed_imbalance"]
    mask = x.notna() & y.notna() & (x != 0) & (y != 0)
    colors = np.where(np.sign(x[mask]) == np.sign(y[mask]), "#55a868", "#c44e52")
    ax.scatter(x[mask], y[mask], s=10, alpha=0.45, c=colors)
    ax.axhline(0, color="black", linewidth=0.5)
    ax.axvline(0, color="black", linewidth=0.5)
    ax.set_xlabel("MOO signed imbalance (shares)")
    ax.set_ylabel("MOC signed imbalance (shares, same day)")
    ax.set_title("Does morning flow predict afternoon flow? (MOO -> MOC persistence)")
    ax.set_xlim(x[mask].quantile(0.01), x[mask].quantile(0.99))
    ax.set_ylim(y[mask].quantile(0.01), y[mask].quantile(0.99))
    agreement = (np.sign(x[mask]) == np.sign(y[mask])).mean()
    p, _ = stats.pearsonr(x[mask], y[mask])
    ax.text(
        0.98, 0.95,
        f"sign agreement = {agreement:.1%}\nPearson r = {p:+.3f}\nn = {mask.sum():,}",
        transform=ax.transAxes, ha="right", va="top",
        bbox={"facecolor": "white", "alpha": 0.85, "edgecolor": "none"},
        fontsize=10,
    )
    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "20_moo_moc_persistence.png")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    section("MOC — Phase 6: MOO (Market-on-Open) persistence test")
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    moo_raw = load_moo_messages()
    bars = load_bars()
    moc = load_moc_features()
    vix = load_vix()

    moo = build_moo_features(moo_raw)
    targets = build_day_targets(bars)
    joined = join_all(moo, targets, moc, vix)

    correlations(joined)
    directional_accuracy(joined)
    decile_binning(joined)
    incremental_r2_vs_vix(joined)

    plot_directional(joined)
    plot_range_decile(joined)
    plot_persistence(joined)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    joined.to_parquet(OUTPUT)

    takeaway(
        f"Wrote {len(joined):,} days -> {OUTPUT.relative_to(ML_ROOT)}.\n"
        "   KEY CELLS:\n"
        "   - directional_accuracy: MOO sign -> day return. If > 55%, "
        "there's a directional edge the MOC analysis missed.\n"
        "   - Pearson r(moo_signed_imbalance, return_day_bps): > 0.2 = "
        "validates the community member's setup thesis.\n"
        "   - MOO -> MOC persistence: if agreement > 55%, morning flow "
        "genuinely carries through the day."
    )


if __name__ == "__main__":
    main()
