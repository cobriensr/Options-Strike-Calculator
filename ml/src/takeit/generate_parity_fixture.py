"""Phase 3b — produce the TS↔Python parity fixture.

50 random labeled rows from the lottery training parquet → prepared features →
Python model's raw + calibrated predictions. The TS scorer must reproduce
both predictions to 1e-6 on these exact rows; if it doesn't, the tree
traversal or isotonic interpolation is wrong.

Output: ml/tests/fixtures/takeit_parity_fixture.json

Decision per spec resolved-decisions item 5: real-data sample (50 random labeled
fires, regenerated only when feature set changes).

CLI:
    ml/.venv/bin/python -m ml.src.takeit.generate_parity_fixture
"""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from .train import prepare_features

DATA_DIR = Path("ml/data/takeit")
FIXTURE_DIR = Path("ml/tests/fixtures")
N_ROWS = 50
SEED = 20260516


def _coerce(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        v = float(value)
        return None if not np.isfinite(v) else v
    if isinstance(value, (np.bool_,)):
        return bool(value)
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


def generate_one(alert_type: str, rng: np.random.Generator) -> dict:
    df = pd.read_parquet(DATA_DIR / f"{alert_type}_training.parquet")
    if len(df) > N_ROWS:
        df = df.sample(n=N_ROWS, random_state=int(rng.integers(0, 2**31 - 1))).reset_index(drop=True)

    bundle = joblib.load(DATA_DIR / f"{alert_type}_classifier.joblib")
    feature_cols: list[str] = bundle["feature_cols"]

    X, _, prepared_cols, _ = prepare_features(df, alert_type, top_tickers=bundle["top_tickers"])
    # Ensure the columns line up with the trained model exactly.
    missing = set(feature_cols) - set(prepared_cols)
    if missing:
        # If new categoricals appeared in the sampled rows that the model never
        # saw, add zero columns so the matrix matches the model's expected shape.
        for c in missing:
            X[c] = 0.0
    X = X[feature_cols].astype(float)

    raw = bundle["model"].predict_proba(X)[:, 1]
    cal = bundle["calibrator"].transform(raw)

    rows = []
    for i in range(len(X)):
        row_features = {col: _coerce(X.iloc[i][col]) for col in feature_cols}
        rows.append({
            "features": row_features,
            "expected_prob_raw": float(raw[i]),
            "expected_prob_calibrated": float(cal[i]),
        })

    return {
        "alert_type": alert_type,
        "bundle_version": _bundle_version(alert_type),
        "n_rows": len(rows),
        "rows": rows,
    }


def _bundle_version(alert_type: str) -> str:
    path = DATA_DIR / f"{alert_type}_classifier.json"
    with open(path) as f:
        return json.load(f)["version"]


def main() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)
    out = {
        "lottery": generate_one("lottery", rng),
        "silentboom": generate_one("silentboom", rng),
    }
    fixture_path = FIXTURE_DIR / "takeit_parity_fixture.json"
    with open(fixture_path, "w") as f:
        json.dump(out, f, indent=2)
    for at, payload in out.items():
        print(
            f"[parity-fixture] {at}: n={payload['n_rows']} rows, "
            f"bundle_version={payload['bundle_version']} → {fixture_path}"
        )


if __name__ == "__main__":
    main()
