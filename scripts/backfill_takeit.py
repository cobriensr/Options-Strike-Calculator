"""One-shot backfill of takeit_prob + takeit_top_features + takeit_model_version
on every enriched alert that doesn't already have the current model version.

Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
(Phase 3c, resolved decision #4: backfill all 641K labeled fires.)

How it works:
1. Load both bundles (joblib for python prediction + SHAP, JSON for version).
2. For each alert type, query rows where peak_ceiling_pct IS NOT NULL AND
   (takeit_model_version IS NULL OR takeit_model_version != <current>).
3. Build the Phase 1 feature matrix via `prepare_features` — same code path
   that produced the training data.
4. Predict probability via the joblib classifier + isotonic calibrator.
5. Compute SHAP top-3 positive + top-3 negative per row via shap_explainer.
6. UPSERT in 1000-row batches via psycopg2 execute_batch.

Idempotent: re-running skips rows already on the current version.

Usage:
    set -a && source .env.local && set +a && \\
    ml/.venv/bin/python -m scripts.backfill_takeit \\
        --alert-type both \\
        --batch-size 1000

Add --dry-run to skip the UPDATE and just print throughput.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import joblib
import pandas as pd
import psycopg2
from psycopg2.extras import execute_batch

# Re-use the Phase 1 + Phase 2 modules so the backfill produces byte-identical
# predictions to what the detect cron will produce going forward.
from ml.src.takeit.build_training_set import (
    build_lottery_from_raw,
    build_silentboom_from_raw,
    load_lottery,
    load_silentboom,
)
from ml.src.takeit.config import WIN_LABEL_THRESHOLD_PCT
from ml.src.takeit.shap_explainer import explain_batch
from ml.src.takeit.train import prepare_features

REPO_ROOT = Path(__file__).resolve().parent.parent
BUNDLE_DIR = REPO_ROOT / "ml" / "data" / "takeit"


def _get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print(
            "ERROR: DATABASE_URL not set. Run: set -a && source .env.local && set +a",
            file=sys.stderr,
        )
        sys.exit(1)
    return psycopg2.connect(url, sslmode="require")


def _load_bundles(alert_type: str) -> tuple[dict, str]:
    """Return (joblib_bundle, version) for the alert type."""
    joblib_path = BUNDLE_DIR / f"{alert_type}_classifier.joblib"
    json_path = BUNDLE_DIR / f"{alert_type}_classifier.json"
    if not joblib_path.exists() or not json_path.exists():
        print(
            f"ERROR: missing bundle for {alert_type}. Regenerate with: "
            f"ml/.venv/bin/python -m ml.src.takeit.train",
            file=sys.stderr,
        )
        sys.exit(1)
    bundle = joblib.load(joblib_path)
    version = json.loads(json_path.read_text())["version"]
    return bundle, version


def _table(alert_type: str) -> str:
    return "lottery_finder_fires" if alert_type == "lottery" else "silent_boom_alerts"


def _coerce_top_features(payload: dict) -> str:
    """JSON-serialize the SHAP top-features payload for JSONB storage."""
    return json.dumps(
        {
            "positive": [
                {
                    "name": c.name,
                    "shap_value": c.shap_value,
                    "feature_value": c.feature_value,
                }
                for c in payload["positive"]
            ],
            "negative": [
                {
                    "name": c.name,
                    "shap_value": c.shap_value,
                    "feature_value": c.feature_value,
                }
                for c in payload["negative"]
            ],
        }
    )


def backfill_one_alert_type(
    alert_type: str,
    *,
    batch_size: int,
    dry_run: bool,
) -> None:
    bundle, version = _load_bundles(alert_type)
    table = _table(alert_type)
    print(f"[backfill] {alert_type}: bundle version = {version}")

    with _get_conn() as conn:
        # Load BOTH frames once for the cofire flag — Phase 1 logic needs the
        # OTHER alert type's rows to compute silent_boom_cofire_within_5min
        # (and the silent-boom equivalent uses lottery for cofire).
        print(f"[backfill] {alert_type}: loading raw frames (lottery + silentboom)...")
        lot_raw = load_lottery(conn)
        sb_raw = load_silentboom(conn)

        # Use the same builder the training set used so features match
        # exactly. This is heavier than scoring just the to-update rows but
        # guarantees parity.
        print(f"[backfill] {alert_type}: building feature frame...")
        if alert_type == "lottery":
            feat = build_lottery_from_raw(lot_raw, sb_raw, WIN_LABEL_THRESHOLD_PCT)
        else:
            feat = build_silentboom_from_raw(sb_raw, lot_raw, WIN_LABEL_THRESHOLD_PCT)

        # Filter to rows that need backfill: have a label AND don't already
        # carry the current version.
        cur = conn.cursor()
        cur.execute(
            f"SELECT id FROM {table} "
            f"WHERE peak_ceiling_pct IS NOT NULL "
            f"AND (takeit_model_version IS NULL OR takeit_model_version != %s)",
            (version,),
        )
        ids_to_update = {row[0] for row in cur.fetchall()}
        cur.close()
        feat = feat[feat["id"].isin(ids_to_update)].reset_index(drop=True)
        print(
            f"[backfill] {alert_type}: {len(feat):,} rows need update "
            f"(of {len(ids_to_update):,} candidate ids)"
        )
        if feat.empty:
            print(f"[backfill] {alert_type}: nothing to do")
            return

        # Prepare features (one-hot etc.) and predict + explain.
        print(f"[backfill] {alert_type}: scoring + SHAP...")
        X, _, feature_cols, _ = prepare_features(
            feat, alert_type, top_tickers=bundle["top_tickers"]
        )
        # Align to model's exact feature_cols (pad missing one-hots with 0).
        missing = set(bundle["feature_cols"]) - set(feature_cols)
        for c in missing:
            X[c] = 0.0
        X = X[bundle["feature_cols"]].astype(float)

        # Predict + calibrate.
        raw_probs = bundle["model"].predict_proba(X)[:, 1]
        cal_probs = bundle["calibrator"].transform(raw_probs)
        # SHAP top-K per row.
        explanations = explain_batch(bundle, X, top_k=3)

        # Build UPSERT payload.
        rows = []
        for i, alert_id in enumerate(feat["id"].tolist()):
            top_features = _coerce_top_features(
                {
                    "positive": explanations[i].top_positive,
                    "negative": explanations[i].top_negative,
                }
            )
            rows.append((float(cal_probs[i]), top_features, version, int(alert_id)))

        if dry_run:
            print(
                f"[backfill] {alert_type}: DRY RUN — would UPSERT {len(rows):,} rows; "
                f"first row sample: prob={rows[0][0]:.4f} version={rows[0][2]}"
            )
            return

        print(f"[backfill] {alert_type}: UPDATEing {len(rows):,} rows in batches of {batch_size}...")
        update_sql = (
            f"UPDATE {table} "
            f"SET takeit_prob = %s, "
            f"    takeit_top_features = %s::jsonb, "
            f"    takeit_model_version = %s "
            f"WHERE id = %s"
        )
        cur = conn.cursor()
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            execute_batch(cur, update_sql, batch, page_size=batch_size)
            conn.commit()
            print(
                f"[backfill] {alert_type}: committed {start + len(batch):,} / {len(rows):,}"
            )
        cur.close()

    # VACUUM ANALYZE in a separate connection — VACUUM cannot run inside a
    # transaction block, and psycopg2's `with conn:` context wraps the whole
    # body in one. Outside the `with` so the prior connection is closed.
    if not dry_run and len(rows) > 10_000:
        print(f"[backfill] {alert_type}: VACUUM (ANALYZE) {table}...")
        vacuum_conn = _get_conn()
        vacuum_conn.autocommit = True
        vacuum_cur = vacuum_conn.cursor()
        vacuum_cur.execute(f"VACUUM (ANALYZE) {table}")
        vacuum_cur.close()
        vacuum_conn.close()

    print(f"[backfill] {alert_type}: done.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--alert-type",
        choices=["lottery", "silentboom", "both"],
        default="both",
    )
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    alert_types = (
        ["lottery", "silentboom"] if args.alert_type == "both" else [args.alert_type]
    )
    for at in alert_types:
        backfill_one_alert_type(at, batch_size=args.batch_size, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
