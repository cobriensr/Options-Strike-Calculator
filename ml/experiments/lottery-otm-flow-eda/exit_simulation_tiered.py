"""
Tiered exit policy simulation for lottery fires.

Fast pop (<15 min to peak): Take profit at +15%
Medium (15-60 min): Trail20_5 (activate +20%, give back 5%)
Slow burn (60+ min): Trail30_10 (existing logic)
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np
import warnings

# Suppress pandas psycopg2 warning
warnings.filterwarnings('ignore', message='pandas only supports SQLAlchemy')

# Add ml/src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from utils import get_connection

PARQUET_DIR = Path("/Users/charlesobrien/Desktop/Bot-Eod-parquet")
COMMISSION_USD_PER_CONTRACT_RT = 0.65
SLIPPAGE_PCT_OF_SPREAD = 0.5


def load_fires(conn) -> pd.DataFrame:
    query = """
        SELECT id, date, trigger_time_ct, entry_price,
               underlying_symbol AS ticker, option_chain_id, option_type,
               peak_ceiling_pct, minutes_to_peak, mode, tod
        FROM lottery_finder_fires
        WHERE date >= '2026-04-13' AND date <= '2026-05-01'
          AND realized_trail30_10_pct IS NOT NULL
        ORDER BY date, trigger_time_ct
    """
    print(f"Loading fires...")
    df = pd.read_sql(query, conn)
    df["trigger_time_ct"] = pd.to_datetime(df["trigger_time_ct"], utc=True)
    print(f"Loaded {len(df)} fires")
    return df


def build_minute_prices(chain_trades: pd.DataFrame) -> pd.DataFrame:
    """Build per-minute mid prices from trade tape (same as exit_simulation_otm.py)."""
    # Handle canceled column - can be bool or string 'f'/'t'
    chain_trades = chain_trades[
        ~chain_trades["canceled"].isin([True, "t", "true", "True"])
    ].copy()
    chain_trades["executed_at"] = pd.to_datetime(chain_trades["executed_at"], utc=True)
    chain_trades["minute"] = chain_trades["executed_at"].dt.floor("1min")
    
    minutes = (
        chain_trades.groupby("minute")
        .agg({"nbbo_bid": "last", "nbbo_ask": "last"})
        .reset_index()
    )
    minutes["mid"] = (minutes["nbbo_bid"] + minutes["nbbo_ask"]) / 2
    return minutes.sort_values("minute").reset_index(drop=True)


def tiered_exit(
    minutes: pd.DataFrame,
    entry_price: float,
    trigger_ts: pd.Timestamp,
) -> tuple[float, str]:
    """
    Returns (exit_pct, policy_used).
    
    Fast pop: +15% take-profit
    Medium: Trail20_5
    Slow burn: Trail30_10
    """
    post_entry = minutes[minutes["minute"] >= trigger_ts].copy()
    if post_entry.empty:
        return 0.0, "no_data"
    
    prices = post_entry["mid"].values
    minutes_since = (
        (post_entry["minute"] - trigger_ts).dt.total_seconds() / 60
    ).values
    
    peak_idx = np.argmax(prices)
    time_to_peak = minutes_since[peak_idx]
    
    # Fast pop: take profit at +15%
    if time_to_peak < 15:
        for i, price in enumerate(prices):
            pct = ((price - entry_price) / entry_price) * 100
            if pct >= 15.0:
                return pct, "fast_tp15"
        return ((prices[-1] - entry_price) / entry_price) * 100, "fast_eod"
    
    # Medium: Trail20_5
    elif time_to_peak < 60:
        high_water = entry_price
        activated = False
        for price in prices:
            if price > high_water:
                high_water = price
            pct_gain = ((high_water - entry_price) / entry_price) * 100
            if pct_gain >= 20.0:
                activated = True
            if activated:
                giveback = ((high_water - price) / high_water) * 100
                if giveback >= 5.0:
                    return ((price - entry_price) / entry_price) * 100, "medium_trail20_5"
        return ((prices[-1] - entry_price) / entry_price) * 100, "medium_eod"
    
    # Slow burn: Trail30_10
    else:
        high_water = entry_price
        activated = False
        for price in prices:
            if price > high_water:
                high_water = price
            pct_gain = ((high_water - entry_price) / entry_price) * 100
            if pct_gain >= 30.0:
                activated = True
            if activated:
                giveback = ((high_water - price) / high_water) * 100
                if giveback >= 10.0:
                    return ((price - entry_price) / entry_price) * 100, "slow_trail30_10"
        return ((prices[-1] - entry_price) / entry_price) * 100, "slow_eod"


def main():
    conn = get_connection()
    fires = load_fires(conn)
    conn.close()
    
    fires_by_date = fires.groupby(fires["date"].astype(str))
    
    results = []
    
    for date_str, day_fires in fires_by_date:
        path = PARQUET_DIR / f"{date_str}-trades.parquet"
        if not path.exists():
            print(f"  missing parquet for {date_str}")
            continue
        
        chains = day_fires["option_chain_id"].unique().tolist()
        all_trades = pd.read_parquet(
            path,
            columns=["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "canceled"],
        )
        day_trades = all_trades[all_trades["option_chain_id"].isin(chains)].copy()
        chain_groups = day_trades.groupby("option_chain_id", observed=True)
        
        for fire in day_fires.itertuples(index=False):
            chain_id = fire.option_chain_id
            if chain_id not in chain_groups.groups:
                continue
            
            minutes = build_minute_prices(chain_groups.get_group(chain_id))
            if minutes.empty:
                continue
            
            exit_pct, policy = tiered_exit(minutes, fire.entry_price, fire.trigger_time_ct)
            
            results.append({
                "fire_id": fire.id,
                "ticker": fire.ticker,
                "option_type": fire.option_type,
                "date": fire.date,
                "peak_ceiling_pct": fire.peak_ceiling_pct,
                "minutes_to_peak": fire.minutes_to_peak,
                "tiered_exit_pct": exit_pct,
                "policy_used": policy,
            })
        
        print(f"  {date_str}: {len(results)} total results")
    
    # Save results
    df = pd.DataFrame(results)
    out_path = Path(__file__).parent / "tiered_exit_results.csv"
    df.to_csv(out_path, index=False)
    print(f"\nSaved {len(df)} results to {out_path}")
    
    if len(df) == 0:
        print("ERROR: No results generated.")
        return
    
    # Classify by speed
    df["speed_category"] = "unknown"
    df.loc[df["minutes_to_peak"] < 15, "speed_category"] = "fast (<15m)"
    df.loc[(df["minutes_to_peak"] >= 15) & (df["minutes_to_peak"] < 60), "speed_category"] = "medium (15-60m)"
    df.loc[df["minutes_to_peak"] >= 60, "speed_category"] = "slow (60m+)"
    
    # Summary stats
    print("\n=== Tiered Exit Performance ===")
    summary = df.groupby("policy_used").agg({
        "fire_id": "count",
        "tiered_exit_pct": ["mean", "median"],
        "peak_ceiling_pct": "mean",
    }).round(1)
    summary.columns = ["fires", "avg_exit", "median_exit", "avg_peak"]
    print(summary)
    
    # Win rate by policy
    print("\n=== Win Rates ===")
    df["won"] = df["tiered_exit_pct"] > 0
    win_rates = df.groupby("policy_used").agg({
        "won": ["sum", "count", "mean"]
    })
    win_rates.columns = ["wins", "total", "win_rate"]
    win_rates["win_rate"] = (win_rates["win_rate"] * 100).round(1)
    print(win_rates)
    
    # Peak distribution by speed
    print("\n=== Peak Distribution by Speed Category ===")
    speed_stats = df.groupby("speed_category").agg({
        "fire_id": "count",
        "peak_ceiling_pct": ["mean", "median", "max"],
        "tiered_exit_pct": ["mean", "median"],
    }).round(1)
    speed_stats.columns = ["fires", "avg_peak", "median_peak", "max_peak", "avg_exit", "median_exit"]
    print(speed_stats)
    
    # Top decile analysis
    print("\n=== Top 10% Peak Fires (5,082 fires) ===")
    top_decile = df.nlargest(int(len(df) * 0.1), "peak_ceiling_pct")
    print(f"Peak threshold: {top_decile['peak_ceiling_pct'].min():.1f}%")
    print(f"\nSpeed breakdown:")
    print(top_decile["speed_category"].value_counts())
    print(f"\nAvg peak: {top_decile['peak_ceiling_pct'].mean():.1f}%")
    print(f"Avg exit: {top_decile['tiered_exit_pct'].mean():.1f}%")
    print(f"Win rate: {(top_decile['tiered_exit_pct'] > 0).mean() * 100:.1f}%")
    
    # Top 5% (even more selective)
    print("\n=== Top 5% Peak Fires (2,541 fires) ===")
    top_5pct = df.nlargest(int(len(df) * 0.05), "peak_ceiling_pct")
    print(f"Peak threshold: {top_5pct['peak_ceiling_pct'].min():.1f}%")
    print(f"\nSpeed breakdown:")
    print(top_5pct["speed_category"].value_counts())
    print(f"\nAvg peak: {top_5pct['peak_ceiling_pct'].mean():.1f}%")
    print(f"Avg exit: {top_5pct['tiered_exit_pct'].mean():.1f}%")
    print(f"Win rate: {(top_5pct['tiered_exit_pct'] > 0).mean() * 100:.1f}%")


if __name__ == "__main__":
    main()
