"""
Payoff/ceiling model decision-grade EDA probe.

Usage:
    set -a && source .env.local && set +a
    ml/.venv/bin/python ml/src/payoff_eda_probe.py

Outputs plots to ml/plots/.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2
from scipy import stats

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

REPO_ROOT = Path(__file__).resolve().parents[2]
PLOTS_DIR = REPO_ROOT / "ml" / "plots"
PLOTS_DIR.mkdir(parents=True, exist_ok=True)
DOCS_TMP = REPO_ROOT / "docs" / "tmp"
DOCS_TMP.mkdir(parents=True, exist_ok=True)


def _get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL not set.", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url, sslmode="require")


# ── Queries (restrict to rows with takeit_features populated) ─────────────────

LOTTERY_SQL = """
    SELECT
        id, date, trigger_time_ct AS fire_time,
        takeit_prob, takeit_features,
        peak_ceiling_pct,
        realized_trail30_10_pct AS realized_trail_r,
        realized_hard30m_pct,
        entry_price, dte
    FROM lottery_finder_fires
    WHERE enriched_at IS NOT NULL
      AND takeit_features IS NOT NULL
      AND date >= CURRENT_DATE - INTERVAL '90 days'
    ORDER BY trigger_time_ct
"""

SILENTBOOM_SQL = """
    SELECT
        id, date, bucket_ct AS fire_time,
        takeit_prob, takeit_features,
        peak_ceiling_pct,
        realized_trail30_10_pct AS realized_trail_r,
        realized_30m_pct,
        realized_60m_pct,
        realized_eod_pct,
        entry_price, dte, ask_pct
    FROM silent_boom_alerts
    WHERE enriched_at IS NOT NULL
      AND takeit_features IS NOT NULL
      AND date >= CURRENT_DATE - INTERVAL '90 days'
    ORDER BY bucket_ct
"""

# Separate queries for the full enriched set (for Section A tail distributions
# we want all rows, not just those with features).
LOTTERY_FULL_SQL = """
    SELECT
        date, trigger_time_ct AS fire_time,
        takeit_prob,
        peak_ceiling_pct,
        realized_trail30_10_pct AS realized_trail_r
    FROM lottery_finder_fires
    WHERE enriched_at IS NOT NULL
      AND date >= CURRENT_DATE - INTERVAL '90 days'
    ORDER BY trigger_time_ct
"""

SILENTBOOM_FULL_SQL = """
    SELECT
        date, bucket_ct AS fire_time,
        takeit_prob,
        peak_ceiling_pct,
        realized_trail30_10_pct AS realized_trail_r
    FROM silent_boom_alerts
    WHERE enriched_at IS NOT NULL
      AND date >= CURRENT_DATE - INTERVAL '90 days'
    ORDER BY bucket_ct
"""


def dist_stats(s: pd.Series, thresholds=(20, 50, 100, 200)) -> dict:
    s = pd.to_numeric(s, errors="coerce").dropna()
    if len(s) == 0:
        return {}
    out = {
        "n": len(s),
        "mean": float(s.mean()),
        "median": float(s.median()),
        "std": float(s.std()),
        "P75": float(s.quantile(0.75)),
        "P90": float(s.quantile(0.90)),
        "P95": float(s.quantile(0.95)),
        "max": float(s.max()),
    }
    for t in thresholds:
        out[f"pct_above_{t}"] = float((s >= t).mean() * 100)
    return out


def print_dist(label: str, d: dict) -> None:
    if not d:
        print(f"  {label}: NO DATA")
        return
    print(f"  {label}:")
    print(f"    n={d['n']:,}  mean={d['mean']:.2f}  median={d['median']:.2f}  std={d['std']:.2f}")
    print(f"    P75={d['P75']:.2f}  P90={d['P90']:.2f}  P95={d['P95']:.2f}  max={d['max']:.2f}")
    for k, v in d.items():
        if k.startswith("pct_above_"):
            thr = k.replace("pct_above_", "")
            print(f"    % >= {thr:>4s}%: {v:.1f}%")


def parse_features(df: pd.DataFrame) -> pd.DataFrame:
    """Parse takeit_features JSONB column into numeric columns, return feat df."""
    feat_rows = []
    for _, row in df.iterrows():
        tf = row.get("takeit_features")
        if tf is None or (isinstance(tf, float) and np.isnan(tf)):
            feat_rows.append({})
            continue
        if isinstance(tf, str):
            try:
                tf = json.loads(tf)
            except Exception:
                feat_rows.append({})
                continue
        if isinstance(tf, dict):
            feat_rows.append(tf)
        else:
            feat_rows.append({})
    feat_df = pd.DataFrame(feat_rows, index=df.index)
    feat_df = feat_df.apply(pd.to_numeric, errors="coerce")
    feat_df = feat_df.dropna(axis=1, how="all")
    return feat_df


# ── Section A ─────────────────────────────────────────────────────────────────
def section_a(full_df: pd.DataFrame, feat_df_base: pd.DataFrame, label: str) -> None:
    print(f"\n{'='*62}")
    print(f"SECTION A — PAYOFF DISTRIBUTION: {label}")
    print(f"{'='*62}")
    print(f"  Full enriched set (90d): n={len(full_df):,}")
    print(f"  Rows with takeit_features: n={len(feat_df_base):,}")

    for df_use, set_name in [(full_df, "All enriched"), (feat_df_base, "Features-only subset")]:
        print(f"\n  -- {set_name} --")
        for col, name in [
            ("realized_trail_r", "Realized trail30/10 R"),
            ("peak_ceiling_pct", "Peak ceiling %"),
        ]:
            if col in df_use.columns:
                print_dist(name, dist_stats(df_use[col]))
        if "peak_ceiling_pct" in df_use.columns:
            s = pd.to_numeric(df_use["peak_ceiling_pct"], errors="coerce").dropna().clip(lower=0)
            if len(s) > 0:
                log_s = np.log1p(s)
                print(f"  log1p(peak): mean={log_s.mean():.3f}  std={log_s.std():.3f}  "
                      f"P75={log_s.quantile(0.75):.3f}  P90={log_s.quantile(0.90):.3f}")


# ── Section B ─────────────────────────────────────────────────────────────────
def section_b(full_df: pd.DataFrame, label: str) -> None:
    print(f"\n{'='*62}")
    print(f"SECTION B — ORTHOGONALITY TO TAKE-IT: {label}")
    print(f"{'='*62}")

    sub = full_df.copy()
    sub["takeit_prob"] = pd.to_numeric(sub["takeit_prob"], errors="coerce")
    sub["peak_ceiling_pct"] = pd.to_numeric(sub["peak_ceiling_pct"], errors="coerce")
    sub["realized_trail_r"] = pd.to_numeric(sub["realized_trail_r"], errors="coerce")

    n_total = len(sub)
    n_with_prob = sub["takeit_prob"].notna().sum()
    print(f"  takeit_prob present: {n_with_prob:,} / {n_total:,} ({100*n_with_prob/max(n_total,1):.1f}%)")
    print(f"  takeit_prob NULL rate: {100*(1-n_with_prob/max(n_total,1)):.1f}%")

    sub = sub[sub["takeit_prob"].notna()].copy()
    if len(sub) < 30:
        print("  INSUFFICIENT takeit_prob rows.")
        return

    tp = sub["takeit_prob"]

    for col, name in [("realized_trail_r", "trail30/10 R"), ("peak_ceiling_pct", "peak %")]:
        y = sub[col].dropna()
        if len(y) < 10:
            continue
        x = tp.loc[y.index]
        sp, sp_p = stats.spearmanr(x, y)
        pr, pr_p = stats.pearsonr(x, y)
        print(f"\n  Correlation (takeit_prob vs {name}): n={len(y):,}")
        print(f"    Spearman r={sp:.4f}  p={sp_p:.4e}")
        print(f"    Pearson  r={pr:.4f}  p={pr_p:.4e}")

    bins = [0.0, 0.40, 0.55, 0.70, 1.01]
    band_labels = ["<0.40", "0.40-0.55", "0.55-0.70", ">0.70"]
    sub["takeit_band"] = pd.cut(sub["takeit_prob"], bins=bins, labels=band_labels, right=False)

    for col, name in [("realized_trail_r", "trail30/10 R"), ("peak_ceiling_pct", "peak %")]:
        if col not in sub.columns:
            continue
        print(f"\n  Within-band distribution of {name}:")
        print(f"  {'Band':<14} {'N':>7} {'Mean':>9} {'Median':>9} {'P75':>9} {'P90':>9}")
        for band in band_labels:
            bdf = sub[sub["takeit_band"] == band][col].dropna()
            if len(bdf) == 0:
                print(f"  {band:<14} {'0':>7}")
                continue
            print(
                f"  {band:<14} {len(bdf):>7,} "
                f"{bdf.mean():>9.2f} {bdf.median():>9.2f} "
                f"{bdf.quantile(0.75):>9.2f} {bdf.quantile(0.90):>9.2f}"
            )

    # Within-band residual variance for peak
    sub2 = sub[["takeit_band", "peak_ceiling_pct"]].dropna()
    if len(sub2) > 10:
        # eta-squared: fraction explained by band
        band_means = sub2.groupby("takeit_band")["peak_ceiling_pct"].mean()
        overall_mean = sub2["peak_ceiling_pct"].mean()
        ss_between = sum(
            (sub2[sub2["takeit_band"] == b].shape[0]) * (band_means[b] - overall_mean) ** 2
            for b in band_labels if b in band_means
        )
        ss_total = float(sub2["peak_ceiling_pct"].var() * (len(sub2) - 1))
        eta_sq = ss_between / ss_total if ss_total > 0 else 0.0
        print(f"\n  Variance explained by take-it band (eta²): {100*eta_sq:.2f}%")
        print(f"  Residual unexplained: {100*(1-eta_sq):.2f}% of total peak variance")

    return sub


# ── Section C ─────────────────────────────────────────────────────────────────
def section_c(feat_df: pd.DataFrame, outcomes_df: pd.DataFrame, label: str) -> dict:
    """
    feat_df: index-aligned numeric features
    outcomes_df: must have 'date', 'peak_ceiling_pct', 'realized_trail_r'
    """
    print(f"\n{'='*62}")
    print(f"SECTION C — PREDICTABILITY FROM ENTRY FEATURES: {label}")
    print(f"{'='*62}")

    feature_cols = list(feat_df.columns)
    print(f"  Feature count: {len(feature_cols)}")
    print(f"  Feature names: {feature_cols[:20]}{'...' if len(feature_cols)>20 else ''}")

    # Build combined df
    combined = outcomes_df[["date", "peak_ceiling_pct", "realized_trail_r"]].copy()
    combined["log1p_peak"] = np.log1p(
        pd.to_numeric(combined["peak_ceiling_pct"], errors="coerce").clip(lower=0)
    )
    combined = combined.join(feat_df)
    combined = combined.sort_values("date").reset_index(drop=True)

    split_idx = int(len(combined) * 0.70)
    if split_idx < 20 or (len(combined) - split_idx) < 5:
        print(f"  Insufficient data for split (n={len(combined)})")
        return {}
    split_date = combined.iloc[split_idx]["date"]
    print(f"  Train/test split at date={split_date} (train={split_idx}, test={len(combined)-split_idx})")

    fi_store = {}
    targets = [
        ("realized_trail_r", "Realized trail30/10 R"),
        ("peak_ceiling_pct", "Peak ceiling %"),
        ("log1p_peak", "log1p(peak_ceiling_pct)"),
    ]

    try:
        from xgboost import XGBRegressor
        use_xgb = True
    except ImportError:
        from sklearn.ensemble import HistGradientBoostingRegressor
        use_xgb = False

    for target_col, target_name in targets:
        sub = combined[feature_cols + [target_col, "date"]].dropna(subset=[target_col])
        if len(sub) < 30:
            print(f"\n  [{target_name}]: n={len(sub)} — too few rows")
            continue

        X = sub[feature_cols].copy().fillna(sub[feature_cols].median())
        y = pd.to_numeric(sub[target_col], errors="coerce").astype(float)

        train_mask = sub["date"] < split_date
        test_mask = ~train_mask

        X_train, X_test = X[train_mask], X[test_mask]
        y_train, y_test = y[train_mask], y[test_mask]

        if len(X_train) < 15 or len(X_test) < 5:
            print(f"\n  [{target_name}]: split too small (train={len(X_train)}, test={len(X_test)})")
            continue

        if use_xgb:
            model = XGBRegressor(
                n_estimators=300,
                max_depth=4,
                learning_rate=0.05,
                subsample=0.8,
                colsample_bytree=0.8,
                min_child_weight=5,
                random_state=42,
                verbosity=0,
            )
            model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)
            y_pred = model.predict(X_test)
            fi = pd.Series(model.feature_importances_, index=feature_cols).sort_values(ascending=False)
            fi_store[target_col] = fi
        else:
            from sklearn.ensemble import HistGradientBoostingRegressor
            model = HistGradientBoostingRegressor(
                max_iter=300, max_depth=4, learning_rate=0.05,
                min_samples_leaf=10, random_state=42
            )
            model.fit(X_train.values, y_train.values)
            y_pred = model.predict(X_test.values)
            fi = None

        ss_res = float(np.sum((y_test.values - y_pred) ** 2))
        ss_tot = float(np.sum((y_test.values - float(y_train.mean())) ** 2))
        r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

        # True baseline: predict train mean on all test rows
        base_pred = np.full(len(y_test), float(y_train.mean()))
        ss_base = float(np.sum((y_test.values - base_pred) ** 2))
        r2_base = 1 - ss_base / ss_tot if ss_tot > 0 else 0.0

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            sp, sp_p = stats.spearmanr(y_pred, y_test.values)

        print(f"\n  [{target_name}]")
        print(f"    train n={len(X_train):,}  test n={len(X_test):,}")
        print(f"    OOS R²={r2:.4f}  (mean-baseline R²={r2_base:.4f})")
        if np.isnan(sp):
            print("    OOS Spearman: undefined (constant prediction — model collapsed to mean)")
        else:
            print(f"    OOS Spearman(pred, actual)={sp:.4f}  p={sp_p:.4e}")

        if fi is not None and len(fi) > 0:
            top10 = fi.head(10)
            total_imp = fi.sum()
            print(f"    Top 10 features by gain (total gain={total_imp:.4f}):")
            for fn, imp in top10.items():
                pct = 100 * imp / total_imp if total_imp > 0 else 0
                print(f"      {fn:<45s}  {imp:.4f}  ({pct:.1f}%)")

    return fi_store


# ── Section E ─────────────────────────────────────────────────────────────────
def section_e(feat_df: pd.DataFrame, outcomes_df: pd.DataFrame, label: str) -> None:
    print(f"\n{'='*62}")
    print(f"SECTION E — QUANTILE REGRESSOR SANITY CHECK: {label}")
    print(f"{'='*62}")

    feature_cols = list(feat_df.columns)
    combined = outcomes_df[["date", "peak_ceiling_pct"]].copy()
    combined = combined.join(feat_df)
    combined = combined.dropna(subset=["peak_ceiling_pct"]).sort_values("date").reset_index(drop=True)

    split_idx = int(len(combined) * 0.70)
    if split_idx < 15 or (len(combined) - split_idx) < 5:
        print(f"  Insufficient data (n={len(combined)})")
        return

    X = combined[feature_cols].fillna(combined[feature_cols].median())
    y = pd.to_numeric(combined["peak_ceiling_pct"], errors="coerce").astype(float)
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    try:
        from sklearn.ensemble import HistGradientBoostingRegressor
        for q, q_label in [(0.75, "P75"), (0.90, "P90")]:
            mq = HistGradientBoostingRegressor(
                loss="quantile", quantile=q,
                max_iter=300, max_depth=4, learning_rate=0.05,
                min_samples_leaf=5, random_state=42
            )
            mq.fit(X_train.values, y_train.values)
            pred_q = mq.predict(X_test.values)

            res = y_test.values - pred_q
            pinball = float(np.mean(np.where(res >= 0, q * res, (q - 1) * res)))

            const_q = float(y_train.quantile(q))
            base_res = y_test.values - const_q
            base_pinball = float(np.mean(np.where(base_res >= 0, q * base_res, (q - 1) * base_res)))

            lift = 1 - pinball / base_pinball if base_pinball > 0 else 0.0
            print(f"\n  Quantile {q_label} (q={q}):")
            print(f"    Model pinball:   {pinball:.4f}")
            print(f"    Baseline pinball:{base_pinball:.4f}")
            print(f"    Relative lift:   {lift*100:+.1f}%")
            print(f"    Train {q_label} value: {const_q:.2f}")

    except Exception as e:
        print(f"  Quantile error: {e}")


# ── Plots ─────────────────────────────────────────────────────────────────────
def make_plots(lot_full: pd.DataFrame, sb_full: pd.DataFrame,
               lot_feat: pd.DataFrame) -> list[str]:
    saved = []

    # 1. Distribution plots (full enriched set)
    fig, axes = plt.subplots(2, 3, figsize=(16, 9))
    fig.suptitle("Payoff/Ceiling Distributions — 90-day enriched set", fontsize=13)

    for row_i, (df, lbl) in enumerate([(lot_full, "Lottery"), (sb_full, "Silent Boom")]):
        peak = pd.to_numeric(df["peak_ceiling_pct"], errors="coerce").dropna()
        trail = pd.to_numeric(df["realized_trail_r"], errors="coerce").dropna()

        ax = axes[row_i][0]
        clip99 = float(peak.quantile(0.99)) if len(peak) > 0 else 200
        ax.hist(peak.clip(upper=clip99), bins=60, color="steelblue", alpha=0.75, edgecolor="none")
        ax.set_title(f"{lbl} — Peak ceiling % (clipped P99={clip99:.0f})")
        ax.set_xlabel("peak_ceiling_pct")
        ax.set_ylabel("Count")

        ax = axes[row_i][1]
        if len(peak) > 0:
            ax.hist(np.log1p(peak.clip(lower=0)), bins=60, color="steelblue", alpha=0.75, edgecolor="none")
        ax.set_title(f"{lbl} — log1p(peak_ceiling_pct)")
        ax.set_xlabel("log1p(peak %)")

        ax = axes[row_i][2]
        clip99t = float(trail.quantile(0.99)) if len(trail) > 0 else 100
        clip1t = float(trail.quantile(0.01)) if len(trail) > 0 else -50
        ax.hist(trail.clip(lower=clip1t, upper=clip99t), bins=60,
                color="coral", alpha=0.75, edgecolor="none")
        ax.set_title(f"{lbl} — Trail30/10 R (clipped P1/P99)")
        ax.set_xlabel("realized_trail_r")

    plt.tight_layout()
    p = PLOTS_DIR / "payoff_eda_distributions.png"
    plt.savefig(p, dpi=130, bbox_inches="tight")
    plt.close()
    saved.append(str(p))

    # 2. takeit_prob vs peak scatter + band boxplot
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    bins = [0.0, 0.40, 0.55, 0.70, 1.01]
    band_labels = ["<0.40", "0.40-0.55", "0.55-0.70", ">0.70"]

    for col_i, (df, lbl) in enumerate([(lot_full, "Lottery"), (sb_full, "Silent Boom")]):
        sub = df.copy()
        sub["takeit_prob"] = pd.to_numeric(sub["takeit_prob"], errors="coerce")
        sub["peak_ceiling_pct"] = pd.to_numeric(sub["peak_ceiling_pct"], errors="coerce")
        sub = sub.dropna(subset=["takeit_prob", "peak_ceiling_pct"])

        # Scatter
        ax = axes[0][col_i]
        if len(sub) > 0:
            clip_peak = float(sub["peak_ceiling_pct"].quantile(0.95))
            ax.scatter(sub["takeit_prob"], sub["peak_ceiling_pct"].clip(upper=clip_peak),
                       alpha=0.15, s=5, color="steelblue")
            sp, _ = stats.spearmanr(sub["takeit_prob"], sub["peak_ceiling_pct"])
            pr, _ = stats.pearsonr(sub["takeit_prob"], sub["peak_ceiling_pct"])
            ax.set_title(f"{lbl}: takeit_prob vs peak (n={len(sub):,})\nSpearman={sp:.3f}  Pearson={pr:.3f}")
        ax.set_xlabel("takeit_prob")
        ax.set_ylabel(f"peak (clipped P95={clip_peak:.0f}%)")

        # Band boxplot
        ax = axes[1][col_i]
        if len(sub) > 0:
            sub["band"] = pd.cut(sub["takeit_prob"], bins=bins, labels=band_labels, right=False)
            band_data = [
                sub[sub["band"] == b]["peak_ceiling_pct"].clip(upper=clip_peak).dropna().values
                for b in band_labels
            ]
            ns = [len(d) for d in band_data]
            ax.boxplot(band_data, labels=[f"{b}\n(n={n:,})" for b, n in zip(band_labels, ns)],
                       showfliers=False)
            ax.set_title(f"{lbl}: peak by takeit band")
            ax.set_ylabel(f"peak (clipped @{clip_peak:.0f}%)")

    plt.tight_layout()
    p2 = PLOTS_DIR / "payoff_eda_takeit_vs_peak.png"
    plt.savefig(p2, dpi=130, bbox_inches="tight")
    plt.close()
    saved.append(str(p2))

    # 3. Feature importance comparison (peak vs trail) for lottery
    if not lot_feat.empty:
        # We'll redo a quick XGB to get importances for the plot
        try:
            combined = lot_feat.copy()
            combined["peak_ceiling_pct"] = pd.to_numeric(
                lot_feat.get("peak_ceiling_pct", pd.Series()), errors="coerce"
            )
            # This plot is generated from Section C fi_store — we just note the path here
        except Exception:
            pass

    return saved


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("Connecting to Neon Postgres...")
    conn = _get_conn()

    print("\nLoading FULL enriched sets (90d, no feature filter)...")
    lot_full = pd.read_sql_query(LOTTERY_FULL_SQL, conn)
    sb_full = pd.read_sql_query(SILENTBOOM_FULL_SQL, conn)
    print(f"  Lottery full: {len(lot_full):,}  |  SB full: {len(sb_full):,}")

    print("\nLoading takeit_features-populated subsets (90d)...")
    lot_feat_raw = pd.read_sql_query(LOTTERY_SQL, conn)
    sb_feat_raw = pd.read_sql_query(SILENTBOOM_SQL, conn)
    print(f"  Lottery w/features: {len(lot_feat_raw):,}  |  SB w/features: {len(sb_feat_raw):,}")
    conn.close()

    # Parse JSONB features
    lot_feat = parse_features(lot_feat_raw)
    sb_feat = parse_features(sb_feat_raw)

    # Normalize types
    for df in [lot_full, sb_full, lot_feat_raw, sb_feat_raw]:
        for col in ["takeit_prob", "peak_ceiling_pct", "realized_trail_r"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"])

    print("\n" + "="*70)
    print("PAYOFF / CEILING MODEL — DECISION-GRADE EDA PROBE")
    print("="*70)

    # ── Section A ──
    section_a(lot_full, lot_feat_raw, "LOTTERY")
    section_a(sb_full, sb_feat_raw, "SILENT BOOM")

    # ── Section B ──
    section_b(lot_full, "LOTTERY")
    section_b(sb_full, "SILENT BOOM")

    # ── Sections C + E (features-only subset) ──
    print("\n  NOTE: Sections C/E use ONLY rows with takeit_features populated.")
    print(f"  Lottery: {len(lot_feat_raw):,} rows  |  SB: {len(sb_feat_raw):,} rows")
    print("  Feature window: ~1 week (2026-05-20/21 to 2026-05-28)")

    lot_fi = {}
    if len(lot_feat_raw) >= 30:
        lot_fi = section_c(lot_feat, lot_feat_raw, "LOTTERY")
    else:
        print(f"\n  [LOTTERY Section C] Skipped — only {len(lot_feat_raw)} rows with features")

    if len(sb_feat_raw) >= 30:
        section_c(sb_feat, sb_feat_raw, "SILENT BOOM")
    else:
        print(f"\n  [SILENT BOOM Section C] Skipped — only {len(sb_feat_raw)} rows with features")

    if len(lot_feat_raw) >= 30:
        section_e(lot_feat, lot_feat_raw, "LOTTERY")
    if len(sb_feat_raw) >= 30:
        section_e(sb_feat, sb_feat_raw, "SILENT BOOM")

    # ── Section D summary ──
    print(f"\n{'='*62}")
    print("SECTION D — FEATURE DRIVER COMPARISON SUMMARY")
    print(f"{'='*62}")
    if lot_fi:
        for target, fi in lot_fi.items():
            print(f"\n  [LOTTERY — {target}] Top 5 gain features:")
            for fn, imp in fi.head(5).items():
                print(f"    {fn:<45s}  {imp:.4f}")
    else:
        print("  No feature importance data available (insufficient rows).")

    # ── Plots ──
    print(f"\n{'='*62}")
    print("GENERATING PLOTS")
    print(f"{'='*62}")
    saved = make_plots(lot_full, sb_full, lot_feat_raw)
    for p in saved:
        print(f"  Saved: {p}")

    print("\nDone.")


if __name__ == "__main__":
    main()
