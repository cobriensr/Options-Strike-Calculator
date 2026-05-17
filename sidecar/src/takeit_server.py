"""Take-It SHAP explainer — Flask HTTP endpoint co-resident with the sidecar.

Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md

Phase 3d: the Vercel cron api/cron/takeit-fill-shap.ts POSTs batches of
feature rows here; we run shap.TreeExplainer against the joblib bundle
(downloaded from Vercel Blob on first request, then cached in memory) and
return the top-K positive + top-K negative contributors per row.

Run as a daemon thread alongside the Databento streamers. Starts when
TAKEIT_SERVER_ENABLED=1 is set in the environment; off by default so
sidecars without the extra deps installed don't crash.

Required env vars when enabled:
    - BLOB_READ_WRITE_TOKEN          read access to the takeit/ namespace
    - TAKEIT_SIDECAR_SHARED_SECRET   bearer token the cron sends
    - TAKEIT_SERVER_PORT             default 8123

Endpoint:
    POST /takeit/explain
    Headers: Authorization: Bearer <TAKEIT_SIDECAR_SHARED_SECRET>
    Body: {
      "alert_type": "lottery" | "silentboom",
      "rows": [{
        "alert_id": <int>,
        "features": { <feature_name>: <number | null>, ... }
      }, ...]
    }
    → 200: { "results": [{ "alert_id": ..., "top_positive": [...], "top_negative": [...] }, ...] }
    → 401: bad/missing bearer
    → 503: bundle unreachable
"""

from __future__ import annotations

import io
import json
import logging
import os
import threading
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

# Lazy import — heavy ML deps only loaded when the server is enabled.
_bundle_cache: dict[str, Any] = {}
_bundle_lock = threading.Lock()

MANIFEST_PATH = "takeit/latest.json"
TOP_K = 3


def _list_blob(prefix: str, token: str) -> list[dict]:
    """Call the Vercel Blob list API to resolve a private blob path."""
    url = f"https://blob.vercel-storage.com/?{urllib.parse.urlencode({'prefix': prefix, 'limit': 100})}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 (trusted)
        return json.loads(resp.read())["blobs"]


def _fetch_blob(url: str) -> bytes:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (trusted)
        return resp.read()


def _load_bundle(alert_type: str) -> dict:
    """Resolve the manifest's current version for `alert_type`, then download
    and joblib.load() the bundle. Cached per-alert_type in-process."""
    import joblib  # noqa: PLC0415  — heavy, intentionally lazy

    with _bundle_lock:
        if alert_type in _bundle_cache:
            return _bundle_cache[alert_type]

        token = os.environ["BLOB_READ_WRITE_TOKEN"]
        # Manifest → versioned bundle path → blob URL.
        manifest_blobs = _list_blob(MANIFEST_PATH, token)
        manifest_entry = next(
            (b for b in manifest_blobs if b["pathname"] == MANIFEST_PATH), None
        )
        if not manifest_entry:
            raise RuntimeError(f"manifest not found at {MANIFEST_PATH}")
        manifest = json.loads(_fetch_blob(manifest_entry["url"]).decode("utf-8"))
        target_path = manifest[alert_type]
        # The Blob does store the JSON form, but for SHAP we need the joblib
        # (which contains the XGBClassifier + IsotonicRegression objects).
        # Convention: the joblib lives alongside the JSON at the same prefix.
        joblib_path = target_path.replace("_classifier_v", "_joblib_v").replace(
            ".json", ".joblib"
        )
        joblib_blobs = _list_blob(joblib_path, token)
        joblib_entry = next(
            (b for b in joblib_blobs if b["pathname"] == joblib_path), None
        )
        if not joblib_entry:
            raise RuntimeError(
                f"joblib bundle missing at {joblib_path}. Upload it alongside "
                f"the JSON via scripts/upload_takeit_bundles.mjs (TODO: extend "
                f"to upload the joblib too)."
            )
        joblib_bytes = _fetch_blob(joblib_entry["url"])
        bundle = joblib.load(io.BytesIO(joblib_bytes))
        _bundle_cache[alert_type] = bundle
        return bundle


def _explain_rows(alert_type: str, rows: list[dict]) -> list[dict]:
    """Compute SHAP top-K per row. Returns the JSON-serializable payload."""
    import numpy as np  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415
    import shap  # noqa: PLC0415

    bundle = _load_bundle(alert_type)
    feature_cols: list[str] = bundle["feature_cols"]
    model = bundle["model"]

    # Build the feature matrix in bundle column order.
    matrix = []
    for r in rows:
        feats = r["features"]
        matrix.append([feats.get(c, np.nan) for c in feature_cols])
    X = pd.DataFrame(matrix, columns=feature_cols).astype(float)

    explainer = shap.TreeExplainer(model)
    shap_values = np.asarray(explainer.shap_values(X))

    out = []
    for i, r in enumerate(rows):
        contribs = shap_values[i]
        order_pos = np.argsort(contribs)[::-1][:TOP_K]
        order_neg = np.argsort(contribs)[:TOP_K]
        feature_values = X.iloc[i].to_numpy()
        pos = [
            {
                "name": feature_cols[j],
                "shap_value": float(contribs[j]),
                "feature_value": _json_safe(feature_values[j]),
            }
            for j in order_pos
            if contribs[j] > 0
        ]
        neg = [
            {
                "name": feature_cols[j],
                "shap_value": float(contribs[j]),
                "feature_value": _json_safe(feature_values[j]),
            }
            for j in order_neg
            if contribs[j] < 0
        ]
        out.append(
            {"alert_id": r["alert_id"], "top_positive": pos, "top_negative": neg}
        )
    return out


def _json_safe(v):
    import math  # noqa: PLC0415

    if v is None:
        return None
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def _build_app():
    """Construct the Flask app on demand so import-time failures don't kill
    the sidecar's main process when ML deps aren't installed."""
    from flask import Flask, jsonify, request  # noqa: PLC0415

    app = Flask(__name__)
    shared_secret = os.environ.get("TAKEIT_SIDECAR_SHARED_SECRET", "")
    if not shared_secret:
        raise RuntimeError("TAKEIT_SIDECAR_SHARED_SECRET not set")

    @app.route("/takeit/health", methods=["GET"])
    def health():
        return jsonify({"status": "ok", "bundles_loaded": list(_bundle_cache.keys())})

    @app.route("/takeit/explain", methods=["POST"])
    def explain():
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {shared_secret}":
            return jsonify({"error": "unauthorized"}), 401
        payload = request.get_json(force=True, silent=False)
        alert_type = payload.get("alert_type")
        if alert_type not in ("lottery", "silentboom"):
            return jsonify({"error": "alert_type must be lottery|silentboom"}), 400
        rows = payload.get("rows") or []
        if not rows:
            return jsonify({"results": []})
        try:
            results = _explain_rows(alert_type, rows)
        except RuntimeError as e:
            logger.error("takeit explain failed: %s", e)
            return jsonify({"error": str(e)}), 503
        return jsonify({"results": results})

    return app


def start_in_thread() -> threading.Thread | None:
    """Spawn the Flask server in a daemon thread. No-op when disabled or when
    optional ML deps are missing — the sidecar's main duties (Databento
    streaming) keep working either way."""
    if os.environ.get("TAKEIT_SERVER_ENABLED", "0") != "1":
        logger.info("takeit_server: disabled (TAKEIT_SERVER_ENABLED!=1); skipping")
        return None
    try:
        # Probe dep availability with explicit imports — better error than a
        # mid-request ModuleNotFoundError.
        import flask  # noqa: F401, PLC0415
        import joblib  # noqa: F401, PLC0415
        import numpy  # noqa: F401, PLC0415
        import pandas  # noqa: F401, PLC0415
        import shap  # noqa: F401, PLC0415
        import xgboost  # noqa: F401, PLC0415
    except ImportError as e:
        logger.error(
            "takeit_server: missing dep %s; install xgboost/shap/joblib/flask in sidecar venv",
            e.name,
        )
        return None

    port = int(os.environ.get("TAKEIT_SERVER_PORT", "8123"))
    app = _build_app()

    def _run():
        # waitress is the Python WSGI server we'd ideally use; Flask's dev
        # server is fine for the single-owner traffic profile and avoids a
        # new dep.
        logger.info("takeit_server: listening on 0.0.0.0:%d", port)
        app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)  # noqa: S104

    t = threading.Thread(target=_run, name="takeit-server", daemon=True)
    t.start()
    return t
