"""Periscope EDA 04 — Embedding cluster + outcome overlay.

UMAP/t-SNE projects the 2000-d ``analysis_embedding`` column to 2D and colors
each point by realized R, with marker shape indicating mode. Reveals natural
regime structure that the explicit ``regime_tag`` enum may not capture.

Output:
    ml/plots/periscope-eda/embedding_cluster.png
    Console: silhouette coefficient if --cluster N is passed.

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/04_embedding_cluster.py \\
        --method umap --cluster 5

Becomes meaningful at n >= 50 reads with both embedding and realized R.

Dependencies: psycopg2, pandas, numpy, matplotlib, scikit-learn.
Optional: umap-learn (preferred). Falls back to sklearn t-SNE if not present.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

PLOT_PATH = Path("ml/plots/periscope-eda/embedding_cluster.png")
EMPTY_THRESHOLD = 50

MODE_MARKERS = {
    "pre_trade": "o",
    "intraday": "s",
    "debrief": "x",
}


def fetch_rows(database_url: str) -> pd.DataFrame:
    """Pull id, mode, regime, embedding, realized_r from periscope_analyses.

    pgvector returns the embedding as a string like '[0.12,0.34,...]'. We
    keep it raw here; ``parse_embedding`` converts to a float array later.
    """
    sql = """
        SELECT id, mode, regime_tag, analysis_embedding, realized_r
        FROM periscope_analyses
        WHERE analysis_embedding IS NOT NULL
          AND realized_r IS NOT NULL
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def parse_embedding(raw: object) -> np.ndarray | None:
    """Convert pgvector text form '[a,b,c]' (or list/array) into a 1D ndarray.

    Returns None on parse failure so the caller can drop the row.
    """
    if raw is None:
        return None
    if isinstance(raw, (list, tuple, np.ndarray)):
        return np.asarray(raw, dtype=float)
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="ignore")
    if not isinstance(raw, str):
        return None
    cleaned = raw.strip().lstrip("[").rstrip("]")
    if not cleaned:
        return None
    try:
        return np.fromstring(cleaned, sep=",")
    except ValueError:
        return None


def project(matrix: np.ndarray, method: str) -> np.ndarray:
    """Project the embedding matrix to 2D via UMAP (preferred) or t-SNE."""
    if method == "umap":
        try:
            import umap

            reducer = umap.UMAP(
                n_components=2,
                n_neighbors=min(15, max(2, matrix.shape[0] - 1)),
                random_state=42,
            )
            return reducer.fit_transform(matrix)
        except ImportError:
            print("umap-learn not installed; falling back to sklearn t-SNE.")
            method = "tsne"

    from sklearn.manifold import TSNE

    perplexity = min(30, max(5, matrix.shape[0] // 3))
    reducer = TSNE(
        n_components=2,
        perplexity=perplexity,
        random_state=42,
        init="pca",
        learning_rate="auto",
    )
    return reducer.fit_transform(matrix)


def annotate_outliers(ax: plt.Axes, df: pd.DataFrame, coords: np.ndarray) -> None:
    """Annotate the 5 strongest +R and 5 strongest -R points with id + regime."""
    sorted_pos = df.sort_values("realized_r", ascending=False).head(5)
    sorted_neg = df.sort_values("realized_r", ascending=True).head(5)

    for sub in (sorted_pos, sorted_neg):
        for idx in sub.index:
            x, y = coords[idx]
            label = f"#{int(df.at[idx, 'id'])} {df.at[idx, 'regime_tag'] or ''}".strip()
            ax.annotate(
                label,
                xy=(x, y),
                xytext=(4, 4),
                textcoords="offset points",
                fontsize=7,
                color="black",
                bbox={"boxstyle": "round,pad=0.2", "fc": "white", "ec": "grey", "lw": 0.5, "alpha": 0.8},
            )


def plot(df: pd.DataFrame, coords: np.ndarray, method: str) -> None:
    """Render the 2D projection with diverging colormap on realized R."""
    PLOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(10, 8))

    r_vals = df["realized_r"].astype(float).values
    vmax = float(np.nanmax(np.abs(r_vals))) if len(r_vals) else 1.0
    vmin = -vmax if vmax > 0 else -1.0

    for mode_name, marker in MODE_MARKERS.items():
        mask = df["mode"] == mode_name
        if not mask.any():
            continue
        sub_coords = coords[mask.values]
        sub_r = r_vals[mask.values]
        sc = ax.scatter(
            sub_coords[:, 0],
            sub_coords[:, 1],
            c=sub_r,
            cmap="RdBu_r",
            vmin=vmin,
            vmax=vmax,
            marker=marker,
            edgecolor="black",
            linewidth=0.3,
            s=60,
            label=mode_name,
        )

    annotate_outliers(ax, df.reset_index(drop=True), coords)

    ax.set_title(f"Periscope embedding cluster ({method.upper()}) — color = realized R")
    ax.set_xlabel(f"{method.upper()} dim 1")
    ax.set_ylabel(f"{method.upper()} dim 2")
    ax.legend(title="mode", loc="best")
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("realized R")
    fig.tight_layout()
    fig.savefig(PLOT_PATH, dpi=120)
    plt.close(fig)
    print(f"Saved plot to {PLOT_PATH}")


def compute_silhouette(matrix: np.ndarray, k: int) -> None:
    """Run KMeans + silhouette score and print the result."""
    if k < 2:
        print("Silhouette requires --cluster N >= 2.")
        return
    if matrix.shape[0] <= k:
        print(
            f"Need more than {k} rows to compute silhouette for k={k}; "
            f"got {matrix.shape[0]}."
        )
        return

    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score

    km = KMeans(n_clusters=k, random_state=42, n_init=10)
    labels = km.fit_predict(matrix)
    score = silhouette_score(matrix, labels)
    print(f"Silhouette coefficient (k={k}): {score:.4f}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--method",
        choices=["umap", "tsne"],
        default="umap",
        help="Projection method (default: umap; auto-falls back to tsne if unavailable).",
    )
    parser.add_argument(
        "--cluster",
        type=int,
        default=None,
        help="Optional KMeans cluster count for silhouette scoring on raw embeddings.",
    )
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set in environment.", file=sys.stderr)
        return 1

    df = fetch_rows(database_url)
    if df.empty:
        print(
            "No rows match query — corpus may be too small. "
            f"Need at least {EMPTY_THRESHOLD} rows."
        )
        return 0

    df = df.copy()
    df["embedding_vec"] = df["analysis_embedding"].apply(parse_embedding)
    df = df[df["embedding_vec"].notna()].reset_index(drop=True)
    if df.empty:
        print("All embeddings failed to parse; nothing to project.")
        return 0

    matrix = np.vstack(df["embedding_vec"].to_list())
    if matrix.shape[0] < 3:
        print(
            f"Only {matrix.shape[0]} parseable embeddings — projection needs >= 3."
        )
        return 0

    coords = project(matrix, args.method)
    plot(df, coords, args.method)

    if args.cluster is not None:
        compute_silhouette(matrix, args.cluster)
    return 0


if __name__ == "__main__":
    sys.exit(main())
