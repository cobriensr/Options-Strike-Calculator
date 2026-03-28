# Experiment Tracking

Each training run saves a JSON file here with parameters, metrics, and metadata.

## File naming convention

```
{phase}_{model}_{date}_{version}.json
```

Example: `phase2_xgboost_2026-05-15_v1.json`

## Schema

```json
{
  "phase": "phase2",
  "model": "xgboost",
  "version": "v1",
  "timestamp": "2026-05-15T10:30:00Z",
  "data": {
    "training_days": 60,
    "feature_count": 47,
    "class_distribution": {"CCS": 33, "PCS": 18, "IC": 8, "SIT_OUT": 1},
    "feature_completeness_threshold": 0.8,
    "date_range": ["2026-02-10", "2026-05-14"]
  },
  "params": {
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
    "accuracy": 0.65,
    "log_loss": 0.89,
    "brier_score": 0.22,
    "per_class_f1": {"CCS": 0.72, "PCS": 0.61, "IC": 0.40},
    "majority_class_baseline": 0.55,
    "walk_forward_folds": 30
  },
  "feature_importance_top10": [
    ["gex_oi_t1", 0.15],
    ["vix1d_vix_ratio", 0.12],
    ["flow_agreement_t1", 0.09]
  ],
  "notes": "First Phase 2 run. Beats majority baseline by 10%."
}
```

## Usage in training scripts

```python
import json
from datetime import datetime, timezone

def save_experiment(phase, model, version, data, params, metrics, notes=""):
    experiment = {
        "phase": phase,
        "model": model,
        "version": version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": data,
        "params": params,
        "metrics": metrics,
        "notes": notes,
    }
    filename = f"{phase}_{model}_{datetime.now().strftime('%Y-%m-%d')}_{version}.json"
    path = Path(__file__).resolve().parent / "experiments" / filename
    path.write_text(json.dumps(experiment, indent=2))
    print(f"  Saved experiment: {path.name}")
```
