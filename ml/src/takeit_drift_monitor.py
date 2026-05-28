# ml/src/takeit_drift_monitor.py
# Daily TAKE-IT drift + validation monitor. Runs as part of `make update`
# (the user's existing daily research target). Outputs:
#   - docs/tmp/takeit-drift-YYYY-MM-DD.md  (committed by make update)
#   - ml/plots/takeit-drift/reliability_<feed>_<date>.png (committed)
#   - rows in takeit_health_daily (ml_-prefixed metric_name)
#
# Targets compared:
#   - peak_ceiling_pct >= 20    (the model's training target)
#   - realized_trail30_10_pct >= 0  (trade-worthiness target)
# The divergence between rolling AUCs on these two targets is itself a
# tracked metric — the empirical case for the deferred realized-target retrain.

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

try:
    import matplotlib

    matplotlib.use('Agg')  # must precede pyplot import
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import psycopg2
    from sklearn.metrics import roc_auc_score
except ImportError:
    print('Missing dependencies. Run:')
    print('  ml/.venv/bin/pip install -r ml/requirements.txt')
    sys.exit(1)

from utils import get_connection  # type: ignore[import-not-found]  # noqa: I001


ML_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_ROOT.parent
DOCS_TMP = REPO_ROOT / 'docs' / 'tmp'
PLOT_DIR = ML_ROOT / 'plots' / 'takeit-drift'

ROLLING_AUC_DROP_MAX = 0.05
PER_SEGMENT_AUC_MIN = 0.55
PER_SEGMENT_MIN_N = 100
FEATURE_Z_ALERT = 3.0


def rolling_auc(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """AUC, returns NaN if y_true is single-class, empty, or y_pred has NaN."""
    if len(y_true) == 0 or len(np.unique(y_true)) < 2:
        return float('nan')
    if np.any(np.isnan(y_pred)):
        return float('nan')
    return float(roc_auc_score(y_true, y_pred))


def reliability_bins(
    y_true: np.ndarray, y_pred: np.ndarray, n_bins: int = 10,
) -> list[tuple[float, float, int]]:
    """Return (predicted_mean, actual_rate, count) per equal-width prob bin."""
    bins = np.linspace(0, 1, n_bins + 1)
    out: list[tuple[float, float, int]] = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        if i == n_bins - 1:
            mask = (y_pred >= lo) & (y_pred <= hi)
        else:
            mask = (y_pred >= lo) & (y_pred < hi)
        n = int(mask.sum())
        if n == 0:
            out.append((float((lo + hi) / 2), float('nan'), 0))
            continue
        out.append(
            (
                float(y_pred[mask].mean()),
                float(y_true[mask].mean()),
                n,
            )
        )
    return out


def per_segment_auc(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    segments: np.ndarray,
    min_n: int = PER_SEGMENT_MIN_N,
) -> dict[str, dict[str, float | int]]:
    """AUC per segment label. Segments with count < min_n are skipped."""
    out: dict[str, dict[str, float | int]] = {}
    for seg in np.unique(segments):
        mask = segments == seg
        n = int(mask.sum())
        if n < min_n:
            continue
        auc = rolling_auc(y_true[mask], y_pred[mask])
        out[str(seg)] = {'auc': auc, 'n': n}
    return out


# Exported for the deferred per-feature drift monitor (see Phase 3 scope notes in
# docs/superpowers/specs/2026-05-28-takeit-reliability-hardening.md). Not called
# in main() until the per-feature baseline table ships in a follow-up plan.
def feature_zscore(
    today: np.ndarray, baseline_mean: float, baseline_std: float,
) -> float:
    """Z-score of today's mean against baseline distribution. NaN on zero std."""
    if baseline_std == 0 or np.isnan(baseline_std):
        return float('nan')
    today_mean = float(np.nanmean(today)) if today.size else float('nan')
    if np.isnan(today_mean):
        return float('nan')
    return (today_mean - baseline_mean) / baseline_std


def fetch_recent_fires(
    conn: psycopg2.extensions.connection, feed: str, lookback_days: int,
) -> pd.DataFrame:
    table = 'lottery_finder_fires' if feed == 'lottery' else 'silent_boom_alerts'
    sql = f"""
      SELECT
        date,
        underlying_symbol,
        option_type,
        dte,
        takeit_prob,
        takeit_model_version,
        peak_ceiling_pct,
        realized_trail30_10_pct
      FROM {table}
      WHERE date >= CURRENT_DATE - INTERVAL '{lookback_days} days'
        AND takeit_prob IS NOT NULL
        AND peak_ceiling_pct IS NOT NULL
    """
    return pd.read_sql(sql, conn, parse_dates=['date'])


def compute_feed_drift(df: pd.DataFrame, feed: str) -> dict:
    out: dict = {'feed': feed, 'n_rows_total': len(df)}
    if df.empty:
        return out

    today = pd.Timestamp.now('UTC').normalize().tz_localize(None).date()
    for window_days, label in [(7, '7d'), (30, '30d')]:
        cutoff = today - dt.timedelta(days=window_days)
        win = df[df['date'] >= pd.Timestamp(cutoff)]
        if win.empty:
            continue
        y_pred = win['takeit_prob'].to_numpy()
        peak_label = (win['peak_ceiling_pct'].to_numpy() >= 20).astype(int)
        out[f'auc_{label}_peak'] = rolling_auc(peak_label, y_pred)
        if 'realized_trail30_10_pct' in win:
            real_label = (
                win['realized_trail30_10_pct'].fillna(-100).to_numpy() >= 0
            ).astype(int)
            out[f'auc_{label}_realized'] = rolling_auc(real_label, y_pred)

    # Per-segment AUC on 30d window
    cutoff30 = today - dt.timedelta(days=30)
    win30 = df[df['date'] >= pd.Timestamp(cutoff30)]
    if not win30.empty:
        y_pred = win30['takeit_prob'].to_numpy()
        peak_label = (win30['peak_ceiling_pct'].to_numpy() >= 20).astype(int)
        dte_seg = pd.cut(
            win30['dte'],
            bins=[-1, 0, 3, 100],
            labels=['0DTE', '1-3', '4+'],
        ).astype(str).to_numpy()
        out['by_dte'] = per_segment_auc(peak_label, y_pred, dte_seg)
        out['by_option_type'] = per_segment_auc(
            peak_label, y_pred, win30['option_type'].astype(str).to_numpy(),
        )

    return out


def render_markdown_report(
    today_str: str, lottery: dict, silent_boom: dict,
) -> str:
    lines: list[str] = []
    lines.append(f'# TAKE-IT drift report — {today_str}')
    lines.append('')
    for feed_name, summary in [('lottery', lottery), ('silent_boom', silent_boom)]:
        lines.append(f'## {feed_name}')
        lines.append('')
        lines.append(f'- rows in 30d window: {summary.get("n_rows_total", 0)}')
        for k in ('auc_7d_peak', 'auc_30d_peak', 'auc_7d_realized', 'auc_30d_realized'):
            v = summary.get(k)
            if v is not None:
                if isinstance(v, float) and not np.isnan(v):
                    lines.append(f'- {k}: {v:.3f}')
                else:
                    lines.append(f'- {k}: n/a')
        if 'by_dte' in summary:
            lines.append('')
            lines.append('### per-DTE 30d AUC (peak target)')
            for seg, m in summary['by_dte'].items():
                lines.append(f'- {seg}: AUC={m["auc"]:.3f}  n={m["n"]}')
        if 'by_option_type' in summary:
            lines.append('')
            lines.append('### per-option-type 30d AUC (peak target)')
            for seg, m in summary['by_option_type'].items():
                lines.append(f'- {seg}: AUC={m["auc"]:.3f}  n={m["n"]}')
        lines.append('')
    return '\n'.join(lines)


def plot_reliability(df: pd.DataFrame, feed: str, today_str: str) -> Path | None:
    if df.empty:
        return None
    cutoff30 = pd.Timestamp.now('UTC').normalize().tz_localize(None) - pd.Timedelta(days=30)
    win = df[df['date'] >= cutoff30]
    if win.empty:
        return None
    y_pred = win['takeit_prob'].to_numpy()
    y_true = (win['peak_ceiling_pct'].to_numpy() >= 20).astype(int)
    bins = reliability_bins(y_true, y_pred, n_bins=10)

    PLOT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PLOT_DIR / f'reliability_{feed}_{today_str}.png'
    fig, ax = plt.subplots(figsize=(8, 6))
    pred = [b[0] for b in bins]
    actual = [b[1] for b in bins]
    ax.plot([0, 1], [0, 1], 'k--', label='perfect calibration')
    ax.plot(pred, actual, 'o-', label=feed)
    ax.set_xlabel('predicted prob (bin mean)')
    ax.set_ylabel('actual rate (peak >= 20%)')
    ax.set_title(f'TAKE-IT reliability — {feed} — 30d ending {today_str}')
    ax.legend()
    ax.grid(alpha=0.3)
    fig.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    return out_path


def main() -> int:
    today_str = dt.date.today().isoformat()
    conn = get_connection()
    try:
        lottery_df = fetch_recent_fires(conn, 'lottery', 30)
        sb_df = fetch_recent_fires(conn, 'silent_boom', 30)

        lottery_summary = compute_feed_drift(lottery_df, 'lottery')
        sb_summary = compute_feed_drift(sb_df, 'silent_boom')

        plot_reliability(lottery_df, 'lottery', today_str)
        plot_reliability(sb_df, 'silent_boom', today_str)

        report = render_markdown_report(today_str, lottery_summary, sb_summary)
        DOCS_TMP.mkdir(parents=True, exist_ok=True)
        report_path = DOCS_TMP / f'takeit-drift-{today_str}.md'
        report_path.write_text(report, encoding='utf-8')
        print(f'Wrote {report_path}')

        # Persist key metrics to takeit_health_daily (ml_-prefixed names)
        with conn.cursor() as cur:
            for feed_name, s in (('lottery', lottery_summary), ('silent_boom', sb_summary)):
                for key in ('auc_7d_peak', 'auc_30d_peak', 'auc_7d_realized', 'auc_30d_realized'):
                    val = s.get(key)
                    if val is None or (isinstance(val, float) and np.isnan(val)):
                        continue
                    cur.execute(
                        """
                        INSERT INTO takeit_health_daily
                          (date, feed, metric_name, metric_value)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (date, feed, metric_name)
                        DO UPDATE SET
                          metric_value = EXCLUDED.metric_value,
                          computed_at = NOW()
                        """,
                        (today_str, feed_name, f'ml_{key}', float(val)),
                    )
            conn.commit()
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
