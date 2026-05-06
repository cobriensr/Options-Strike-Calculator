# Periscope EDA scripts

Four standalone Python scripts that analyze the `periscope_analyses` corpus
once enough reads have accumulated. Each script reads `DATABASE_URL` from the
environment, queries Neon Postgres, and writes plots/CSVs to
`ml/plots/periscope-eda/`.

## Scripts

| # | Script                            | One-liner                                                                       | Meaningful at |
| - | --------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| 1 | `01_confidence_calibration.py`    | Mean realized R per `confidence` band — checks if "high" actually wins more.    | n >= 10 per band |
| 2 | `02_regime_bias_table.py`         | (regime_tag x bias) -> mean realized R pivot + heatmap for playbook sanity.     | n >= 30 total |
| 3 | `03_trade_type_ev.py`             | Per-regime bar charts of mean R for each `trade_types_recommended` element.     | n >= 30 total |
| 4 | `04_embedding_cluster.py`         | UMAP/t-SNE of the 2000-d analysis embeddings, colored by realized R.            | n >= 50 total |

## Running

```bash
ml/.venv/bin/python ml/src/periscope_eda/01_confidence_calibration.py --min-samples 5 --mode all
ml/.venv/bin/python ml/src/periscope_eda/02_regime_bias_table.py     --min-samples 5
ml/.venv/bin/python ml/src/periscope_eda/03_trade_type_ev.py         --min-samples 3
ml/.venv/bin/python ml/src/periscope_eda/04_embedding_cluster.py     --method umap --cluster 5
```

All scripts handle the empty-result case gracefully (print a "corpus may be
too small" hint and exit 0) so they're safe to wire into a nightly cron
before the corpus has grown.

## Output

Everything lands in `ml/plots/periscope-eda/`:

- `confidence_calibration.png`
- `regime_bias_table.csv`, `regime_bias_table_n.csv`, `regime_bias_table.png`
- `trade_type_ev_<regime>.png` (one per regime)
- `embedding_cluster.png`

## Dependencies

Already in `ml/.venv`: `numpy`, `pandas`, `matplotlib`, `psycopg2`,
`scikit-learn`. Add `seaborn` for the regime/bias heatmap (the script falls
back to `matplotlib.imshow` if seaborn isn't installed). `umap-learn` is
optional for script 4 — falls back to sklearn t-SNE when missing.

```bash
ml/.venv/bin/pip install seaborn umap-learn
```

## Status

Scripts are wired but **not yet run** — the corpus is still too small for
results to be meaningful. Run them once each script's threshold above is met.
