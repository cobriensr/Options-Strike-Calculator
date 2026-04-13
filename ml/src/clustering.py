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

try:
    import numpy as np
    import pandas as pd
    from scipy.stats import chi2_contingency
    from sklearn.cluster import AgglomerativeClustering, KMeans
    from sklearn.decomposition import PCA
    from sklearn.impute import SimpleImputer
    from sklearn.metrics import (
        calinski_harabasz_score,
        davies_bouldin_score,
        silhouette_score,
    )
    from sklearn.mixture import GaussianMixture
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from statsmodels.stats.proportion import proportion_confint
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas scikit-learn matplotlib")
    sys.exit(1)

from utils import (
    DARK_POOL_FEATURES,
    GEX_FEATURES_T1T2,
    GREEK_FEATURES_CORE,
    IV_PCR_FEATURES,
    MAX_PAIN_FEATURES,
    ML_ROOT,
    OI_CHANGE_FEATURES,
    OPTIONS_VOLUME_FEATURES,
    VOL_SURFACE_FEATURES,
    VOLATILITY_FEATURES,
    load_data,
    save_section_findings,
    validate_dataframe,
)

# ── Feature Groups ───────────────────────────────────────────

# T1-T2 features only (first hour). Grouped by category for interpretability.
# VOLATILITY_FEATURES and GEX_FEATURES_T1T2 imported from utils.

REGIME_FEATURES = [
    "cluster_mult",
    "dow_mult",
    "sigma",
]

# Categorical features that need one-hot encoding
CATEGORICAL_FEATURES = ["regime_zone"]

CALENDAR_FEATURES = [
    "day_of_week",
    "is_friday",
]

CALCULATOR_FEATURES = [
    "ic_ceiling",
    "put_spread_ceiling",
    "call_spread_ceiling",
]

FLOW_FEATURES_T1T2 = [
    "mt_ncp_t1",
    "mt_npp_t1",
    "mt_ncp_t2",
    "mt_npp_t2",
    "spx_ncp_t1",
    "spx_npp_t1",
    "spx_ncp_t2",
    "spx_npp_t2",
    "spy_ncp_t1",
    "spy_npp_t1",
    "spy_ncp_t2",
    "spy_npp_t2",
    "qqq_ncp_t1",
    "qqq_npp_t1",
    "qqq_ncp_t2",
    "qqq_npp_t2",
    "spy_etf_ncp_t1",
    "spy_etf_npp_t1",
    "spy_etf_ncp_t2",
    "spy_etf_npp_t2",
    "qqq_etf_ncp_t1",
    "qqq_etf_npp_t1",
    "qqq_etf_ncp_t2",
    "qqq_etf_npp_t2",
    "zero_dte_ncp_t1",
    "zero_dte_npp_t1",
    "zero_dte_ncp_t2",
    "zero_dte_npp_t2",
    "delta_flow_total_t1",
    "delta_flow_dir_t1",
    "delta_flow_total_t2",
    "delta_flow_dir_t2",
]

FLOW_AGGREGATE_T1T2 = [
    "flow_agreement_t1",
    "flow_agreement_t2",
    "etf_tide_divergence_t1",
    "etf_tide_divergence_t2",
    "ncp_npp_gap_spx_t1",
    "ncp_npp_gap_spx_t2",
]

# Clustering extends core greeks with charm OI features
GREEK_FEATURES = GREEK_FEATURES_CORE + ["charm_oi_t1", "charm_oi_t2"]

CHARM_PATTERN_COL = "charm_pattern"

# Minimum members required for a cluster to be considered a "real" regime.
# Set to 5 because the smallest meaningful trading regime is roughly one
# trading week — anything smaller tends to be a geometrically clean but
# statistically meaningless singleton/outlier split (e.g. a 1/40 partition
# whose silhouette is high only because one point is isolated). When the
# best-k selector finds that every k produces a cluster smaller than this,
# it refuses to pick a k and falls back to k=1 (no valid clustering).
MIN_CLUSTER_SIZE = 5

ALL_NUMERIC_FEATURES = (
    VOLATILITY_FEATURES
    + REGIME_FEATURES
    + CALENDAR_FEATURES
    + CALCULATOR_FEATURES
    + FLOW_FEATURES_T1T2
    + FLOW_AGGREGATE_T1T2
    + GEX_FEATURES_T1T2
    + GREEK_FEATURES
    + DARK_POOL_FEATURES
    + OPTIONS_VOLUME_FEATURES
    + IV_PCR_FEATURES
    + MAX_PAIN_FEATURES
    + OI_CHANGE_FEATURES
    + VOL_SURFACE_FEATURES
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
    print(
        f"  Features: {n_features}, Null cells: {n_nulls}/{n_cells} ({n_nulls / n_cells:.1%})"
    )

    # Sample-aware PCA component cap.
    #
    # Enforces a floor of ~8 samples per PCA dimension to prevent
    # curse-of-dimensionality in small-sample clustering. With only a few
    # samples per dim, KMeans silhouettes collapse and the "best" partition
    # degenerates to isolating single-point outliers. Scales from 3
    # components (very small samples) to 15 (large samples).
    #
    # This replaces the earlier `n_components=0.85` variance target, which
    # kept too many noisy PCs when feature count was high relative to
    # sample count.
    n_samples = len(df_feat)
    hard_limit = min(n_samples, df_feat.shape[1])
    n_components = min(hard_limit, max(3, min(n_samples // 8, 15)))

    # Impute → Standardize → PCA via Pipeline (avoids data leakage)
    pipeline = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            ("pca", PCA(n_components=n_components, random_state=42)),
        ],
        memory=None,
    )
    X_pca = pipeline.fit_transform(df_feat)
    pca = pipeline.named_steps["pca"]

    n_components = X_pca.shape[1]
    variance_explained = pca.explained_variance_ratio_.sum()
    samples_per_dim = n_samples / n_components if n_components > 0 else 0.0
    print(
        f"  PCA: {n_features} features -> {n_components} components "
        f"({variance_explained:.1%} variance, {samples_per_dim:.1f} samples/dim)"
    )

    # Feature loadings for interpretation
    loadings = pd.DataFrame(
        pca.components_.T,
        index=df_feat.columns,
        columns=[f"PC{i + 1}" for i in range(n_components)],
    )

    # Top features per component
    print("\n  Top features per principal component:")
    for i in range(min(n_components, 5)):
        pc = loadings[f"PC{i + 1}"].abs().nlargest(5)
        features_str = ", ".join(
            f"{name} ({loadings.loc[name, f'PC{i + 1}']:+.2f})" for name in pc.index
        )
        print(f"    PC{i + 1} ({pca.explained_variance_ratio_[i]:.1%}): {features_str}")

    pca_labels = [f"PC{i + 1}" for i in range(n_components)]
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


def _avg_silhouette(row: dict) -> float:
    """Average silhouette across KMeans / GMM / Hierarchical for a results row."""
    return (row["kmeans_sil"] + row["gmm_sil"] + row["hier_sil"]) / 3


def select_best_k(
    results: dict,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
) -> tuple[int, str | None]:
    """Pick the best k from clustering results, rejecting tiny-cluster partitions.

    A k is considered *valid* only if every cluster it produces has at least
    ``min_cluster_size`` members (inspected on the KMeans partition). Of the
    valid k values, the one with the highest average silhouette across
    KMeans / GMM / Hierarchical is selected.

    Returns:
        (best_k, rejection_reason)

        If at least one k is valid, ``best_k`` is that k (in 2..N) and
        ``rejection_reason`` is ``None``.

        If no k is valid, ``best_k`` is ``1`` and ``rejection_reason`` is a
        human-readable string listing every k and why it was rejected — for
        example ``"k=2 rejected (min size 1 < 5), k=3 rejected (min size 2 < 5)"``.
        Callers should treat k=1 as "no valid clustering" and skip downstream
        validation that assumes multiple clusters.
    """
    valid: list[tuple[int, float]] = []
    rejections: list[str] = []

    for k in sorted(results.keys()):
        row = results[k]
        sizes = row["kmeans_sizes"]
        min_size = min(sizes) if sizes else 0
        if min_size >= min_cluster_size:
            valid.append((k, _avg_silhouette(row)))
        else:
            rejections.append(
                f"k={k} rejected (min size {min_size} < {min_cluster_size})"
            )

    if valid:
        best_k, _ = max(valid, key=lambda pair: pair[1])
        return best_k, None

    reason = ", ".join(rejections) if rejections else "no candidate k values"
    return 1, reason


def print_results(results: dict) -> int:
    """Print clustering results and return best k.

    Best-k selection delegates to :func:`select_best_k`, which refuses to
    choose any k whose smallest cluster is below :data:`MIN_CLUSTER_SIZE`.
    When no valid k exists, returns ``1`` (caller should treat as
    "no valid clustering" and skip cluster-dependent validation).
    """
    print(f"\n{'=' * 70}")
    print("  CLUSTERING RESULTS")
    print(f"{'=' * 70}\n")

    print(
        f"  {'k':>3s}  {'K-Means':>10s}  {'GMM':>10s}  {'Hier.':>10s}  {'CH':>10s}  {'DB':>8s}  {'GMM BIC':>12s}  {'Sizes (KM)':>20s}"
    )
    print(
        f"  {'':->3s}  {'':->10s}  {'':->10s}  {'':->10s}  {'':->10s}  {'':->8s}  {'':->12s}  {'':->20s}"
    )

    for k, r in sorted(results.items()):
        sizes = str(r["kmeans_sizes"])
        print(
            f"  {k:3d}  {r['kmeans_sil']:10.3f}  {r['gmm_sil']:10.3f}  {r['hier_sil']:10.3f}  {r['kmeans_ch']:10.1f}  {r['kmeans_db']:8.3f}  {r['gmm_bic']:12.1f}  {sizes:>20s}"
        )

    best_k, rejection_reason = select_best_k(results)
    if rejection_reason is None:
        best_sil = _avg_silhouette(results[best_k])
        print(f"\n  Best k by average silhouette: {best_k} (avg sil = {best_sil:.3f})")
    else:
        print(
            f"\n  No valid k (every partition had a cluster smaller than "
            f"{MIN_CLUSTER_SIZE}). Falling back to k=1."
        )
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

    print(f"\n{'=' * 70}")
    print(f"  CLUSTER PROFILES ({method}, k={k})")
    print(f"{'=' * 70}")

    for i in range(k):
        mask = df_c["cluster"] == i
        cluster = df_c[mask]
        n = len(cluster)

        print(f"\n  --- Cluster {i} ({n} days, {n / len(df_c):.0%}) ---")
        print(f"  Dates: {', '.join(d.strftime('%m/%d') for d in cluster.index)}")

        # Volatility profile
        if "vix" in cluster.columns:
            vix_vals = cluster["vix"].dropna().astype(float)
            if len(vix_vals) > 0:
                print(
                    f"  VIX: {vix_vals.mean():.1f} avg ({vix_vals.min():.1f}-{vix_vals.max():.1f})"
                )

        if "vix1d_vix_ratio" in cluster.columns:
            ratio = cluster["vix1d_vix_ratio"].dropna().astype(float)
            if len(ratio) > 0:
                print(f"  VIX1D/VIX: {ratio.mean():.2f} avg")

        # GEX profile
        if "gex_oi_t1" in cluster.columns:
            gex = cluster["gex_oi_t1"].dropna().astype(float)
            if len(gex) > 0:
                gex_b = gex / 1e9
                print(
                    f"  GEX OI (T1): {gex_b.mean():.1f}B avg ({gex_b.min():.1f}B to {gex_b.max():.1f}B)"
                )

        # Flow agreement
        if "flow_agreement_t1" in cluster.columns:
            fa = cluster["flow_agreement_t1"].dropna().astype(float)
            if len(fa) > 0:
                print(f"  Flow Agreement (T1): {fa.mean():.1f} avg")

        # Dark pool profile
        if "dp_total_premium" in cluster.columns:
            dp = cluster["dp_total_premium"].dropna().astype(float)
            if len(dp) > 0:
                dp_m = dp / 1e6
                print(f"  Dark Pool Premium: ${dp_m.mean():.1f}M avg")
        if "dp_support_resistance_ratio" in cluster.columns:
            sr = cluster["dp_support_resistance_ratio"].dropna().astype(float)
            if len(sr) > 0:
                print(f"  DP Support/Resistance: {sr.mean():.2f} avg")
        # Options volume profile
        if "opt_vol_pcr" in cluster.columns:
            pcr = cluster["opt_vol_pcr"].dropna().astype(float)
            if len(pcr) > 0:
                print(f"  Options PCR: {pcr.mean():.2f} avg")

        # IV profile
        if "iv_open" in cluster.columns:
            iv = cluster["iv_open"].dropna().astype(float)
            if len(iv) > 0:
                print(f"  IV Open: {iv.mean():.1f} avg")

        # Charm pattern distribution
        if "charm_pattern" in cluster.columns:
            cp = cluster["charm_pattern"].dropna()
            if len(cp) > 0:
                dist = cp.value_counts()
                parts = [f"{v}={c}" for v, c in dist.items()]
                print(f"  Charm: {', '.join(parts)}")

        # Calendar
        dow = cluster["day_of_week"].dropna().astype(int)
        day_names = {
            0: "Sun",
            1: "Mon",
            2: "Tue",
            3: "Wed",
            4: "Thu",
            5: "Fri",
            6: "Sat",
        }
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
                print(f"  Correct: {correct}/{len(sc)} ({correct / len(sc):.0%})")

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


def split_half_validation(X: np.ndarray, k: int, *, random_state: int = 42) -> dict:
    """Split-half validation: cluster on 50%, evaluate on held-out 50%.

    Returns NaN silhouettes when the split yields a degenerate labeling
    (fewer than 2 unique labels on either half). This happens with highly
    imbalanced clusters where a random split may miss the minority cluster
    entirely — the silhouette is mathematically undefined in that case.
    """
    rng = np.random.default_rng(random_state)
    n = len(X)
    indices = rng.permutation(n)
    half = n // 2

    train_idx = indices[:half]
    test_idx = indices[half:]

    X_train = X[train_idx]
    X_test = X[test_idx]

    km = KMeans(n_clusters=k, n_init=20, random_state=random_state)
    train_labels = km.fit_predict(X_train)
    test_labels = km.predict(X_test)

    # silhouette_score requires 2 <= n_labels <= n_samples - 1. Guard against
    # degenerate splits (e.g. all test points collapse to a single centroid
    # when the minority cluster is absent from the training half).
    def _safe_silhouette(X_split: np.ndarray, labels: np.ndarray) -> float:
        if k <= 1:
            return 0.0
        n_unique = len(np.unique(labels))
        if n_unique < 2 or n_unique >= len(labels):
            return float("nan")
        return float(silhouette_score(X_split, labels))

    train_sil = _safe_silhouette(X_train, train_labels)
    test_sil = _safe_silhouette(X_test, test_labels)
    optimism = float(train_sil - test_sil)  # NaN propagates correctly

    return {
        "train_silhouette": train_sil,
        "holdout_silhouette": test_sil,
        "optimism": optimism,
    }


def outcome_association_test(
    df: pd.DataFrame,
    labels: np.ndarray,
    _k: int,
) -> None:
    """Test if cluster assignments are associated with trading outcomes."""
    df_c = df.copy()
    df_c["cluster"] = labels

    print("\n  --- Outcome Association Tests (chi-squared) ---\n")

    for outcome_col in [
        "range_category",
        "settlement_direction",
        "recommended_structure",
    ]:
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
            strength = (
                "strong"
                if cramers_v >= 0.5
                else "moderate"
                if cramers_v >= 0.3
                else "weak"
            )
            print(
                f"  {outcome_col:25s}  chi2={chi2:6.2f}  p={p:.3f}  Cramer's V={cramers_v:.2f} ({strength}){sig}"
            )

            # Warning for small expected counts
            pct_small = (expected < 5).sum() / expected.size
            if pct_small > 0.2:
                print(
                    f"    Warning: {pct_small:.0%} of cells have expected count < 5 (Fisher's exact may be more appropriate)"
                )
        except Exception:
            continue

    # Structure correctness by cluster (if available)
    if "structure_correct" in df_c.columns:
        has_sc = df_c[["structure_correct", "cluster"]].dropna()
        if len(has_sc) >= 10:
            correct_by_cluster = has_sc.groupby("cluster")["structure_correct"].agg(
                ["sum", "count"]
            )
            correct_by_cluster.columns = ["correct", "total"]
            correct_by_cluster["pct"] = (
                correct_by_cluster["correct"] / correct_by_cluster["total"]
            )
            print("\n  Structure correctness by cluster:")
            for cluster_id, row in correct_by_cluster.iterrows():
                lo, hi = proportion_confint(
                    int(row["correct"]), int(row["total"]), method="wilson"
                )
                print(
                    f"    Cluster {cluster_id}: {int(row['correct'])}/{int(row['total'])} ({row['pct']:.0%})  CI [{lo:.0%}-{hi:.0%}]"
                )


def _draw_confidence_ellipse(ax, x, y, color, alpha=0.15):
    """Draw a 95% confidence ellipse for 2D data."""
    if len(x) < 3:
        return
    from matplotlib.patches import Ellipse

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
        xy=(mean_x, mean_y),
        width=width,
        height=height,
        angle=angle,
        facecolor=color,
        edgecolor=color,
        alpha=alpha,
        linewidth=1.5,
        linestyle="--",
    )
    ax.add_patch(ellipse)


def plot_cluster_transitions(plot_dir: Path, labels: np.ndarray, k: int) -> None:
    """Save a Markov transition probability heatmap for day-type clusters."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return

    if k < 2:
        print("  Skipping cluster transitions: k < 2")
        return

    if len(labels) < 5:
        print("  Skipping cluster transitions: fewer than 4 consecutive-day pairs")
        return

    # Build transition count matrix
    transition_counts = np.zeros((k, k), dtype=int)
    for i in range(len(labels) - 1):
        from_c = labels[i]
        to_c = labels[i + 1]
        transition_counts[from_c, to_c] += 1

    # Row-normalize (guard against zero-sum rows)
    row_sums = transition_counts.sum(axis=1, keepdims=True)
    row_sums = np.where(row_sums == 0, 1, row_sums)
    transition_probs = transition_counts / row_sums

    tick_labels = [f"Cluster {i}" for i in range(k)]

    fig, ax = plt.subplots(1, 1, figsize=(max(5, k * 1.4), max(4, k * 1.2)))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")

    im = ax.imshow(transition_probs, cmap="Blues", aspect="auto", vmin=0, vmax=1)

    # Annotate each cell with its probability
    for row in range(k):
        for col in range(k):
            ax.text(
                col,
                row,
                f"{transition_probs[row, col]:.2f}",
                ha="center",
                va="center",
                color="#ffffff",
                fontsize=10,
            )

    ax.set_xticks(range(k))
    ax.set_xticklabels(tick_labels, color="#cccccc")
    ax.set_yticks(range(k))
    ax.set_yticklabels(tick_labels, color="#cccccc")
    ax.tick_params(colors="#cccccc")
    ax.set_title("Day Type Transition Matrix", color="#cccccc")
    ax.set_xlabel("To Cluster", color="#cccccc")
    ax.set_ylabel("From Cluster", color="#cccccc")

    cbar = fig.colorbar(im, ax=ax, shrink=0.8)
    cbar.ax.yaxis.set_tick_params(color="#cccccc")
    plt.setp(cbar.ax.yaxis.get_ticklabels(), color="#cccccc")

    for spine in ax.spines.values():
        spine.set_edgecolor("#cccccc")

    fig.tight_layout()
    fig.savefig(plot_dir / "cluster_transitions.png", dpi=150)
    print("  Saved: ml/plots/cluster_transitions.png")
    plt.close(fig)


def save_plots(X_pca: np.ndarray, labels: np.ndarray, k: int, df: pd.DataFrame) -> None:
    """Save PCA scatter plot and cluster summary."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("  matplotlib not available, skipping plots")
        return

    plot_dir = ML_ROOT / "plots"
    plot_dir.mkdir(exist_ok=True)

    # PCA scatter (PC1 vs PC2)
    fig, ax = plt.subplots(1, 1, figsize=(10, 7))
    colors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"]

    for i in range(k):
        mask = labels == i
        ax.scatter(
            X_pca[mask, 0],
            X_pca[mask, 1],
            c=colors[i % len(colors)],
            label=f"Cluster {i} (n={mask.sum()})",
            s=80,
            alpha=0.8,
            edgecolors="white",
            linewidth=0.5,
        )
        # Draw 95% confidence ellipse
        _draw_confidence_ellipse(
            ax, X_pca[mask, 0], X_pca[mask, 1], colors[i % len(colors)]
        )

        # Annotate with dates
        dates = df.index[mask]
        for j, (x, y) in enumerate(zip(X_pca[mask, 0], X_pca[mask, 1])):
            ax.annotate(
                dates[j].strftime("%m/%d"),
                (x, y),
                fontsize=7,
                ha="center",
                va="bottom",
                alpha=0.7,
            )

    ax.set_xlabel("PC1")
    ax.set_ylabel("PC2")
    ax.set_title(f"Day Type Clusters (k={k}, PCA projection)")
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(plot_dir / "clusters_pca.png", dpi=150)
    print("\n  Saved: ml/plots/clusters_pca.png")

    # Cluster feature heatmap
    df_c = df.copy()
    df_c["cluster"] = labels

    summary_features = [
        "vix",
        "vix1d_vix_ratio",
        "gex_oi_t1",
        "flow_agreement_t1",
        "charm_slope",
        "agg_net_gamma",
        "dp_support_resistance_ratio",
        "opt_vol_pcr",
        "iv_open",
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
        print("  Saved: ml/plots/clusters_heatmap.png")

    # Cluster transition matrix
    plot_cluster_transitions(plot_dir, labels, k)

    plt.close("all")


def filter_by_completeness(df: pd.DataFrame, threshold: float = 0.80) -> pd.DataFrame:
    """Drop days with feature_completeness below the threshold.

    Market holidays leak into training_features when the feature-builder
    cron doesn't check the NYSE calendar — those days have near-zero
    completeness (no options/GEX/dark pool data) and pollute distance-based
    clustering by creating phantom "outlier" days driven by median
    imputation of 70%+ missing features. This filter also catches days
    with upstream data pipeline failures.

    Mirrors the filter in ml/src/phase2_early.py so both pipelines see the
    same cleaned input. No-op (with warning) if the column is absent.
    """
    if "feature_completeness" not in df.columns:
        print("  WARNING: feature_completeness column missing — skipping filter")
        return df

    mask = df["feature_completeness"].astype(float) >= threshold
    dropped = df[~mask]
    filtered = df[mask]
    if len(dropped) > 0:
        dropped_dates = ", ".join(dropped.index.strftime("%Y-%m-%d"))
        print(
            f"  Dropped {len(dropped)} day(s) below {threshold:.0%} completeness "
            f"(holidays / incomplete data): {dropped_dates}"
        )
        print(f"  {len(filtered)} days remain after completeness filter")
    return filtered


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 1: Day Type Clustering")
    parser.add_argument(
        "--k", type=int, default=None, help="Force specific k (default: auto-select)"
    )
    parser.add_argument("--plot", action="store_true", help="Save plots to ml/plots/")
    args = parser.parse_args()

    print("Loading data ...")
    df = load_data_clustering()
    print(
        f"  {len(df)} days loaded ({df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d})"
    )

    df = filter_by_completeness(df)

    validate_dataframe(
        df,
        min_rows=10,
        required_columns=["vix", "day_of_week"],
        range_checks={"vix": (9, 90), "day_of_week": (0, 6)},
    )

    print("\nPreprocessing ...")
    X_pca, _, df_feat = preprocess(df)

    n_samples = X_pca.shape[0]
    max_k = min(6, n_samples - 1)
    k_range = range(2, max_k + 1)

    print(f"\nRunning clustering (k={k_range.start}..{k_range.stop - 1}) ...")
    results = run_clustering(X_pca, k_range)

    # Always print the comparison table.
    print_results(results)

    # Resolve best_k. A user-supplied --k overrides the guard, but is still
    # validated to exist in results. Otherwise select_best_k applies the
    # MIN_CLUSTER_SIZE guard and may return 1 (no valid clustering).
    rejection_reason: str | None = None
    if args.k is not None:
        if args.k in results:
            best_k = args.k
        else:
            print(f"  k={args.k} not in results, using k=2")
            best_k = 2
    else:
        best_k, rejection_reason = select_best_k(results)

    if best_k == 1:
        # No valid k — print prominent warning and skip cluster-dependent
        # validation. Findings are still recorded so downstream consumers see
        # the fallback explicitly.
        print(f"\n{'=' * 70}")
        print("  NO VALID CLUSTERING")
        print(f"{'=' * 70}")
        print(
            f"  No k in {k_range.start}..{k_range.stop - 1} produced clusters "
            f"with minimum size >= {MIN_CLUSTER_SIZE}."
        )
        print()
        print(f"  Rejection details: {rejection_reason}")
        print()
        print(
            "  Falling back to k=1 (no clustering). Insufficient regime separation in"
        )
        print("  the current dataset. Wait for more data before trusting clustering")
        print("  output for downstream decisions.")
        print(f"{'=' * 70}\n")

        # Summary (k=1 fallback flavor)
        print(f"\n{'=' * 70}")
        print("  SUMMARY")
        print(f"{'=' * 70}")
        print(f"  Days: {n_samples}")
        print(
            f"  Features used: {X_pca.shape[1]} PCA components from "
            f"{len(df_feat.columns)} features"
        )
        print("  Best k: 1 (fallback — no valid clustering)")
        print()

        save_section_findings(
            "clustering",
            {
                "best_k": 1,
                "algorithm": "KMeans",
                "fallback_reason": rejection_reason,
                "silhouette": None,
                "calinski_harabasz": None,
                "davies_bouldin": None,
                "cluster_sizes": None,
                "stability": None,
                "split_half_holdout_sil": None,
                "gmm_bic": None,
                "permutation_p": None,
                "chi_squared": {},
                "n_samples": n_samples,
                "n_pca_components": int(X_pca.shape[1]),
                "n_features": len(df_feat.columns),
            },
        )
        return

    # Use K-Means labels for profiling (most interpretable)
    best_labels = results[best_k]["kmeans_labels"]

    characterize_clusters(df, best_labels, best_k, "K-Means")

    # Stability check
    print("\nStability check (leave-one-out) ...")
    stability = stability_check(X_pca, best_k)
    print(f"  Stability: {stability:.0%} of days keep their cluster assignment")

    if stability < 0.7:
        print("  WARNING: Clusters are fragile. Consider waiting for more data.")

    # Split-half validation
    print("\nSplit-half validation (cluster on 50%, evaluate on 50%) ...")
    sh = split_half_validation(X_pca, best_k)
    print(f"  Train silhouette:   {sh['train_silhouette']:.3f}")
    print(f"  Holdout silhouette: {sh['holdout_silhouette']:.3f}")
    print(f"  Optimism gap:       {sh['optimism']:.3f}")
    if np.isnan(sh["holdout_silhouette"]) or np.isnan(sh["train_silhouette"]):
        print("  WARNING: Split-half validation is undefined for this clustering.")
        print(
            "  A random half likely missed the minority cluster — check cluster sizes."
        )
    elif sh["optimism"] > 0.15:
        print("  WARNING: Large optimism gap — clusters may not generalize well.")

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
    print(f"\n{'=' * 70}")
    print("  SUMMARY")
    print(f"{'=' * 70}")
    print(f"  Days: {n_samples}")
    print(
        f"  Features used: {X_pca.shape[1]} PCA components from {len(df_feat.columns)} features"
    )
    print(f"  Best k: {best_k}")
    print(f"  Silhouette: {results[best_k]['kmeans_sil']:.3f} (K-Means)")
    print(f"  Stability: {stability:.0%}")
    print(f"  Split-half holdout sil: {sh['holdout_silhouette']:.3f}")
    print(f"  GMM BIC: {results[best_k]['gmm_bic']:.1f}")
    print(f"  Permutation p: {p_value:.3f}")
    print()

    # Save findings
    best_r = results[best_k]
    chi2_results = {}
    df_c = df.copy()
    df_c["cluster"] = best_labels
    for outcome_col in [
        "range_category",
        "settlement_direction",
        "recommended_structure",
    ]:
        if outcome_col not in df_c.columns:
            continue
        has_both = df_c[[outcome_col, "cluster"]].dropna()
        if len(has_both) < 10:
            continue
        ct = pd.crosstab(has_both["cluster"], has_both[outcome_col])
        if ct.shape[0] < 2 or ct.shape[1] < 2:
            continue
        try:
            chi2_val, p_val, _, _ = chi2_contingency(ct)
            chi2_results[outcome_col] = {
                "chi2": round(float(chi2_val), 2),
                "p": round(float(p_val), 4),
            }
        except Exception:
            continue

    save_section_findings(
        "clustering",
        {
            "best_k": best_k,
            "algorithm": "KMeans",
            "fallback_reason": None,
            "silhouette": round(float(best_r["kmeans_sil"]), 3),
            "calinski_harabasz": round(float(best_r["kmeans_ch"]), 1),
            "davies_bouldin": round(float(best_r["kmeans_db"]), 3),
            "cluster_sizes": best_r["kmeans_sizes"],
            "stability": round(float(stability), 3),
            "split_half_holdout_sil": (
                None
                if np.isnan(sh["holdout_silhouette"])
                else round(sh["holdout_silhouette"], 3)
            ),
            "gmm_bic": round(float(best_r["gmm_bic"]), 1),
            "permutation_p": round(float(p_value), 3),
            "chi_squared": chi2_results,
            "n_samples": n_samples,
            "n_pca_components": int(X_pca.shape[1]),
            "n_features": len(df_feat.columns),
        },
    )


if __name__ == "__main__":
    main()
