# Experiment Tracking

Each training run saves a JSON file here with parameters, metrics, and metadata.

## File naming convention

```text
{phase}_{date}_{version}.json
```

Example: `phase2_early_2026-03-31_v2.json`

## Schema (v2 — multi-model comparison)

```json
{
  "phase": "phase2_early",
  "model": "xgboost",
  "version": "v2",
  "timestamp": "2026-03-31T10:30:00Z",
  "data": {
    "training_days": 25,
    "feature_count": 74,
    "class_distribution": {
      "CALL CREDIT SPREAD": 14,
      "PUT CREDIT SPREAD": 7,
      "IRON CONDOR": 4
    },
    "feature_completeness_threshold": 0.80,
    "date_range": ["2026-02-09", "2026-03-31"]
  },
  "xgboost_params": {
    "objective": "multi:softprob",
    "max_depth": 3,
    "n_estimators": 50,
    "learning_rate": 0.1,
    "min_child_weight": 3,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 1.0,
    "reg_lambda": 2.0
  },
  "metrics": {
    "accuracy": 0.80,
    "log_loss": 0.7023,
    "per_class_f1": {
      "CALL CREDIT SPREAD": 0.889,
      "PUT CREDIT SPREAD": 0.0,
      "IRON CONDOR": 0.0
    },
    "majority_class": "CALL CREDIT SPREAD",
    "majority_baseline": 0.80,
    "prev_day_baseline": 0.80,
    "walk_forward_folds": 5
  },
  "model_comparison": {
    "XGBoost": { "accuracy": 0.80, "log_loss": 0.7023, "per_class_f1": {} },
    "Logistic Reg (L2)": { "accuracy": 0.60, "log_loss": 8.5278, "per_class_f1": {} },
    "Random Forest (15)": { "accuracy": 0.60, "log_loss": 7.7793, "per_class_f1": {} },
    "Naive Bayes": { "accuracy": 0.60, "log_loss": 6.8889, "per_class_f1": {} },
    "Decision Tree (d=2)": { "accuracy": 0.60, "log_loss": 7.5517, "per_class_f1": {} }
  },
  "best_model": "XGBoost",
  "feature_importance_top10": [
    ["mt_npp_t2", 0.1133],
    ["gex_vol_t2", 0.0842],
    ["neg_gamma_nearest_dist", 0.0839]
  ],
  "notes": "Walk-forward comparison of 5 models on 3-class structure prediction."
}
```

## Key fields

| Field | Description |
| --- | --- |
| `metrics` | XGBoost walk-forward metrics (primary model) |
| `model_comparison` | All 5 models' accuracy, log loss, and per-class F1 |
| `best_model` | Name of the highest-accuracy model |
| `xgboost_params` | XGBoost hyperparameters (sklearn models use defaults) |

## Comparing experiments across dates

```bash
# View latest experiment
cat ml/experiments/phase2_early_*.json | python3 -m json.tool

# Track accuracy over time
grep '"accuracy"' ml/experiments/phase2_early_*.json

# Check which model wins as data grows
grep '"best_model"' ml/experiments/phase2_early_*.json
```
