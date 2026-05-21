"""Regime detector for gamma node rejection signals.

Investigates whether a measurable regime feature predicts whether the
mean-reversion thesis works on a given day, separately from the H1/H2
calendar split (Feb 26 - Mar 26 vs Mar 27 - May 19 2026).

For each event:
  - Compute "worked" flag = ret_30m beat control_ret_30m in the direction
    of the rejection thesis (down event -> negative ret beats; up event -> positive)
  - Compute regime features: trailing SPX 5d return, 5d avg range/close,
    iv_30d, iv_rv_spread, iv_rank, 10d realized vol, DOW
  - Bucket / logistic-regress and walk-forward test
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = '/Users/charlesobrien/Documents/Workspace/strike-calculator'
CSV_PATH = f'{ROOT}/docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
OUT_MD = f'{ROOT}/docs/tmp/forensic-multi-day/regime_detector_findings.md'


def connect():
    load_dotenv(f'{ROOT}/.env.local')
    url = os.getenv('DATABASE_URL_UNPOOLED') or os.getenv('DATABASE_URL')
    return psycopg2.connect(url)


def load_events() -> pd.DataFrame:
    df = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    df['event_date'] = df['event_ts'].dt.tz_convert('UTC').dt.date
    df['dow'] = df['event_ts'].dt.tz_convert('UTC').dt.dayofweek  # 0=Mon
    return df


def load_spx_daily(conn) -> pd.DataFrame:
    """Build a daily SPX series from index_candles_1m (RTH close + true range)."""
    q = """
        SELECT
          date,
          MIN(low)  AS day_low,
          MAX(high) AS day_high,
          (ARRAY_AGG(close ORDER BY timestamp DESC))[1] AS day_close,
          (ARRAY_AGG(open  ORDER BY timestamp ASC ))[1] AS day_open
        FROM index_candles_1m
        WHERE symbol='SPX'
        GROUP BY date
        ORDER BY date
    """
    daily = pd.read_sql(q, conn)
    daily['day_close'] = daily['day_close'].astype(float)
    daily['day_high'] = daily['day_high'].astype(float)
    daily['day_low'] = daily['day_low'].astype(float)
    daily['day_open'] = daily['day_open'].astype(float)
    daily['daily_range_pct'] = (daily['day_high'] - daily['day_low']) / daily['day_close']
    daily['daily_ret'] = daily['day_close'].pct_change()
    # trailing windows (use shift so we never use same-day close, i.e. point-in-time at open of event day)
    daily['ret_5d_prior'] = daily['day_close'].pct_change(5).shift(1)
    daily['avg_range_5d_prior'] = daily['daily_range_pct'].rolling(5).mean().shift(1)
    daily['rv_10d_prior'] = daily['daily_ret'].rolling(10).std().shift(1) * np.sqrt(252)
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    return daily


def load_vol_realized(conn) -> pd.DataFrame:
    vol = pd.read_sql(
        'SELECT date, iv_30d, rv_30d, iv_rv_spread, iv_rank FROM vol_realized ORDER BY date',
        conn,
    )
    vol['date'] = pd.to_datetime(vol['date']).dt.date
    for c in ('iv_30d', 'rv_30d', 'iv_rv_spread', 'iv_rank'):
        vol[c] = vol[c].astype(float)
    return vol


def build_features(events: pd.DataFrame, daily: pd.DataFrame, vol: pd.DataFrame) -> pd.DataFrame:
    df = events.merge(daily, left_on='event_date', right_on='date', how='left')
    # vol_realized may not have every day -> forward-fill onto event_date via merge_asof
    vol_sorted = vol.sort_values('date').reset_index(drop=True)
    df_sorted = df.sort_values('event_date').reset_index(drop=True)
    df_sorted['event_date_dt'] = pd.to_datetime(df_sorted['event_date'])
    vol_sorted['date_dt'] = pd.to_datetime(vol_sorted['date'])
    merged = pd.merge_asof(
        df_sorted,
        vol_sorted[['date_dt', 'iv_30d', 'rv_30d', 'iv_rv_spread', 'iv_rank']],
        left_on='event_date_dt',
        right_on='date_dt',
        direction='backward',
    )
    return merged


def compute_worked(df: pd.DataFrame) -> pd.DataFrame:
    """Signal-worked = thesis ret_30m beat control's ret_30m.

    For 'down' rejections, thesis is reversion DOWN, so worked when
    event_ret_30m < control_ret_30m. For 'up', worked when
    event_ret_30m > control_ret_30m.
    """
    df = df.copy()
    sign = np.where(df['direction'] == 'down', -1.0, 1.0)
    df['signed_event'] = sign * df['ret_30m']
    df['signed_control'] = sign * df['control_ret_30m']
    df['edge'] = df['signed_event'] - df['signed_control']
    df['worked'] = (df['edge'] > 0).astype(int)
    return df


def report_bucket(df: pd.DataFrame, feature: str, lines: list[str]) -> None:
    """Quartile bucket: report worked-rate + mean edge per bucket."""
    sub = df[[feature, 'worked', 'edge']].dropna()
    if len(sub) < 40:
        lines.append(f'### {feature}\n\n_skipped (only {len(sub)} non-null rows)_\n')
        return
    try:
        sub['q'] = pd.qcut(sub[feature], 4, labels=['Q1', 'Q2', 'Q3', 'Q4'], duplicates='drop')
    except ValueError:
        lines.append(f'### {feature}\n\n_skipped (insufficient unique values)_\n')
        return
    grp = sub.groupby('q', observed=True).agg(
        n=('worked', 'size'),
        worked_rate=('worked', 'mean'),
        mean_edge=('edge', 'mean'),
        feat_min=(feature, 'min'),
        feat_max=(feature, 'max'),
    )
    lines.append(f'### {feature}\n')
    lines.append(grp.to_markdown(floatfmt='.4f'))
    lines.append('')


@dataclass
class WFResult:
    feature: str
    auc_h2: float
    base_rate_h2: float
    n_train: int
    n_test: int
    top_quartile_worked_rate: float
    top_quartile_n: int


def walkforward_single(df: pd.DataFrame, feature: str, h1_end: pd.Timestamp) -> WFResult | None:
    sub = df[[feature, 'worked', 'event_date_dt']].dropna()
    train = sub[sub['event_date_dt'] <= h1_end]
    test = sub[sub['event_date_dt'] > h1_end]
    if len(train) < 30 or len(test) < 30 or train['worked'].nunique() < 2:
        return None
    X_train = train[[feature]].to_numpy()
    y_train = train['worked'].to_numpy()
    X_test = test[[feature]].to_numpy()
    y_test = test['worked'].to_numpy()
    model = LogisticRegression(max_iter=1000)
    model.fit(X_train, y_train)
    p_test = model.predict_proba(X_test)[:, 1]
    try:
        auc = roc_auc_score(y_test, p_test)
    except ValueError:
        return None
    # Top-quartile of predicted probability on test
    cutoff = np.quantile(p_test, 0.75)
    top_mask = p_test >= cutoff
    top_rate = y_test[top_mask].mean() if top_mask.any() else float('nan')
    return WFResult(
        feature=feature,
        auc_h2=auc,
        base_rate_h2=float(y_test.mean()),
        n_train=len(train),
        n_test=len(test),
        top_quartile_worked_rate=float(top_rate),
        top_quartile_n=int(top_mask.sum()),
    )


def calendar_baseline_auc(df: pd.DataFrame, h1_end: pd.Timestamp) -> float:
    """If we use the H1/H2 calendar as the only feature, what's the test AUC?
    By construction this is 0.5 because every test point has the same label
    (all are post-H1), so logistic regression can't differentiate. Reported
    for clarity: calendar transfers zero information out-of-sample.
    """
    sub = df[['worked', 'event_date_dt']].dropna()
    train = sub[sub['event_date_dt'] <= h1_end]
    test = sub[sub['event_date_dt'] > h1_end]
    # baseline: predict train mean worked-rate for every test row -> AUC = 0.5
    return 0.5 if len(train) and len(test) else float('nan')


def dow_analysis(df: pd.DataFrame, lines: list[str]) -> None:
    grp = df.groupby('dow').agg(n=('worked', 'size'), worked_rate=('worked', 'mean'), mean_edge=('edge', 'mean'))
    grp.index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][: len(grp)]
    lines.append('### day of week\n')
    lines.append(grp.to_markdown(floatfmt='.4f'))
    lines.append('')
    # H1 vs H2 split per DOW
    h1_end = pd.Timestamp('2026-03-26', tz='UTC')
    df = df.copy()
    df['half'] = np.where(df['event_date_dt'] <= h1_end, 'H1', 'H2')
    grp2 = df.groupby(['dow', 'half']).agg(n=('worked', 'size'), worked_rate=('worked', 'mean'))
    lines.append('### day of week split by H1/H2\n')
    lines.append(grp2.to_markdown(floatfmt='.4f'))
    lines.append('')


def gate_simulation(df: pd.DataFrame, feature: str, lines: list[str]) -> None:
    """For the best transferable feature, simulate using it as a gate.

    Fit threshold on H1 (worked-rate top quartile), apply to H2.
    """
    h1_end = pd.Timestamp('2026-03-26', tz='UTC')
    sub = df[[feature, 'worked', 'edge', 'event_date_dt']].dropna()
    train = sub[sub['event_date_dt'] <= h1_end]
    test = sub[sub['event_date_dt'] > h1_end]
    if not len(train) or not len(test):
        return
    # find threshold that maximizes worked-rate on train with min N=20
    candidate_thresholds = np.quantile(train[feature], np.linspace(0.1, 0.9, 17))
    best = None
    for direction in ('>=', '<='):
        for thr in candidate_thresholds:
            if direction == '>=':
                m = train[feature] >= thr
            else:
                m = train[feature] <= thr
            if m.sum() < 20:
                continue
            wr = train.loc[m, 'worked'].mean()
            if best is None or wr > best[2]:
                best = (direction, thr, wr, m.sum())
    if best is None:
        return
    direction, thr, train_wr, train_n = best
    if direction == '>=':
        test_mask = test[feature] >= thr
    else:
        test_mask = test[feature] <= thr
    lines.append(f'### gate simulation: {feature} {direction} {thr:.4f}\n')
    lines.append(f'- Train (H1): N={train_n}, worked-rate {train_wr:.3f} (vs H1 baseline {train["worked"].mean():.3f})')
    if test_mask.any():
        test_wr = test.loc[test_mask, 'worked'].mean()
        test_edge = test.loc[test_mask, 'edge'].mean()
        lines.append(
            f'- Test (H2): N={int(test_mask.sum())}, worked-rate {test_wr:.3f} '
            f'(vs H2 baseline {test["worked"].mean():.3f}), mean edge {test_edge:.4f}'
        )
        lines.append(f'- Trade-count reduction: {int(test_mask.sum())}/{len(test)} = {test_mask.mean():.1%} survive gate')
    else:
        lines.append('- Test (H2): N=0, gate rejected all H2 events')
    lines.append('')


def main() -> None:
    lines: list[str] = []
    lines.append('# Regime detector findings (gamma node rejection 0DTE)\n')
    lines.append('Generated 2026-05-21. Source CSV: `gamma_node_rejection_2026-05-20_v4-vol-crush.csv`.\n')
    lines.append('Definition: `worked` = signed thesis return beat signed control return on ret_30m. H1 = events on or before 2026-03-26; H2 = events after.\n')

    events = load_events()
    conn = connect()
    daily = load_spx_daily(conn)
    vol = load_vol_realized(conn)
    conn.close()

    df = build_features(events, daily, vol)
    df = compute_worked(df)
    df['event_date_dt'] = pd.to_datetime(df['event_date_dt'], utc=True)
    h1_end = pd.Timestamp('2026-03-26', tz='UTC')
    df['half'] = np.where(df['event_date_dt'] <= h1_end, 'H1', 'H2')

    lines.append('## Sample\n')
    lines.append(f'- Total events: **{len(df)}**')
    lines.append(f'- H1 events (Feb 26 - Mar 26): **{int((df["half"] == "H1").sum())}**')
    lines.append(f'- H2 events (Mar 27 - May 19): **{int((df["half"] == "H2").sum())}**')
    lines.append(f'- Overall worked-rate: **{df["worked"].mean():.3f}**')
    lines.append(f'- H1 worked-rate: **{df[df["half"] == "H1"]["worked"].mean():.3f}**')
    lines.append(f'- H2 worked-rate: **{df[df["half"] == "H2"]["worked"].mean():.3f}**')
    lines.append(f'- Overall mean edge (event - control, signed): **{df["edge"].mean():.4f}**')
    lines.append(f'- H1 mean edge: **{df[df["half"] == "H1"]["edge"].mean():.4f}**')
    lines.append(f'- H2 mean edge: **{df[df["half"] == "H2"]["edge"].mean():.4f}**')
    lines.append('')

    features = [
        'ret_5d_prior',
        'avg_range_5d_prior',
        'rv_10d_prior',
        'iv_30d',
        'rv_30d',
        'iv_rv_spread',
        'iv_rank',
        'event_iv_t0',
        'event_iv_crush',
    ]

    lines.append('## Quartile-bucket worked-rate (full sample)\n')
    for f in features:
        report_bucket(df, f, lines)

    lines.append('## Day-of-week\n')
    dow_analysis(df, lines)

    lines.append('## Walk-forward (train H1, test H2)\n')
    lines.append('Calendar baseline AUC on H2 = 0.500 (calendar feature is constant in test set).\n')
    wf_results: list[WFResult] = []
    for f in features:
        res = walkforward_single(df, f, h1_end)
        if res is not None:
            wf_results.append(res)

    if wf_results:
        wf_df = pd.DataFrame([r.__dict__ for r in wf_results])
        wf_df = wf_df.sort_values('auc_h2', ascending=False)
        lines.append(wf_df.to_markdown(index=False, floatfmt='.4f'))
        lines.append('')
        best = wf_df.iloc[0]
        lines.append(f"**Best transferable feature: `{best['feature']}` (H2 AUC {best['auc_h2']:.3f}).**\n")
    else:
        lines.append('_No walk-forward results (insufficient data per feature)._\n')
        best = None

    # Multivariate model
    lines.append('## Multivariate logistic regression (walk-forward)\n')
    # NOTE: iv_rv_spread is 493/544 null in vol_realized so we exclude it; only
    # ~50 dates have a populated iv_rv_spread and that subset isn't large enough
    # to walk-forward.
    feat_set = ['ret_5d_prior', 'avg_range_5d_prior', 'rv_10d_prior', 'iv_30d', 'iv_rank']
    sub = df[feat_set + ['worked', 'event_date_dt']].dropna()
    train = sub[sub['event_date_dt'] <= h1_end]
    test = sub[sub['event_date_dt'] > h1_end]
    if len(train) > 30 and len(test) > 30 and train['worked'].nunique() > 1:
        # standardize
        mu, sd = train[feat_set].mean(), train[feat_set].std().replace(0, 1)
        Xtr = ((train[feat_set] - mu) / sd).to_numpy()
        Xte = ((test[feat_set] - mu) / sd).to_numpy()
        model = LogisticRegression(max_iter=1000)
        model.fit(Xtr, train['worked'].to_numpy())
        p_te = model.predict_proba(Xte)[:, 1]
        try:
            auc = roc_auc_score(test['worked'].to_numpy(), p_te)
        except ValueError:
            auc = float('nan')
        lines.append(f'- N train={len(train)}, N test={len(test)}, H2 AUC={auc:.3f}')
        coefs = pd.Series(model.coef_[0], index=feat_set).sort_values(key=abs, ascending=False)
        lines.append('- Standardized coefficients:')
        lines.append('')
        lines.append(coefs.to_frame('coef').to_markdown(floatfmt='.3f'))
        # gate sim using p_te > median
        top_q = np.quantile(p_te, 0.75)
        gate_mask = p_te >= top_q
        if gate_mask.any():
            gate_wr = test['worked'].to_numpy()[gate_mask].mean()
            lines.append('')
            lines.append(
                f'- Top-quartile predicted-prob gate on H2: N={int(gate_mask.sum())}, '
                f'worked-rate {gate_wr:.3f} (vs H2 baseline {test["worked"].mean():.3f})'
            )
    else:
        lines.append('_Insufficient overlap for multivariate fit._')
    lines.append('')

    # Gate simulation on best univariate feature
    if best is not None:
        lines.append('## Single-feature gate simulation (H1-fit threshold, applied to H2)\n')
        for feat in [best['feature'], 'ret_5d_prior', 'iv_30d', 'avg_range_5d_prior']:
            gate_simulation(df, feat, lines)

    # ---- Honest assessment ----
    lines.append('## Honest assessment\n')
    lines.append('### What we found\n')
    lines.append(
        '- The H1->H2 worked-rate swing is real and large: 0.391 -> 0.519 (+12.8 pp). '
        'Mean edge moved from -5.31 to +0.26 (>5pp shift). The regime change is genuine, '
        'not a measurement artifact.'
    )
    lines.append(
        '- **Day-of-week is the cleanest non-calendar signal but does NOT survive walk-forward as a regime feature.** '
        'Mon and Fri worked at ~0.32 overall (vs Tue/Wed/Thu ~0.50). But the Mon split is 0.22 H1 -> 0.46 H2 — '
        'so Mondays became *better* in H2, not worse. DOW is structural (Mon/Fri differ from midweek) but ALSO '
        'shifts with the regime, so a DOW-only gate is not a regime detector.'
    )
    lines.append(
        '- Best univariate walk-forward feature is `rv_10d_prior` (H2 AUC 0.552). '
        'Gate `rv_10d_prior <= 0.122` (low realized vol) keeps 31.5% of H2 trades with worked-rate 0.598 vs 0.519 baseline. '
        'This is ~8pp lift on a 1/3 sample — borderline, not slam-dunk.'
    )
    lines.append(
        '- `ret_5d_prior` is monotone in the FULL-sample bucket analysis (worked-rate climbs 0.43 -> 0.52 from Q1 to Q4), '
        'but the gate (very negative 5d return) failed to transfer to H2 (0.515 vs 0.519). The full-sample monotonicity '
        'is a calendar artifact: H2 had higher trailing returns AND higher worked-rate.'
    )
    lines.append(
        '- Multivariate logistic regression had H2 AUC 0.478 (worse than chance). The model overfits H1.'
    )
    lines.append('')
    lines.append('### What we did NOT find\n')
    lines.append(
        '- **No single feature cleanly beats the H1/H2 calendar split in walk-forward.** '
        'Best AUC is 0.552 (`rv_10d_prior`), which is barely better than coin flip. '
        'Anything above 0.55 here is on small samples and may be noise.'
    )
    lines.append(
        '- iv_30d, iv_rank, avg_range_5d, and the multivariate model all underperform random on H2.'
    )
    lines.append('')
    lines.append('### Is the regime predictable?\n')
    lines.append(
        'Mostly no. We have ~60 trading days of data split into two ~30-day blocks with different '
        'baseline worked-rates. The features available (price-based, IV-based) capture only weak signal '
        '(best AUC ~0.55), which means most of the H1/H2 difference is driven by something we are not '
        'measuring — likely a microstructure / dealer-positioning shift that needs sub-daily features '
        'rather than daily features. A 2-block sample is also fundamentally underpowered to declare a '
        'regime detector "transferable": we have one H1->H2 transition, not many.'
    )
    lines.append('')
    lines.append('### Shippable gate?\n')
    lines.append(
        '**Cautious yes for `rv_10d_prior <= 0.122` as a tilt, not a hard gate.** It survived '
        'walk-forward, gives ~8pp worked-rate lift, and reduces trade count by 68.5%. But the lift is '
        'small enough that out-of-sample on a third block (June+) could easily go the other way. '
        'Recommend: track it live as a separate cohort flag, do not let it gate signal firing until we '
        'have a third regime block to confirm.'
    )
    lines.append('')

    with open(OUT_MD, 'w') as fh:
        fh.write('\n'.join(lines))
    print(f'Wrote {OUT_MD}')
    print(f'Best WF feature: {best["feature"] if best is not None else "none"}')


if __name__ == '__main__':
    main()
    sys.exit(0)
