"""
Phase 1: Day Type Clustering

Discovers natural groupings in trading days using unsupervised clustering.
Uses T1-T2 features (first hour of trading), equal weights, one-hot charm pattern.

Usage:
    python3 ml/clustering.py              # Run full analysis
    python3 ml/clustering.py --k 3        # Force k=3 clusters
    python3 ml/clustering.py --plot       # Save plots to ml/plots/

Requires: pip install psycopg2-binary pandas scikit-learn matplotlib
"""

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    from sklearn.cluster import KMeans, AgglomerativeClustering
    from sklearn.decomposition import PCA
    from sklearn.impute import SimpleImputer
    from sklearn.metrics import (
        calinski_harabasz_score,
        davies_bouldin_score,
        silhouette_score,
    )
    from sklearn.mixture import GaussianMixture
    from sklearn.preprocessing import StandardScaler
    from scipy.stats import chi2_contingency
    from statsmodels.stats.proportion import proportion_confint
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas scikit-learn matplotlib")
    sys.exit(1)

from utils import (
    load_data,
    validate_dataframe,
    VOLATILITY_FEATURES,
    GEX_FEATURES_T1T2,
    GREEK_FEATURES_CORE,
)


# ── Feature Groups ───────────────────────────────────────────

# T1-T2 features only (first hour). Grouped by category for interpretability.
# VOLATILITY_FEATURES and GEX_FEATURES_T1T2 imported from utils.

REGIME_FEATURES = [
    "cluster_mult", "dow_mult", "sigma",
]

# Categorical features that need one-hot encoding
CATEGORICAL_FEATURES = ["regime_zone"]

CALENDAR_FEATURES = [
    "day_of_week", "is_friday",
]

CALCULATOR_FEATURES = [
    "ic_ceiling", "put_spread_ceiling", "call_spread_ceiling",
]

FLOW_FEATURES_T1T2 = [
    "mt_ncp_t1", "mt_npp_t1", "mt_ncp_t2", "mt_npp_t2",
    "spx_ncp_t1", "spx_npp_t1", "spx_ncp_t2", "spx_npp_t2",
    "spy_ncp_t1", "spy_npp_t1", "spy_ncp_t2", "spy_npp_t2",
    "qqq_ncp_t1", "qqq_npp_t1", "qqq_ncp_t2", "qqq_npp_t2",
    "spy_etf_ncp_t1", "spy_etf_npp_t1", "spy_etf_ncp_t2", "spy_etf_npp_t2",
    "qqq_etf_ncp_t1", "qqq_etf_npp_t1", "qqq_etf_ncp_t2", "qqq_etf_npp_t2",
    "zero_dte_ncp_t1", "zero_dte_npp_t1", "zero_dte_ncp_t2", "zero_dte_npp_t2",
    "delta_flow_total_t1", "delta_flow_dir_t1",
    "delta_flow_total_t2", "delta_flow_dir_t2",
]

FLOW_AGGREGATE_T1T2 = [
    "flow_agreement_t1", "flow_agreement_t2",
    "etf_tide_divergence_t1", "etf_tide_divergence_t2",
    "ncp_npp_gap_spx_t1", "ncp_npp_gap_spx_t2",
]

# Clustering extends core greeks with charm OI features
GREEK_FEATURES = GREEK_FEATURES_CORE + ["charm_oi_t1", "charm_oi_t2"]

CHARM_PATTERN_COL = "charm_pattern"

ALL_NUMERIC_FEATURES = (
    VOLATILITY_FEATURES + REGIME_FEATURES + CALENDAR_FEATURES +
    CALCULATOR_FEATURES + FLOW_FEATURES_T1T2 + FLOW_AGGREGATE_T1T2 +
    GEX_FEATURES_T1T2 + GREEK_FEATURES
)


# ── Data Loading ─────────────────────────────────────────────

def load_data_clustering() -> pd.DataFrame:
    """Load training features + outcomes + labels from Neon."""
    query = """
        SELECT f.*, o.day_range_pts, o.settlement, o.day_open,
               l.recommended_structure, l.structure_correct,
               l.range_category, l.settlement_direction
        FROM training_features f
        LEFT JOIN outcomes o ON o.date = f.date
        LEFT JOIN day_labels l ON l.date = f.date
        ORDER BY f.date ASC
    """
    return load_data(query)


# ── Preprocessing ────────────────────────────────────────────

def preprocess(df: pd.DataFrame) -> tuple[np.ndarray, list[str], pd.DataFrame]:
    """
    Preprocess features for clustering.
    Returns: (X_pca, pca_labels, df_features_before_pca)
    """
    # Select numeric features that exist in the dataframe
    available = [f for f in ALL_NUMERIC_FEATURES if f in df.columns]
    missing = [f for f in ALL_NUMERIC_FEATURES if f not in df.columns]
    if missing:
        print(f"  Note: {len(missing)} features not in data, skipping")

    df_feat = df[available].copy().astype(float)

    # One-hot encode categorical columns
    for cat_col in [CHARM_PATTERN_COL] + CATEGORICAL_FEATURES:
        if cat_col in df.columns:
            prefix = cat_col.replace("_pattern", "").replace("_zone", "")
            dummies = pd.get_dummies(df[cat_col], prefix=prefix)
            df_feat = pd.concat([df_feat, dummies], axis=1)

    # Drop columns that are >50% null (too sparse to impute reliably)
    null_pct = df_feat.isnull().mean()
    sparse = null_pct[null_pct > 0.5].index.tolist()
    if sparse:
        print(f"  Dropping {len(sparse)} sparse columns (>50% null): {sparse}")
        df_feat = df_feat.drop(columns=sparse)

    # Report coverage
    n_features = len(df_feat.columns)
    n_nulls = df_feat.isnull().sum().sum()
    n_cells = len(df_feat) * n_features
    print(f"  Features: {n_features}, Null cells: {n_nulls}/{n_cells} ({n_nulls/n_cells:.1%})")

    # Impute remaining nulls with median
    imputer = SimpleImputer(strategy="median")
    X_imputed = imputer.fit_transform(df_feat)

    # Standardize (z-score)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_imputed)

    # PCA — keep components explaining 85% variance
    pca = PCA(n_components=0.85, random_state=42)
    X_pca = pca.fit_transform(X_scaled)

    n_components = X_pca.shape[1]
    variance_explained = pca.explained_variance_ratio_.sum()
    print(f"  PCA: {n_features} features -> {n_components} components ({variance_explained:.1%} variance)")

    # Feature loadings for interpretation
    loadings = pd.DataFrame(
        pca.components_.T,
        index=df_feat.columns,
        columns=[f"PC{i+1}" for i in range(n_components)],
    )

    # Top features per component
    print(f"\n  Top features per principal component:")
    for i in range(min(n_components, 5)):
        pc = loadings[f"PC{i+1}"].abs().nlargest(5)
        features_str = ", ".join(f"{name} ({loadings.loc[name, f'PC{i+1}']:+.2f})" for name in pc.index)
        print(f"    PC{i+1} ({pca.explained_variance_ratio_[i]:.1%}): {features_str}")

    pca_labels = [f"PC{i+1}" for i in range(n_components)]
    return X_pca, pca_labels, df_feat


# ── Clustering ───────────────────────────────────────────────

def run_clustering(X: np.ndarray, k_range: range) -> dict:
    """Run K-Means, GMM, and Hierarchical for each k. Return results."""
    results = {}

    for k in k_range:
        row = {"k": k}

        # K-Means
        km = KMeans(n_clusters=k, n_init=20, random_state=42)
        km_labels = km.fit_predict(X)
        km_sil = silhouette_score(X, km_labels) if k > 1 else 0
        km_ch = calinski_harabasz_score(X, km_labels) if k > 1 else 0
        km_db = davies_bouldin_score(X, km_labels) if k > 1 else 0
        row["kmeans_sil"] = km_sil
        row["kmeans_ch"] = km_ch
        row["kmeans_db"] = km_db
        row["kmeans_labels"] = km_labels
        row["kmeans_sizes"] = [int((km_labels == i).sum()) for i in range(k)]

        # Gaussian Mixture
        gmm = GaussianMixture(n_components=k, n_init=10, random_state=42)
        gmm_labels = gmm.fit_predict(X)
        gmm_sil = silhouette_score(X, gmm_labels) if k > 1 else 0
        row["gmm_sil"] = gmm_sil
        row["gmm_labels"] = gmm_labels
        row["gmm_probs"] = gmm.predict_proba(X)
        row["gmm_bic"] = gmm.bic(X)

        # Hierarchical (Ward)
        hc = AgglomerativeClustering(n_clusters=k, linkage="ward")
        hc_labels = hc.fit_predict(X)
        hc_sil = silhouette_score(X, hc_labels) if k > 1 else 0
        row["hier_sil"] = hc_sil
        row["hier_labels"] = hc_labels

        results[k] = row

    return results


def print_results(results: dict) -> int:
    """Print clustering results and return best k."""
    print(f"\n{'='*70}")
    print(f"  CLUSTERING RESULTS")
    print(f"{'='*70}\n")

    print(f"  {'k':>3s}  {'K-Means':>10s}  {'GMM':>10s}  {'Hier.':>10s}  {'CH':>10s}  {'DB':>8s}  {'GMM BIC':>12s}  {'Sizes (KM)':>20s}")
    print(f"  {'':->3s}  {'':->10s}  {'':->10s}  {'':->10s}  {'':->10s}  {'':->8s}  {'':->12s}  {'':->20s}")

    best_k = 2
    best_sil = -1

    for k, r in sorted(results.items()):
        sizes = str(r["kmeans_sizes"])
        print(f"  {k:3d}  {r['kmeans_sil']:10.3f}  {r['gmm_sil']:10.3f}  {r['hier_sil']:10.3f}  {r['kmeans_ch']:10.1f}  {r['kmeans_db']:8.3f}  {r['gmm_bic']:12.1f}  {sizes:>20s}")

        avg_sil = (r["kmeans_sil"] + r["gmm_sil"] + r["hier_sil"]) / 3
        if avg_sil > best_sil:
            best_sil = avg_sil
            best_k = k

    print(f"\n  Best k by average silhouette: {best_k} (avg sil = {best_sil:.3f})")
    return best_k


def characterize_clusters(
    df: pd.DataFrame,
    labels: np.ndarray,
    k: int,
    method: str,
) -> None:
    """Print detailed cluster profiles."""
    df_c = df.copy()
    df_c["cluster"] = labels

    print(f"\n{'='*70}")
    print(f"  CLUSTER PROFILES ({method}, k={k})")
    print(f"{'='*70}")

    for i in range(k):
        mask = df_c["cluster"] == i
        cluster = df_c[mask]
        n = len(cluster)

        print(f"\n  --- Cluster {i} ({n} days, {n/len(df_c):.0%}) ---")
        print(f"  Dates: {', '.join(d.strftime('%m/%d') for d in cluster.index)}")

        # Volatility profile
        if "vix" in cluster.columns:
            vix_vals = cluster["vix"].dropna().astype(float)
            if len(vix_vals) > 0:
                print(f"  VIX: {vix_vals.mean():.1f} avg ({vix_vals.min():.1f}-{vix_vals.max():.1f})")

        if "vix1d_vix_ratio" in cluster.columns:
            ratio = cluster["vix1d_vix_ratio"].dropna().astype(float)
            if len(ratio) > 0:
                print(f"  VIX1D/VIX: {ratio.mean():.2f} avg")

        # GEX profile
        if "gex_oi_t1" in cluster.columns:
            gex = cluster["gex_oi_t1"].dropna().astype(float)
            if len(gex) > 0:
                gex_b = gex / 1e9
                print(f"  GEX OI (T1): {gex_b.mean():.1f}B avg ({gex_b.min():.1f}B to {gex_b.max():.1f}B)")

        # Flow agreement
        if "flow_agreement_t1" in cluster.columns:
            fa = cluster["flow_agreement_t1"].dropna().astype(float)
            if len(fa) > 0:
                print(f"  Flow Agreement (T1): {fa.mean():.1f} avg")

        # Charm pattern distribution
        if "charm_pattern" in cluster.columns:
            cp = cluster["charm_pattern"].dropna()
            if len(cp) > 0:
                dist = cp.value_counts()
                parts = [f"{v}={c}" for v, c in dist.items()]
                print(f"  Charm: {', '.join(parts)}")

        # Calendar
        dow = cluster["day_of_week"].dropna().astype(int)
        day_names = {0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat"}
        if len(dow) > 0:
            dow_dist = dow.map(day_names).value_counts()
            parts = [f"{v}={c}" for v, c in dow_dist.items()]
            print(f"  Days: {', '.join(parts)}")

        # Outcomes
        if "range_category" in cluster.columns:
            rc = cluster["range_category"].dropna()
            if len(rc) > 0:
                dist = rc.value_counts()
                parts = [f"{v}={c}" for v, c in dist.items()]
                print(f"  Range: {', '.join(parts)}")

        if "recommended_structure" in cluster.columns:
            rs = cluster["recommended_structure"].dropna()
            if len(rs) > 0:
                dist = rs.value_counts()
                parts = [f"{v}={c}" for v, c in dist.items()]
                print(f"  Structure: {', '.join(parts)}")

        if "structure_correct" in cluster.columns:
            sc = cluster["structure_correct"].dropna()
            if len(sc) > 0:
                correct = sc.sum()
                print(f"  Correct: {correct}/{len(sc)} ({correct/len(sc):.0%})")

        if "settlement_direction" in cluster.columns:
            sd = cluster["settlement_direction"].dropna()
            if len(sd) > 0:
                dist = sd.value_counts()
                parts = [f"{v}={c}" for v, c in dist.items()]
                print(f"  Settlement: {', '.join(parts)}")


def stability_check(X: np.ndarray, k: int) -> float:
    """Leave-one-out stability: how often does each point keep its cluster?"""
    base = KMeans(n_clusters=k, n_init=20, random_state=42)
    base_labels = base.fit_predict(X)

    stable = 0
    total = len(X)

    for i in range(total):
        X_loo = np.delete(X, i, axis=0)
        loo = KMeans(n_clusters=k, n_init=20, random_state=42)
        loo_labels = loo.fit_predict(X_loo)

        # Find best label mapping (cluster IDs may permute)
        # Check which cluster the left-out point would be assigned to
        point = X[i].reshape(1, -1)
        predicted = loo.predict(point)[0]

        # Map loo clusters to base clusters by majority vote
        label_map = {}
        for c in range(k):
            loo_mask = loo_labels == c
            if loo_mask.sum() == 0:
                continue
            # Which base cluster do most of these points belong to?
            base_subset = np.delete(base_labels, i)[loo_mask]
            label_map[c] = int(np.bincount(base_subset).argmax())

        mapped = label_map.get(predicted, -1)
        if mapped == base_labels[i]:
            stable += 1

    return stable / total


def permutation_test(X: np.ndarray, k: int, n_permutations: int = 100) -> float:
    """Test if clustering is better than random data with same marginals."""
    real_km = KMeans(n_clusters=k, n_init=20, random_state=42)
    real_labels = real_km.fit_predict(X)
    real_sil = silhouette_score(X, real_labels)

    null_silhouettes = []
    rng = np.random.default_rng(42)
    for _ in range(n_permutations):
        # Shuffle each column independently to break feature correlations
        X_null = np.column_stack([rng.permutation(X[:, i]) for i in range(X.shape[1])])
        null_km = KMeans(n_clusters=k, n_init=10, random_state=42)
        null_labels = null_km.fit_predict(X_null)
        null_sil = silhouette_score(X_null, null_labels)
        null_silhouettes.append(null_sil)

    null_arr = np.array(null_silhouettes)
    p_value = np.mean(null_arr >= real_sil)
    return p_value


def outcome_association_test(
    df: pd.DataFrame, labels: np.ndarray, k: int,  # noqa: ARG001
) -> None:
    """Test if cluster assignments are associated with trading outcomes."""
    df_c = df.copy()
    df_c["cluster"] = labels

    print("\n  --- Outcome Association Tests (chi-squared) ---\n")

    for outcome_col in ["range_category", "settlement_direction", "recommended_structure"]:
        if outcome_col not in df_c.columns:
            continue
        has_both = df_c[[outcome_col, "cluster"]].dropna()
        if len(has_both) < 10:
            continue

        # Build contingency table
        ct = pd.crosstab(has_both["cluster"], has_both[outcome_col])
        if ct.shape[0] < 2 or ct.shape[1] < 2:
            continue

        try:
            chi2, p, _, expected = chi2_contingency(ct)
            # Cramér's V effect size
            n = ct.values.sum()
            min_dim = min(ct.shape[0], ct.shape[1]) - 1
            cramers_v = np.sqrt(chi2 / (n * min_dim)) if min_dim > 0 else 0
            sig = " **" if p < 0.05 else " *" if p < 0.10 else ""
            strength = "strong" if cramers_v >= 0.5 else "moderate" if cramers_v >= 0.3 else "weak"
            print(f"  {outcome_col:25s}  chi2={chi2:6.2f}  p={p:.3f}  Cramer's V={cramers_v:.2f} ({strength}){sig}")

            # Warning for small expected counts
            pct_small = (expected < 5).sum() / expected.size
            if pct_small > 0.2:
                print(f"    Warning: {pct_small:.0%} of cells have expected count < 5 (Fisher's exact may be more appropriate)")
        except Exception:
            continue

    # Structure correctness by cluster (if available)
    if "structure_correct" in df_c.columns:
        has_sc = df_c[["structure_correct", "cluster"]].dropna()
        if len(has_sc) >= 10:
            correct_by_cluster = has_sc.groupby("cluster")["structure_correct"].agg(["sum", "count"])
            correct_by_cluster.columns = ["correct", "total"]
            correct_by_cluster["pct"] = correct_by_cluster["correct"] / correct_by_cluster["total"]
            print("\n  Structure correctness by cluster:")
            for cluster_id, row in correct_by_cluster.iterrows():
                lo, hi = proportion_confint(int(row["correct"]), int(row["total"]), method='wilson')
                print(f"    Cluster {cluster_id}: {int(row['correct'])}/{int(row['total'])} ({row['pct']:.0%})  CI [{lo:.0%}-{hi:.0%}]")


def _draw_confidence_ellipse(ax, x, y, color, alpha=0.15):
    """Draw a 95% confidence ellipse for 2D data."""
    if len(x) < 3:
        return
    from matplotlib.patches import Ellipse
    import matplotlib.transforms as transforms

    mean_x, mean_y = np.mean(x), np.mean(y)
    cov = np.cov(x, y)

    # Eigenvalues and eigenvectors
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    order = eigenvalues.argsort()[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]

    # Angle of rotation
    angle = np.degrees(np.arctan2(eigenvectors[1, 0], eigenvectors[0, 0]))

    # 95% confidence: chi-squared with 2 dof at 0.05 = 5.991
    chi2_val = 5.991
    width = 2 * np.sqrt(chi2_val * eigenvalues[0])
    height = 2 * np.sqrt(chi2_val * eigenvalues[1])

    ellipse = Ellipse(
        xy=(mean_x, mean_y), width=width, height=height, angle=angle,
        facecolor=color, edgecolor=color, alpha=alpha, linewidth=1.5,
        linestyle="--",
    )
    ax.add_patch(ellipse)


def save_plots(X_pca: np.ndarray, labels: np.ndarray, k: int, df: pd.DataFrame) -> None:
    """Save PCA scatter plot and cluster summary."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("  matplotlib not available, skipping plots")
        return

    plot_dir = Path(__file__).resolve().parent / "plots"
    plot_dir.mkdir(exist_ok=True)

    # PCA scatter (PC1 vs PC2)
    fig, ax = plt.subplots(1, 1, figsize=(10, 7))
    colors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"]

    for i in range(k):
        mask = labels == i
        ax.scatter(
            X_pca[mask, 0], X_pca[mask, 1],
            c=colors[i % len(colors)], label=f"Cluster {i} (n={mask.sum()})",
            s=80, alpha=0.8, edgecolors="white", linewidth=0.5,
        )
        # Draw 95% confidence ellipse
        _draw_confidence_ellipse(ax, X_pca[mask, 0], X_pca[mask, 1], colors[i % len(colors)])

        # Annotate with dates
        dates = df.index[mask]
        for j, (x, y) in enumerate(zip(X_pca[mask, 0], X_pca[mask, 1])):
            ax.annotate(
                dates[j].strftime("%m/%d"), (x, y),
                fontsize=7, ha="center", va="bottom", alpha=0.7,
            )

    ax.set_xlabel("PC1")
    ax.set_ylabel("PC2")
    ax.set_title(f"Day Type Clusters (k={k}, PCA projection)")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(plot_dir / "clusters_pca.png", dpi=150)
    print(f"\n  Saved: ml/plots/clusters_pca.png")

    # Cluster feature heatmap
    df_c = df.copy()
    df_c["cluster"] = labels

    summary_features = [
        "vix", "vix1d_vix_ratio", "gex_oi_t1", "flow_agreement_t1",
        "charm_slope", "agg_net_gamma",
    ]
    available = [f for f in summary_features if f in df_c.columns]

    if available:
        means = df_c.groupby("cluster")[available].mean().astype(float)
        # Z-score the means for heatmap
        means_z = (means - means.mean()) / means.std()

        fig2, ax2 = plt.subplots(1, 1, figsize=(8, max(3, k * 1.2)))
        im = ax2.imshow(means_z.values, cmap="RdBu_r", aspect="auto", vmin=-2, vmax=2)
        ax2.set_xticks(range(len(available)))
        ax2.set_xticklabels(available, rotation=45, ha="right", fontsize=9)
        ax2.set_yticks(range(k))
        ax2.set_yticklabels([f"Cluster {i}" for i in range(k)])
        ax2.set_title("Cluster Feature Profiles (z-scored)")
        fig2.colorbar(im, ax=ax2, shrink=0.8)
        fig2.tight_layout()
        fig2.savefig(plot_dir / "clusters_heatmap.png", dpi=150)
        print(f"  Saved: ml/plots/clusters_heatmap.png")

    plt.close("all")


# ── Main ─────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 1: Day Type Clustering")
    parser.add_argument("--k", type=int, default=None, help="Force specific k (default: auto-select)")
    parser.add_argument("--plot", action="store_true", help="Save plots to ml/plots/")
    args = parser.parse_args()

    print("Loading data ...")
    df = load_data_clustering()
    print(f"  {len(df)} days loaded ({df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d})")

    validate_dataframe(
        df,
        min_rows=10,
        required_columns=["vix", "day_of_week"],
        range_checks={"vix": (9, 90), "day_of_week": (0, 6)},
    )

    print("\nPreprocessing ...")
    X_pca, pca_labels, df_feat = preprocess(df)

    n_samples = X_pca.shape[0]
    max_k = min(6, n_samples - 1)
    k_range = range(2, max_k + 1)

    print(f"\nRunning clustering (k={k_range.start}..{k_range.stop - 1}) ...")
    results = run_clustering(X_pca, k_range)

    best_k = args.k if args.k else print_results(results)

    if best_k not in results:
        print(f"  k={best_k} not in results, using k=2")
        best_k = 2

    # Use K-Means labels for profiling (most interpretable)
    best_labels = results[best_k]["kmeans_labels"]

    characterize_clusters(df, best_labels, best_k, "K-Means")

    # Stability check
    print(f"\nStability check (leave-one-out) ...")
    stability = stability_check(X_pca, best_k)
    print(f"  Stability: {stability:.0%} of days keep their cluster assignment")

    if stability < 0.7:
        print("  WARNING: Clusters are fragile. Consider waiting for more data.")

    # Permutation test
    print("\nPermutation test (is clustering better than chance?) ...")
    p_value = permutation_test(X_pca, best_k)
    print(f"  p-value: {p_value:.3f}")
    if p_value < 0.05:
        print("  Clusters are significantly better than random (p < 0.05)")
    elif p_value < 0.10:
        print("  Clusters are marginally better than random (p < 0.10)")
    else:
        print("  WARNING: Clusters are NOT significantly better than random.")
        print("  The observed structure may be noise. Wait for more data.")

    # Outcome association
    outcome_association_test(df, best_labels, best_k)

    # Plots
    if args.plot:
        print("\nGenerating plots ...")
        save_plots(X_pca, best_labels, best_k, df)

    # Summary
    print(f"\n{'='*70}")
    print(f"  SUMMARY")
    print(f"{'='*70}")
    print(f"  Days: {n_samples}")
    print(f"  Features used: {X_pca.shape[1]} PCA components from {len(df_feat.columns)} features")
    print(f"  Best k: {best_k}")
    print(f"  Silhouette: {results[best_k]['kmeans_sil']:.3f} (K-Means)")
    print(f"  Stability: {stability:.0%}")
    print(f"  GMM BIC: {results[best_k]['gmm_bic']:.1f}")
    print(f"  Permutation p: {p_value:.3f}")
    print()


if __name__ == "__main__":
    main()
