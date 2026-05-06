"""
Lottery fire scoring model and ticker statistics computation.

Analyzes historical lottery_otm_fires data to:
1. Compute per-ticker high-peak rates and confidence intervals
2. Define composite score weights for ranking fires
3. Output ticker stats JSON for database seeding

Run: ml/.venv/bin/python ml/src/lottery_scoring.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

# Add ml/src to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from utils import get_connection


def compute_confidence_interval(
    successes: int, trials: int, confidence: float = 0.95
) -> tuple[float, float, float]:
    """
    Compute Wilson score confidence interval for binomial proportion.
    
    Returns (point_estimate, lower_bound, upper_bound).
    """
    if trials == 0:
        return 0.0, 0.0, 0.0
    
    p_hat = successes / trials
    z = stats.norm.ppf((1 + confidence) / 2)
    
    denominator = 1 + z**2 / trials
    center = (p_hat + z**2 / (2 * trials)) / denominator
    margin = z * np.sqrt((p_hat * (1 - p_hat) + z**2 / (4 * trials)) / trials) / denominator
    
    return p_hat, max(0, center - margin), min(1, center + margin)


def fetch_fire_data() -> pd.DataFrame:
    """Fetch all lottery fires from database."""
    conn = get_connection()
    
    query = """
    SELECT 
        underlying_symbol AS ticker,
        mode,
        entry_price,
        tod,
        option_type,
        peak_ceiling_pct AS peak_pct,
        date AS fired_at
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL
    ORDER BY date DESC
    """
    
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    return df


def compute_ticker_stats(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute per-ticker statistics with confidence intervals.
    
    Returns DataFrame with columns:
    - ticker
    - n_fires
    - high_peak_rate (% of fires with peak ≥50%)
    - ci_lower, ci_upper, ci_width
    - tier ('reliable' if CI width <10%, 'uncertain' if >15%, else '')
    """
    # Define high-peak threshold
    HIGH_PEAK_THRESHOLD = 50.0
    
    ticker_groups = df.groupby('ticker')
    
    stats_list = []
    for ticker, group in ticker_groups:
        n_fires = len(group)
        high_peak_fires = (group['peak_pct'] >= HIGH_PEAK_THRESHOLD).sum()
        
        rate, ci_lower, ci_upper = compute_confidence_interval(high_peak_fires, n_fires)
        ci_width = (ci_upper - ci_lower) * 100  # Convert to percentage points
        
        # Determine tier
        if ci_width < 10:
            tier = 'reliable'
        elif ci_width > 15:
            tier = 'uncertain'
        else:
            tier = ''
        
        stats_list.append({
            'ticker': ticker,
            'n_fires': n_fires,
            'high_peak_rate': rate * 100,  # Convert to percentage
            'ci_lower': ci_lower * 100,
            'ci_upper': ci_upper * 100,
            'ci_width': ci_width,
            'tier': tier
        })
    
    return pd.DataFrame(stats_list).sort_values('n_fires', ascending=False)


def define_score_weights(ticker_stats: pd.DataFrame) -> dict:
    """
    Define scoring weights based on ticker stats distribution.

    Returns dict with weight mappings for each factor.
    """
    # Ticker boost: 0-10 points based on high-peak rate.
    # CRITICAL: filter to statistically reliable tickers BEFORE ranking.
    # Without this, tickers with 50-80 fires can land at the top by
    # chance (CI width 20pp+) and crowd out high-volume names whose
    # smaller raw rate is a much more reliable edge. The `tier` column
    # is set to 'reliable' when Wilson CI width <10pp.
    reliable = ticker_stats[ticker_stats['tier'] == 'reliable']
    if len(reliable) < 15:
        # Fall back to widening the bar if we don't have 15 reliable
        # tickers yet (early-history case). Include 'borderline' (no
        # label, 10≤CI<15) before going to 'uncertain'.
        reliable = ticker_stats[ticker_stats['tier'] != 'uncertain']
    # Top 5 tickers get 10, next 5 get 7, next 5 get 5, rest get 0
    top_tickers = reliable.nlargest(5, 'high_peak_rate')['ticker'].tolist()
    mid_tickers = reliable.nlargest(10, 'high_peak_rate').tail(5)['ticker'].tolist()
    good_tickers = reliable.nlargest(15, 'high_peak_rate').tail(5)['ticker'].tolist()
    
    ticker_weights = {}
    for ticker in top_tickers:
        ticker_weights[ticker] = 10
    for ticker in mid_tickers:
        ticker_weights[ticker] = 7
    for ticker in good_tickers:
        ticker_weights[ticker] = 5
    
    return {
        'ticker': ticker_weights,
        'mode': {
            '0DTE': 5,
            'multi-day': 0
        },
        'price': {
            # Entry price ≤ $0.50 gets 5 points, $0.50-1.00 gets 3, >$1.00 gets 0
            'thresholds': [(0.50, 5), (1.00, 3)]
        },
        'tod': {
            'AM_open': 3,
            'MID': 2,
            'LUNCH': 0,
            'PM': 0
        },
        'option_type': {
            'call': 2,
            'put': 0
        }
    }


def compute_score(
    ticker: str,
    mode: str,
    price: float,
    tod: str,
    option_type: str,
    weights: dict
) -> int:
    """Compute composite score for a fire."""
    score = 0
    
    # Ticker boost
    score += weights['ticker'].get(ticker, 0)
    
    # Mode boost
    score += weights['mode'].get(mode, 0)
    
    # Price boost
    for threshold, points in weights['price']['thresholds']:
        if price <= threshold:
            score += points
            break
    
    # TOD boost
    score += weights['tod'].get(tod, 0)
    
    # Option type boost
    score += weights['option_type'].get(option_type, 0)
    
    return score


def validate_score_distribution(df: pd.DataFrame, weights: dict) -> dict:
    """
    Compute scores for all fires and validate distribution.
    
    Returns dict with tier counts and sample fires per tier.
    """
    df['score'] = df.apply(
        lambda row: compute_score(
            row['ticker'],
            row['mode'],
            row['entry_price'],
            row['tod'],
            row['option_type'],
            weights
        ),
        axis=1
    )
    
    # Count fires per tier
    tier1_count = (df['score'] >= 18).sum()
    tier2_count = ((df['score'] >= 12) & (df['score'] < 18)).sum()
    tier3_count = (df['score'] < 12).sum()
    
    # Compute high-peak rates per tier
    tier1_fires = df[df['score'] >= 18]
    tier2_fires = df[(df['score'] >= 12) & (df['score'] < 18)]
    tier3_fires = df[df['score'] < 12]
    
    tier1_rate = (tier1_fires['peak_pct'] >= 50).sum() / len(tier1_fires) * 100 if len(tier1_fires) > 0 else 0
    tier2_rate = (tier2_fires['peak_pct'] >= 50).sum() / len(tier2_fires) * 100 if len(tier2_fires) > 0 else 0
    tier3_rate = (tier3_fires['peak_pct'] >= 50).sum() / len(tier3_fires) * 100 if len(tier3_fires) > 0 else 0
    
    total_days = (df['fired_at'].max() - df['fired_at'].min()).days
    
    return {
        'total_fires': len(df),
        'total_days': total_days,
        'tier1': {
            'count': int(tier1_count),
            'per_day': tier1_count / total_days if total_days > 0 else 0,
            'high_peak_rate': tier1_rate
        },
        'tier2': {
            'count': int(tier2_count),
            'per_day': tier2_count / total_days if total_days > 0 else 0,
            'high_peak_rate': tier2_rate
        },
        'tier3': {
            'count': int(tier3_count),
            'per_day': tier3_count / total_days if total_days > 0 else 0,
            'high_peak_rate': tier3_rate
        },
        'score_distribution': {
            'min': int(df['score'].min()),
            'max': int(df['score'].max()),
            'mean': float(df['score'].mean()),
            'median': float(df['score'].median())
        }
    }


def main():
    """Run scoring analysis and output results."""
    print("Fetching lottery fire data...")
    df = fetch_fire_data()
    print(f"Loaded {len(df)} fires")
    
    print("\nComputing ticker statistics...")
    ticker_stats = compute_ticker_stats(df)
    print(f"Analyzed {len(ticker_stats)} tickers")
    
    print("\nDefining score weights...")
    weights = define_score_weights(ticker_stats)
    
    print("\nValidating score distribution...")
    distribution = validate_score_distribution(df, weights)
    
    # Output results
    output_dir = Path(__file__).parent.parent / 'data'
    output_dir.mkdir(exist_ok=True)
    
    # Save ticker stats
    ticker_stats_path = output_dir / 'lottery_ticker_stats.json'
    ticker_stats.to_json(ticker_stats_path, orient='records', indent=2)
    print(f"\nSaved ticker stats to {ticker_stats_path}")
    
    # Save score weights
    weights_path = output_dir / 'lottery_score_weights.json'
    with open(weights_path, 'w') as f:
        json.dump(weights, f, indent=2)
    print(f"Saved score weights to {weights_path}")
    
    # Save distribution analysis
    distribution_path = output_dir / 'lottery_score_distribution.json'
    with open(distribution_path, 'w') as f:
        json.dump(distribution, f, indent=2)
    print(f"Saved distribution analysis to {distribution_path}")
    
    # Print summary
    print("\n" + "="*60)
    print("SCORING MODEL SUMMARY")
    print("="*60)
    print(f"\nTotal fires analyzed: {distribution['total_fires']:,}")
    print(f"Date range: {distribution['total_days']} days")
    print(f"\nTier 1 (score ≥18): {distribution['tier1']['count']:,} fires ({distribution['tier1']['per_day']:.1f}/day)")
    print(f"  High-peak rate: {distribution['tier1']['high_peak_rate']:.1f}%")
    print(f"\nTier 2 (score 12-17): {distribution['tier2']['count']:,} fires ({distribution['tier2']['per_day']:.1f}/day)")
    print(f"  High-peak rate: {distribution['tier2']['high_peak_rate']:.1f}%")
    print(f"\nTier 3 (score <12): {distribution['tier3']['count']:,} fires ({distribution['tier3']['per_day']:.1f}/day)")
    print(f"  High-peak rate: {distribution['tier3']['high_peak_rate']:.1f}%")
    print(f"\nScore range: {distribution['score_distribution']['min']}-{distribution['score_distribution']['max']}")
    print(f"Mean score: {distribution['score_distribution']['mean']:.1f}")
    print(f"Median score: {distribution['score_distribution']['median']:.1f}")
    
    print("\nTop 10 tickers by high-peak rate:")
    print(ticker_stats.head(10)[['ticker', 'n_fires', 'high_peak_rate', 'ci_width', 'tier']].to_string(index=False))


if __name__ == '__main__':
    main()
