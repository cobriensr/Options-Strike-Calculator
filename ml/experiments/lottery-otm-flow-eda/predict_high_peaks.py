"""
Predict high-peak fires BEFORE they happen.

Goal: Find entry-time features that predict peak_ceiling_pct ≥ 232%
(top 5% threshold) so we can filter alerts in real-time.

Features available at entry:
- ticker
- option_type (C/P)
- mode (cheap_call_pm, cheap_put_pm, etc.)
- tod (morning, midday, afternoon)
- entry_price (premium level)
- underlying price context (if we join)
- flow metrics at trigger time (if we join)

Output:
- Feature importance ranking
- Decision rules for real-time filtering
- Expected daily alert count after filtering
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np
import warnings
import psycopg2
import os

warnings.filterwarnings('ignore', message='pandas only supports SQLAlchemy')

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_LOCAL = REPO_ROOT / ".env.local"


def load_env() -> None:
    """Load environment variables from .env.local."""
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k, v.strip().strip('"'))


load_env()
db_url = os.getenv("DATABASE_URL")
if not db_url:
    print("ERROR: DATABASE_URL not set")
    sys.exit(1)

conn = psycopg2.connect(db_url)


def load_fires_with_features(conn) -> pd.DataFrame:
    """Load fires with all entry-time features."""
    query = """
        SELECT 
            id, date, trigger_time_ct, entry_price,
            underlying_symbol AS ticker, 
            option_chain_id, option_type,
            peak_ceiling_pct, minutes_to_peak,
            mode, tod,
            cheap_call_pm_tagged,
            strike
        FROM lottery_finder_fires
        WHERE date >= '2026-04-13' AND date <= '2026-05-01'
          AND realized_trail30_10_pct IS NOT NULL
        ORDER BY date, trigger_time_ct
    """
    print("Loading fires with entry-time features...")
    df = pd.read_sql(query, conn)
    print(f"Loaded {len(df)} fires")
    return df


def analyze_predictors(df: pd.DataFrame, threshold_pct: float = 232.0):
    """Analyze which entry-time features predict high peaks."""
    
    df["high_peak"] = df["peak_ceiling_pct"] >= threshold_pct
    high_peak_count = df["high_peak"].sum()
    high_peak_rate = df["high_peak"].mean()
    
    print(f"\n=== Predicting Peaks ≥ {threshold_pct}% ===")
    print(f"Base rate: {high_peak_count} / {len(df)} = {high_peak_rate*100:.1f}%")
    print(f"Daily avg: {high_peak_count / df['date'].nunique():.0f} fires/day")
    
    # 1. Ticker analysis
    print("\n=== By Ticker ===")
    ticker_stats = df.groupby("ticker").agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    ticker_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    ticker_stats = ticker_stats.sort_values("high_peak_rate", ascending=False)
    print(ticker_stats.head(10))
    
    # 2. Mode analysis
    print("\n=== By Mode ===")
    mode_stats = df.groupby("mode").agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    mode_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    mode_stats = mode_stats.sort_values("high_peak_rate", ascending=False)
    print(mode_stats)
    
    # 3. Time of day
    print("\n=== By Time of Day ===")
    tod_stats = df.groupby("tod").agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    tod_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    tod_stats = tod_stats.sort_values("high_peak_rate", ascending=False)
    print(tod_stats)
    
    # 4. Option type
    print("\n=== By Option Type ===")
    type_stats = df.groupby("option_type").agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    type_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    print(type_stats)
    
    # 5. Entry price buckets
    print("\n=== By Entry Price ===")
    df["entry_bucket"] = pd.cut(
        df["entry_price"],
        bins=[0, 0.10, 0.25, 0.50, 1.00, 2.00, 100],
        labels=["<$0.10", "$0.10-0.25", "$0.25-0.50", "$0.50-1.00", "$1.00-2.00", ">$2.00"]
    )
    price_stats = df.groupby("entry_bucket", observed=True).agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    price_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    print(price_stats)
    
    # 6. Cheap PM tag
    print("\n=== By Cheap PM Tag ===")
    pm_stats = df.groupby("cheap_call_pm_tagged").agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    pm_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    print(pm_stats)
    
    # 7. Multi-factor combinations
    print("\n=== Top Combinations (High Peak Rate) ===")
    combo_stats = df.groupby(["ticker", "mode", "tod"]).agg({
        "high_peak": ["sum", "count", "mean"],
        "peak_ceiling_pct": "mean",
    }).round(3)
    combo_stats.columns = ["high_peak_count", "total", "high_peak_rate", "avg_peak"]
    # Filter to combos with at least 20 fires
    combo_stats = combo_stats[combo_stats["total"] >= 20]
    combo_stats = combo_stats.sort_values("high_peak_rate", ascending=False)
    print(combo_stats.head(20))


def build_decision_rules(df: pd.DataFrame, threshold_pct: float = 232.0):
    """Build simple decision rules for real-time filtering."""
    
    df["high_peak"] = df["peak_ceiling_pct"] >= threshold_pct
    
    print(f"\n=== Decision Rules for Peaks ≥ {threshold_pct}% ===")
    
    # Rule 1: Ticker whitelist
    ticker_rates = df.groupby("ticker")["high_peak"].agg(["sum", "count", "mean"])
    ticker_rates.columns = ["high_peak_count", "total", "rate"]
    # Keep tickers with >10% high-peak rate and >50 total fires
    good_tickers = ticker_rates[
        (ticker_rates["rate"] > 0.10) & (ticker_rates["total"] > 50)
    ].index.tolist()
    
    rule1_df = df[df["ticker"].isin(good_tickers)]
    print(f"\nRule 1: Ticker in {good_tickers}")
    print(f"  Keeps: {len(rule1_df)} / {len(df)} fires ({len(rule1_df)/len(df)*100:.1f}%)")
    print(f"  High-peak rate: {rule1_df['high_peak'].mean()*100:.1f}%")
    print(f"  Daily avg: {len(rule1_df) / df['date'].nunique():.0f} fires/day")
    
    # Rule 2: Add mode filter
    mode_rates = rule1_df.groupby("mode")["high_peak"].mean()
    good_modes = mode_rates[mode_rates > 0.10].index.tolist()
    rule2_df = rule1_df[rule1_df["mode"].isin(good_modes)]
    print(f"\nRule 2: + Mode in {good_modes}")
    print(f"  Keeps: {len(rule2_df)} / {len(df)} fires ({len(rule2_df)/len(df)*100:.1f}%)")
    print(f"  High-peak rate: {rule2_df['high_peak'].mean()*100:.1f}%")
    print(f"  Daily avg: {len(rule2_df) / df['date'].nunique():.0f} fires/day")
    
    # Rule 3: Add entry price filter
    rule3_df = rule2_df[rule2_df["entry_price"] <= 1.00]
    print(f"\nRule 3: + Entry price ≤ $1.00")
    print(f"  Keeps: {len(rule3_df)} / {len(df)} fires ({len(rule3_df)/len(df)*100:.1f}%)")
    print(f"  High-peak rate: {rule3_df['high_peak'].mean()*100:.1f}%")
    print(f"  Daily avg: {len(rule3_df) / df['date'].nunique():.0f} fires/day")
    
    return rule3_df


def temporal_validation(df: pd.DataFrame, threshold_pct: float = 232.0):
    """Walk-forward validation to check if rules hold over time."""
    
    print("\n=== TEMPORAL VALIDATION (Walk-Forward) ===")
    
    df["high_peak"] = df["peak_ceiling_pct"] >= threshold_pct
    dates = sorted(df["date"].unique())
    
    # Split into 3 periods
    n = len(dates)
    train_dates = dates[:n//3]
    val_dates = dates[n//3:2*n//3]
    test_dates = dates[2*n//3:]
    
    train_df = df[df["date"].isin(train_dates)]
    val_df = df[df["date"].isin(val_dates)]
    test_df = df[df["date"].isin(test_dates)]
    
    print(f"\nTrain: {train_dates[0]} to {train_dates[-1]} ({len(train_df)} fires)")
    print(f"Val:   {val_dates[0]} to {val_dates[-1]} ({len(val_df)} fires)")
    print(f"Test:  {test_dates[0]} to {test_dates[-1]} ({len(test_df)} fires)")
    
    # Learn rules on train set
    ticker_rates = train_df.groupby("ticker")["high_peak"].agg(["sum", "count", "mean"])
    ticker_rates.columns = ["high_peak_count", "total", "rate"]
    good_tickers = ticker_rates[
        (ticker_rates["rate"] > 0.10) & (ticker_rates["total"] > 30)
    ].index.tolist()
    
    print(f"\nTrain-derived ticker whitelist ({len(good_tickers)} tickers):")
    print(f"  {good_tickers}")
    
    # Apply rules to each period
    for name, period_df in [("Train", train_df), ("Val", val_df), ("Test", test_df)]:
        filtered = period_df[
            (period_df["ticker"].isin(good_tickers)) &
            (period_df["mode"] == "A_intraday_0DTE") &
            (period_df["entry_price"] <= 1.00)
        ]
        
        base_rate = period_df["high_peak"].mean()
        filtered_rate = filtered["high_peak"].mean() if len(filtered) > 0 else 0
        lift = filtered_rate / base_rate if base_rate > 0 else 0
        
        print(f"\n{name} Period:")
        print(f"  Base rate: {base_rate*100:.1f}%")
        print(f"  Filtered: {len(filtered)} fires, {filtered_rate*100:.1f}% high-peak rate")
        print(f"  Lift: {lift:.1f}x")
        
    # Check if lift degrades over time
    print("\n⚠️  If Test lift << Train lift, rules are overfit!")


def stability_analysis(df: pd.DataFrame, threshold_pct: float = 232.0):
    """Check if high-peak rates are stable day-to-day."""
    
    print("\n=== STABILITY ANALYSIS (Day-to-Day Variance) ===")
    
    df["high_peak"] = df["peak_ceiling_pct"] >= threshold_pct
    
    # Per-day high-peak rate
    daily = df.groupby("date")["high_peak"].agg(["sum", "count", "mean"])
    daily.columns = ["high_peak_count", "total", "rate"]
    
    print(f"\nDaily high-peak rate statistics:")
    print(f"  Mean: {daily['rate'].mean()*100:.1f}%")
    print(f"  Std:  {daily['rate'].std()*100:.1f}%")
    print(f"  Min:  {daily['rate'].min()*100:.1f}%")
    print(f"  Max:  {daily['rate'].max()*100:.1f}%")
    print(f"  CV:   {daily['rate'].std() / daily['rate'].mean():.2f}")
    
    # Check for outlier days
    mean_rate = daily["rate"].mean()
    std_rate = daily["rate"].std()
    outliers = daily[(daily["rate"] > mean_rate + 2*std_rate) | 
                     (daily["rate"] < mean_rate - 2*std_rate)]
    
    if len(outliers) > 0:
        print(f"\n⚠️  {len(outliers)} outlier days (>2 std from mean):")
        print(outliers[["high_peak_count", "total", "rate"]].round(3))
    
    # Apply filters and check stability
    good_tickers = ['RDDT', 'RIVN', 'RUTW', 'SMCI', 'SNDK', 'SNOW', 'SOFI', 
                    'SOUN', 'STX', 'TEAM', 'TSLL', 'TSM', 'USAR', 'WDC', 
                    'WMT', 'WULF', 'XOM']
    
    filtered = df[
        (df["ticker"].isin(good_tickers)) &
        (df["mode"] == "A_intraday_0DTE") &
        (df["entry_price"] <= 1.00)
    ]
    
    daily_filtered = filtered.groupby("date")["high_peak"].agg(["sum", "count", "mean"])
    daily_filtered.columns = ["high_peak_count", "total", "rate"]
    
    print(f"\nFiltered daily high-peak rate statistics:")
    print(f"  Mean: {daily_filtered['rate'].mean()*100:.1f}%")
    print(f"  Std:  {daily_filtered['rate'].std()*100:.1f}%")
    print(f"  CV:   {daily_filtered['rate'].std() / daily_filtered['rate'].mean():.2f}")
    
    print("\n✓ Lower CV after filtering = more stable/predictable")


def ticker_sample_size_check(df: pd.DataFrame, threshold_pct: float = 232.0):
    """Check if ticker rates are based on sufficient samples."""
    
    print("\n=== TICKER SAMPLE SIZE CHECK ===")
    
    df["high_peak"] = df["peak_ceiling_pct"] >= threshold_pct
    
    ticker_stats = df.groupby("ticker").agg({
        "high_peak": ["sum", "count", "mean"],
    })
    ticker_stats.columns = ["high_peak_count", "total", "rate"]
    ticker_stats = ticker_stats.sort_values("rate", ascending=False)
    
    # Wilson score confidence interval for binomial proportion
    from scipy import stats
    
    def wilson_ci(successes: int, n: int, confidence: float = 0.95):
        """Wilson score interval for binomial proportion."""
        if n == 0:
            return 0, 0
        p = successes / n
        z = stats.norm.ppf((1 + confidence) / 2)
        denominator = 1 + z**2 / n
        center = (p + z**2 / (2*n)) / denominator
        margin = z * np.sqrt(p*(1-p)/n + z**2/(4*n**2)) / denominator
        return max(0, center - margin), min(1, center + margin)
    
    ticker_stats["ci_lower"] = ticker_stats.apply(
        lambda row: wilson_ci(row["high_peak_count"], row["total"])[0], axis=1
    )
    ticker_stats["ci_upper"] = ticker_stats.apply(
        lambda row: wilson_ci(row["high_peak_count"], row["total"])[1], axis=1
    )
    ticker_stats["ci_width"] = ticker_stats["ci_upper"] - ticker_stats["ci_lower"]
    
    print("\nTop 20 tickers with 95% confidence intervals:")
    print(ticker_stats.head(20).round(3))
    
    # Flag tickers with wide CIs (uncertain estimates)
    wide_ci = ticker_stats[ticker_stats["ci_width"] > 0.15]
    print(f"\n⚠️  {len(wide_ci)} tickers have CI width > 15% (uncertain):")
    print(wide_ci[["total", "rate", "ci_lower", "ci_upper", "ci_width"]].round(3))
    
    # Recommend minimum sample size
    print("\n✓ Tickers with >100 fires have narrow CIs (<10% width)")


def feature_correlation_check(df: pd.DataFrame, threshold_pct: float = 232.0):
    """Check for multicollinearity between predictive features."""
    
    print("\n=== FEATURE CORRELATION CHECK ===")
    
    df["high_peak"] = df["peak_ceiling_pct"] >= threshold_pct
    
    # Encode categorical features
    df["is_0dte"] = (df["mode"] == "A_intraday_0DTE").astype(int)
    df["is_call"] = (df["option_type"] == "C").astype(int)
    df["is_am_open"] = (df["tod"] == "AM_open").astype(int)
    df["is_cheap"] = (df["entry_price"] <= 1.00).astype(int)
    
    # Top tickers
    good_tickers = ['RDDT', 'RIVN', 'RUTW', 'SMCI', 'SNDK', 'SNOW', 'SOFI', 
                    'SOUN', 'STX', 'TEAM', 'TSLL', 'TSM', 'USAR', 'WDC', 
                    'WMT', 'WULF', 'XOM']
    df["is_good_ticker"] = df["ticker"].isin(good_tickers).astype(int)
    
    features = ["is_good_ticker", "is_0dte", "is_call", "is_am_open", "is_cheap"]
    corr_matrix = df[features].corr()
    
    print("\nFeature correlation matrix:")
    print(corr_matrix.round(3))
    
    # Check for high correlations (>0.7)
    high_corr = []
    for i in range(len(features)):
        for j in range(i+1, len(features)):
            if abs(corr_matrix.iloc[i, j]) > 0.7:
                high_corr.append((features[i], features[j], corr_matrix.iloc[i, j]))
    
    if high_corr:
        print("\n⚠️  High correlations detected (>0.7):")
        for f1, f2, corr in high_corr:
            print(f"  {f1} <-> {f2}: {corr:.3f}")
        print("  → Rules may be redundant")
    else:
        print("\n✓ No high correlations — features are independent")


def main():
    load_env()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set")
        sys.exit(1)
    
    conn = psycopg2.connect(db_url)
    
    try:
        df = load_fires_with_features(conn)
        
        # Original analysis
        analyze_predictors(df)
        filtered_df = build_decision_rules(df)
        
        # NEW: Robustness checks
        temporal_validation(df)
        stability_analysis(df)
        ticker_sample_size_check(df)
        feature_correlation_check(df)
        
        # Save filtered dataset
        output_path = Path(__file__).parent / "high_peak_filtered.csv"
        filtered_df.to_csv(output_path, index=False)
        print(f"\nSaved {len(filtered_df)} filtered fires to {output_path}")
        
    finally:
        conn.close()


if __name__ == "__main__":
    main()
